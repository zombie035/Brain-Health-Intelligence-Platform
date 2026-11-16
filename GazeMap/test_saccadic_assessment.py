import unittest

from saccadic_assessment import (
    TRIAL_COUNT,
    calculate_saccadic_metrics,
    create_saccadic_targets,
)


class SaccadicAssessmentMetricTests(unittest.TestCase):
    def test_creates_twelve_balanced_horizontal_trials_deterministically(self):
        targets = create_saccadic_targets("test-session", 1920, 1080)

        self.assertEqual(len(targets), TRIAL_COUNT)
        self.assertEqual(
            [target["side"] for target in targets].count("left"),
            TRIAL_COUNT // 2,
        )
        self.assertEqual(
            [target["side"] for target in targets].count("right"),
            TRIAL_COUNT // 2,
        )
        self.assertEqual(
            targets,
            create_saccadic_targets("test-session", 1920, 1080),
        )
        self.assertTrue(all(target["yPx"] == 540 for target in targets))
        self.assertTrue(all(
            target["xPx"] == (384 if target["side"] == "left" else 1536)
            for target in targets
        ))

    def _stable_target_samples(self, targets, gaze_at_target=True):
        samples = []
        for target in targets:
            onset = target["appearedAtSeconds"]
            offset = target["disappearedAtSeconds"]
            frame_count = int((offset - onset) * 30)
            for frame in range(frame_count + 1):
                timestamp = onset + frame / 30
                acquired = timestamp >= onset + 0.2
                if gaze_at_target and acquired:
                    x_px = target["xPx"]
                else:
                    x_px = 960
                samples.append({
                    "timeSeconds": timestamp,
                    "xPx": x_px,
                    "yPx": target["yPx"],
                    "valid": True,
                    "distanceMm": 600,
                })
        return samples

    def test_reports_latency_endpoint_error_and_acquisition_from_stable_trials(self):
        targets = [
            {
                "id": "trial-1",
                "side": "left",
                "xPx": 200,
                "yPx": 50,
                "appearedAtSeconds": 0,
                "disappearedAtSeconds": 1,
            },
            {
                "id": "trial-2",
                "side": "right",
                "xPx": 1720,
                "yPx": 50,
                "appearedAtSeconds": 1.5,
                "disappearedAtSeconds": 2.5,
            },
        ]
        samples = self._stable_target_samples(targets)

        result = calculate_saccadic_metrics(
            samples, targets, 345 / 1920
        )

        self.assertTrue(result["sampleQuality"]["latencyAnalysisSupported"])
        self.assertEqual(
            result["measurements"]["targetAcquisitionRatePct"], 100.0
        )
        self.assertAlmostEqual(
            result["measurements"]["meanResponseLatencyMs"], 200.0
        )
        self.assertEqual(result["measurements"]["meanEndpointErrorPx"], 0.0)
        self.assertTrue(all(
            target["acquired"] and target["responseLatencyMs"] is not None
            for target in result["targetMeasurements"]
        ))

    def test_reports_zero_acquisition_without_fabricating_latency(self):
        targets = [{
            "id": "trial-1",
            "side": "left",
            "xPx": 200,
            "yPx": 50,
            "appearedAtSeconds": 0,
            "disappearedAtSeconds": 1,
        }]
        samples = self._stable_target_samples(targets, gaze_at_target=False)

        result = calculate_saccadic_metrics(
            samples, targets, 345 / 1920
        )

        self.assertEqual(
            result["measurements"]["targetAcquisitionRatePct"], 0.0
        )
        self.assertIsNone(result["measurements"]["meanResponseLatencyMs"])
        self.assertFalse(result["targetMeasurements"][0]["acquired"])
        self.assertIsNone(
            result["targetMeasurements"][0]["responseLatencyMs"]
        )

    def test_withholds_mean_latency_when_too_few_trials_are_acquired(self):
        targets = [
            {
                "id": "trial-1",
                "side": "left",
                "xPx": 200,
                "yPx": 50,
                "appearedAtSeconds": 0,
                "disappearedAtSeconds": 1,
            },
            {
                "id": "trial-2",
                "side": "right",
                "xPx": 1720,
                "yPx": 50,
                "appearedAtSeconds": 1.5,
                "disappearedAtSeconds": 2.5,
            },
        ]
        samples = (
            self._stable_target_samples(targets[:1])
            + self._stable_target_samples(targets[1:], gaze_at_target=False)
        )

        result = calculate_saccadic_metrics(
            samples, targets, 345 / 1920
        )

        self.assertEqual(
            result["measurements"]["targetAcquisitionRatePct"], 50.0
        )
        self.assertIsNone(result["measurements"]["meanResponseLatencyMs"])
        self.assertIn(
            "at least 70%",
            " ".join(result["sampleQuality"]["qualityNotes"]),
        )

    def test_returns_null_metrics_when_sample_quality_is_insufficient(self):
        targets = [{
            "id": "trial-1",
            "side": "left",
            "xPx": 200,
            "yPx": 50,
            "appearedAtSeconds": 0,
            "disappearedAtSeconds": 1,
        }]
        samples = [
            {
                "timeSeconds": index / 7,
                "xPx": 20,
                "yPx": 50,
                "valid": True,
                "distanceMm": 600,
            }
            for index in range(30)
        ]

        result = calculate_saccadic_metrics(
            samples, targets, 345 / 1920
        )

        self.assertFalse(result["sampleQuality"]["latencyAnalysisSupported"])
        self.assertIsNone(
            result["measurements"]["targetAcquisitionRatePct"]
        )
        self.assertIsNone(result["measurements"]["meanEndpointErrorPx"])
        self.assertIn(
            "at least 8 Hz",
            " ".join(result["sampleQuality"]["qualityNotes"]),
        )


if __name__ == "__main__":
    unittest.main()
