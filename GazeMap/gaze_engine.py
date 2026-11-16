# GazeMap/gaze_engine.py
import base64
import cv2
import math
import numpy as np
import time

from blink_monitoring import (
    LEFT_EYE_CONTOUR_INDICES,
    LEFT_EYE_EAR_INDICES,
    RIGHT_EYE_CONTOUR_INDICES,
    RIGHT_EYE_EAR_INDICES,
    ear,
    eye_landmarks_are_visible as blink_eye_landmarks_are_visible,
)

# Import the logic directly from your existing gaze_demo.py
# (This works safely because gaze_demo.py uses `if __name__ == "__main__":`)
from gaze_demo import (
    load_gaze_models,
    load_face_model,
    make_landmarker,
    default_camera_matrix,
    process_frame,
    gaze_on_screen,
    Screen,
    fit_offsets,
    fit_mapping,
    apply_mapping,
    calibration_target_angles
)

class GazeEngine:
    def __init__(self, model_dir="results/final/models"):
        print("Initializing GazeEngine (loading models)...")
        self.models = load_gaze_models(model_dir)
        self.face_model = load_face_model()
        self.detect = make_landmarker()

        # Calibration storage (per session)
        self.offsets = None
        self.mapping = None
        self.screen = None
        print("GazeEngine ready.")

    def set_screen(self, width_px, height_px, width_mm=345.0, camera_offset_mm=5.0):
        """Must be called by the browser before processing frames."""
        self.screen = Screen(width_px, height_px, width_mm, camera_offset_mm)

    def reset_calibration(self):
        self.offsets = None
        self.mapping = None

    def process_base64_frame(
        self, b64_string, timestamp_ms, return_raw=False, include_ear=False
    ):
        """Receives a base64 image from the browser, returns gaze coordinates."""
        if self.screen is None and not include_ear:
            return {"valid": False, "error": "Screen not initialized. Call /init_screen first."}

        # 1. Decode Base64 to OpenCV image
        try:
            if "," in b64_string:
                b64_string = b64_string.split(",")[1]
            img_data = base64.b64decode(b64_string)
            nparr = np.frombuffer(img_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        except Exception as e:
            return {"valid": False, "error": "Invalid image data"}

        if frame is None:
            return {"valid": False, "error": "Failed to decode image"}

        h, w = frame.shape[:2]
        camera_matrix = default_camera_matrix(w, h)

        if include_ear:
            try:
                self.detect(frame, timestamp_ms)
            except Exception as e:
                return {"valid": False, "error": f"Processing error: {str(e)}"}

            full_landmarks = getattr(self.detect, "last_full_landmarks", None)
            if full_landmarks is None:
                return {
                    "valid": False,
                    "faceDetected": False,
                    "leftEyeVisible": False,
                    "rightEyeVisible": False,
                    "leftEAR": None,
                    "rightEAR": None,
                    "avgEAR": None,
                    "leftEyeLandmarks": None,
                    "rightEyeLandmarks": None,
                    "reason": "face_not_detected",
                }

            required_indices = (
                LEFT_EYE_EAR_INDICES
                + RIGHT_EYE_EAR_INDICES
                + LEFT_EYE_CONTOUR_INDICES
                + RIGHT_EYE_CONTOUR_INDICES
            )
            if len(full_landmarks) <= max(required_indices):
                return {
                    "valid": False,
                    "faceDetected": True,
                    "leftEyeVisible": False,
                    "rightEyeVisible": False,
                    "leftEAR": None,
                    "rightEAR": None,
                    "avgEAR": None,
                    "leftEyeLandmarks": None,
                    "rightEyeLandmarks": None,
                    "reason": "eyes_not_reliably_visible",
                }

            left_ear = ear([full_landmarks[i] for i in LEFT_EYE_EAR_INDICES])
            right_ear = ear([full_landmarks[i] for i in RIGHT_EYE_EAR_INDICES])
            left_contour = [full_landmarks[i] for i in LEFT_EYE_CONTOUR_INDICES]
            right_contour = [full_landmarks[i] for i in RIGHT_EYE_CONTOUR_INDICES]
            left_eye_visible = (
                left_ear is not None
                and blink_eye_landmarks_are_visible(
                    [full_landmarks[i] for i in LEFT_EYE_EAR_INDICES],
                    left_contour,
                    w,
                    h,
                )
            )
            right_eye_visible = (
                right_ear is not None
                and blink_eye_landmarks_are_visible(
                    [full_landmarks[i] for i in RIGHT_EYE_EAR_INDICES],
                    right_contour,
                    w,
                    h,
                )
            )
            both_eyes_visible = left_eye_visible and right_eye_visible
            left_eye_landmarks = (
                [[float(point[0] / w), float(point[1] / h)] for point in left_contour]
                if left_eye_visible and left_ear is not None else None
            )
            right_eye_landmarks = (
                [[float(point[0] / w), float(point[1] / h)] for point in right_contour]
                if right_eye_visible and right_ear is not None else None
            )
            return {
                "valid": both_eyes_visible,
                "faceDetected": True,
                "leftEyeVisible": left_eye_visible,
                "rightEyeVisible": right_eye_visible,
                "leftEAR": float(left_ear)
                if left_eye_visible and left_ear is not None else None,
                "rightEAR": float(right_ear)
                if right_eye_visible and right_ear is not None else None,
                "avgEAR": (left_ear + right_ear) / 2
                if both_eyes_visible and left_ear is not None and right_ear is not None
                else None,
                "leftEyeLandmarks": left_eye_landmarks,
                "rightEyeLandmarks": right_eye_landmarks,
                "reason": None if both_eyes_visible else "eyes_not_reliably_visible",
            }

        # 2. Run MediaPipe and GazeNet
        try:
            out = process_frame(
                frame, self.detect, timestamp_ms, self.face_model,
                camera_matrix, self.models, offsets=self.offsets
            )
        except Exception as e:
            return {"valid": False, "error": f"Processing error: {str(e)}"}

        if out is None:
            return {"valid": False, "reason": "face_not_detected"}

        # 3a. Calibration mode — return raw geometry, no screen projection
        if return_raw:
            features = []
            for r in out[0]:
                features.append({
                    "name": r["name"],
                    "raw": r["raw"].tolist(),
                    "center": r["center"].tolist(),
                    "R": r["R"].tolist()
                })
            return {"valid": True, "features": features}

        # 3b. Normal mode — project to screen
        position, distance_mm = gaze_on_screen(
            out[0], self.offsets, self.mapping, self.screen
        )

        if position is None:
            return {"valid": False, "reason": "gaze_outside_screen"}

        # 4. Return normalized coordinates (0.0 to 1.0)
        return {
            "valid": True,
            "xFraction": float(position[0]),
            "yFraction": float(position[1]),
            "distanceMm": float(distance_mm) if distance_mm else None
        }

    def calibrate(self, calibration_points):
        """
        Takes per-frame eye features collected at each browser calibration target.
        """
        if self.screen is None:
            return {"success": False, "message": "Screen not initialized"}
        if not isinstance(calibration_points, list) or len(calibration_points) < 6:
            return {
                "success": False,
                "message": "At least six calibration targets are required."
            }

        samples = []
        dots = []

        for i, point in enumerate(calibration_points):
            if not isinstance(point, dict):
                return {"success": False, "message": "Invalid calibration target."}
            target_x = point.get("targetX")
            target_y = point.get("targetY")
            features = point.get("features")
            if (
                not isinstance(target_x, (int, float))
                or not isinstance(target_y, (int, float))
                or not 0 <= target_x <= 1
                or not 0 <= target_y <= 1
                or not isinstance(features, list)
                or not features
            ):
                return {"success": False, "message": "Invalid calibration target data."}

            feature_batches = features
            if feature_batches and isinstance(feature_batches[0], dict):
                feature_batches = [feature_batches]

            frames_results = []
            for batch in feature_batches:
                if not isinstance(batch, list):
                    continue
                frame_results = []
                for eye_data in batch:
                    if not isinstance(eye_data, dict):
                        continue
                    try:
                        raw = np.asarray(eye_data["raw"], dtype=float)
                        center = np.asarray(eye_data["center"], dtype=float)
                        rotation = np.asarray(eye_data["R"], dtype=float)
                        name = eye_data["name"]
                    except (KeyError, TypeError, ValueError):
                        continue
                    if (
                        name not in ("right", "left")
                        or raw.shape != (2,)
                        or center.shape != (3,)
                        or rotation.shape != (3, 3)
                        or not np.isfinite(raw).all()
                        or not np.isfinite(center).all()
                        or not np.isfinite(rotation).all()
                    ):
                        continue
                    frame_results.append({
                        "name": name,
                        "raw": raw,
                        "center": center,
                        "R": rotation,
                    })
                if frame_results:
                    frames_results.append(frame_results)

            if frames_results:
                dots.append((float(target_x), float(target_y), frames_results))
                for frame_results in frames_results:
                    for result in frame_results:
                        target = self.screen.to_camera(
                            target_x * self.screen.width_px,
                            target_y * self.screen.height_px
                        )
                        samples.append((
                            i,
                            result["name"],
                            result["raw"],
                            calibration_target_angles(result, target)
                        ))

        # 1. Fit the per-eye offsets
        try:
            self.offsets = fit_offsets(samples)
        except Exception as e:
            return {"success": False, "message": f"Offset calibration failed: {str(e)}"}

        # 2. Fit the affine screen mapping
        try:
            from gaze_demo import dot_estimate  # Import locally to avoid circular issues

            estimates = []
            targets = []
            for fx, fy, frames_results in dots:
                # Get the median position for this dot using the new offsets
                est, _ = dot_estimate(frames_results, self.offsets, None, self.screen)
                if est is not None:
                    estimates.append(est)
                    targets.append([fx, fy])

            if len(estimates) >= 6:
                self.mapping = fit_mapping(np.array(estimates), np.array(targets), "affine")
            else:
                return {
                    "success": False,
                    "message": "At least six calibration targets need valid gaze samples."
                }
        except Exception as e:
            return {"success": False, "message": f"Mapping calibration failed: {str(e)}"}

        return {
            "success": True,
            "message": "Calibration complete with affine mapping.",
            "calibrationPointCount": len(estimates),
            "mappingMethod": self.mapping["method"],
        }


# Singleton instance
engine = GazeEngine()