import unittest

from attention_assessment import calculate_attention_metrics


class AttentionAssessmentMetricsTests(unittest.TestCase):
    def test_detects_fixation_and_target_consistency_from_stable_samples(self):
        samples = []
        targets = []

        for target_index, target_x in enumerate((20, 180)):
            onset = target_index * 1.5
            targets.append({
                "id": f"target-{target_index}",
                "xPx": target_x,
                "yPx": 50,
                "appearedAtSeconds": onset,
                "disappearedAtSeconds": onset + 1.0,
            })
            for frame in range(31):
                timestamp = onset + frame / 30
                gaze_x = 20 if target_index == 0 else 20
                samples.append({
                    "timeSeconds": timestamp,
                    "xPx": gaze_x,
                    "yPx": 50,
                    "valid": True,
                    "distanceMm": 600,
                })

        result = calculate_attention_metrics(samples, targets, 200, 100, 1.0)

        self.assertTrue(result["sampleQuality"]["fixationAnalysisSupported"])
        self.assertEqual(result["measurements"]["fixationCount"], 2)
        self.assertEqual(
            result["measurements"]["targetFixationConsistencyPct"], 50.0
        )
        self.assertIsNotNone(
            result["measurements"]["averageFixationDurationMs"]
        )

    def test_returns_null_fixation_metrics_when_sample_rate_is_too_low(self):
        samples = [
            {
                "timeSeconds": index / 8,
                "xPx": 20,
                "yPx": 50,
                "valid": True,
                "distanceMm": 600,
            }
            for index in range(16)
        ]
        targets = [{
            "id": "target-0",
            "xPx": 20,
            "yPx": 50,
            "appearedAtSeconds": 0,
            "disappearedAtSeconds": 1.8,
        }]

        result = calculate_attention_metrics(samples, targets, 200, 100, 1.0)

        self.assertFalse(result["sampleQuality"]["fixationAnalysisSupported"])
        self.assertIsNone(result["measurements"]["fixationCount"])
        self.assertIsNone(
            result["measurements"]["averageFixationDurationMs"]
        )
        self.assertIn(
            "at least 15 Hz",
            result["metricExplanations"]["fixationAnalysis"],
        )

    def test_counts_invalid_samples_without_replacing_them_with_zero(self):
        samples = [
            {
                "timeSeconds": index / 30,
                "xPx": None,
                "yPx": None,
                "valid": False,
                "distanceMm": None,
                "reason": "face_not_detected",
            }
            for index in range(10)
        ]

        result = calculate_attention_metrics(samples, [], 200, 100, 1.0)

        self.assertEqual(result["measurements"]["validGazeSamples"], 0)
        self.assertEqual(result["measurements"]["invalidGazeSamples"], 10)
        self.assertEqual(
            result["measurements"]["missingSamplePercentage"], 100.0
        )
        self.assertIsNone(
            result["measurements"]["averageGazeToTargetDistancePx"]
        )


if __name__ == "__main__":
    unittest.main()
