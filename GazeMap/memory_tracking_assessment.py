import math
import statistics
from scipy.stats import norm

def calculate_memory_metrics(samples, trials):
    # 1. Memory Performance
    hits = sum(1 for t in trials if t["phase"] == "recognition" and t["isOld"] and t["userResponse"] == "seen")
    misses = sum(1 for t in trials if t["phase"] == "recognition" and t["isOld"] and t["userResponse"] == "not_seen")
    false_alarms = sum(1 for t in trials if t["phase"] == "recognition" and not t["isOld"] and t["userResponse"] == "seen")
    correct_rejections = sum(1 for t in trials if t["phase"] == "recognition" and not t["isOld"] and t["userResponse"] == "not_seen")
    
    total_recog = hits + misses + false_alarms + correct_rejections
    accuracy = ((hits + correct_rejections) / total_recog * 100) if total_recog > 0 else None
    
    response_times = [t["responseTimeMs"] for t in trials if t["phase"] == "recognition" and t.get("responseTimeMs")]
    mean_rt = statistics.mean(response_times) if response_times else None
    
    # d-prime calculation (with Macmillan & Kaplan correction for 0/1 rates)
    hr = hits / (hits + misses) if (hits + misses) > 0 else 0
    far = false_alarms / (false_alarms + correct_rejections) if (false_alarms + correct_rejections) > 0 else 0
    
    if hr == 0: hr = 0.5 / (hits + misses + 1)
    elif hr == 1: hr = (hits + 0.5) / (hits + misses + 1)
    if far == 0: far = 0.5 / (false_alarms + correct_rejections + 1)
    elif far == 1: far = (false_alarms + 0.5) / (false_alarms + correct_rejections + 1)
    
    d_prime = norm.ppf(hr) - norm.ppf(far) if total_recog > 0 else None

    # 2. Eye Tracking (Simplified fixation logic)
    # We just average the fixation durations calculated during the GazeMap run
    enc_fix = [t["fixationDurationMs"] for t in trials if t["phase"] == "encoding" and t.get("fixationDurationMs")]
    rec_fix = [t["fixationDurationMs"] for t in trials if t["phase"] == "recognition" and t.get("fixationDurationMs")]

    valid_samples = sum(1 for s in samples if s.get("valid"))
    total_samples = len(samples)

    quality_notes = []
    if accuracy is None:
        quality_notes.append("Not enough trials to calculate recognition accuracy.")

    return {
        "measurements": {
            "recognitionAccuracy": round(accuracy, 1) if accuracy is not None else None,
            "hits": hits,
            "misses": misses,
            "correctRejections": correct_rejections,
            "falseAlarms": false_alarms,
            "meanResponseTimeMs": round(mean_rt, 1) if mean_rt is not None else None,
            "dPrime": round(d_prime, 2) if d_prime is not None else None,
            "meanEncodingFixationMs": round(statistics.mean(enc_fix), 1) if enc_fix else None,
            "meanRecognitionFixationMs": round(statistics.mean(rec_fix), 1) if rec_fix else None,
        },
        "sampleQuality": {
            "totalSamples": total_samples,
            "validSamples": valid_samples,
            "validTrackingPct": round((valid_samples / total_samples * 100), 1) if total_samples > 0 else None,
            "qualityNotes": quality_notes,
        }
    }