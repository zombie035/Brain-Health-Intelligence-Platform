import math
import statistics

MIN_VALID_SAMPLES = 30
MIN_VALID_FRACTION = 0.7
MIN_SAMPLE_RATE_HZ = 8.0
TARGET_RADIUS_DEGREES = 3.0

def calculate_smooth_pursuit_metrics(samples, targets, mm_per_px):
    valid_samples = [
        s for s in samples 
        if s.get("valid") and math.isfinite(s.get("xPx")) and s.get("targetXPx") is not None
    ]
    
    if not valid_samples:
        return {
            "measurements": {},
            "sampleQuality": {"qualityNotes": ["No valid samples collected."]},
            "targetMeasurements": [],
            "metricExplanations": {}
        }

    # 1. Position Error
    errors = [math.hypot(s["xPx"] - s["targetXPx"], s["yPx"] - s["targetYPx"]) for s in valid_samples]
    mean_error_px = statistics.mean(errors)
    rmse_px = math.sqrt(statistics.mean([e**2 for e in errors]))

    # 2. Tracking Accuracy (within 3 degrees)
    distances = [s["distanceMm"] for s in valid_samples if s.get("distanceMm") and s["distanceMm"] > 0]
    median_distance_mm = statistics.median(distances) if distances else 600.0
    threshold_px = median_distance_mm * math.tan(math.radians(TARGET_RADIUS_DEGREES)) / mm_per_px if mm_per_px > 0 else 100.0
    
    accurate_samples = sum(1 for e in errors if e <= threshold_px)
    accuracy_pct = (accurate_samples / len(valid_samples)) * 100.0

    # 3. Pursuit Gain and Catch-up Saccades
    gaze_vels = []
    target_vels = []
    catch_up_count = 0

    for i in range(1, len(valid_samples)):
        dt = valid_samples[i]["timeSeconds"] - valid_samples[i-1]["timeSeconds"]
        if dt <= 0: continue
        
        dx_g = valid_samples[i]["xPx"] - valid_samples[i-1]["xPx"]
        dy_g = valid_samples[i]["yPx"] - valid_samples[i-1]["yPx"]
        dx_t = valid_samples[i]["targetXPx"] - valid_samples[i-1]["targetXPx"]
        dy_t = valid_samples[i]["targetYPx"] - valid_samples[i-1]["targetYPx"]
        
        v_g = math.hypot(dx_g, dy_g) / dt
        v_t = math.hypot(dx_t, dy_t) / dt
        
        target_vels.append(v_t)
        gaze_vels.append(v_g)

        # Catch-up saccade: high gaze velocity when target velocity is lower
        if v_g > 300.0 and v_t < 150.0:
            catch_up_count += 1

    # Calculate Gain (only when target is moving)
    gains = [g / t for g, t in zip(gaze_vels, target_vels) if t > 20.0]
    mean_gain = statistics.median(gains) if gains else None

    # 4. Continuity
    total_samples = len(samples)
    continuity_pct = (len(valid_samples) / total_samples * 100.0) if total_samples > 0 else 0

    quality_notes = []
    if len(valid_samples) < MIN_VALID_SAMPLES:
        quality_notes.append("Low sample count.")
    if continuity_pct < 70.0:
        quality_notes.append("High tracking loss.")

    return {
        "measurements": {
            "totalSamples": total_samples,
            "validGazeSamples": len(valid_samples),
            "meanPositionErrorPx": round(mean_error_px, 2),
            "rmsePositionErrorPx": round(rmse_px, 2),
            "trackingAccuracyPct": round(accuracy_pct, 1),
            "pursuitGain": round(mean_gain, 2) if mean_gain else None,
            "catchUpSaccades": catch_up_count,
            "trackingContinuityPct": round(continuity_pct, 1)
        },
        "sampleQuality": {
            "qualityNotes": quality_notes,
            "thresholdPx": round(threshold_px, 1)
        },
        "targetMeasurements": [], # Not used for smooth pursuit
        "metricExplanations": {}
    }