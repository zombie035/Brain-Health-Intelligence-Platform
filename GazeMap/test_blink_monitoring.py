import unittest

from blink_monitoring import (
    calculate_blink_metrics,
    detect_blink_events,
    ear,
    eye_landmarks_are_visible,
)


class EarTests(unittest.TestCase):
    def test_closed_eye_returns_low_ear(self):
        # Points collapsed vertically -> low EAR
        pts = [(0, 0), (1, 0.1), (2, 0.1), (3, 0), (2, -0.1), (1, -0.1)]
        value = ear(pts)
        if value is None:
            self.fail("EAR should be defined for valid eye points")
        self.assertLess(value, 0.2)

    def test_open_eye_returns_higher_ear(self):
        pts = [(0, 0), (1, 1.5), (2, 1.5), (3, 0), (2, -1.5), (1, -1.5)]
        value = ear(pts)
        if value is None:
            self.fail("EAR should be defined for valid eye points")
        self.assertGreater(value, 0.3)

    def test_invalid_eye_coordinates_do_not_produce_ear(self):
        self.assertIsNone(ear([(0, 0), (1, float("nan")), (2, 1), (3, 0), (2, -1), (1, -1)]))
        self.assertIsNone(ear([(0, 0), (1, 4), (2, 4), (3, 0), (2, -4), (1, -4)]))

    def test_eye_visibility_rejects_points_outside_frame_or_too_small(self):
        ear_points = [(20, 20), (22, 18), (24, 18), (28, 20), (24, 22), (22, 22)]
        contour_points = [(x, y) for x, y in ear_points] + [
            (21, 19), (23, 18), (25, 18), (27, 19), (27, 21), (25, 22),
            (23, 22), (21, 21), (20, 20), (28, 20),
        ]
        self.assertTrue(eye_landmarks_are_visible(ear_points, contour_points, 640, 480))
        outside = [(640, y) if index == 0 else (x, y)
                   for index, (x, y) in enumerate(contour_points)]
        self.assertFalse(eye_landmarks_are_visible(ear_points, outside, 640, 480))
        small_ear = [(x / 10, y / 10) for x, y in ear_points]
        small_contour = [(x / 10, y / 10) for x, y in contour_points]
        self.assertFalse(eye_landmarks_are_visible(
            small_ear, small_contour, 640, 480
        ))


class BlinkDetectionTests(unittest.TestCase):
    def _make_samples(self, seq):
        # seq is a list of tuples: (ear_value, num_frames)
        samples = []
        t = 0.0
        for val, n in seq:
            for _ in range(n):
                samples.append({
                    "timeSeconds": round(t, 3),
                    "leftEAR": val,
                    "rightEAR": val,
                    "faceDetected": True,
                    "valid": True,
                })
                t += 1 / 30
        return samples

    def test_detects_single_blink(self):
        # 20 open frames, 8 closed frames (~266 ms), 20 open frames
        samples = self._make_samples([(0.35, 20), (0.10, 8), (0.35, 20)])
        blinks, closures = detect_blink_events(samples, threshold=0.2)
        self.assertEqual(len(blinks), 1)
        self.assertEqual(blinks[0]["category"], "blink")
        self.assertGreater(blinks[0]["durationMs"], 200)
        self.assertLess(blinks[0]["durationMs"], 500)

    def test_detects_prolonged_closure(self):
        # Closed for 90 frames (~3 seconds) -> prolonged
        samples = self._make_samples([(0.35, 10), (0.10, 90), (0.35, 10)])
        _, closures = detect_blink_events(samples, threshold=0.2)
        self.assertTrue(any(c["category"] == "prolonged_closure" for c in closures))

    def test_ignores_noise_spike(self):
        # 1 frame closed -> too short, no event
        samples = self._make_samples([(0.35, 10), (0.10, 1), (0.35, 10)])
        blinks, closures = detect_blink_events(samples, threshold=0.2)
        self.assertEqual(len(blinks), 0)
        self.assertEqual(len(closures), 0)

    def test_does_not_double_count_rapid_blinks(self):
        samples = self._make_samples([
            (0.35, 10), (0.10, 6), (0.35, 6),
            (0.10, 6), (0.35, 6),
            (0.10, 6), (0.35, 10),
        ])
        blinks, _ = detect_blink_events(samples, threshold=0.2)
        self.assertEqual(len(blinks), 3)


class MetricAggregationTests(unittest.TestCase):
    def test_returns_null_metrics_when_empty(self):
        result = calculate_blink_metrics([])
        self.assertEqual(result["measurements"], {})
        self.assertTrue(result["sampleQuality"]["qualityNotes"])

    def test_returns_counts_for_synthetic_baseline(self):
        samples = []
        t = 0.0
        for _ in range(30):
            samples.append({"timeSeconds": t, "leftEAR": 0.35, "rightEAR": 0.35,
                            "faceDetected": True, "valid": True})
            t += 1 / 30
        for _ in range(8):
            samples.append({"timeSeconds": t, "leftEAR": 0.10, "rightEAR": 0.10,
                            "faceDetected": True, "valid": True})
            t += 1 / 30
        for _ in range(30):
            samples.append({"timeSeconds": t, "leftEAR": 0.35, "rightEAR": 0.35,
                            "faceDetected": True, "valid": True})
            t += 1 / 30

        result = calculate_blink_metrics(samples)
        self.assertEqual(result["measurements"]["totalBlinks"], 1)
        # ~2 s of data is too short for a meaningful rate, so none is reported
        self.assertIsNone(result["measurements"]["blinksPerMinute"])
        self.assertIsNotNone(result["sampleQuality"]["baselineEAR"])


def _trace(duration, hz, closed_spans=(), lost_spans=()):
    """Synthetic recording: open EAR 0.30, closed 0.10, optional lost-tracking spans."""
    samples, t = [], 0.0
    while t < duration:
        lost = any(a <= t < b for a, b in lost_spans)
        closed = any(a <= t < b for a, b in closed_spans)
        ear_value = None if lost else (0.10 if closed else 0.30)
        samples.append({"timeSeconds": t, "leftEAR": ear_value, "rightEAR": ear_value,
                        "avgEAR": ear_value, "faceDetected": not lost, "valid": not lost})
        t += 1.0 / hz
    return samples


class TrackingLossAndRateTests(unittest.TestCase):
    def test_closure_is_not_stretched_across_lost_tracking(self):
        # eyes close at 10.0 s, tracking lost 10.1-13.0 s, eyes open when found again
        samples = _trace(30, 15, closed_spans=[(10.0, 10.1)], lost_spans=[(10.1, 13.0)])
        result = calculate_blink_metrics(samples)
        self.assertEqual(result["measurements"]["prolongedClosureCount"], 0)
        self.assertEqual(result["measurements"]["totalBlinks"], 0)
        for event in result["closureEvents"]:
            self.assertLess(event["durationMs"], 500)
        self.assertTrue(any("tracking was lost" in n.lower()
                            for n in result["sampleQuality"]["qualityNotes"]))

    def test_blink_rate_uses_tracked_time_not_wall_clock(self):
        spans = [(6, 6.2), (9, 9.2), (12, 12.2), (20, 20.2)]
        full = calculate_blink_metrics(_trace(30, 30, closed_spans=spans))
        lossy = calculate_blink_metrics(
            _trace(30, 30, closed_spans=spans, lost_spans=[(14, 18)])
        )
        self.assertEqual(full["measurements"]["totalBlinks"], 4)
        self.assertAlmostEqual(full["measurements"]["blinksPerMinute"], 8.0, delta=0.5)
        # 4 s of 30 s lost: still 4 blinks, rate over ~26 s tracked, not 30 s
        self.assertEqual(lossy["measurements"]["totalBlinks"], 4)
        self.assertGreater(lossy["measurements"]["blinksPerMinute"],
                           full["measurements"]["blinksPerMinute"])
        self.assertAlmostEqual(lossy["measurements"]["trackedSeconds"], 26.0, delta=0.6)

    def test_sample_rate_reported_and_low_rate_warns(self):
        result = calculate_blink_metrics(_trace(30, 12))
        self.assertAlmostEqual(result["measurements"]["sampleRateHz"], 12.0, delta=0.5)
        self.assertTrue(any("underestimated" in n
                            for n in result["sampleQuality"]["qualityNotes"]))
        fast = calculate_blink_metrics(_trace(30, 30))
        self.assertFalse(any("underestimated" in n
                             for n in fast["sampleQuality"]["qualityNotes"]))

    def test_short_tracking_does_not_report_rate(self):
        result = calculate_blink_metrics(_trace(6, 30, closed_spans=[(3, 3.2)]))
        self.assertIsNone(result["measurements"]["blinksPerMinute"])


if __name__ == "__main__":
    unittest.main()