"""Blink and fatigue monitoring: EAR-based blink detection and metrics.

This module follows the same pattern as saccadic_assessment.py and
smooth_pursuit_assessment.py: it takes raw per-frame samples collected by
gaze_demo.py and returns aggregated measurements.

EAR (Eye Aspect Ratio) landmarks per MediaPipe Face Mesh:
  Right eye: 33 (outer) 160 (upper) 158 (upper) 133 (inner) 153 (lower) 144 (lower)
  Left eye: 362 (inner) 385 (upper) 387 (upper) 263 (outer) 373 (lower) 380 (lower)

EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
"""

import math
import statistics

# MediaPipe Face Mesh eye landmark indices
RIGHT_EYE_EAR_INDICES = [33, 160, 158, 133, 153, 144]
LEFT_EYE_EAR_INDICES = [362, 385, 387, 263, 373, 380]
RIGHT_EYE_CONTOUR_INDICES = [
    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
]
LEFT_EYE_CONTOUR_INDICES = [
    362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398,
]

# Defaults (all overridable)
EAR_THRESHOLD_DEFAULT = 0.20
MIN_CLOSURE_DURATION_SECONDS = 0.05     # 50 ms — below this is noise
BLINK_MAX_DURATION_SECONDS = 0.5        # 500 ms — normal blink upper bound
LONGER_CLOSURE_MAX_SECONDS = 2.0        # 2 s — above this is prolonged
MIN_VALID_FRAMES = 30
MIN_VALID_FRACTION = 0.5
MIN_SAMPLE_RATE_HZ = 8.0


def ear(points):
    """Compute Eye Aspect Ratio from 6 landmark (x, y) points.

    Returns None if the eye cannot be evaluated (degenerate width).
    """
    if len(points) != 6:
        return None
    try:
        coordinates = [
            (float(point[0]), float(point[1]))
            for point in points
        ]
    except (IndexError, TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for point in coordinates for value in point):
        return None

    def dist(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    h1 = dist(coordinates[1], coordinates[5])
    h2 = dist(coordinates[2], coordinates[4])
    w = dist(coordinates[0], coordinates[3])
    if w <= 1e-6:
        return None
    ratio = (h1 + h2) / (2.0 * w)
    return ratio if math.isfinite(ratio) and ratio <= 1.0 else None


def eye_landmarks_are_visible(ear_points, contour_points, frame_width, frame_height):
    """Reject missing, out-of-frame, or too-small eye landmarks before measuring EAR."""
    if len(ear_points) != 6 or len(contour_points) < 6:
        return False
    try:
        points = [
            (float(point[0]), float(point[1]))
            for point in [*ear_points, *contour_points]
        ]
    except (IndexError, TypeError, ValueError):
        return False
    if not all(
        math.isfinite(x)
        and math.isfinite(y)
        and 0 <= x < frame_width
        and 0 <= y < frame_height
        for x, y in points
    ):
        return False

    corner_width = math.hypot(
        float(ear_points[0][0]) - float(ear_points[3][0]),
        float(ear_points[0][1]) - float(ear_points[3][1]),
    )
    contour_width = max(point[0] for point in points) - min(point[0] for point in points)
    minimum_width = max(6.0, frame_width * 0.008)
    return corner_width >= minimum_width and contour_width >= minimum_width


def _combined_ear(sample):
    left = sample.get("leftEAR")
    right = sample.get("rightEAR")
    vals = [v for v in (left, right) if isinstance(v, (int, float)) and math.isfinite(v)]
    if not vals:
        return None
    return sum(vals) / len(vals)


def detect_blink_events(samples, threshold):
    """State-machine blink/closure detection over per-frame EAR samples.

    Returns (blink_events, closure_events).
    """
    blink_events = []
    closure_events = []

    state = "open"           # "open" | "closing" | "closed"
    closure_start = None
    last_valid_time = None

    for sample in samples:
        if not sample.get("valid"):
            continue
        avg = _combined_ear(sample)
        if avg is None:
            continue

        now = sample["timeSeconds"]
        is_closed = avg < threshold

        if state == "open" and is_closed:
            state = "closing"
            closure_start = now

        elif state == "closing" and is_closed:
            if now - closure_start >= MIN_CLOSURE_DURATION_SECONDS:
                state = "closed"

        elif state == "closing" and not is_closed:
            state = "open"
            closure_start = None

        elif state == "closed" and not is_closed:
            duration = now - closure_start
            if duration < BLINK_MAX_DURATION_SECONDS:
                category = "blink"
            elif duration < LONGER_CLOSURE_MAX_SECONDS:
                category = "longer_closure"
            else:
                category = "prolonged_closure"

            event = {
                "startTimeSeconds": round(closure_start, 3),
                "endTimeSeconds": round(now, 3),
                "durationMs": round(duration * 1000.0, 1),
                "category": category,
            }
            closure_events.append(event)
            if category == "blink":
                blink_events.append(event)
            state = "open"
            closure_start = None

        if sample.get("valid"):
            last_valid_time = now

    # If still closed at end of recording, mark as uncertain (don't invent an end)
    if state == "closed" and closure_start is not None and last_valid_time is not None:
        duration = last_valid_time - closure_start
        closure_events.append({
            "startTimeSeconds": round(closure_start, 3),
            "endTimeSeconds": round(last_valid_time, 3),
            "durationMs": round(duration * 1000.0, 1),
            "category": "uncertain_incomplete",
        })

    return blink_events, closure_events


def calculate_blink_metrics(samples):
    """Aggregate per-frame EAR samples into blink and fatigue metrics."""

    total_frames = len(samples)
    valid_frames = sum(1 for s in samples if s.get("valid"))
    valid_fraction = valid_frames / total_frames if total_frames > 0 else None

    if total_frames < 2:
        return {
            "measurements": {},
            "sampleQuality": {"qualityNotes": ["No samples collected."]},
            "observations": [],
            "blinkEvents": [],
            "closureEvents": [],
        }

    total_duration = samples[-1]["timeSeconds"] - samples[0]["timeSeconds"]
    sample_rate_hz = ((valid_frames - 1) / total_duration) if total_duration > 0 and valid_frames > 1 else None

    quality_notes = []
    if valid_frames < MIN_VALID_FRAMES:
        quality_notes.append(f"Only {valid_frames} valid frames (need ≥{MIN_VALID_FRAMES}).")
    if valid_fraction is None or valid_fraction < MIN_VALID_FRACTION:
        quality_notes.append("Less than 50% of frames contained valid eye landmarks.")
    if sample_rate_hz is not None and sample_rate_hz < MIN_SAMPLE_RATE_HZ:
        quality_notes.append(f"Low sample rate ({sample_rate_hz:.1f} Hz, need ≥{MIN_SAMPLE_RATE_HZ} Hz).")

    # Baseline from first 60 valid samples (open-eye EAR for personalization)
    valid_ears = [
        _combined_ear(s) for s in samples
        if s.get("valid") and _combined_ear(s) is not None
    ]
    if len(valid_ears) >= 30:
        baseline_ear = statistics.median(valid_ears[:60])
        threshold = max(baseline_ear * 0.7, EAR_THRESHOLD_DEFAULT * 0.8)
    else:
        baseline_ear = None
        threshold = EAR_THRESHOLD_DEFAULT

    blink_events, closure_events = detect_blink_events(samples, threshold)

    blink_durations = [e["durationMs"] for e in blink_events]
    closure_durations = [e["durationMs"] for e in closure_events]

    blinks_per_minute = None
    if total_duration > 0:
        blinks_per_minute = (len(blink_events) / total_duration) * 60.0

    prolonged_count = sum(1 for e in closure_events if e["category"] == "prolonged_closure")
    longer_count = sum(1 for e in closure_events if e["category"] == "longer_closure")

    # Experimental observations (descriptive only, no diagnosis)
    observations = []
    if len(blink_events) >= 3:
        observations.append(f"Detected {len(blink_events)} blink events during the {total_duration:.1f} s recording.")
    if blinks_per_minute is not None:
        observations.append(f"Blink frequency: {blinks_per_minute:.1f} blinks per minute.")
    if blink_durations:
        observations.append(f"Average blink duration: {statistics.mean(blink_durations):.0f} ms.")
    if prolonged_count > 0:
        observations.append(f"Observed {prolonged_count} prolonged eye closure event(s) exceeding {LONGER_CLOSURE_MAX_SECONDS:.1f} s.")
    elif longer_count > 0:
        observations.append(f"Observed {longer_count} longer-than-typical closure event(s) between {BLINK_MAX_DURATION_SECONDS*1000:.0f} and {LONGER_CLOSURE_MAX_SECONDS*1000:.0f} ms.")
    if quality_notes:
        observations.append("Some metrics may be unreliable due to tracking quality.")

    measurements = {
        "totalBlinks": len(blink_events),
        "blinksPerMinute": round(blinks_per_minute, 2) if blinks_per_minute is not None else None,
        "avgBlinkDurationMs": round(statistics.mean(blink_durations), 1) if blink_durations else None,
        "medianBlinkDurationMs": round(statistics.median(blink_durations), 1) if blink_durations else None,
        "minBlinkDurationMs": round(min(blink_durations), 1) if blink_durations else None,
        "maxBlinkDurationMs": round(max(blink_durations), 1) if blink_durations else None,
        "longestClosureMs": round(max(closure_durations), 1) if closure_durations else None,
        "prolongedClosureCount": prolonged_count,
        "longerClosureCount": longer_count,
        "totalClosureEvents": len(closure_events),
        "validTrackingPct": round((valid_fraction or 0) * 100.0, 1) if valid_fraction is not None else None,
        "totalFrames": total_frames,
        "validFrames": valid_frames,
    }

    return {
        "measurements": measurements,
        "sampleQuality": {
            "earThreshold": round(threshold, 4),
            "baselineEAR": round(baseline_ear, 4) if baseline_ear is not None else None,
            "qualityNotes": quality_notes,
        },
        "observations": observations,
        "blinkEvents": blink_events,
        "closureEvents": closure_events,
    }