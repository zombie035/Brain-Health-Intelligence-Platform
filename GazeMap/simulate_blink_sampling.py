"""Simulate blink detection at different camera sample rates.

Synthetic, idealised traces (rectangular closures, light noise), so real-world
recall will be lower. Run from this folder:  python simulate_blink_sampling.py
"""
import random, statistics, sys
sys.path.insert(0, ".")
from blink_monitoring import calculate_blink_metrics

OPEN, CLOSED, NOISE = 0.30, 0.10, 0.01

def make_blinks(rng, n=10, total=30.0):
    """n non-overlapping true closures, durations 80-250 ms (rectangular = easiest case for the detector)."""
    blinks, t = [], 5.0  # leave first 5 s open for the baseline
    while len(blinks) < n:
        t += rng.uniform(1.2, 2.6)
        d = rng.uniform(0.08, 0.25)
        if t + d > total - 0.5: break
        blinks.append((t, t + d)); t += d
    return blinks

def sample(rng, blinks, base_dt, jitter=0.15, total=30.0):
    out, t = [], 0.0
    while t < total:
        closed = any(a <= t < b for a, b in blinks)
        e = (CLOSED if closed else OPEN) + rng.gauss(0, NOISE)
        out.append({"timeSeconds": t, "leftEAR": e, "rightEAR": e, "avgEAR": e,
                    "faceDetected": True, "valid": True})
        t += base_dt * (1 + rng.uniform(-jitter, jitter))
    return out

print("A) Blink detection vs sample rate (300 simulated 30 s runs each; ~9 true blinks/run, 80-250 ms)")
print(f"{'rate':>8} {'true':>6} {'found':>6} {'recall':>7} {'dur err (ms)':>13}")
for hz in (60, 30, 15, 12, 10, 8, 6):
    rng = random.Random(1)
    true_n = found_n = 0; errs = []
    for _ in range(300):
        bl = make_blinks(rng)
        r = calculate_blink_metrics(sample(rng, bl, 1.0 / hz))
        true_n += len(bl); found_n += r["measurements"]["totalBlinks"]
        # duration error vs truth only when counts match (clean pairing)
        if len(r["blinkEvents"]) == len(bl):
            errs += [e["durationMs"] - (b - a) * 1000 for e, (a, b) in zip(r["blinkEvents"], bl)]
    print(f"{hz:>6}Hz {true_n:>6} {found_n:>6} {found_n/true_n:>7.0%} "
          f"{(statistics.mean(errs) if errs else float('nan')):>+9.0f} ±{(statistics.pstdev(errs) if errs else float('nan')):.0f}")

print("\nB) Tracking gap during a closure (12 Hz; eyes close at t=10.00, face lost 10.1-13.0, eyes open when re-detected)")
s = []
t = 0.0
while t < 30:
    if 10.0 <= t < 10.1: e, v = CLOSED, True
    elif 10.1 <= t < 13.0: e, v = None, False
    else: e, v = OPEN, True
    s.append({"timeSeconds": t, "leftEAR": e, "rightEAR": e, "avgEAR": e, "faceDetected": v, "valid": v})
    t += 1/12
r = calculate_blink_metrics(s)
print("  closure events:", r["closureEvents"])
print("  totalBlinks:", r["measurements"]["totalBlinks"], "| prolongedClosureCount:", r["measurements"]["prolongedClosureCount"])

print("\nC) Blinks-per-minute when tracking is lost for part of the recording (12 Hz, 9 true blinks, 30 s)")
rng = random.Random(7)
bl = make_blinks(rng)
base = sample(rng, bl, 1/12)
for lost in (0.0, 0.3, 0.5):
    s = [dict(x) for x in base]
    cut_start, cut_end = 14.0, 14.0 + 30 * lost
    for x in s:
        if cut_start <= x["timeSeconds"] < cut_end:
            x.update(valid=False, faceDetected=False, leftEAR=None, rightEAR=None, avgEAR=None)
    m = calculate_blink_metrics(s)["measurements"]
    tracked = 30 * (1 - lost)
    print(f"  {int(lost*100):>2}% lost: reported {m['blinksPerMinute']:>5} /min  (blinks found {m['totalBlinks']}, tracked time {tracked:.0f}s -> rate over tracked time {m['totalBlinks']/tracked*60:.1f}/min)")
