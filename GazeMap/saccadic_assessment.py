import math
import random
import statistics
from typing import Optional

import cv2
import numpy as np


TRIAL_COUNT = 12
FIXATION_DURATION_SECONDS = 0.45
TARGET_DURATION_SECONDS = 0.85
MIN_VALID_SAMPLES = 30
MIN_VALID_FRACTION = 0.7
MIN_SAMPLE_RATE_HZ = 8.0  # Lowered from 15.0 to accept typical webcam frame rates
MIN_TRIAL_SAMPLES = 3
MIN_TRIAL_SPAN_SECONDS = 0.1
MAX_ACQUISITION_GAP_SECONDS = 0.5
TARGET_RADIUS_DEGREES = 3.0
ENDPOINT_WINDOW_SECONDS = 0.25
MIN_ACQUIRED_TRIAL_FRACTION = 0.7

# OpenCV uses BGR. Darker colors to minimize glare on the face.
LEFT_HALF_COLOR  = (80,  50,   0)   # Dark blue-ish
RIGHT_HALF_COLOR = ( 0,  50,  80)   # Dark red-ish
CUE_COLOR        = (255, 255, 255)   # white center fixation cue
TARGET_COLOR     = (255, 255, 255)   # white side target
STIMULUS_DOT_RADIUS_PX = 18


def make_split_screen(width: int, height: int) -> np.ndarray:
    """Return a BGR frame split into two equal vertical colored halves."""
    frame = np.empty((height, width, 3), dtype=np.uint8)
    mid = width // 2
    frame[:, :mid] = LEFT_HALF_COLOR
    frame[:, mid:] = RIGHT_HALF_COLOR
    return frame


def render_stimulus_frame(
    width: int,
    height: int,
    *,
    phase: str,
    target_x_px: Optional[int] = None,
    target_y_px: Optional[int] = None,
) -> np.ndarray:
    """
    Compose one fullscreen BGR frame for the saccadic test.
    """
    frame = make_split_screen(width, height)

    if phase == "cue":
        cv2.circle(
            frame,
            (width // 2, height // 2),
            STIMULUS_DOT_RADIUS_PX,
            CUE_COLOR,
            -1,
        )
    elif phase == "target":
        if target_x_px is None or target_y_px is None:
            raise ValueError("phase='target' requires target_x_px and target_y_px")
        cv2.circle(
            frame,
            (int(target_x_px), int(target_y_px)),
            STIMULUS_DOT_RADIUS_PX,
            TARGET_COLOR,
            -1,
        )
    elif phase != "idle":
        raise ValueError(f"Unknown stimulus phase: {phase!r}")

    return frame


def create_saccadic_targets(session_id, width_px, height_px):
    sides = ["left", "right"] * (TRIAL_COUNT // 2)
    random.Random(session_id).shuffle(sides)
    return [
        {
            "id": f"trial-{index + 1}",
            "side": side,
            "xPx": int((0.2 if side == "left" else 0.8) * width_px),
            "yPx": height_px // 2,
            "cueOnsetAtSeconds": None,
            "appearedAtSeconds": None,
            "disappearedAtSeconds": None,
        }
        for index, side in enumerate(sides)
    ]


def _is_valid_sample(sample):
    return (
        sample.get("valid")
        and all(
            isinstance(sample.get(key), (int, float))
            and math.isfinite(sample[key])
            for key in ("timeSeconds", "xPx", "yPx")
        )
    )


def calculate_saccadic_metrics(samples, targets, mm_per_px):
    valid_samples = [sample for sample in samples if _is_valid_sample(sample)]
    invalid_count = len(samples) - len(valid_samples)
    valid_fraction = len(valid_samples) / len(samples) if samples else None
    valid_samples.sort(key=lambda sample: sample["timeSeconds"])

    sample_rate_hz = None
    if (
        len(valid_samples) > 1
        and valid_samples[-1]["timeSeconds"] > valid_samples[0]["timeSeconds"]
    ):
        sample_rate_hz = (len(valid_samples) - 1) / (
            valid_samples[-1]["timeSeconds"] - valid_samples[0]["timeSeconds"]
        )

    quality_notes = []
    if len(valid_samples) < MIN_VALID_SAMPLES:
        quality_notes.append(
            f"At least {MIN_VALID_SAMPLES} valid gaze samples are required."
        )
    if valid_fraction is None or valid_fraction < MIN_VALID_FRACTION:
        quality_notes.append("At least 70% of captured samples must be valid.")
    if sample_rate_hz is None or sample_rate_hz < MIN_SAMPLE_RATE_HZ:
        quality_notes.append(
            f"A valid gaze sampling rate of at least {MIN_SAMPLE_RATE_HZ:g} Hz is required."
        )
    global_quality_supported = not quality_notes

    displayed_targets = [
        target for target in targets
        if target.get("appearedAtSeconds") is not None
    ]
    end_of_samples = (
        valid_samples[-1]["timeSeconds"] if valid_samples else 0
    )
    distances = [
        sample["distanceMm"]
        for sample in valid_samples
        if isinstance(sample.get("distanceMm"), (int, float))
        and math.isfinite(sample["distanceMm"])
        and sample["distanceMm"] > 0
    ]
    median_distance_mm = statistics.median(distances) if distances else None
    target_radius_px = None
    if median_distance_mm is not None and mm_per_px > 0:
        target_radius_px = (
            median_distance_mm
            * math.tan(math.radians(TARGET_RADIUS_DEGREES))
            / mm_per_px
        )

    target_measurements = []
    interval_supported_count = 0
    targets_with_endpoint_error = 0
    endpoint_errors = []
    response_latencies = []
    acquired_count = 0
    acquisition_eligible_count = 0

    for target in displayed_targets:
        onset = target["appearedAtSeconds"]
        offset = target.get("disappearedAtSeconds")
        if offset is None:
            offset = end_of_samples
        target_samples = [
            sample for sample in valid_samples
            if onset <= sample["timeSeconds"] <= offset
        ]
        interval_supported = (
            len(target_samples) >= MIN_TRIAL_SAMPLES
            and target_samples[-1]["timeSeconds"]
            - target_samples[0]["timeSeconds"] >= MIN_TRIAL_SPAN_SECONDS
        )
        interval_supported_count += int(interval_supported)

        endpoint_error = None
        if global_quality_supported and interval_supported:
            endpoint_samples = [
                sample for sample in target_samples
                if sample["timeSeconds"] >= offset - ENDPOINT_WINDOW_SECONDS
            ]
            if len(endpoint_samples) >= MIN_TRIAL_SAMPLES:
                errors = [
                    math.hypot(
                        sample["xPx"] - target["xPx"],
                        sample["yPx"] - target["yPx"],
                    )
                    for sample in endpoint_samples
                ]
                endpoint_error = round(statistics.median(errors), 2)
                endpoint_errors.append(endpoint_error)
                targets_with_endpoint_error += 1

        acquired = None
        response_latency_ms = None
        if (
            global_quality_supported
            and interval_supported
            and target_radius_px is not None
        ):
            acquired = False
            acquisition_eligible_count += 1
            for start_index, first_sample in enumerate(target_samples):
                if math.hypot(
                    first_sample["xPx"] - target["xPx"],
                    first_sample["yPx"] - target["yPx"],
                ) > target_radius_px:
                    continue
                previous_sample = first_sample
                cluster_sample_count = 1
                for sample in target_samples[start_index + 1:]:
                    sample_gap = (
                        sample["timeSeconds"] - previous_sample["timeSeconds"]
                    )
                    if sample_gap > MAX_ACQUISITION_GAP_SECONDS:
                        break
                    if math.hypot(
                        sample["xPx"] - target["xPx"],
                        sample["yPx"] - target["yPx"],
                    ) > target_radius_px:
                        break
                    cluster_sample_count += 1
                    if (
                        cluster_sample_count >= MIN_TRIAL_SAMPLES
                        and sample["timeSeconds"] - first_sample["timeSeconds"]
                        >= MIN_TRIAL_SPAN_SECONDS
                    ):
                        acquired = True
                        acquired_count += 1
                        response_latency_ms = round(
                            max(0, first_sample["timeSeconds"] - onset) * 1000,
                            1,
                        )
                        response_latencies.append(response_latency_ms)
                        break
                    previous_sample = sample
                if acquired:
                    break

        target_measurements.append({
            "id": target["id"],
            "side": target.get("side"),
            "xPx": target["xPx"],
            "yPx": target["yPx"],
            "cueOnsetAtSeconds": target.get("cueOnsetAtSeconds"),
            "appearedAtSeconds": onset,
            "disappearedAtSeconds": target.get("disappearedAtSeconds"),
            "validSampleCount": len(target_samples),
            "endpointErrorPx": endpoint_error,
            "acquired": acquired,
            "responseLatencyMs": response_latency_ms,
        })

    minimum_supported_targets = math.ceil(len(displayed_targets) * 0.7)
    target_coverage_supported = (
        bool(displayed_targets)
        and interval_supported_count >= minimum_supported_targets
    )
    if global_quality_supported and not target_coverage_supported:
        quality_notes.append(
            "At least 70% of displayed targets need 3 valid samples spanning "
            "at least 100 ms."
        )
    endpoint_analysis_supported = (
        global_quality_supported
        and bool(displayed_targets)
        and targets_with_endpoint_error >= minimum_supported_targets
    )
    acquisition_analysis_supported = (
        global_quality_supported
        and target_coverage_supported
        and target_radius_px is not None
    )
    minimum_latency_trials = math.ceil(
        acquisition_eligible_count * MIN_ACQUIRED_TRIAL_FRACTION
    )
    latency_analysis_supported = (
        acquisition_analysis_supported
        and acquisition_eligible_count > 0
        and len(response_latencies) >= minimum_latency_trials
    )
    if target_radius_px is None:
        quality_notes.append(
            "Target acquisition requires valid camera-to-screen distance samples."
        )
    elif (
        acquisition_analysis_supported
        and not latency_analysis_supported
    ):
        quality_notes.append(
            "Mean response latency requires successful acquisition on at least "
            "70% of adequately sampled trials."
        )

    measurements = {
        "totalSamples": len(samples),
        "validGazeSamples": len(valid_samples),
        "invalidGazeSamples": invalid_count,
        "totalTrials": len(displayed_targets),
        "trialsWithEnoughGazeSamples": interval_supported_count,
        "targetsWithEndpointError": targets_with_endpoint_error,
        "successfulTargetAcquisitions": (
            acquired_count if acquisition_analysis_supported else None
        ),
        "targetAcquisitionRatePct": (
            round(acquired_count / acquisition_eligible_count * 100, 1)
            if acquisition_analysis_supported and acquisition_eligible_count else None
        ),
        "meanResponseLatencyMs": (
            round(statistics.mean(response_latencies), 1)
            if latency_analysis_supported and response_latencies else None
        ),
        "medianResponseLatencyMs": (
            round(statistics.median(response_latencies), 1)
            if latency_analysis_supported and response_latencies else None
        ),
        "meanEndpointErrorPx": (
            round(statistics.mean(endpoint_errors), 2)
            if endpoint_analysis_supported and endpoint_errors else None
        ),
        "missingSamplePercentage": (
            round(invalid_count / len(samples) * 100, 2) if samples else None
        ),
    }

    explanations = {
        "responseLatency": (
            None if measurements["meanResponseLatencyMs"] is not None
            else "Response latency requires adequate valid samples and a "
            "sustained gaze entry within 3 degrees of the target on at least "
            "70% of adequately sampled trials."
        ),
        "endpointError": (
            None if measurements["meanEndpointErrorPx"] is not None
            else "Endpoint error requires adequate valid samples in the final "
            "250 ms of at least 70% of displayed targets."
        ),
        "targetAcquisition": (
            None if measurements["targetAcquisitionRatePct"] is not None
            else "Target acquisition requires adequate valid samples, "
            "calibrated distance, and target coverage."
        ),
    }

    return {
        "measurements": measurements,
        "sampleQuality": {
            "sampleRateHz": (
                round(sample_rate_hz, 2) if sample_rate_hz is not None else None
            ),
            "validSampleFraction": (
                round(valid_fraction, 3) if valid_fraction is not None else None
            ),
            "targetAcquisitionSupported": acquisition_analysis_supported,
            "latencyAnalysisSupported": latency_analysis_supported,
            "targetRadiusDegrees": TARGET_RADIUS_DEGREES,
            "targetsWithSufficientGazeSamples": interval_supported_count,
            "qualityNotes": quality_notes,
        },
        "targetMeasurements": target_measurements,
        "metricExplanations": explanations,
    }