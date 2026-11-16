import json
import math
import os
import time
from pathlib import Path


FIXATION_DISPERSION_DEGREES = 1.5
FIXATION_MIN_DURATION_SECONDS = 0.1
FIXATION_MIN_SAMPLES = 3
FIXATION_MIN_SAMPLE_RATE_HZ = 15.0
FIXATION_MIN_VALID_FRACTION = 0.7
TARGET_FIXATION_RADIUS_DEGREES = 3.0


def write_json_atomic(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")

    with temporary_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, allow_nan=False)

    # Windows sometimes locks the file if FastAPI is reading it at the same time.
    # We retry the replace operation up to 10 times with a short delay.
    for _ in range(10):
        try:
            os.replace(temporary_path, path)
            break
        except PermissionError:
            time.sleep(0.05)
    else:
        # If it still fails after 10 tries, let the error raise
        os.replace(temporary_path, path)


def _dispersion(points):
    xs = [point["xPx"] for point in points]
    ys = [point["yPx"] for point in points]
    return max(xs) - min(xs) + max(ys) - min(ys)


def detect_dispersion_fixations(
    samples,
    start_seconds,
    end_seconds,
    dispersion_threshold_px,
    minimum_duration_seconds=FIXATION_MIN_DURATION_SECONDS,
    minimum_samples=FIXATION_MIN_SAMPLES,
):
    """I-DT: grow a time window until its x/y dispersion exceeds the threshold."""
    points = [
        sample for sample in samples
        if sample["valid"]
        and start_seconds <= sample["timeSeconds"] <= end_seconds
    ]
    points.sort(key=lambda point: point["timeSeconds"])
    fixations = []
    start = 0

    while start < len(points):
        end = start
        while (
            end < len(points)
            and points[end]["timeSeconds"] - points[start]["timeSeconds"]
            < minimum_duration_seconds
        ):
            end += 1

        if end >= len(points):
            break
        if end - start + 1 < minimum_samples:
            start += 1
            continue

        window_end = end
        if _dispersion(points[start:window_end + 1]) > dispersion_threshold_px:
            start += 1
            continue

        while window_end + 1 < len(points):
            candidate = points[start:window_end + 2]
            if _dispersion(candidate) > dispersion_threshold_px:
                break
            window_end += 1

        fixation_points = points[start:window_end + 1]
        duration = (
            fixation_points[-1]["timeSeconds"]
            - fixation_points[0]["timeSeconds"]
        )
        if duration >= minimum_duration_seconds:
            fixations.append({
                "startSeconds": fixation_points[0]["timeSeconds"],
                "endSeconds": fixation_points[-1]["timeSeconds"],
                "durationMs": duration * 1000,
                "centroidXPx": sum(point["xPx"] for point in fixation_points)
                / len(fixation_points),
                "centroidYPx": sum(point["yPx"] for point in fixation_points)
                / len(fixation_points),
                "sampleCount": len(fixation_points),
            })
        start = window_end + 1

    return fixations


def calculate_attention_metrics(samples, targets, width_px, height_px, mm_per_px):
    valid_samples = [
        sample for sample in samples
        if sample["valid"]
        and math.isfinite(sample["xPx"])
        and math.isfinite(sample["yPx"])
    ]
    invalid_count = len(samples) - len(valid_samples)
    on_screen_count = sum(
        1 for sample in valid_samples
        if 0 <= sample["xPx"] < width_px and 0 <= sample["yPx"] < height_px
    )
    valid_fraction = len(valid_samples) / len(samples) if samples else None
    valid_times = sorted(sample["timeSeconds"] for sample in valid_samples)
    sample_rate_hz = None
    if len(valid_times) > 1 and valid_times[-1] > valid_times[0]:
        sample_rate_hz = (len(valid_times) - 1) / (
            valid_times[-1] - valid_times[0]
        )

    analysis_reasons = []
    if len(valid_samples) < 30:
        analysis_reasons.append("At least 30 valid gaze samples are required.")
    if valid_fraction is None or valid_fraction < FIXATION_MIN_VALID_FRACTION:
        analysis_reasons.append(
            "At least 70% of captured samples must contain valid gaze coordinates."
        )
    if sample_rate_hz is None or sample_rate_hz < FIXATION_MIN_SAMPLE_RATE_HZ:
        analysis_reasons.append(
            "A valid gaze sampling rate of at least 15 Hz is required."
        )
    analysis_supported = not analysis_reasons

    displayed_targets = [
        target for target in targets
        if target.get("appearedAtSeconds") is not None
    ]
    target_measurements = []
    all_fixations = []
    target_errors = []
    target_fixations = 0
    target_fixation_eligible = 0
    target_radius_px = None
    end_of_samples = max(valid_times) if valid_times else 0

    distances = [
        sample["distanceMm"] for sample in valid_samples
        if sample.get("distanceMm") is not None
        and math.isfinite(sample["distanceMm"])
        and sample["distanceMm"] > 0
    ]
    median_distance_mm = (
        sorted(distances)[len(distances) // 2] if distances else None
    )
    if (
        median_distance_mm is not None
        and mm_per_px > 0
    ):
        target_radius_px = (
            median_distance_mm
            * math.tan(math.radians(TARGET_FIXATION_RADIUS_DEGREES))
            / mm_per_px
        )

    for target in displayed_targets:
        onset = target["appearedAtSeconds"]
        offset = target.get("disappearedAtSeconds")
        if offset is None:
            offset = end_of_samples
        target_samples = [
            sample for sample in valid_samples
            if onset <= sample["timeSeconds"] <= offset
        ]
        errors = []
        target_samples_span = (
            target_samples[-1]["timeSeconds"] - target_samples[0]["timeSeconds"]
            if len(target_samples) >= 2 else 0
        )
        target_interval_supported = (
            len(target_samples) >= 3 and target_samples_span >= 0.1
        )
        if target_interval_supported:
            errors = [
                math.hypot(
                    sample["xPx"] - target["xPx"],
                    sample["yPx"] - target["yPx"],
                )
                for sample in target_samples
            ]
        target_error = sum(errors) / len(errors) if errors else None
        if target_error is not None:
            target_errors.extend(errors)

        fixations = []
        if (
            analysis_supported
            and target_interval_supported
            and median_distance_mm is not None
        ):
            dispersion_px = (
                median_distance_mm
                * math.tan(math.radians(FIXATION_DISPERSION_DEGREES))
                / mm_per_px
            )
            fixations = detect_dispersion_fixations(
                target_samples,
                onset,
                offset,
                dispersion_px,
            )
            all_fixations.extend(fixations)
            target_fixation_eligible += 1

        target_fixated = False
        if (
            target_interval_supported
            and analysis_supported
            and fixations
            and target_radius_px is not None
        ):
            target_fixated = any(
                math.hypot(
                    fixation["centroidXPx"] - target["xPx"],
                    fixation["centroidYPx"] - target["yPx"],
                ) <= target_radius_px
                for fixation in fixations
            )
            target_fixations += int(target_fixated)
        if not target_interval_supported or not analysis_supported:
            target_fixated = None

        target_measurements.append({
            "id": target["id"],
            "xPx": target["xPx"],
            "yPx": target["yPx"],
            "appearedAtSeconds": onset,
            "disappearedAtSeconds": target.get("disappearedAtSeconds"),
            "averageGazeToTargetDistancePx": (
                round(target_error, 2) if target_error is not None else None
            ),
            "fixationCount": (
                len(fixations)
                if analysis_supported and target_interval_supported else None
            ),
            "fixationDetected": target_fixated,
            "fixationDurationMs": (
                round(max(fixation["durationMs"] for fixation in fixations), 1)
                if fixations
                else (
                    None
                    if not analysis_supported or not target_interval_supported
                    else None
                )
            ),
        })

    targets_with_enough_samples = sum(
        1 for target in target_measurements
        if target["averageGazeToTargetDistancePx"] is not None
    )
    fixation_analysis_supported = (
        analysis_supported
        and bool(displayed_targets)
        and target_fixation_eligible >= math.ceil(
            len(displayed_targets) * 0.7
        )
    )
    if analysis_supported and not fixation_analysis_supported:
        analysis_reasons.append(
            "At least 70% of displayed targets need 3 valid samples spanning "
            "at least 100 ms for fixation analysis."
        )
    target_error_supported = (
        len(valid_samples) >= 30
        and valid_fraction is not None
        and valid_fraction >= FIXATION_MIN_VALID_FRACTION
        and bool(displayed_targets)
        and targets_with_enough_samples >= math.ceil(
            len(displayed_targets) * 0.7
        )
    )
    if not target_error_supported:
        for target in target_measurements:
            target["averageGazeToTargetDistancePx"] = None

    average_target_error = (
        sum(target_errors) / len(target_errors)
        if target_errors and target_error_supported else None
    )
    average_fixation_duration = (
        sum(item["durationMs"] for item in all_fixations) / len(all_fixations)
        if all_fixations else None
    )
    missing_percentage = (
        invalid_count / len(samples) * 100 if samples else None
    )
    target_consistency = (
        target_fixations / target_fixation_eligible * 100
        if (
            fixation_analysis_supported
            and displayed_targets
            and target_radius_px is not None
        )
        else None
    )
    explanations = {
        "averageGazeToTargetDistancePx": (
            None if average_target_error is not None
            else (
                "At least 3 valid gaze samples are required for at least 70% "
                "of displayed targets."
            )
        ),
        "averageFixationDurationMs": (
            None if average_fixation_duration is not None
            else (
                "No dispersion-qualified fixations were detected."
                if fixation_analysis_supported
                else " ".join(analysis_reasons)
            )
        ),
        "targetFixationConsistencyPct": (
            None if target_consistency is not None
            else (
                "At least 70% of displayed targets need 3 valid samples spanning "
                "at least 100 ms for target fixation consistency."
            )
        ),
        "fixationAnalysis": (
            None if fixation_analysis_supported else " ".join(analysis_reasons)
        ),
    }

    return {
        "measurements": {
            "totalSamples": len(samples),
            "validGazeSamples": len(valid_samples),
            "invalidGazeSamples": invalid_count,
            "onScreenGazeSamples": on_screen_count,
            "numberOfTargetsDisplayed": len(displayed_targets),
            "fixationCount": (
                len(all_fixations) if fixation_analysis_supported else None
            ),
            "averageFixationDurationMs": (
                round(average_fixation_duration, 1)
                if (
                    fixation_analysis_supported
                    and average_fixation_duration is not None
                ) else None
            ),
            "averageGazeToTargetDistancePx": (
                round(average_target_error, 2)
                if average_target_error is not None else None
            ),
            "targetFixationConsistencyPct": (
                round(target_consistency, 1)
                if target_consistency is not None else None
            ),
            "missingSamplePercentage": (
                round(missing_percentage, 2)
                if missing_percentage is not None else None
            ),
        },
        "sampleQuality": {
            "sampleRateHz": (
                round(sample_rate_hz, 2) if sample_rate_hz is not None else None
            ),
            "validSampleFraction": (
                round(valid_fraction, 3) if valid_fraction is not None else None
            ),
            "fixationAnalysisSupported": fixation_analysis_supported,
            "fixationMethod": "I-DT dispersion threshold",
            "dispersionThresholdDegrees": FIXATION_DISPERSION_DEGREES,
            "minimumFixationDurationMs": FIXATION_MIN_DURATION_SECONDS * 1000,
            "minimumFixationSamples": FIXATION_MIN_SAMPLES,
            "targetFixationRadiusDegrees": TARGET_FIXATION_RADIUS_DEGREES,
            "targetsWithSufficientGazeSamples": target_fixation_eligible,
            "qualityNotes": analysis_reasons,
        },
        "targetMeasurements": target_measurements,
        "metricExplanations": explanations,
    }