import base64
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import gaze_service
import gaze_demo
import gaze_engine as gaze_engine_module
import mediapipe as mp
import numpy as np
from fastapi import HTTPException, WebSocketDisconnect
from gaze_engine import GazeEngine


class FakeProcess:
    pid = 12345

    def __init__(self):
        self.returncode: int | None = None

    def poll(self):
        return self.returncode


class FakeWebSocket:
    def __init__(self, messages, origin="http://localhost:3000"):
        self.messages = iter(messages)
        self.headers = {"origin": origin}
        self.responses = []
        self.closed = None

    async def accept(self):
        return None

    async def close(self, code, reason):
        self.closed = (code, reason)

    async def receive_json(self):
        try:
            return next(self.messages)
        except StopIteration:
            raise WebSocketDisconnect(code=1000)

    async def send_json(self, message):
        self.responses.append(message)


class GazeServiceAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_results_dir = gaze_service.ASSESSMENT_RESULTS_DIR
        self.old_process = gaze_service.process
        self.old_process_log = gaze_service.process_log
        self.old_sessions = gaze_service.assessment_sessions
        self.fake_process = FakeProcess()

        gaze_service.ASSESSMENT_RESULTS_DIR = Path(self.temp_dir.name)
        gaze_service.process = None
        gaze_service.process_log = None
        gaze_service.assessment_sessions = {}
        self.popen_patch = patch.object(
            gaze_service.subprocess,
            "Popen",
            return_value=self.fake_process,
        )
        self.fake_popen = self.popen_patch.start()

    def tearDown(self):
        self.popen_patch.stop()
        if gaze_service.process_log is not None:
            gaze_service.process_log.close()
        for session in gaze_service.assessment_sessions.values():
            if session["log"] is not None:
                session["log"].close()
        gaze_service.ASSESSMENT_RESULTS_DIR = self.old_results_dir
        gaze_service.process = self.old_process
        gaze_service.process_log = self.old_process_log
        gaze_service.assessment_sessions = self.old_sessions
        self.temp_dir.cleanup()

    def test_saccadic_analysis_endpoint_uses_existing_metric_calculator(self):
        samples = [{"timeSeconds": 0.1, "valid": False}]
        targets = [{"id": "trial-1", "appearedAtSeconds": 0.2}]
        expected = {"measurements": {"totalTrials": 1}}
        request = gaze_service.SaccadicAnalysisRequest(
            samples=samples,
            targets=targets,
            mmPerPx=0.25,
        )

        with patch.object(
            gaze_service,
            "calculate_saccadic_metrics",
            return_value=expected,
        ) as calculate:
            result = gaze_service.analyze_saccadic_assessment(request)

        self.assertEqual(result, expected)
        calculate.assert_called_once_with(samples, targets, 0.25)

    def test_smooth_pursuit_analysis_uses_existing_metric_calculator(self):
        samples = [{"timeSeconds": 0.1, "valid": True}]
        expected = {"measurements": {"totalSamples": 1}}
        request = gaze_service.SmoothPursuitAnalysisRequest(
            samples=samples,
            mmPerPx=0.25,
        )

        with patch.object(
            gaze_service,
            "calculate_smooth_pursuit_metrics",
            return_value=expected,
        ) as calculate:
            result = gaze_service.analyze_smooth_pursuit_assessment(request)

        self.assertEqual(result, expected)
        calculate.assert_called_once_with(samples, [], 0.25)

    def test_blink_analysis_endpoint_uses_existing_metric_calculator(self):
        samples = [
            {"timeSeconds": 0.0, "valid": True, "avgEAR": 0.3},
            {"timeSeconds": 0.1, "valid": True, "avgEAR": 0.3},
        ]
        expected = {"measurements": {"totalBlinks": 0}}
        request = gaze_service.BlinkAnalysisRequest(samples=samples)

        with patch.object(
            gaze_service,
            "calculate_blink_metrics",
            return_value=expected,
        ) as calculate:
            result = gaze_service.analyze_blink_monitoring(request)

        self.assertEqual(result, expected)
        calculate.assert_called_once_with(samples)

    def test_memory_analysis_endpoint_uses_existing_metric_calculator(self):
        samples = [{"timeSeconds": 0.1, "valid": True}]
        trials = [{"phase": "recognition", "isOld": True, "userResponse": "seen"}]
        expected = {"measurements": {"recognitionAccuracy": 100.0}}
        request = gaze_service.MemoryAnalysisRequest(
            samples=samples,
            trials=trials,
        )

        with patch.object(
            gaze_service,
            "calculate_memory_metrics",
            return_value=expected,
        ) as calculate:
            result = gaze_service.analyze_memory_tracking(request)

        self.assertEqual(result, expected)
        calculate.assert_called_once_with(samples, trials)

    def test_memory_metrics_keep_zero_accuracy_and_d_prime_values(self):
        result = gaze_service.calculate_memory_metrics(
            [],
            [{
                "phase": "recognition",
                "isOld": True,
                "userResponse": "not_seen",
                "responseTimeMs": 1000,
            }],
        )

        self.assertEqual(result["measurements"]["recognitionAccuracy"], 0.0)
        self.assertIsNotNone(result["measurements"]["dPrime"])
        self.assertEqual(result["sampleQuality"]["qualityNotes"], [])

    def test_assessment_session_blocks_legacy_recording_until_finished(self):
        started = gaze_service.start_assessment(
            gaze_service.AssessmentStartRequest()
        )
        session_id = started["sessionId"]

        status = gaze_service.assessment_status(session_id)
        self.assertTrue(status["running"])
        self.assertEqual(status["status"], "preparing")

        with self.assertRaises(HTTPException) as overlap:
            gaze_service.start_assessment(
                gaze_service.AssessmentStartRequest()
            )
        self.assertEqual(overlap.exception.status_code, 409)

        with self.assertRaises(HTTPException) as legacy_overlap:
            gaze_service.start_recording(
                gaze_service.RecordingRequest(
                    stimulus="test-image.jpg",
                    seconds=5,
                )
            )
        self.assertEqual(legacy_overlap.exception.status_code, 409)

        cancelled = gaze_service.cancel_assessment(session_id)
        self.assertTrue(cancelled["cancelRequested"])
        self.assertTrue(
            Path(gaze_service.assessment_sessions[session_id]["cancel_path"]).exists()
        )

        self.fake_process.returncode = 0
        ended = gaze_service.assessment_status(session_id)
        self.assertFalse(ended["running"])
        self.assertEqual(ended["status"], "failed")

    def test_rejects_unsupported_assessment_types(self):
        with self.assertRaises(HTTPException) as error:
            gaze_service.start_assessment(
                gaze_service.AssessmentStartRequest(
                    assessment_type="unsupported_type"
                )
            )
        self.assertEqual(error.exception.status_code, 400)

    def test_smooth_pursuit_legacy_start_does_not_launch_desktop_process(self):
        with self.assertRaises(HTTPException) as error:
            gaze_service.start_assessment(
                gaze_service.AssessmentStartRequest(
                    assessment_type="smooth_pursuit"
                )
            )

        self.assertEqual(error.exception.status_code, 410)
        self.fake_popen.assert_not_called()

    def test_blink_legacy_start_does_not_launch_desktop_process(self):
        with self.assertRaises(HTTPException) as error:
            gaze_service.start_assessment(
                gaze_service.AssessmentStartRequest(
                    assessment_type="blink_monitoring"
                )
            )

        self.assertEqual(error.exception.status_code, 410)
        self.fake_popen.assert_not_called()

    def test_memory_legacy_start_does_not_launch_desktop_process(self):
        with self.assertRaises(HTTPException) as error:
            gaze_service.start_assessment(
                gaze_service.AssessmentStartRequest(
                    assessment_type="memory_tracking"
                )
            )

        self.assertEqual(error.exception.status_code, 410)
        self.fake_popen.assert_not_called()

    def test_starts_saccadic_sessions_with_saccadic_capture_mode(self):
        started = gaze_service.start_assessment(
            gaze_service.AssessmentStartRequest(
                assessment_type="saccadic"
            )
        )

        command = self.fake_popen.call_args[0][0]
        self.assertIn("--assessment-type", command)
        self.assertEqual(
            command[command.index("--assessment-type") + 1],
            "saccadic",
        )
        with self.assertRaises(HTTPException) as legacy_overlap:
            gaze_service.start_recording(
                gaze_service.RecordingRequest(
                    stimulus="test-image.jpg",
                    seconds=5,
                )
            )
        self.assertEqual(legacy_overlap.exception.status_code, 409)

        status_path = Path(self.temp_dir.name) / (
            f"{started['sessionId']}.status.json"
        )
        self.assertEqual(
            json.loads(status_path.read_text())["targetCount"],
            12,
        )


class GazeServiceWebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_initializes_and_processes_browser_frames(self):
        frame_result = {
            "valid": True,
            "xFraction": 0.4,
            "yFraction": 0.6,
        }
        websocket = FakeWebSocket([
            {
                "type": "init",
                "requestId": "1",
                "widthPx": 1280,
                "heightPx": 720,
                "widthMm": 345,
            },
            {
                "type": "frame",
                "requestId": "2",
                "imageBase64": "data:image/jpeg;base64,ZmFrZQ==",
                "timestampMs": 123,
                "returnRaw": False,
                "includeEar": True,
            },
            {
                "type": "calibrate",
                "requestId": "3",
                "points": [],
            },
        ])
        with (
            patch.object(gaze_service.engine, "set_screen") as set_screen,
            patch.object(gaze_service.engine, "reset_calibration") as reset_calibration,
            patch.object(
                gaze_service.engine,
                "process_base64_frame",
                return_value=frame_result,
            ) as process_frame,
            patch.object(
                gaze_service.engine,
                "calibrate",
                return_value={
                    "success": True,
                    "calibrationPointCount": 9,
                    "mappingMethod": "affine",
                },
            ) as calibrate,
        ):
            await gaze_service.gaze_websocket(websocket)

        self.assertEqual(
            [message["type"] for message in websocket.responses],
            ["initialized", "frame", "calibration"],
        )
        self.assertEqual(websocket.responses[1]["xFraction"], 0.4)
        set_screen.assert_called_once_with(1280, 720, 345.0)
        reset_calibration.assert_called_once_with()
        process_frame.assert_called_once()
        self.assertTrue(process_frame.call_args.args[3])
        calibrate.assert_called_once_with([])


class GazeEngineCalibrationTests(unittest.TestCase):
    def test_browser_blink_frame_returns_measured_ear_without_gaze_models(self):
        class FakeDetector:
            last_full_landmarks = None
            hide_right_eye = False

            def __call__(self, frame, timestamp_ms):
                points = np.zeros((468, 2), dtype=float)
                eye_points = [
                    (10, 20), (12, 18), (14, 18), (18, 20), (14, 22), (12, 22),
                ]
                contour_points = [
                    (10, 20), (11, 19), (12, 18), (13, 18),
                    (15, 18), (17, 19), (18, 20), (17, 21),
                    (16, 22), (14, 22), (12, 22), (11, 21),
                    (10, 20), (18, 20), (17, 19), (11, 19),
                ]
                for ear_indices, contour_indices, offset in (
                    (
                        gaze_engine_module.LEFT_EYE_EAR_INDICES,
                        gaze_engine_module.LEFT_EYE_CONTOUR_INDICES,
                        0,
                    ),
                    (
                        gaze_engine_module.RIGHT_EYE_EAR_INDICES,
                        gaze_engine_module.RIGHT_EYE_CONTOUR_INDICES,
                        24,
                    ),
                ):
                    for index, point in zip(contour_indices, contour_points):
                        points[index] = (point[0] + offset, point[1])
                    for index, point in zip(ear_indices, eye_points):
                        points[index] = (point[0] + offset, point[1])
                    if offset and self.hide_right_eye:
                        for index in ear_indices + contour_indices:
                            points[index] = (64, 20)
                self.last_full_landmarks = points
                return np.zeros((6, 2), dtype=float)

        encoded_ok, encoded = cv2.imencode(
            ".jpg", np.zeros((64, 64, 3), dtype=np.uint8)
        )
        self.assertTrue(encoded_ok)
        gaze_engine = GazeEngine.__new__(GazeEngine)
        gaze_engine.screen = None
        fake_detector = FakeDetector()
        gaze_engine.detect = fake_detector

        result = gaze_engine.process_base64_frame(
            base64.b64encode(encoded.tobytes()).decode("ascii"),
            100,
            include_ear=True,
        )

        self.assertTrue(result["valid"])
        self.assertTrue(result["faceDetected"])
        self.assertTrue(result["leftEyeVisible"])
        self.assertTrue(result["rightEyeVisible"])
        self.assertAlmostEqual(result["leftEAR"], 0.5)
        self.assertAlmostEqual(result["rightEAR"], 0.5)
        self.assertAlmostEqual(result["avgEAR"], 0.5)
        self.assertEqual(len(result["leftEyeLandmarks"]), 16)
        self.assertEqual(result["leftEyeLandmarks"][13], [12 / 64, 18 / 64])
        self.assertEqual(len(result["rightEyeLandmarks"]), 16)

        fake_detector.hide_right_eye = True
        one_eye_result = gaze_engine.process_base64_frame(
            base64.b64encode(encoded.tobytes()).decode("ascii"),
            101,
            include_ear=True,
        )
        self.assertFalse(one_eye_result["valid"])
        self.assertTrue(one_eye_result["leftEyeVisible"])
        self.assertFalse(one_eye_result["rightEyeVisible"])
        self.assertIsNone(one_eye_result["avgEAR"])
        self.assertIsNone(one_eye_result["rightEAR"])

    def test_calibration_keeps_frame_groups_and_matching_targets(self):
        gaze_engine = GazeEngine.__new__(GazeEngine)
        gaze_engine.screen = type(
            "ScreenStub",
            (),
            {
                "width_px": 1280,
                "height_px": 720,
                "to_camera": lambda self, x, y: np.array([x, y, 0.0]),
            },
        )()
        gaze_engine.offsets = None
        gaze_engine.mapping = None

        targets = [
            (0.06, 0.06), (0.5, 0.06), (0.94, 0.06),
            (0.06, 0.5), (0.5, 0.5), (0.94, 0.5), (0.06, 0.94),
        ]
        points = []
        for target_x, target_y in targets:
            frame_features = []
            for _ in range(3):
                frame_features.append([
                    {
                        "name": name,
                        "raw": [0.0, 0.0],
                        "center": [0.0, 0.0, 500.0],
                        "R": np.eye(3).tolist(),
                    }
                    for name in ("right", "left")
                ])
            points.append({
                "targetX": target_x,
                "targetY": target_y,
                "features": frame_features,
            })

        estimate_count = 0

        def estimate_dot(frame_groups, offsets, mapping, screen):
            nonlocal estimate_count
            self.assertEqual(len(frame_groups), 3)
            self.assertEqual(len(frame_groups[0]), 2)
            estimate_count += 1
            if estimate_count == 7:
                return None, None
            return np.array([estimate_count / 10, estimate_count / 10]), 500.0

        with (
            patch("gaze_engine.fit_offsets", return_value={}) as fit_offsets,
            patch(
                "gaze_engine.calibration_target_angles",
                return_value=np.zeros(2),
            ),
            patch(
                "gaze_engine.fit_mapping",
                return_value={"method": "affine"},
            ) as fit_mapping,
            patch("gaze_demo.dot_estimate", side_effect=estimate_dot),
        ):
            result = gaze_engine.calibrate(points)

        self.assertTrue(result["success"])
        self.assertEqual(result["calibrationPointCount"], 6)
        self.assertEqual(len(fit_offsets.call_args.args[0]), 42)
        mapped_targets = fit_mapping.call_args.args[1]
        np.testing.assert_allclose(mapped_targets, targets[:6])


class FaceLandmarkerAdapterTests(unittest.TestCase):
    def test_builds_public_mediapipe_image_and_tracks_monotonic_time(self):
        class FakeLandmarker:
            def __init__(self):
                self.image = None
                self.timestamp_ms = None

            def detect_for_video(self, image, timestamp_ms):
                self.image = image
                self.timestamp_ms = timestamp_ms
                landmarks = [
                    SimpleNamespace(x=index / 400, y=index / 800)
                    for index in range(400)
                ]
                return SimpleNamespace(face_landmarks=[landmarks])

        detector = gaze_demo.FaceLandmarker()
        detector._landmarker = FakeLandmarker()
        frame = np.zeros((20, 40, 3), dtype=np.uint8)

        first = detector(frame, 100)
        second = detector(frame, 50)

        self.assertIsInstance(detector._landmarker.image, mp.Image)
        self.assertEqual(detector._landmarker.image.image_format, mp.ImageFormat.SRGB)
        self.assertEqual(first.shape, (6, 2))
        self.assertEqual(second.shape, (6, 2))
        self.assertEqual(detector._landmarker.timestamp_ms, 101)
        self.assertEqual(detector.last_full_landmarks.shape, (400, 2))


if __name__ == "__main__":
    unittest.main()