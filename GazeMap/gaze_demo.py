"""GazeMap live demo: webcam -> face landmarks -> normalized eye images -> CNN -> gaze arrows."""
import argparse
import bisect
import datetime
import json
import random as _random
from collections import deque
from collections.abc import MutableMapping
import time
import urllib.request
import zipfile
from pathlib import Path

import cv2
import numpy as np
import torch
from scipy.io import loadmat

from gaze_model import GazeNet, pose_to_angles

FACE_MODEL_PATH = Path("dataset/6 points-based face model.mat")
LANDMARKER_PATH = Path("face_landmarker.task")
LANDMARKER_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
                  "face_landmarker/float16/1/face_landmarker.task")
CALIBRATION_PATH = Path("calibration.json")
MODELS_URL = "https://github.com/fammad/GazeMap/releases/latest/download/gazemap_models.zip"
HEATMAP_DIR = Path("heatmaps")
HEAT_SCALE = 8
TRAIL_SECONDS = 1.0
VIDEO_OUT_WIDTH = 1280
PANEL_ASPECT = 2 / 3
PANEL_ZOOM = 0.9
PANEL_FACE_UP = 0.18

MEDIAPIPE_IDS = [33, 133, 362, 263, 61, 291]

FOCAL_NORM = 960.0
DISTANCE_NORM = 600.0
EYE_SIZE = (60, 36)

CALIBRATION_DOTS = ([(x, y) for y in (0.06, 0.5, 0.94) for x in (0.06, 0.5, 0.94)]
                    + [(0.28, 0.28), (0.72, 0.28), (0.28, 0.72), (0.72, 0.72)])
VALIDATION_DOTS = [(0.25, 0.15), (0.75, 0.15), (0.5, 0.5), (0.25, 0.85), (0.75, 0.85)]
MAPPING_RIDGE = 0.001
TEST_DOTS = [((c + 0.5) / 4, (r + 0.5) / 4) for r in range(4) for c in range(4)]
DRIFT_MM = 50.0
DRIFT_DEG = 12.0
DRIFT_WINDOW = 15
SELECT_MARGIN_DEG = 0.2
SETTLE_SECONDS = 1.0
COLLECT_SECONDS = 1.5


def download_models(model_dir):
    print(f"No trained models in {model_dir}. Downloading them once from\n  {MODELS_URL}")
    model_dir.mkdir(parents=True, exist_ok=True)
    archive = model_dir / "gazemap_models.zip"
    try:
        urllib.request.urlretrieve(MODELS_URL, archive)
        with zipfile.ZipFile(archive) as zf:
            for name in zf.namelist():
                if Path(name).name.startswith("lopo_p") and name.endswith(".pt"):
                    (model_dir / Path(name).name).write_bytes(zf.read(name))
    except Exception as error:
        print(f"Download failed ({error}). Get gazemap_models.zip from the repository's Releases "
              f"page and unzip it into {model_dir}, or train your own with train_lopo.py.")
    finally:
        archive.unlink(missing_ok=True)


def load_gaze_models(model_dir):
    model_dir = Path(model_dir)
    with open(model_dir.parent / "config.json") as file:
        config = json.load(file)

    paths = sorted(model_dir.glob("lopo_p*.pt"))
    if not paths:
        download_models(model_dir)
        paths = sorted(model_dir.glob("lopo_p*.pt"))
    if not paths:
        raise FileNotFoundError(f"No lopo_p*.pt files in {model_dir}")

    models = []
    for path in paths:
        model = GazeNet(config["conv1"], config["conv2"], config["hidden"], config["head_pose"])
        model.load_state_dict(torch.load(path, map_location="cpu"))
        model.eval()
        models.append(model)

    print(f"Loaded {len(models)} models from {model_dir} "
          f"(network {config['conv1']}/{config['conv2']}/{config['hidden']}, head pose: {config['head_pose']})")
    return models


def predict(models, eye_images, head_angles):
    x = torch.from_numpy(eye_images).float().div(255.0).unsqueeze(1)
    h = torch.from_numpy(head_angles.astype(np.float32))
    with torch.no_grad():
        outputs = torch.stack([m(x, h) for m in models])
    return outputs.mean(dim=0).numpy()


def load_face_model():
    return loadmat(str(FACE_MODEL_PATH))["model"].astype(np.float64)


def estimate_head_pose(points_2d, face_model, camera_matrix):
    object_points = face_model.T.reshape(-1, 1, 3)
    image_points = points_2d.reshape(-1, 1, 2).astype(np.float64)
    ok, rvec, tvec = cv2.solvePnP(object_points, image_points, camera_matrix, None,
                                  flags=cv2.SOLVEPNP_EPNP)
    ok, rvec, tvec = cv2.solvePnP(object_points, image_points, camera_matrix, None,
                                  rvec, tvec, useExtrinsicGuess=True,
                                  flags=cv2.SOLVEPNP_ITERATIVE)
    return cv2.Rodrigues(rvec)[0], tvec.reshape(3)


def rotation_angle_deg(Ra, Rb):
    return float(np.degrees(np.arccos(np.clip((np.trace(Ra.T @ Rb) - 1) / 2, -1, 1))))


def orthonormalize(R):
    u, _, vt = np.linalg.svd(R)
    return u @ vt


class HeadPoseTracker:
    def __init__(self, smoothing=0.5, max_jump_deg=15.0, max_rejects=10):
        self.smoothing = smoothing
        self.max_jump_deg = max_jump_deg
        self.max_rejects = max_rejects
        self.reset()

    def reset(self):
        self.rvec = self.tvec = self.R = self.t = None
        self.rejects = 0

    def update(self, points_2d, face_model, camera_matrix):
        if self.R is None:
            R, t = estimate_head_pose(points_2d, face_model, camera_matrix)
            self.rvec, self.tvec = cv2.Rodrigues(R)[0], t.reshape(3, 1)
            self.R, self.t = R, t
            return R, t

        assert self.t is not None
        object_points = face_model.T.reshape(-1, 1, 3)
        image_points = points_2d.reshape(-1, 1, 2).astype(np.float64)
        ok, rvec, tvec = cv2.solvePnP(object_points, image_points, camera_matrix, None,
                                      self.rvec.copy(), self.tvec.copy(), useExtrinsicGuess=True,
                                      flags=cv2.SOLVEPNP_ITERATIVE)
        R_new, t_new = cv2.Rodrigues(rvec)[0], tvec.reshape(3)

        if rotation_angle_deg(self.R, R_new) > self.max_jump_deg and self.rejects < self.max_rejects:
            self.rejects += 1
            R_new = self.R
        else:
            self.rejects = 0

        a = self.smoothing
        self.R = orthonormalize(a * self.R + (1 - a) * R_new)
        self.t = a * self.t + (1 - a) * t_new
        self.rvec, self.tvec = cv2.Rodrigues(self.R)[0], self.t.reshape(3, 1).copy()
        return self.R, self.t


def eye_centers(head_rotation, head_translation, face_model):
    face_3d = head_rotation @ face_model + head_translation.reshape(3, 1)
    right = face_3d[:, 0:2].mean(axis=1)
    left = face_3d[:, 2:4].mean(axis=1)
    return right, left


def normalize_eye(image_bgr, camera_matrix, head_rotation, center):
    distance = np.linalg.norm(center)
    forward = center / distance
    down = np.cross(forward, head_rotation[:, 0])
    down /= np.linalg.norm(down)
    right = np.cross(down, forward)
    right /= np.linalg.norm(right)
    R = np.stack([right, down, forward])

    S = np.diag([1.0, 1.0, DISTANCE_NORM / distance])
    camera_norm = np.array([[FOCAL_NORM, 0, EYE_SIZE[0] / 2],
                            [0, FOCAL_NORM, EYE_SIZE[1] / 2],
                            [0, 0, 1.0]])
    W = camera_norm @ S @ R @ np.linalg.inv(camera_matrix)

    warped = cv2.warpPerspective(image_bgr, W, EYE_SIZE)
    grey = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    return cv2.equalizeHist(grey), R


def angles_to_vector(pitch, yaw):
    return np.array([-np.cos(pitch) * np.sin(yaw),
                     -np.sin(pitch),
                     -np.cos(pitch) * np.cos(yaw)])


def vector_to_angles(v):
    v = v / np.linalg.norm(v)
    return np.array([np.arcsin(np.clip(-v[1], -1, 1)), np.arctan2(-v[0], -v[2])])


def estimate_gaze(image_bgr, camera_matrix, head_rotation, centers, models, offsets=None):
    eyes, heads, rotations = [], [], []

    for name, center in zip(["right", "left"], centers):
        eye_img, R = normalize_eye(image_bgr, camera_matrix, head_rotation, center)
        head_norm = cv2.Rodrigues(R @ head_rotation)[0].reshape(1, 3)
        head = pose_to_angles(head_norm)[0]

        if name == "left":
            eye_img = eye_img[:, ::-1]
            head = head * np.array([1, -1])

        eyes.append(np.ascontiguousarray(eye_img))
        heads.append(head)
        rotations.append(R)

    angles = predict(models, np.stack(eyes), np.stack(heads))

    results = []
    for i, (name, center) in enumerate(zip(["right", "left"], centers)):
        raw = angles[i].copy()
        if name == "left":
            raw[1] = -raw[1]
        corrected = raw + (offsets[name] if offsets else 0.0)
        gaze_camera = rotations[i].T @ angles_to_vector(*corrected)
        results.append({
            "name": name,
            "center": center,
            "R": rotations[i],
            "head_R": head_rotation,
            "raw": raw,
            "gaze": gaze_camera / np.linalg.norm(gaze_camera),
            "eye_img": eyes[i][:, ::-1] if name == "left" else eyes[i],
        })
    return results


def combined_gaze(results):
    center = np.mean([r["center"] for r in results], axis=0)
    gaze = np.sum([r["gaze"] for r in results], axis=0)
    return center, gaze / np.linalg.norm(gaze)


class Screen:
    def __init__(self, width_px, height_px, width_mm, camera_offset_mm):
        self.width_px, self.height_px = width_px, height_px
        self.width_mm = width_mm
        self.mm_per_px = width_mm / width_px
        self.camera_offset_mm = camera_offset_mm

    def to_camera(self, px, py):
        x = -(px / self.width_px - 0.5) * self.width_mm
        y = self.camera_offset_mm + py * self.mm_per_px
        return np.array([x, y, 0.0])

    def to_pixels(self, point_mm):
        px = (0.5 - point_mm[0] / self.width_mm) * self.width_px
        py = (point_mm[1] - self.camera_offset_mm) / self.mm_per_px
        return np.array([px, py])


def intersect_screen(center, gaze):
    if gaze[2] > -1e-6:
        return None
    t = -center[2] / gaze[2]
    return center + t * gaze


def open_fullscreen(window):
    cv2.namedWindow(window, cv2.WINDOW_NORMAL)
    cv2.setWindowProperty(window, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
    cv2.imshow(window, np.zeros((900, 1440, 3), np.uint8))
    for _ in range(15):
        cv2.waitKey(50)
    rect = cv2.getWindowImageRect(window)
    return (rect[2], rect[3]) if rect[2] > 100 else (1440, 900)


def calibration_target_angles(result, target_mm):
    gaze = target_mm - result["center"]
    return vector_to_angles(result["R"] @ (gaze / np.linalg.norm(gaze)))


def fit_offsets(samples):
    offsets = {}
    for name in ("right", "left"):
        per_dot = {}
        for dot, n, raw, true in samples:
            if n == name:
                per_dot.setdefault(dot, []).append(true - raw)
        if len(per_dot) < 5:
            raise RuntimeError(f"Too few calibration dots for the {name} eye ({len(per_dot)}).")
        offsets[name] = np.mean([np.median(d, axis=0) for d in per_dot.values()], axis=0)
    return offsets


def with_offsets(results, offsets):
    out = []
    for r in results:
        corrected = r["raw"] + (offsets[r["name"]] if offsets else 0.0)
        gaze = r["R"].T @ angles_to_vector(*corrected)
        out.append({**r, "gaze": gaze / np.linalg.norm(gaze)})
    return out


def screen_fraction(results, screen):
    center, gaze = combined_gaze(results)
    hit = intersect_screen(center, gaze)
    if hit is None:
        return None, None
    px = screen.to_pixels(hit)
    return np.array([px[0] / screen.width_px, px[1] / screen.height_px]), float(np.linalg.norm(center))


def mapping_features(fractions, method):
    f = np.atleast_2d(fractions)
    x, y, one = f[:, 0], f[:, 1], np.ones(len(f))
    columns = [x, y, one] if method == "affine" else [x, y, one, x * x, y * y, x * y]
    return np.column_stack(columns)


def fit_mapping(estimates, targets, method, ridge=MAPPING_RIDGE):
    X = mapping_features(estimates, method)
    identity = np.zeros((X.shape[1], 2))
    identity[0, 0] = identity[1, 1] = 1.0
    A = np.linalg.solve(X.T @ X + ridge * np.eye(X.shape[1]), X.T @ targets + ridge * identity)
    return {"method": method, "A": A}


def apply_mapping(mapping, fraction):
    if mapping is None:
        return np.asarray(fraction, dtype=float)
    return (mapping_features(fraction, mapping["method"]) @ mapping["A"])[0]


def gaze_on_screen(results, offsets, mapping, screen):
    fraction, distance = screen_fraction(with_offsets(results, offsets), screen)
    if fraction is None:
        return None, None
    return apply_mapping(mapping, fraction), distance


def head_reference(frames):
    mids = [np.mean([r["center"] for r in res], axis=0) for res in frames]
    rotation = orthonormalize(np.mean([res[0]["head_R"] for res in frames], axis=0))
    return {"eye_mid_mm": np.median(mids, axis=0), "head_R": rotation}


def head_drift(results, reference):
    if reference is None:
        return None
    mid = np.mean([r["center"] for r in results], axis=0)
    moved = float(np.linalg.norm(mid - reference["eye_mid_mm"]))
    if "head_R" in reference:
        turned = rotation_angle_deg(reference["head_R"], results[0]["head_R"])
    else:
        forward = results[0]["head_R"][:, 2]
        turned = float(np.degrees(np.arccos(np.clip(forward @ reference["head_forward"], -1, 1))))
    return moved, turned


class DriftMonitor:
    def __init__(self):
        self.values = deque(maxlen=DRIFT_WINDOW)

    def update(self, drift):
        if drift is not None:
            self.values.append(drift)
        return tuple(np.median(self.values, axis=0)) if len(self.values) >= 5 else None


def draw_drift_warning(view, drift):
    if drift is None or (drift[0] < DRIFT_MM and drift[1] < DRIFT_DEG):
        return
    text = f"You moved {drift[0] / 10:.1f} cm / turned {drift[1]:.0f} deg since calibration: press c"
    cv2.rectangle(view, (0, 0), (view.shape[1], 50), (0, 0, 180), -1)
    cv2.putText(view, text, (20, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)


def save_calibration(calib):
    mapping = calib.get("mapping")
    reference = calib.get("reference")
    info = {k: v for k, v in calib.get("info", {}).items()
            if k not in ("offsets_rad", "mapping", "reference", "points")}
    payload = {
        **info,
        "offsets_rad": {k: v.tolist() for k, v in calib["offsets"].items()},
        "mapping": {"method": mapping["method"], "A": mapping["A"].tolist()} if mapping else None,
        "reference": {k: np.asarray(v).tolist() for k, v in reference.items()} if reference else None,
        "points": [{"target": [float(v) for v in p["target"]], "estimate": [float(v) for v in p["estimate"]],
                    "distance": float(p["distance"]), "source": p["source"]} for p in calib.get("points") or []],
    }
    CALIBRATION_PATH.write_text(json.dumps(payload, indent=2))


def load_calibration():
    if not CALIBRATION_PATH.exists():
        return None
    payload = json.loads(CALIBRATION_PATH.read_text())
    mapping = payload.get("mapping")
    if mapping:
        mapping = {"method": mapping["method"], "A": np.array(mapping["A"])}
    elif payload.get("affine") is not None:
        mapping = {"method": "affine", "A": np.array(payload["affine"])}
    reference = payload.get("reference")
    points = [{"target": np.array(p["target"]), "estimate": np.array(p["estimate"]),
               "distance": p["distance"], "source": p["source"]} for p in payload.get("points", [])]
    info = {k: v for k, v in payload.items()
            if k not in ("offsets_rad", "mapping", "reference", "points", "affine")}
    return {"offsets": {k: np.array(v) for k, v in payload["offsets_rad"].items()},
            "mapping": mapping,
            "reference": {k: np.array(v) for k, v in reference.items()} if reference else None,
            "points": points, "info": info}


def show_message(window, width, height, lines, wait_keys=(" ",)):
    canvas = np.zeros((height, width, 3), np.uint8)
    for k, line in enumerate(lines):
        cv2.putText(canvas, line, (60, height // 2 - 40 + 45 * k), cv2.FONT_HERSHEY_SIMPLEX, 1.0,
                    (255, 255, 255), 2)
    cv2.imshow(window, canvas)
    while True:
        key = cv2.waitKey(30) & 0xFF
        if key == 27:
            return "esc"
        for k in wait_keys:
            if key == ord(k):
                return k


def collect_dot(cap, detect, start_time, face_model, models, args, window, width, height, fx, fy):
    frames = []
    dot_start = time.time()

    # Use the split screen during calibration to perfectly match the saccadic assessment lighting
    try:
        from saccadic_assessment import make_split_screen
        background = make_split_screen(width, height)
    except ImportError:
        background = np.zeros((height, width, 3), np.uint8)

    while time.time() - dot_start < SETTLE_SECONDS + COLLECT_SECONDS:
        elapsed = time.time() - dot_start
        canvas = background.copy()
        radius = int(18 - 10 * min(elapsed / (SETTLE_SECONDS + COLLECT_SECONDS), 1))
        center_px = (int(fx * width), int(fy * height))
        cv2.circle(canvas, center_px, radius, (255, 255, 255), -1)
        cv2.circle(canvas, center_px, 3, (0, 0, 255), -1)
        cv2.imshow(window, canvas)
        if (cv2.waitKey(1) & 0xFF) == 27:
            return None
        ok, frame = cap.read()
        if not ok or elapsed < SETTLE_SECONDS:
            continue
        h, w = frame.shape[:2]
        camera_matrix = default_camera_matrix(w, h, args.focal)
        out = process_frame(frame, detect, int((time.time() - start_time) * 1000),
                            face_model, camera_matrix, models, offsets=None)
        if out is not None:
            frames.append(out[0])
    return frames


def dot_estimate(frames, offsets, mapping, screen):
    hits = [gaze_on_screen(res, offsets, mapping, screen) for res in frames]
    hits = [(p, d) for p, d in hits if p is not None]
    if len(hits) < 3:
        return None, None
    return np.median([p for p, _ in hits], axis=0), float(np.median([d for _, d in hits]))


METHOD_COLOURS = {"offset": (255, 140, 0), "affine": (0, 220, 0), "quadratic": (255, 0, 255)}
MIN_POINTS = {"offset": 0, "affine": 6, "quadratic": 12}


def choose_method(scores, margin=SELECT_MARGIN_DEG):
    chosen = "offset"
    for method in ("affine", "quadratic"):
        if method in scores and scores[method] < scores[chosen] - margin:
            chosen = method
    return chosen


def point_error_deg(estimate, target, distance, screen):
    err_mm = np.hypot((estimate[0] - target[0]) * screen.width_px,
                      (estimate[1] - target[1]) * screen.height_px) * screen.mm_per_px
    return float(np.degrees(np.arctan(err_mm / distance))), float(err_mm)


def leave_one_out_scores(points, screen):
    est = np.array([p["estimate"] for p in points])
    tgt = np.array([p["target"] for p in points])
    scores = {}
    for method, minimum in MIN_POINTS.items():
        if len(points) - 1 < minimum:
            continue
        errors = []
        for i, p in enumerate(points):
            keep = np.arange(len(points)) != i
            mapping = None if method == "offset" else fit_mapping(est[keep], tgt[keep], method)
            errors.append(point_error_deg(apply_mapping(mapping, est[i]), tgt[i], p["distance"], screen)[0])
        scores[method] = float(np.mean(errors))
    return scores


def refit_with_points(calib, new_points, screen):
    points = list(calib.get("points") or []) + list(new_points)
    scores = leave_one_out_scores(points, screen)
    method = choose_method(scores)
    est = np.array([p["estimate"] for p in points])
    tgt = np.array([p["target"] for p in points])
    calib = dict(calib)
    calib["mapping"] = None if method == "offset" else fit_mapping(est, tgt, method)
    calib["points"] = points
    info = dict(calib.get("info", {}))
    info.update({"method": method, "n_points": len(points),
                 "leave_one_out_error_deg": scores})
    calib["info"] = info
    save_calibration(calib)
    return calib, scores, method


def run_calibration(cap, detect, start_time, face_model, models, args):
    window = "GazeMap calibration"
    width, height = open_fullscreen(window)
    screen = Screen(width, height, args.screen_width_mm, args.camera_offset_mm)
    print(f"Calibration window: {width} x {height}")

    while True:
        answer = show_message(window, width, height, [
            "Calibration: look at each white dot until it disappears.",
            "Keep your head still and natural. 13 dots, then 5 test dots.",
            "Press SPACE to start, ESC to cancel."])
        if answer == "esc":
            cv2.destroyWindow(window)
            return None

        dots = []
        for fx, fy in CALIBRATION_DOTS:
            frames = collect_dot(cap, detect, start_time, face_model, models, args, window, width, height, fx, fy)
            if frames is None:
                cv2.destroyWindow(window)
                return None
            dots.append((fx, fy, frames))

        samples = []
        for d, (fx, fy, frames) in enumerate(dots):
            target = screen.to_camera(fx * width, fy * height)
            for results in frames:
                for r in results:
                    samples.append((d, r["name"], r["raw"], calibration_target_angles(r, target)))
        try:
            offsets = fit_offsets(samples)
        except RuntimeError as error:
            if show_message(window, width, height, [str(error), "SPACE = try again, ESC = cancel"]) == "esc":
                cv2.destroyWindow(window)
                return None
            continue

        estimates, targets, points = [], [], []
        for fx, fy, frames in dots:
            estimate, distance = dot_estimate(frames, offsets, None, screen)
            if estimate is not None:
                estimates.append(estimate)
                targets.append([fx, fy])
                points.append({"target": np.array([fx, fy]), "estimate": estimate,
                               "distance": distance, "source": "calibration"})
        estimates, targets = np.array(estimates), np.array(targets)
        mappings = {"offset": None}
        if len(estimates) >= 6:
            mappings["affine"] = fit_mapping(estimates, targets, "affine")
        if len(estimates) >= 10:
            mappings["quadratic"] = fit_mapping(estimates, targets, "quadratic")
        reference = head_reference([res for _, _, frames in dots for res in frames])

        errors = {m: [] for m in mappings}
        markers = []
        for fx, fy in VALIDATION_DOTS:
            frames = collect_dot(cap, detect, start_time, face_model, models, args, window, width, height, fx, fy)
            if frames is None:
                break
            estimate, distance = dot_estimate(frames, offsets, None, screen)
            if estimate is None:
                continue
            target = np.array([fx, fy])
            points.append({"target": target, "estimate": estimate, "distance": distance, "source": "validation"})
            shown = {}
            for method, mapping in mappings.items():
                est = apply_mapping(mapping, estimate)
                err_mm = np.hypot((est[0] - target[0]) * width, (est[1] - target[1]) * height) * screen.mm_per_px
                errors[method].append((err_mm, np.degrees(np.arctan(err_mm / distance))))
                shown[method] = est
            markers.append((target, shown))

        mean = {m: (np.mean([e[0] for e in v]), np.mean([e[1] for e in v])) for m, v in errors.items() if v}
        method = choose_method({m: v[1] for m, v in mean.items()})

        canvas = np.zeros((height, width, 3), np.uint8)
        for target, shown in markers:
            cv2.circle(canvas, (int(target[0] * width), int(target[1] * height)), 12, (255, 255, 255), 2)
            for m, est in shown.items():
                cv2.circle(canvas, (int(est[0] * width), int(est[1] * height)), 8, METHOD_COLOURS[m], -1)
        lines = ["Validation (white = dot, blue = offset, green = affine, pink = quadratic):"]
        for m, (mm, deg) in mean.items():
            lines.append(f"  {m:9s} mean error {mm / 10:.1f} cm = {deg:.1f} deg")
        lines.append(f"Using: {method} (a more flexible fit must win by {SELECT_MARGIN_DEG} deg).")
        lines.append("SPACE = accept,  R = redo calibration")
        for k, line in enumerate(lines):
            cv2.putText(canvas, line, (60, 80 + 45 * k), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
        cv2.imshow(window, canvas)
        answer = None
        while answer is None:
            key = cv2.waitKey(30) & 0xFF
            if key in (ord(" "), 27):
                answer = "accept"
            elif key in (ord("r"), ord("R")):
                answer = "redo"
        if answer == "redo":
            continue

        calib = {
            "offsets": offsets,
            "mapping": mappings.get(method),
            "reference": reference,
            "points": points,
            "info": {"method": method, "screen_width_mm": args.screen_width_mm,
                     "camera_offset_mm": args.camera_offset_mm,
                     "validation_error_deg": {m: float(v[1]) for m, v in mean.items()},
                     "validation_error_cm": {m: float(v[0] / 10) for m, v in mean.items()}},
        }
        save_calibration(calib)
        print(f"Calibration saved to {CALIBRATION_PATH}: method {method}, validation error " +
              ", ".join(f"{m} {v[1]:.1f}° ({v[0] / 10:.1f} cm)" for m, v in mean.items()))
        cv2.destroyWindow(window)
        return calib


def run_test(args, models, face_model):
    detect = make_landmarker()
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise RuntimeError("Cannot open the camera. On macOS, allow camera access for Terminal "
                           "in System Settings > Privacy & Security > Camera.")
    start = time.time()
    calib = None if args.no_calibration else load_calibration()
    if args.calibrate or calib is None:
        calib = run_calibration(cap, detect, start, face_model, models, args) or calib
    offsets = calib["offsets"] if calib else None
    mapping = calib["mapping"] if calib else None
    reference = calib["reference"] if calib else None

    window = "GazeMap accuracy test"
    width, height = open_fullscreen(window)
    screen = Screen(width, height, args.screen_width_mm, args.camera_offset_mm)
    if show_message(window, width, height, [
            "Accuracy test: 16 dots, one in each cell. Sit the way you normally do.",
            "Press SPACE to start, ESC to cancel."]) == "esc":
        cap.release()
        cv2.destroyAllWindows()
        return

    rows, drifts = [], []
    for fx, fy in TEST_DOTS:
        frames = collect_dot(cap, detect, start, face_model, models, args, window, width, height, fx, fy)
        if frames is None:
            break
        raw_estimate, distance = dot_estimate(frames, offsets, None, screen)
        if frames and reference is not None:
            drifts.append(np.median([head_drift(res, reference) for res in frames], axis=0))
        if raw_estimate is None:
            continue
        estimate = apply_mapping(mapping, raw_estimate)
        err_mm = np.array([(estimate[0] - fx) * width, (estimate[1] - fy) * height]) * screen.mm_per_px
        err_deg = float(np.degrees(np.arctan(np.linalg.norm(err_mm) / distance)))
        frame_points = [gaze_on_screen(res, offsets, mapping, screen)[0] for res in frames]
        frame_points = np.array([q for q in frame_points if q is not None])
        spread_mm = np.sqrt(np.mean(np.sum(((frame_points - estimate) * np.array([width, height])
                                            * screen.mm_per_px) ** 2, axis=1)))
        precision_deg = float(np.degrees(np.arctan(spread_mm / distance)))
        rows.append({"target": np.array([fx, fy]), "estimate": estimate, "raw_estimate": raw_estimate,
                     "distance": distance, "err_mm": err_mm, "err_deg": err_deg, "precision_deg": precision_deg})

    if not rows:
        print("No face found during the test.")
        cap.release()
        cv2.destroyAllWindows()
        return

    errs = np.array([r["err_mm"] for r in rows])
    shift = errs.mean(axis=0)
    residual = np.linalg.norm(errs - shift, axis=1).mean()
    centre = np.array([0.5 * width, 0.5 * height]) * screen.mm_per_px
    outward = []
    for r in rows:
        direction = r["target"] * np.array([width, height]) * screen.mm_per_px - centre
        outward.append(r["err_mm"] @ (direction / np.linalg.norm(direction)))
    outward = float(np.mean(outward))
    mean_deg = float(np.mean([r["err_deg"] for r in rows]))
    mean_cm = float(np.linalg.norm(errs, axis=1).mean() / 10)
    precision = float(np.mean([r["precision_deg"] for r in rows]))
    drift = np.mean(drifts, axis=0) if drifts else None

    canvas = make_background(width, height, None)
    for r in rows:
        t = (int(r["target"][0] * width), int(r["target"][1] * height))
        e = (int(np.clip(r["estimate"][0], -0.2, 1.2) * width), int(np.clip(r["estimate"][1], -0.2, 1.2) * height))
        colour = (0, 200, 0) if r["err_deg"] < 1.5 else ((0, 220, 255) if r["err_deg"] < 3 else (0, 0, 255))
        cv2.circle(canvas, t, 10, (255, 255, 255), 2)
        cv2.arrowedLine(canvas, t, e, colour, 3, tipLength=0.15)
        cv2.putText(canvas, f"{r['err_deg']:.1f}", (t[0] + 14, t[1] - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.7, colour, 2)

    vertical = "lower" if shift[1] > 0 else "higher"
    horizontal = "right" if shift[0] > 0 else "left"
    lines = [
        f"Mean error {mean_deg:.1f} deg ({mean_cm:.1f} cm), calibration: {calib['mapping']['method'] if mapping else 'offset'}",
        f"Whole map shifted {abs(shift[1]) / 10:.1f} cm {vertical} and {abs(shift[0]) / 10:.1f} cm {horizontal}",
        f"Error left after removing that shift: {residual / 10:.1f} cm",
        f"Points pushed {'outward from' if outward > 0 else 'in towards'} the middle by {abs(outward) / 10:.1f} cm on average",
        f"Precision (frame-to-frame wobble while holding still): {precision:.1f} deg",
    ]
    if drift is not None:
        lines.append(f"Head since calibration: moved {drift[0] / 10:.1f} cm, turned {drift[1]:.0f} deg")
    lines.append("A = add these 16 dots to the calibration and refit,  any other key = close")
    top = height - 40 * len(lines) - 40
    panel = canvas.copy()
    cv2.rectangle(panel, (20, top - 10), (min(width - 20, 1150), height - 15), (0, 0, 0), -1)
    canvas = cv2.addWeighted(panel, 0.75, canvas, 0.25, 0)
    for k, line in enumerate(lines):
        cv2.putText(canvas, line, (40, top + 30 + 40 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)

    HEATMAP_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    cv2.imwrite(str(HEATMAP_DIR / f"test_{stamp}.png"), canvas)
    with open(HEATMAP_DIR / f"test_{stamp}.csv", "w") as file:
        file.write("target_x,target_y,estimate_x,estimate_y,error_x_mm,error_y_mm,error_deg,precision_deg\n")
        for r in rows:
            file.write(f"{r['target'][0]:.3f},{r['target'][1]:.3f},{r['estimate'][0]:.4f},{r['estimate'][1]:.4f},"
                       f"{r['err_mm'][0]:.1f},{r['err_mm'][1]:.1f},{r['err_deg']:.2f},{r['precision_deg']:.2f}\n")
    print("\n".join(lines[:-1]))
    print(f"Saved {HEATMAP_DIR}/test_{stamp}.png and .csv")

    cv2.imshow(window, canvas)
    key = cv2.waitKey(0) & 0xFF
    if key in (ord("a"), ord("A")) and calib is not None:
        new_points = [{"target": r["target"], "estimate": r["raw_estimate"], "distance": r["distance"],
                       "source": "test"} for r in rows]
        calib, scores, method = refit_with_points(calib, new_points, screen)
        summary = ", ".join(f"{m} {v:.1f} deg" for m, v in scores.items())
        print(f"Refitted on {len(calib['points'])} dots. Leave-one-out error: {summary}. Using: {method}")
        show_message(window, width, height, [
            f"Refitted on {len(calib['points'])} dots (each one tested while left out of the fit):",
            f"  {summary}",
            f"Using: {method}. Run --test again to check.  SPACE = close"])
    cap.release()
    cv2.destroyAllWindows()


def project(camera_matrix, points):
    projected, _ = cv2.projectPoints(np.asarray(points, float), np.zeros(3), np.zeros(3), camera_matrix, None)
    return projected.reshape(-1, 2).astype(int)


def draw(frame, camera_matrix, results, arrow_mm=150.0):
    for r in results:
        start, end = project(camera_matrix, [r["center"], r["center"] + arrow_mm * r["gaze"]])
        cv2.circle(frame, tuple(start), 3, (0, 255, 255), -1)
        cv2.arrowedLine(frame, tuple(start), tuple(end), (0, 0, 255), 2, tipLength=0.2)
    center, gaze = combined_gaze(results)
    start, end = project(camera_matrix, [center, center + 1.5 * arrow_mm * gaze])
    cv2.arrowedLine(frame, tuple(start), tuple(end), (0, 220, 0), 3, tipLength=0.15)


def draw_eye_patches(frame, results):
    y = 10
    for r in results:
        patch = cv2.resize(r["eye_img"], (180, 108), interpolation=cv2.INTER_NEAREST)
        frame[y:y + 108, 10:190] = cv2.cvtColor(patch, cv2.COLOR_GRAY2BGR)
        cv2.putText(frame, r["name"], (14, y + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        y += 116


def gaze_text(results):
    _, gaze = combined_gaze(results)
    pitch, yaw = np.degrees(vector_to_angles(gaze))
    return f"pitch {pitch:+.0f} deg  yaw {yaw:+.0f} deg"


class FaceLandmarker:
    def __init__(self):
        self.last_full_landmarks: np.ndarray | None = None
        self.pose_tracker = HeadPoseTracker()
        self._last_ts = -1
        self._landmarker = None

    def _init_mediapipe(self):
        import mediapipe as mp

        if not LANDMARKER_PATH.exists():
            print("Downloading MediaPipe face landmarker model (about 4 MB)...")
            urllib.request.urlretrieve(LANDMARKER_URL, LANDMARKER_PATH)

        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(LANDMARKER_PATH)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_faces=1,
        )
        self._landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)

    def __call__(self, frame_bgr, timestamp_ms):
        if self._landmarker is None:
            self._init_mediapipe()

        landmarker = self._landmarker
        if landmarker is None:
            raise RuntimeError("Failed to initialize MediaPipe face landmarker")

        timestamp_ms = max(timestamp_ms, self._last_ts + 1)
        self._last_ts = timestamp_ms
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        import mediapipe as mp

        image = mp.Image(
            image_format=mp.ImageFormat.SRGB,
            data=rgb,
        )
        result = landmarker.detect_for_video(image, timestamp_ms)
        if not result.face_landmarks:
            self.last_full_landmarks = None
            return None
        h, w = frame_bgr.shape[:2]
        marks = result.face_landmarks[0]
        self.last_full_landmarks = np.array([[m.x * w, m.y * h] for m in marks])
        return np.array([[marks[i].x * w, marks[i].y * h] for i in MEDIAPIPE_IDS])


def make_landmarker():
    return FaceLandmarker()


def default_camera_matrix(width, height, focal=None):
    f = focal if focal else float(width)
    return np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1.0]])


def process_frame(frame, detect, timestamp_ms, face_model, camera_matrix, models, offsets=None):
    # Pass the original color frame to MediaPipe for stable landmark tracking.
    # The GazeMap model handles its own grayscale and histogram equalization internally.
    points = detect(frame, timestamp_ms)
    tracker = getattr(detect, "pose_tracker", None)
    if points is None:
        if tracker is not None:
            tracker.reset()
        return None
    if tracker is not None:
        head_rotation, head_translation = tracker.update(points, face_model, camera_matrix)
    else:
        head_rotation, head_translation = estimate_head_pose(points, face_model, camera_matrix)
    centers = eye_centers(head_rotation, head_translation, face_model)
    return estimate_gaze(frame, camera_matrix, head_rotation, centers, models, offsets), points


def run_camera(args, models, face_model):
    detect = make_landmarker()
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise RuntimeError("Cannot open the camera. On macOS, allow camera access for Terminal "
                           "in System Settings > Privacy & Security > Camera.")

    start = time.time()
    calib = None if args.no_calibration else load_calibration()
    if args.calibrate:
        calib = run_calibration(cap, detect, start, face_model, models, args) or calib
    offsets = calib["offsets"] if calib else None
    if offsets:
        print("Using calibration from", CALIBRATION_PATH)

    mirror, smooth = True, True
    drift_monitor = DriftMonitor()
    smoothed = {}
    last = time.time()
    fps = 0.0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        camera_matrix = default_camera_matrix(w, h, args.focal)
        out = process_frame(frame, detect, int((time.time() - start) * 1000),
                            face_model, camera_matrix, models, offsets)
        results = None
        points = None

        if out is not None:
            results, points = out
            if smooth:
                for r in results:
                    previous = smoothed.get(r["name"], r["gaze"])
                    r["gaze"] = 0.5 * previous + 0.5 * r["gaze"]
                    r["gaze"] /= np.linalg.norm(r["gaze"])
                    smoothed[r["name"]] = r["gaze"]
            for p in points:
                cv2.circle(frame, tuple(p.astype(int)), 2, (255, 200, 0), -1)
            draw(frame, camera_matrix, results)
            text = gaze_text(results)
        else:
            text = "no face"

        view = cv2.flip(frame, 1) if mirror else frame
        if results is not None:
            draw_eye_patches(view, results)
            draw_drift_warning(view, drift_monitor.update(head_drift(results, calib["reference"] if calib else None)))

        now = time.time()
        fps = 0.9 * fps + 0.1 / max(now - last, 1e-6)
        last = now
        status = "calibrated" if offsets else "not calibrated"
        cv2.putText(view, f"{text}  {fps:.0f} fps  {status}  [q]uit [c]alibrate [x]clear [m]irror [s]mooth",
                    (10, h - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
        cv2.imshow("GazeMap", view)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        if key == ord("m"):
            mirror = not mirror
        if key == ord("s"):
            smooth = not smooth
            smoothed.clear()
        if key == ord("c"):
            calib = run_calibration(cap, detect, start, face_model, models, args) or calib
            offsets = calib["offsets"] if calib else None
            smoothed.clear()
        if key == ord("x"):
            offsets = None
            smoothed.clear()

    cap.release()
    cv2.destroyAllWindows()


def fit_image(image, width, height, fill=30):
    canvas = np.full((height, width, 3), fill, np.uint8)
    scale = min(width / image.shape[1], height / image.shape[0])
    resized = cv2.resize(image, (int(image.shape[1] * scale), int(image.shape[0] * scale)))
    y0 = (height - resized.shape[0]) // 2
    x0 = (width - resized.shape[1]) // 2
    canvas[y0:y0 + resized.shape[0], x0:x0 + resized.shape[1]] = resized
    return canvas, (x0, y0, scale)


def make_background(width, height, stimulus=None):
    if stimulus:
        image = cv2.imread(stimulus)
        if image is None:
            raise FileNotFoundError(stimulus)
        return fit_image(image, width, height)[0]

    canvas = np.full((height, width, 3), 30, np.uint8)

    for k in range(1, 4):
        cv2.line(canvas, (k * width // 4, 0), (k * width // 4, height), (70, 70, 70), 1)
        cv2.line(canvas, (0, k * height // 4), (width, k * height // 4), (70, 70, 70), 1)
    for row in range(4):
        for col in range(4):
            label = "ABCD"[row] + str(col + 1)
            cv2.putText(canvas, label, (col * width // 4 + 20, row * height // 4 + 50),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.2, (110, 110, 110), 2)
    return canvas


IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def list_stimuli(path):
    if not path:
        return [None]
    path = Path(path)
    if path.is_dir():
        images = sorted(p for p in path.iterdir() if p.suffix.lower() in IMAGE_TYPES)
        if not images:
            raise FileNotFoundError(f"No images in {path}")
        return [str(p) for p in images]
    return [str(path)]


def save_heatmap(base, heat, blob_px, points, name):
    HEATMAP_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    stem = f"{name}_{stamp}"
    cv2.imwrite(str(HEATMAP_DIR / f"{stem}.png"), render_heatmap(base, heat, blob_px))
    with open(HEATMAP_DIR / f"{stem}_points.csv", "w") as file:
        file.write("seconds,x_px,y_px\n")
        file.writelines(f"{t:.3f},{x:.1f},{y:.1f}\n" for t, x, y in points)
    print(f"Saved {HEATMAP_DIR}/{stem}.png and _points.csv ({len(points)} samples)")


def render_heatmap(base, heat, blob_px, alpha=0.6):
    sigma = max(blob_px / HEAT_SCALE, 1.0)
    blurred = cv2.GaussianBlur(heat, (0, 0), sigmaX=sigma)
    if blurred.max() <= 0:
        return base.copy()
    level = (blurred / blurred.max() * 255).astype(np.uint8)
    level = cv2.resize(level, (base.shape[1], base.shape[0]), interpolation=cv2.INTER_LINEAR)
    colour = cv2.applyColorMap(level, cv2.COLORMAP_TURBO)
    weight = level.astype(np.float32)[..., None] / 255.0 * alpha
    weight[level < 25] = 0
    return (base * (1 - weight) + colour * weight).astype(np.uint8)


def open_camera(index):
    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        raise RuntimeError("Cannot open the camera. On macOS, allow camera access for Terminal "
                           "in System Settings > Privacy & Security > Camera.")
    return cap


def load_or_calibrate(cap, detect, start, face_model, models, args):
    calib = None if args.no_calibration else load_calibration()
    if args.calibrate or calib is None:
        calib = run_calibration(cap, detect, start, face_model, models, args) or calib
    if calib is None:
        print("Warning: running without calibration, gaze on the screen will be less accurate.")
    return calib


def run_heatmap(args, models, face_model):
    detect = make_landmarker()
    cap = open_camera(args.camera)
    start = time.time()

    calib = load_or_calibrate(cap, detect, start, face_model, models, args)
    offsets = calib["offsets"] if calib else None
    mapping = calib["mapping"] if calib else None
    reference = calib["reference"] if calib else None

    window = "GazeMap heatmap"
    width, height = open_fullscreen(window)
    screen = Screen(width, height, args.screen_width_mm, args.camera_offset_mm)
    print(f"Heatmap window: {width} x {height}, {screen.mm_per_px:.3f} mm per pixel")

    stimuli = list_stimuli(args.stimulus)
    index = 0
    base = make_background(width, height, stimuli[index])
    heat = np.zeros((height // HEAT_SCALE + 1, width // HEAT_SCALE + 1), np.float32)
    points = []
    shown_since = time.time()
    distance = None

    def stimulus_name():
        stimulus = stimuli[index]
        return Path(stimulus).stem if stimulus else "heatmap"
    smoothed = None
    paused = False
    drift_monitor = DriftMonitor()
    writer = None
    blob_px = 50.0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        camera_matrix = default_camera_matrix(w, h, args.focal)
        out = process_frame(frame, detect, int((time.time() - start) * 1000),
                            face_model, camera_matrix, models, offsets)

        current = None
        drift = None
        if out is not None:
            fraction, distance = gaze_on_screen(out[0], offsets, mapping, screen)
            drift = drift_monitor.update(head_drift(out[0], reference))
            if fraction is not None:
                p = np.array([fraction[0] * width, fraction[1] * height])
                smoothed = p if smoothed is None else 0.6 * smoothed + 0.4 * p
                current = smoothed
                blob_px = distance * np.tan(np.radians(args.blob_deg)) / screen.mm_per_px
                inside = 0 <= current[0] < width and 0 <= current[1] < height
                if inside and not paused:
                    heat[int(current[1]) // HEAT_SCALE, int(current[0]) // HEAT_SCALE] += 1
                    points.append((time.time() - start, float(current[0]), float(current[1])))

        view = render_heatmap(base, heat, blob_px)
        if current is not None:
            x = int(np.clip(current[0], 0, width - 1))
            y = int(np.clip(current[1], 0, height - 1))
            cv2.circle(view, (x, y), 14, (255, 255, 255), 2)
            cv2.circle(view, (x, y), 3, (255, 255, 255), -1)

        preview = cv2.flip(frame, 1)
        pw = min(320, width // 5)
        preview = cv2.resize(preview, (pw, int(preview.shape[0] * pw / preview.shape[1])))
        view[10:10 + preview.shape[0], width - pw - 10:width - 10] = preview

        state = "PAUSED" if paused else ("no face" if out is None else "tracking")
        rec = "  REC" if writer is not None else ""
        dist = f"  eyes {distance / 10:.0f} cm from camera" if distance else ""
        slide = f"  image {index + 1}/{len(stimuli)} [n]ext" if len(stimuli) > 1 else ""
        status = (f"{state}{rec}  {len(points)} samples{dist}{slide}  "
                  f"[r]eset [p]ause [s]ave [v]ideo [c]alibrate [q]uit")
        cv2.putText(view, status, (20, height - 25), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 5)
        cv2.putText(view, status, (20, height - 25), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        draw_drift_warning(view, drift)
        cv2.imshow(window, view)

        if writer is not None:
            writer.write(cv2.resize(view, (1280, int(height * 1280 / width))))

        key = cv2.waitKey(1) & 0xFF
        timed_out = args.seconds and not paused and time.time() - shown_since > args.seconds
        if key == ord("n") or timed_out:
            if points:
                save_heatmap(base, heat, blob_px, points, stimulus_name())
            if index + 1 >= len(stimuli):
                if timed_out or len(stimuli) > 1:
                    break
            else:
                index += 1
                base = make_background(width, height, stimuli[index])
                heat[:] = 0
                points.clear()
                shown_since = time.time()
                continue
        if key in (ord("q"), 27):
            break
        if key == ord("r"):
            heat[:] = 0
            points.clear()
        if key == ord("p"):
            paused = not paused
        if key == ord("c"):
            calib = run_calibration(cap, detect, start, face_model, models, args) or calib
            offsets = calib["offsets"] if calib else None
            mapping = calib["mapping"] if calib else None
            reference = calib["reference"] if calib else None
            width, height = open_fullscreen(window)
            smoothed = None
        if key == ord("s"):
            save_heatmap(base, heat, blob_px, points, stimulus_name())
        if key == ord("v"):
            if writer is None:
                HEATMAP_DIR.mkdir(exist_ok=True)
                path = HEATMAP_DIR / f"heatmap_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
                writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 15,
                                         (1280, int(height * 1280 / width)))
                print("Recording video to", path)
            else:
                writer.release()
                writer = None
                print("Video saved")

    if writer is not None:
        writer.release()
    cap.release()
    cv2.destroyAllWindows()


def make_video_writer(path, fps, size):
    fourcc_factory = getattr(cv2, "VideoWriter_fourcc", None)
    if fourcc_factory is None:
        raise RuntimeError("OpenCV does not expose cv2.VideoWriter_fourcc on this build")
    return cv2.VideoWriter(str(path), fourcc_factory(*"mp4v"), fps, size)


def record_video_gaze(args, models, face_model, video_path):
    video = cv2.VideoCapture(str(video_path))
    if not video.isOpened():
        raise FileNotFoundError(video_path)
    fps = video.get(cv2.CAP_PROP_FPS) or 25.0
    n_frames = int(video.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = n_frames / fps

    detect = make_landmarker()
    cap = open_camera(args.camera)
    start = time.time()
    calib = load_or_calibrate(cap, detect, start, face_model, models, args)
    offsets = calib["offsets"] if calib else None
    mapping = calib["mapping"] if calib else None
    reference = calib["reference"] if calib else None

    out_height = int(round(video.get(cv2.CAP_PROP_FRAME_HEIGHT) * VIDEO_OUT_WIDTH
                           / video.get(cv2.CAP_PROP_FRAME_WIDTH)))
    panel_size = (int(out_height * PANEL_ASPECT), out_height)

    window = "GazeMap video"
    width, height = open_fullscreen(window)
    screen = Screen(width, height, args.screen_width_mm, args.camera_offset_mm)
    if show_message(window, width, height, [
            f"{Path(video_path).name}: {duration:.0f} s",
            "Watch the video naturally. Keep your head roughly where it was during calibration.",
            "SPACE = start, then space = pause, q = stop and save"], wait_keys=(" ", "q")) != " ":
        cv2.destroyWindow(window)
        cap.release()
        return None
    countdown(window, width, height, cap)

    ok, frame = video.read()
    frame_index = 0
    canvas, (x0, y0, scale) = fit_image(frame, width, height, fill=0)
    samples = []
    insets = []
    face_x = face_y = None
    hint_y = height - max(12, (height - int(frame.shape[0] * scale)) // 4)
    drift_monitor = DriftMonitor()
    smoothed = None
    paused = False
    clock = 0.0
    last_tick = time.time()

    while True:
        ok_cam, cam = cap.read()
        captured = time.time()
        if not ok_cam:
            break
        if not paused:
            clock += captured - last_tick
        last_tick = captured
        if clock >= duration:
            break

        target = int(clock * fps)
        while frame_index < target:
            ok = video.grab()
            frame_index += 1
            if not ok:
                break
        if ok and frame_index == target:
            ok, decoded = video.retrieve()
            if ok:
                canvas, (x0, y0, scale) = fit_image(decoded, width, height, fill=0)
        if not ok:
            break

        h, w = cam.shape[:2]
        camera_matrix = default_camera_matrix(w, h, args.focal)
        out = process_frame(cam, detect, int((captured - start) * 1000), face_model,
                            camera_matrix, models, offsets)
        current = None
        drift = None
        if out is not None and not paused:
            fraction, distance = gaze_on_screen(out[0], offsets, mapping, screen)
            drift = drift_monitor.update(head_drift(out[0], reference))
            if fraction is not None:
                p = np.array([fraction[0] * width, fraction[1] * height])
                smoothed = p if smoothed is None else 0.6 * smoothed + 0.4 * p
                current = smoothed
                samples.append((clock, (current[0] - x0) / scale, (current[1] - y0) / scale, distance))
        if not paused:
            shot = cam.copy()
            if out is not None:
                draw(shot, camera_matrix, out[0], arrow_mm=100.0)
                fx, fy = out[1].mean(axis=0)
                face_x = fx if face_x is None else 0.8 * face_x + 0.2 * fx
                face_y = fy if face_y is None else 0.8 * face_y + 0.2 * fy
            panel = webcam_panel(shot, face_x, face_y, panel_size)
            insets.append((clock, cv2.imencode(".jpg", panel, [cv2.IMWRITE_JPEG_QUALITY, 85])[1]))

        view = canvas.copy()
        if args.show_gaze and current is not None:
            cv2.circle(view, (int(current[0]), int(current[1])), 14, (255, 255, 255), 2)
        if out is None:
            cv2.putText(view, "no face", (20, height - 25), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
        if paused:
            cv2.putText(view, "PAUSED: space to continue", (20, height - 25),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        else:
            hint = f"{clock:4.0f} / {duration:.0f} s    space = pause    q = stop and save"
            cv2.putText(view, hint, (width - 560, hint_y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (110, 110, 110), 1)
        draw_drift_warning(view, drift)
        cv2.imshow(window, view)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if key == ord(" "):
            paused = not paused
            smoothed = None

    video.release()
    cap.release()
    cv2.destroyWindow(window)
    cv2.waitKey(1)

    seen = len({int(t * 10) for t, *_ in samples}) / max(clock * 10, 1)
    print(f"Recorded {len(samples)} gaze samples over {clock:.1f} s "
          f"({len(samples) / max(clock, 1e-6):.1f} per second, gaze found in {seen:.0%} of the time)")
    return {"fps": fps, "samples": samples, "insets": insets, "screen": screen,
            "video_scale": scale, "played": clock}


def countdown(window, width, height, cap, seconds=3):
    for n in range(seconds, 0, -1):
        until = time.time() + 1.0
        while time.time() < until:
            cap.read()
            canvas = np.zeros((height, width, 3), np.uint8)
            cv2.putText(canvas, str(n), (width // 2 - 30, height // 2 + 30), cv2.FONT_HERSHEY_SIMPLEX,
                        3.0, (255, 255, 255), 6)
            cv2.imshow(window, canvas)
            cv2.waitKey(1)


def webcam_panel(frame, face_x, face_y, size):
    h, w = frame.shape[:2]
    crop_h = int(h * PANEL_ZOOM)
    crop_w = min(w, int(crop_h * size[0] / size[1]))
    cx = w / 2 if face_x is None else face_x
    cy = h / 2 if face_y is None else face_y + PANEL_FACE_UP * crop_h
    x0 = int(np.clip(cx - crop_w / 2, 0, w - crop_w))
    y0 = int(np.clip(cy - crop_h / 2, 0, h - crop_h))
    crop = frame[y0:y0 + crop_h, x0:x0 + crop_w]
    return cv2.flip(cv2.resize(crop, size), 1)


def draw_trail(frame, recent, now, radius):
    if not recent:
        return frame
    for (t0, x0, y0), (t1, x1, y1) in zip(recent, recent[1:]):
        fade = 1.0 - (now - t1) / TRAIL_SECONDS
        colour = (0, int(140 + 115 * fade), 255)
        cv2.line(frame, (int(x0), int(y0)), (int(x1), int(y1)), colour, max(1, int(2 + 4 * fade)), cv2.LINE_AA)
    _, x, y = recent[-1]
    disc = frame.copy()
    cv2.circle(disc, (int(x), int(y)), int(radius), (0, 255, 255), -1, cv2.LINE_AA)
    frame = cv2.addWeighted(disc, 0.35, frame, 0.65, 0)
    cv2.circle(frame, (int(x), int(y)), int(radius), (0, 255, 255), 2, cv2.LINE_AA)
    return frame


def render_video_gaze(video_path, record, blob_deg, inset=True):
    video = cv2.VideoCapture(str(video_path))
    vw = int(video.get(cv2.CAP_PROP_FRAME_WIDTH))
    vh = int(video.get(cv2.CAP_PROP_FRAME_HEIGHT))
    k = VIDEO_OUT_WIDTH / vw
    size = (VIDEO_OUT_WIDTH, int(round(vh * k)))
    panel_w = int(size[1] * PANEL_ASPECT) if inset else 0
    out_size = (size[0] + panel_w, size[1])
    samples = record["samples"]
    times = [s[0] for s in samples]
    inset_times = [t for t, _ in record["insets"]]

    distance = np.median([s[3] for s in samples]) if samples else 600.0
    screen_px = distance * np.tan(np.radians(blob_deg)) / record["screen"].mm_per_px
    radius = max(screen_px / record["video_scale"] * k, 6)

    HEATMAP_DIR.mkdir(exist_ok=True)
    stem = f"{Path(video_path).stem}_{time.strftime('%Y%m%d_%H%M%S')}"
    writer = cv2.VideoWriter(str(HEATMAP_DIR / f"{stem}_gaze.mp4"), cv2.VideoWriter.fourcc(*"mp4v"),
                             record["fps"], out_size)
    heat = np.zeros((size[1] // HEAT_SCALE + 1, size[0] // HEAT_SCALE + 1), np.float32)
    middle = None
    n_out = int(record["played"] * record["fps"])

    for i in range(n_out):
        ok, frame = video.read()
        if not ok:
            break
        now = i / record["fps"]
        frame = cv2.resize(frame, size)
        if i == n_out // 2:
            middle = frame.copy()
        lo, hi = bisect.bisect_left(times, now - TRAIL_SECONDS), bisect.bisect_right(times, now)
        recent = [(t, x * k, y * k) for t, x, y, _ in samples[lo:hi]]
        frame = draw_trail(frame, recent, now, radius)

        combined = np.zeros((out_size[1], out_size[0], 3), np.uint8)
        combined[:, :size[0]] = frame
        j = bisect.bisect_right(inset_times, now) - 1
        if inset and j >= 0:
            panel = cv2.imdecode(record["insets"][j][1], cv2.IMREAD_COLOR)
            if panel is not None:
                combined[:, size[0]:] = cv2.resize(panel, (panel_w, size[1]))
        for text, x in (("", 16), ("webcam eye tracker", size[0] + 16)):
            if x < out_size[0]:
                cv2.putText(combined, text, (x, size[1] - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4, cv2.LINE_AA)
                cv2.putText(combined, text, (x, size[1] - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                            (255, 255, 255), 1, cv2.LINE_AA)
        writer.write(combined)
    writer.release()
    video.release()

    for _, x, y, _ in samples:
        if 0 <= x * k < size[0] and 0 <= y * k < size[1]:
            heat[int(y * k) // HEAT_SCALE, int(x * k) // HEAT_SCALE] += 1
    summary = render_heatmap(middle, heat, radius) if middle is not None else None
    if summary is not None:
        cv2.imwrite(str(HEATMAP_DIR / f"{stem}_summary.png"), summary)
    with open(HEATMAP_DIR / f"{stem}_points.csv", "w") as file:
        file.write("video_seconds,x_video_px,y_video_px,eye_distance_mm\n")
        file.writelines(f"{t:.3f},{x:.1f},{y:.1f},{d:.0f}\n" for t, x, y, d in samples)

    folder = HEATMAP_DIR.resolve()
    print(f"Saved in {folder}:\n  {stem}_gaze.mp4\n  {stem}_summary.png\n  {stem}_points.csv")
    print(f"For a GIF: ffmpeg -i {HEATMAP_DIR}/{stem}_gaze.mp4 -vf "
          f"\"fps=12,scale=900:-1:flags=lanczos\" {HEATMAP_DIR}/{stem}.gif")
    return summary, folder, stem


def run_video(args, models, face_model):
    record = record_video_gaze(args, models, face_model, args.video)
    if record is None or not record["samples"]:
        print("No gaze recorded, nothing saved.")
        return
    print("Rendering the gaze video...")
    summary, folder, stem = render_video_gaze(args.video, record, args.blob_deg, inset=not args.no_inset)
    if summary is not None:
        view = summary.copy()
        for k, line in enumerate([f"Saved in {folder}", f"{stem}_gaze.mp4 (trail video), _summary.png",
                                  "any key = close"]):
            cv2.putText(view, line, (16, 34 + 30 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
            cv2.putText(view, line, (16, 34 + 30 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1)
        cv2.imshow("GazeMap result", view)
        cv2.waitKey(0)
        cv2.destroyAllWindows()


def run_image(args, models, face_model):
    detect = make_landmarker()
    frame = cv2.imread(args.image)
    if frame is None:
        raise FileNotFoundError(args.image)
    h, w = frame.shape[:2]
    camera_matrix = default_camera_matrix(w, h, args.focal)
    out = process_frame(frame, detect, 0, face_model, camera_matrix, models,
                        (load_calibration() or {}).get("offsets"))
    if out is None:
        print("No face found.")
        return
    results, _ = out
    draw(frame, camera_matrix, results)
    draw_eye_patches(frame, results)
    print(gaze_text(results))
    out_path = str(Path(args.image).with_name(Path(args.image).stem + "_gaze.jpg"))
    cv2.imwrite(out_path, frame)
    print("Saved:", out_path)


def run_selftest(args, models, face_model):
    person = args.selftest_person
    base = Path("dataset/Data/Original") / person
    camera_matrix = loadmat(str(base / "Calibration" / "Camera.mat"))["cameraMatrix"]
    frames = []
    for day in sorted(p for p in base.iterdir() if p.name.startswith("day")):
        annotation = np.loadtxt(day / "annotation.txt", ndmin=2)
        for i, row in enumerate(annotation[: args.selftest_frames]):
            image = cv2.imread(str(day / f"{i + 1:04d}.jpg"))
            if image is not None:
                frames.append((image, row))

    def run(offsets, subset):
        errors = []
        for image, row in subset:
            head_rotation = cv2.Rodrigues(row[29:32])[0]
            centers = (row[35:38], row[38:41])
            results = estimate_gaze(image, camera_matrix, head_rotation, centers, models, offsets)
            for r in results:
                truth = row[26:29] - r["center"]
                errors.append(np.degrees(np.arccos(np.clip(r["gaze"] @ truth / np.linalg.norm(truth), -1, 1))))
        return np.mean(errors)

    print(f"Self-test on {person}: {len(frames)} frames, mean angular error {run(None, frames):.2f} deg")

    calib, test = frames[:9], frames[9:]
    samples = []
    for k, (image, row) in enumerate(calib):
        head_rotation = cv2.Rodrigues(row[29:32])[0]
        for r in estimate_gaze(image, camera_matrix, head_rotation, (row[35:38], row[38:41]), models):
            samples.append((k, r["name"], r["raw"], calibration_target_angles(r, row[26:29])))
    offsets = fit_offsets(samples)
    print(f"Calibration check: 9 frames -> remaining {len(test)} frames: "
          f"{run(None, test):.2f} deg without, {run(offsets, test):.2f} deg with calibration")
    print("Note: if these models were trained with this person included, the error is optimistic.")


def run_eye_assessment(args, models, face_model):
    import attention_assessment

    assessment_type = getattr(args, "assessment_type", "attention")
    memory_tracking_assessment = None
    if assessment_type == "saccadic":
        import saccadic_assessment
        smooth_pursuit_assessment = None
        blink_monitoring = None
    elif assessment_type == "smooth_pursuit":
        import smooth_pursuit_assessment
        saccadic_assessment = None
        blink_monitoring = None
    elif assessment_type == "blink_monitoring":
        import blink_monitoring
        saccadic_assessment = None
        smooth_pursuit_assessment = None
    elif assessment_type == "memory_tracking":
        # A. NEW: import the memory tracker
        import memory_tracking_assessment
        saccadic_assessment = None
        smooth_pursuit_assessment = None
        blink_monitoring = None
    else:
        saccadic_assessment = None
        smooth_pursuit_assessment = None
        blink_monitoring = None

    session_id = getattr(
        args,
        "assessment_session_id",
        getattr(args, "attention_session_id", None),
    )
    results_dir = Path(args.attention_results_dir)
    status_path = results_dir / f"{session_id}.status.json"
    result_path = results_dir / f"{session_id}.json"
    cancel_path = Path(args.attention_cancel_file)
    target_count = (
        saccadic_assessment.TRIAL_COUNT
        if assessment_type == "saccadic" and saccadic_assessment is not None
        else 9
    )
    results_dir.mkdir(parents=True, exist_ok=True)

    def update_status(status, message, progress=0, target_index=0):
        attention_assessment.write_json_atomic(status_path, {
            "sessionId": session_id,
            "status": status,
            "message": message,
            "progress": progress,
            "targetIndex": target_index,
            "targetCount": target_count,
        })

    session_started_at = datetime.datetime.now(
        datetime.timezone.utc
    ).isoformat()
    session_start = None
    cap = None
    samples = []
    targets = []
    error_message = None
    final_status = "failed"
    screen_data = {"widthPx": None, "heightPx": None}
    calibration_data = {
        "available": False,
        "mappingMethod": None,
        "calibrationPointCount": 0,
    }

    try:
        update_status("preparing", "Loading saved gaze calibration.")
        calibration = load_calibration()
        if not calibration or not calibration.get("offsets"):
            raise RuntimeError(
                "No saved GazeMap calibration was found. Run "
                "'python gaze_demo.py --calibrate' before this assessment."
            )

        calibration_data = {
            "available": True,
            "mappingMethod": (
                calibration["mapping"].get("method")
                if calibration.get("mapping") else "uncalibrated-screen-map"
            ),
            "calibrationPointCount": len(calibration.get("points", [])),
        }

        update_status("preparing", "Opening the webcam and stimulus window.")
        detect = make_landmarker()
        cap = open_camera(args.camera)
        window = f"BrainGuard {assessment_type.title()} Assessment"
        width, height = open_fullscreen(window)
        screen = Screen(
            width,
            height,
            args.screen_width_mm,
            args.camera_offset_mm,
        )
        screen_data = {"widthPx": width, "heightPx": height}

        if assessment_type == "saccadic":
            from saccadic_assessment import make_split_screen

            instruction = make_split_screen(width, height)
            lines = [
                "SACCADIC EYE MOVEMENT TEST",
                "Keep your head still and follow each target with your eyes.",
                "Fixate the center mark, then look quickly at the side target.",
                "Press SPACE to begin. Press ESC to cancel.",
            ]
        elif assessment_type == "smooth_pursuit":
            instruction = np.zeros((height, width, 3), np.uint8)
            lines = [
                "SMOOTH PURSUIT TEST",
                "Keep your head still and follow the moving target smoothly.",
                "Do not try to predict where the target will move.",
                "Press SPACE to begin. Press ESC to cancel.",
            ]
        elif assessment_type == "blink_monitoring":
            instruction = np.zeros((height, width, 3), np.uint8)
            lines = [
                "BLINK AND FATIGUE MONITORING",
                "Position your face comfortably in front of the camera.",
                "Keep your eyes naturally open and blink normally.",
                "Do not deliberately change your blinking pattern.",
                "Press SPACE to begin. Press ESC to cancel.",
            ]
        elif assessment_type == "memory_tracking":
            instruction = np.zeros((height, width, 3), np.uint8)
            lines = [
                "MEMORY TRACKING TEST",
                "You will study 8 words, then answer whether you recognize them.",
                "Keep your head still and look at the words as they appear.",
                "Press SPACE to begin. Press ESC to cancel.",
            ]
        else:
            instruction = np.zeros((height, width, 3), np.uint8)
            lines = [
                "ATTENTION TRACKING TEST",
                "Keep your head still and follow each target with your eyes.",
                "Look at the center fixation mark between targets.",
                "Press SPACE to begin. Press ESC to cancel.",
            ]

        for index, line in enumerate(lines):
            scale = 1.0 if index == 0 else 0.7
            text_width = cv2.getTextSize(
                line, cv2.FONT_HERSHEY_SIMPLEX, scale, 2
            )[0][0]
            cv2.putText(
                instruction,
                line,
                ((width - text_width) // 2, height // 2 - 70 + index * 45),
                cv2.FONT_HERSHEY_SIMPLEX,
                scale,
                (255, 255, 255),
                2,
            )
        cv2.imshow(window, instruction)
        update_status(
            "ready",
            f"{assessment_type.title()} assessment ready in the GazeMap window.",
        )

        if getattr(
            args,
            "assessment_auto_start",
            getattr(args, "attention_auto_start", False),
        ):
            session_start = time.perf_counter()
            session_started_at = datetime.datetime.now(
                datetime.timezone.utc
            ).isoformat()
        else:
            while True:
                if cancel_path.exists():
                    final_status = "incomplete"
                    error_message = "The assessment was cancelled by the website."
                    break
                key = cv2.waitKey(30) & 0xFF
                if key == 27:
                    final_status = "incomplete"
                    error_message = "The assessment was cancelled before it started."
                    break
                if key == ord(" "):
                    session_start = time.perf_counter()
                    session_started_at = datetime.datetime.now(
                        datetime.timezone.utc
                    ).isoformat()
                    break

        if session_start is not None:

            if assessment_type == "smooth_pursuit":
                # --- SMOOTH PURSUIT LOGIC ---
                duration_seconds = 30.0
                amplitude = width * 0.35
                frequency = 0.15
                pipeline_start = time.perf_counter()
                update_status("running", "Smooth Pursuit assessment in progress.", 0, 1)

                while True:
                    now = time.perf_counter()
                    elapsed = now - session_start
                    if elapsed >= duration_seconds:
                        break

                    if cancel_path.exists():
                        final_status = "incomplete"
                        error_message = "The assessment was cancelled."
                        break

                    # 1. Calculate and Draw Target
                    tx = (width / 2) + amplitude * np.sin(2 * np.pi * frequency * elapsed)
                    ty = height / 2

                    canvas = np.zeros((height, width, 3), np.uint8)
                    cv2.circle(canvas, (int(tx), int(ty)), 18, (255, 255, 255), -1)
                    cv2.circle(canvas, (int(tx), int(ty)), 4, (0, 0, 255), -1)

                    # Draw UI
                    remaining = max(0, int(duration_seconds - elapsed + 0.99))
                    cv2.putText(canvas, f"Time remaining: {remaining}s", (max(30, width - 260), 45), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                    progress = int((elapsed / duration_seconds) * 100)
                    cv2.rectangle(canvas, (30, 60), (230, 76), (90, 90, 90), 1)
                    cv2.rectangle(canvas, (31, 61), (31 + int(197 * progress / 100), 75), (40, 200, 120), -1)

                    cv2.imshow(window, canvas)
                    if (cv2.waitKey(1) & 0xFF) == 27:
                        final_status = "incomplete"
                        break

                    # 2. Read Webcam and Process Gaze
                    ok, frame = cap.read()
                    if not ok: continue

                    captured_at = time.perf_counter()
                    captured_seconds = captured_at - session_start
                    frame_height, frame_width = frame.shape[:2]
                    camera_matrix = default_camera_matrix(frame_width, frame_height)

                    output = process_frame(frame, detect, int((captured_at - pipeline_start) * 1000), face_model, camera_matrix, models, calibration["offsets"])

                    if output is None:
                        samples.append({
                            "timeSeconds": captured_seconds,
                            "xPx": None,
                            "yPx": None,
                            "targetXPx": tx,
                            "targetYPx": ty,
                            "valid": False,
                            "onScreen": False,
                            "distanceMm": None
                        })
                    else:
                        position, distance_mm = gaze_on_screen(output[0], calibration["offsets"], calibration.get("mapping"), screen)
                        if position is None:
                            samples.append({
                                "timeSeconds": captured_seconds,
                                "xPx": None,
                                "yPx": None,
                                "targetXPx": tx,
                                "targetYPx": ty,
                                "valid": False,
                                "onScreen": False,
                                "distanceMm": distance_mm if distance_mm is not None else None
                            })
                        else:
                            gx = float(position[0] * width)
                            gy = float(position[1] * height)
                            valid = np.isfinite(gx) and np.isfinite(gy)
                            on_screen = valid and 0 <= gx < width and 0 <= gy < height
                            samples.append({
                                "timeSeconds": captured_seconds,
                                "xPx": gx if valid else None,
                                "yPx": gy if valid else None,
                                "targetXPx": tx,
                                "targetYPx": ty,
                                "valid": bool(valid),
                                "onScreen": bool(on_screen),
                                "distanceMm": distance_mm if distance_mm is not None else None
                            })

                final_status = "completed"
                # Smooth pursuit already ran its own loop above.
                # Provide empty timeline/targets so the shared saccadic/attention
                # block below safely skips without raising NameError.
                timeline = []
                targets = []

            elif assessment_type == "blink_monitoring":
                duration_seconds = 30.0
                pipeline_start = time.perf_counter()
                update_status("running", "Blink monitoring in progress.", 0, 1)

                # Text paragraph for the user to read
                paragraph = [
                    "Please read the following text naturally",
                    "while the assessment runs. Keep your head",
                    "still, keep your eyes open, and blink normally.",
                    "",
                    "The quick brown fox jumps over the lazy dog.",
                    "Pack my box with five dozen liquor jugs.",
                    "How vexingly quick daft zebras jump!",
                    "Sphinx of black quartz, judge my vow.",
                    "Two driven jocks help fax my big quiz.",
                    "In a hole in the ground there lived a hobbit.",
                    "Not a nasty, dirty, wet hole, filled with the",
                    "ends of worms and an oozy smell, nor yet a",
                    "dry, bare, sandy hole with nothing in it.",
                    "",
                    "Continue reading until the timer finishes."
                ]

                while True:
                    now = time.perf_counter()
                    elapsed = now - session_start
                    if elapsed >= duration_seconds:
                        break
                    if cancel_path.exists():
                        final_status = "incomplete"
                        error_message = "Cancelled by website."
                        break

                    ok, frame = cap.read()
                    if not ok:
                        continue

                    captured_at = time.perf_counter()
                    captured_seconds = captured_at - session_start

                    # 1. Detect landmarks
                    points = detect(frame, int((captured_at - pipeline_start) * 1000))
                    full = detect.last_full_landmarks

                    # 2. Create the white background canvas
                    canvas = np.full((height, width, 3), 255, np.uint8)
                    
                    # 3. Draw the reading paragraph (Black text)
                    font = cv2.FONT_HERSHEY_SIMPLEX
                    y_offset = 220  # Pushed down to avoid the top-left corner eye previews
                    for line in paragraph:
                        if line == "":
                            y_offset += 20
                            continue
                        # Center the text
                        text_size = cv2.getTextSize(line, font, 1.0, 2)[0]
                        x_offset = (width - text_size[0]) // 2
                        cv2.putText(canvas, line, (x_offset, y_offset), font, 1.0, (0, 0, 0), 2)
                        y_offset += 45

                    # 4. Process Eye Previews and Landmarks
                    left_ear = None
                    right_ear = None
                    
                    if full is not None and blink_monitoring is not None:
                        l_pts = [full[i] for i in blink_monitoring.LEFT_EYE_EAR_INDICES]
                        r_pts = [full[i] for i in blink_monitoring.RIGHT_EYE_EAR_INDICES]

                        left_ear = blink_monitoring.ear(l_pts)
                        right_ear = blink_monitoring.ear(r_pts)

                        # Define bounding boxes for crops (with padding)
                        def get_bounds(pts, pad=25):
                            xs = [p[0] for p in pts]
                            ys = [p[1] for p in pts]
                            return (max(0, int(min(xs)) - pad), 
                                    min(frame.shape[1], int(max(xs)) + pad), 
                                    max(0, int(min(ys)) - pad), 
                                    min(frame.shape[0], int(max(ys)) + pad))

                        l_min_x, l_max_x, l_min_y, l_max_y = get_bounds(l_pts)
                        r_min_x, r_max_x, r_min_y, r_max_y = get_bounds(r_pts)

                        # Crop and resize eyes
                        l_crop = frame[l_min_y:l_max_y, l_min_x:l_max_x]
                        r_crop = frame[r_min_y:r_max_y, r_min_x:r_max_x]
                        
                        target_w, target_h = 240, 120
                        
                        if l_crop.size > 0 and r_crop.size > 0:
                            # Flip horizontally to act like a mirror
                            l_resized = cv2.flip(cv2.resize(l_crop, (target_w, target_h)), 1)
                            r_resized = cv2.flip(cv2.resize(r_crop, (target_w, target_h)), 1)

                            # Paste onto top-left corner
                            c_x = 30
                            c_y = 30
                            canvas[c_y:c_y+target_h, c_x:c_x+target_w] = l_resized
                            
                            c_x_r = c_x + 260
                            canvas[c_y:c_y+target_h, c_x_r:c_x_r+target_w] = r_resized

                            # Function to map original coordinates to resized AND flipped crop
                            def scale_pt(pt, min_x, min_y, orig_w, orig_h):
                                x = int((pt[0] - min_x) * target_w / orig_w)
                                y = int((pt[1] - min_y) * target_h / orig_h)
                                return target_w - x, y  # Invert X because the image is flipped

                            # Draw Left Eye Lines & Points
                            l_orig_w = l_max_x - l_min_x
                            l_orig_h = l_max_y - l_min_y
                            s_l = [scale_pt(p, l_min_x, l_min_y, l_orig_w, l_orig_h) for p in l_pts]
                            
                            # Draw lines (P1-P4, P2-P6, P3-P5)
                            cv2.line(canvas, (s_l[0][0]+c_x, s_l[0][1]+c_y), (s_l[3][0]+c_x, s_l[3][1]+c_y), (0, 255, 255), 1)
                            cv2.line(canvas, (s_l[1][0]+c_x, s_l[1][1]+c_y), (s_l[5][0]+c_x, s_l[5][1]+c_y), (0, 255, 255), 1)
                            cv2.line(canvas, (s_l[2][0]+c_x, s_l[2][1]+c_y), (s_l[4][0]+c_x, s_l[4][1]+c_y), (0, 255, 255), 1)
                            
                            # Draw points and labels
                            for i, p in enumerate(s_l):
                                cv2.circle(canvas, (p[0]+c_x, p[1]+c_y), 3, (0, 0, 255), -1)
                                cv2.putText(canvas, f"P{i+1}", (p[0]+c_x-15, p[1]+c_y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)

                            # Draw Right Eye Lines & Points
                            r_orig_w = r_max_x - r_min_x
                            r_orig_h = r_max_y - r_min_y
                            s_r = [scale_pt(p, r_min_x, r_min_y, r_orig_w, r_orig_h) for p in r_pts]
                            
                            cv2.line(canvas, (s_r[0][0]+c_x_r, s_r[0][1]+c_y), (s_r[3][0]+c_x_r, s_r[3][1]+c_y), (0, 255, 255), 1)
                            cv2.line(canvas, (s_r[1][0]+c_x_r, s_r[1][1]+c_y), (s_r[5][0]+c_x_r, s_r[5][1]+c_y), (0, 255, 255), 1)
                            cv2.line(canvas, (s_r[2][0]+c_x_r, s_r[2][1]+c_y), (s_r[4][0]+c_x_r, s_r[4][1]+c_y), (0, 255, 255), 1)
                            
                            for i, p in enumerate(s_r):
                                cv2.circle(canvas, (p[0]+c_x_r, p[1]+c_y), 3, (0, 0, 255), -1)
                                cv2.putText(canvas, f"P{i+1}", (p[0]+c_x_r-15, p[1]+c_y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)

                            # Add numericals
                            l_text = f"Left EAR: {left_ear:.2f}" if left_ear else "Left EAR: ---"
                            r_text = f"Right EAR: {right_ear:.2f}" if right_ear else "Right EAR: ---"
                            cv2.putText(canvas, l_text, (c_x, c_y + target_h + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
                            cv2.putText(canvas, r_text, (c_x_r, c_y + target_h + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

                    # 5. Save the sample to the list
                    vals = [v for v in (left_ear, right_ear) if v is not None and np.isfinite(v)]
                    avg_ear = float(np.mean(vals)) if vals else None
                    face_ok = points is not None
                    valid = face_ok and avg_ear is not None

                    samples.append({
                        "timeSeconds": captured_seconds,
                        "leftEAR": left_ear if left_ear is not None else None,
                        "rightEAR": right_ear if right_ear is not None else None,
                        "avgEAR": avg_ear,
                        "faceDetected": face_ok,
                        "valid": valid,
                    })

                    # 6. Draw UI Overlay (Time remaining & Progress Bar)
                    remaining = max(0, int(duration_seconds - elapsed + 0.99))
                    cv2.putText(canvas, f"Time remaining: {remaining}s", (width - 350, height - 50), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
                    
                    progress = int((elapsed / duration_seconds) * 100)
                    cv2.rectangle(canvas, (50, height - 70), (350, height - 50), (0, 0, 0), 2)
                    cv2.rectangle(canvas, (52, height - 68), (52 + int(296 * progress / 100), height - 52), (40, 200, 120), -1)

                    cv2.imshow(window, canvas)
                    if (cv2.waitKey(1) & 0xFF) == 27:
                        final_status = "incomplete"
                        error_message = "Cancelled by user."
                        break

                final_status = "completed"
                timeline = []
                targets = []

            elif assessment_type == "memory_tracking":
                # --- MEMORY TRACKING LOGIC ---
                duration_seconds = 60.0
                pipeline_start = time.perf_counter()
                update_status("running", "Memory Assessment starting.", 0, 1)

                # 10 Words for Encoding (Old) + 10 Words for Recognition (New)
                words_old = ["APPLE", "BICYCLE", "CLOCK", "CHAIR", "CAR", "BOOK", "FLOWER", "CUP", "UMBRELLA", "CAMERA"]
                words_new = ["TRAIN", "BRIDGE", "PIANO", "ORANGE", "RIVER", "MOUNTAIN", "PENCIL", "WINDOW", "PLANT", "TELEPHONE"]

                import random
                old_encoded = random.sample(words_old, 8)

                # Build recognition trials (8 old + 8 new = 16 total)
                recognition_trials = [(w, True) for w in old_encoded] + [(w, False) for w in random.sample(words_new, 8)]
                random.shuffle(recognition_trials)

                trials_data = []
                # samples is the outer list; we append every gaze sample there.

                def add_sample(cx, cy, valid, phase, img_id):
                    samples.append({
                        "timeSeconds": round(time.perf_counter() - session_start, 3),
                        "xPx": cx, "yPx": cy, "valid": valid,
                        "phase": phase, "imageId": img_id
                    })

                def process_frame_gaze(elapsed_sec, phase, img_id):
                    ok, frame = cap.read()
                    if not ok: return None, None
                    cam_h, cam_w = frame.shape[:2]
                    cam_matrix = default_camera_matrix(cam_w, cam_h)
                    out = process_frame(frame, detect, int((time.perf_counter() - pipeline_start) * 1000), face_model, cam_matrix, models, calibration["offsets"])
                    if out is None:
                        add_sample(None, None, False, phase, img_id)
                        return None, None
                    pos, dist = gaze_on_screen(out[0], calibration["offsets"], calibration.get("mapping"), screen)
                    if pos is None:
                        add_sample(None, None, False, phase, img_id)
                        return None, dist
                    gx, gy = float(pos[0] * width), float(pos[1] * height)
                    val = np.isfinite(gx) and np.isfinite(gy)
                    add_sample(gx if val else None, gy if val else None, bool(val), phase, img_id)
                    return (gx, gy), dist

                # --- STAGE 1: ENCODING (8 images, 3s each) ---
                img_w, img_h = 600, 400
                img_x = (width - img_w) // 2
                img_y = (height - img_h) // 2

                for i, word in enumerate(old_encoded):
                    update_status("running", f"Encoding image {i+1}/8", int((i/8)*30), i+1)

                    trial_samples = []
                    start_t = time.perf_counter()
                    while time.perf_counter() - start_t < 3.0:
                        elapsed = time.perf_counter() - start_t
                        canvas = np.zeros((height, width, 3), np.uint8)
                        # Draw Image Box
                        cv2.rectangle(canvas, (img_x, img_y), (img_x+img_w, img_y+img_h), (200, 200, 200), -1)
                        cv2.rectangle(canvas, (img_x, img_y), (img_x+img_w, img_y+img_h), (255, 255, 255), 4)
                        cv2.putText(canvas, word, (img_x+50, img_y+220), cv2.FONT_HERSHEY_SIMPLEX, 3.0, (0,0,0), 6)

                        # Progress bar
                        cv2.putText(canvas, f"Study {i+1} / 8", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255,255,255), 2)
                        cv2.imshow(window, canvas)
                        cv2.waitKey(1)

                        pos, dist = process_frame_gaze(elapsed, "encoding", word)
                        if pos: trial_samples.append(pos)

                    # Very simple fixation logic for encoding
                    # If they looked near the text box, count it as a fixation
                    fix_count = sum(1 for p in trial_samples if img_x <= p[0] <= img_x+img_w and img_y <= p[1] <= img_y+img_h)

                    trials_data.append({
                        "imageId": word, "phase": "encoding", "isOld": True,
                        "userResponse": None, "isCorrect": None, "responseTimeMs": None,
                        "fixationCount": fix_count, "fixationDurationMs": fix_count * 33.3 # approx
                    })

                    # Inter-stimulus blank
                    canvas = np.zeros((height, width, 3), np.uint8)
                    cv2.imshow(window, canvas)
                    cv2.waitKey(200)

                # --- STAGE 2: RETENTION (5 seconds) ---
                update_status("running", "Retention Interval (Blank Screen)", 40, 1)
                start_t = time.perf_counter()
                while time.perf_counter() - start_t < 5.0:
                    canvas = np.zeros((height, width, 3), np.uint8)
                    cv2.putText(canvas, "Wait 5 seconds...", (width//2 - 150, height//2), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (100,100,100), 2)
                    cv2.imshow(window, canvas)
                    cv2.waitKey(1)
                    process_frame_gaze(0, "retention", "blank")

                # --- STAGE 3: RECOGNITION (16 trials) ---
                for i, (word, is_old) in enumerate(recognition_trials):
                    update_status("running", f"Recognition {i+1}/16", 50 + int((i/16)*50), i+1)

                    trial_samples = []
                    start_t = time.perf_counter()
                    response = None

                    while True:
                        elapsed = time.perf_counter() - start_t
                        if elapsed > 5.0: # 5 second timeout per trial
                            break

                        canvas = np.zeros((height, width, 3), np.uint8)
                        cv2.rectangle(canvas, (img_x, img_y), (img_x+img_w, img_y+img_h), (200, 200, 200), -1)
                        cv2.putText(canvas, word, (img_x+50, img_y+220), cv2.FONT_HERSHEY_SIMPLEX, 3.0, (0,0,0), 6)

                        # Instructions
                        cv2.putText(canvas, "Have you seen this word before?", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255,255,255), 2)
                        cv2.putText(canvas, "Press Y for YES, N for NO", (50, 90), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)

                        cv2.imshow(window, canvas)
                        key = cv2.waitKey(1) & 0xFF

                        if key == ord('y') or key == ord('Y'):
                            response = "seen"
                            break
                        elif key == ord('n') or key == ord('N'):
                            response = "not_seen"
                            break
                        elif key == 27: # Esc
                            final_status = "incomplete"
                            break

                        pos, dist = process_frame_gaze(elapsed, "recognition", word)
                        if pos: trial_samples.append(pos)

                    rt_ms = round(elapsed * 1000, 1) if response else None
                    is_correct = (response == "seen" and is_old) or (response == "not_seen" and not is_old) if response else False

                    fix_count = sum(1 for p in trial_samples if img_x <= p[0] <= img_x+img_w and img_y <= p[1] <= img_y+img_h)

                    trials_data.append({
                        "imageId": word, "phase": "recognition", "isOld": is_old,
                        "userResponse": response, "isCorrect": is_correct, "responseTimeMs": rt_ms,
                        "fixationCount": fix_count, "fixationDurationMs": fix_count * 33.3
                    })

                    # Blank gap
                    canvas = np.zeros((height, width, 3), np.uint8)
                    cv2.imshow(window, canvas)
                    cv2.waitKey(200)

                final_status = "completed"
                timeline = []
                # Hand trials off to the finally block through `targets`
                targets = trials_data

            elif assessment_type == "saccadic":

                assert saccadic_assessment is not None
                targets = saccadic_assessment.create_saccadic_targets(
                    session_id, width, height
                )
                fixation_duration = (
                    saccadic_assessment.FIXATION_DURATION_SECONDS
                )
                target_duration = saccadic_assessment.TARGET_DURATION_SECONDS
                timeline = []
                for index in range(len(targets)):
                    timeline.append({
                        "kind": "fixation",
                        "targetIndex": index,
                        "duration": fixation_duration,
                    })
                    timeline.append({
                        "kind": "target",
                        "targetIndex": index,
                        "duration": target_duration,
                    })
            else:
                target_locations = [
                    (0.18, 0.18), (0.50, 0.18), (0.82, 0.18),
                    (0.18, 0.50), (0.50, 0.50), (0.82, 0.50),
                    (0.18, 0.82), (0.50, 0.82), (0.82, 0.82),
                ]
                _random.Random(session_id).shuffle(target_locations)
                targets = [
                    {
                        "id": f"target-{index + 1}",
                        "xPx": int(x_fraction * width),
                        "yPx": int(y_fraction * height),
                        "appearedAtSeconds": None,
                        "disappearedAtSeconds": None,
                    }
                    for index, (x_fraction, y_fraction)
                    in enumerate(target_locations)
                ]
                target_duration = 1.5
                fixation_gap = 0.3
                timeline = []
                for index in range(len(targets)):
                    timeline.append({
                        "kind": "target",
                        "targetIndex": index,
                        "duration": target_duration,
                    })
                    if index < len(targets) - 1:
                        timeline.append({
                            "kind": "fixation",
                            "targetIndex": index,
                            "duration": fixation_gap,
                        })

            total_duration = sum(stage["duration"] for stage in timeline)
            stage_index = 0
            phase_started = session_start
            target_index = 0
            last_status_update = 0.0
            pipeline_start = time.perf_counter()
            update_status(
                "running",
                f"{assessment_type.title()} assessment is in progress.",
                0,
                1,
            )

            while stage_index < len(timeline):
                if cancel_path.exists():
                    final_status = "incomplete"
                    error_message = "The assessment was cancelled by the website."
                    break
                now = time.perf_counter()
                elapsed = now - session_start

                stage = timeline[stage_index]
                target_index = stage["targetIndex"]
                if now - phase_started >= stage["duration"]:
                    if stage["kind"] == "target":
                        targets[target_index]["disappearedAtSeconds"] = elapsed
                    stage_index += 1
                    if stage_index >= len(timeline):
                        break
                    phase_started = now
                    stage = timeline[stage_index]
                    target_index = stage["targetIndex"]

                if assessment_type == "saccadic":
                    assert saccadic_assessment is not None
                    canvas = saccadic_assessment.make_split_screen(width, height)
                else:
                    canvas = np.zeros((height, width, 3), np.uint8)

                current_target = None
                if stage["kind"] == "target":
                    current_target = targets[target_index]
                    if current_target["appearedAtSeconds"] is None:
                        current_target["appearedAtSeconds"] = elapsed
                    center = (current_target["xPx"], current_target["yPx"])
                    cv2.circle(canvas, center, 18, (255, 255, 255), -1)
                    cv2.circle(canvas, center, 4, (0, 0, 255), -1)
                else:
                    if (
                        assessment_type == "saccadic"
                        and targets[target_index]["cueOnsetAtSeconds"] is None
                    ):
                        targets[target_index]["cueOnsetAtSeconds"] = elapsed
                    center = (width // 2, height // 2)
                    cv2.circle(canvas, center, 10, (255, 255, 255), 2)

                phase_progress = (
                    min((now - phase_started) / stage["duration"], 1.0)
                    if stage["kind"] == "target"
                    else (0.0 if assessment_type == "saccadic" else 1.0)
                )
                completed = target_index + (
                    1
                    if stage["kind"] == "fixation"
                    and assessment_type == "attention"
                    else 0
                )
                progress = int(
                    ((completed + phase_progress) / len(targets)) * 100
                )
                cv2.putText(
                    canvas,
                    (
                        f"{'Trial' if assessment_type == 'saccadic' else 'Target'} "
                        f"{min(target_index + 1, len(targets))} / {len(targets)}"
                    ),
                    (30, 45),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (255, 255, 255),
                    2,
                )
                remaining_seconds = max(
                    0, int(total_duration - elapsed + 0.99)
                )
                cv2.putText(
                    canvas,
                    f"Time remaining: {remaining_seconds}s",
                    (max(30, width - 260), 45),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (255, 255, 255),
                    2,
                )
                cv2.rectangle(
                    canvas, (30, 60), (230, 76), (90, 90, 90), 1
                )
                cv2.rectangle(
                    canvas,
                    (31, 61),
                    (31 + int(197 * progress / 100), 75),
                    (40, 200, 120),
                    -1,
                )
                cv2.imshow(window, canvas)
                key = cv2.waitKey(1) & 0xFF
                if key == 27:
                    final_status = "incomplete"
                    error_message = "The assessment was cancelled by the user."
                    break

                ok, frame = cap.read()
                captured_at = time.perf_counter()
                captured_seconds = captured_at - session_start
                if not ok:
                    samples.append({
                        "timeSeconds": captured_seconds,
                        "xPx": None,
                        "yPx": None,
                        "valid": False,
                        "onScreen": False,
                        "distanceMm": None,
                        "reason": "camera_frame_unavailable",
                    })
                    final_status = "incomplete"
                    error_message = "The webcam stopped returning frames."
                    break

                frame_height, frame_width = frame.shape[:2]
                camera_matrix = default_camera_matrix(frame_width, frame_height)
                try:
                    output = process_frame(
                        frame,
                        detect,
                        int((captured_at - pipeline_start) * 1000),
                        face_model,
                        camera_matrix,
                        models,
                        calibration["offsets"],
                    )
                except Exception:
                    samples.append({
                        "timeSeconds": captured_seconds,
                        "xPx": None,
                        "yPx": None,
                        "valid": False,
                        "onScreen": False,
                        "distanceMm": None,
                        "reason": "gaze_processing_error",
                    })
                    raise
                if output is None:
                    samples.append({
                        "timeSeconds": captured_seconds,
                        "xPx": None,
                        "yPx": None,
                        "valid": False,
                        "onScreen": False,
                        "distanceMm": None,
                        "reason": "face_not_detected",
                    })
                else:
                    position, distance_mm = gaze_on_screen(
                        output[0],
                        calibration["offsets"],
                        calibration.get("mapping"),
                        screen,
                    )
                    if position is None:
                        samples.append({
                            "timeSeconds": captured_seconds,
                            "xPx": None,
                            "yPx": None,
                            "valid": False,
                            "onScreen": False,
                            "distanceMm": (
                                float(distance_mm) if distance_mm is not None else None
                            ),
                            "reason": "gaze_projection_unavailable",
                        })
                    else:
                        x_px = float(position[0] * width)
                        y_px = float(position[1] * height)
                        valid = np.isfinite(x_px) and np.isfinite(y_px)
                        on_screen = (
                            valid and 0 <= x_px < width and 0 <= y_px < height
                        )
                        samples.append({
                            "timeSeconds": captured_seconds,
                            "xPx": x_px if valid else None,
                            "yPx": y_px if valid else None,
                            "valid": bool(valid),
                            "onScreen": bool(on_screen),
                            "distanceMm": (
                                float(distance_mm) if distance_mm is not None else None
                            ),
                            "reason": None if valid else "non_finite_gaze",
                        })

                if captured_seconds - last_status_update >= 0.5:
                    update_status(
                        "running",
                        "Attention test is in progress.",
                        progress,
                        min(target_index + 1, len(targets)),
                    )
                    last_status_update = captured_seconds

            if final_status != "incomplete":
                final_status = "completed"
                
            # Safely check for target-specific keys to prevent KeyError 
            # during Memory or Blink assessments (which don't use these timestamps).
            if targets and isinstance(targets[-1], dict) and targets[-1].get("appearedAtSeconds") is not None:
                if targets[-1].get("disappearedAtSeconds") is None:
                    targets[-1]["disappearedAtSeconds"] = (
                        time.perf_counter() - session_start
                    )

    except Exception as error:
        error_message = str(error)
        final_status = "failed"
        raise
    finally:
        if cap is not None:
            cap.release()
        cv2.destroyAllWindows()

        ended_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        duration_seconds = (
            time.perf_counter() - session_start if session_start is not None else 0
        )
        mm_per_px = (
            args.screen_width_mm / screen_data["widthPx"]
            if screen_data["widthPx"] else 1
        )
        if assessment_type == "saccadic":
            assert saccadic_assessment is not None
            metrics = saccadic_assessment.calculate_saccadic_metrics(
                samples, targets, mm_per_px
            )
        elif assessment_type == "smooth_pursuit":
            assert smooth_pursuit_assessment is not None
            metrics = smooth_pursuit_assessment.calculate_smooth_pursuit_metrics(
                samples, targets, mm_per_px
            )
        elif assessment_type == "blink_monitoring":
            assert blink_monitoring is not None
            metrics = blink_monitoring.calculate_blink_metrics(samples)
        elif assessment_type == "memory_tracking":
            # D. NEW: memory metrics use (samples, trials) instead of (samples, targets)
            assert memory_tracking_assessment is not None
            metrics = memory_tracking_assessment.calculate_memory_metrics(
                samples, targets  # `targets` == trials_data for memory_tracking
            )
        else:
            metrics = attention_assessment.calculate_attention_metrics(
                samples,
                targets,
                screen_data["widthPx"] or 1,
                screen_data["heightPx"] or 1,
                mm_per_px,
            )
        result = {
            "sessionId": session_id,
            "assessmentType": assessment_type,
            "status": final_status,
            "message": error_message or (
                f"{assessment_type.title()} assessment completed."
                if final_status == "completed"
                else f"{assessment_type.title()} assessment did not complete."
            ),
            "startedAt": session_started_at,
            "endedAt": ended_at,
            "durationSeconds": round(duration_seconds, 3),
            "coordinateSpace": "gaze_map_fullscreen_window_pixels",
            "screen": screen_data,
            "calibration": calibration_data,
            "samples": samples,
            "targets": targets,
            **metrics,
        }
        attention_assessment.write_json_atomic(result_path, result)
        update_status(
            final_status,
            result["message"],
            100 if final_status == "completed" else 0,
            len(targets),
        )


def run_attention_assessment(args, models, face_model):
    return run_eye_assessment(args, models, face_model)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default="results/final/models")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--focal", type=float, default=None,
                        help="camera focal length in pixels (default: image width)")
    parser.add_argument("--calibrate", action="store_true", help="run the 13-dot calibration at start")
    parser.add_argument("--no-calibration", action="store_true", help="ignore a saved calibration.json")
    parser.add_argument("--screen-width-mm", type=float, default=345.0,
                        help="physical screen width in mm (default: MacBook Pro 16 inch, 2021)")
    parser.add_argument("--camera-offset-mm", type=float, default=5.0,
                        help="distance from the camera down to the top edge of the fullscreen window")
    parser.add_argument("--heatmap", action="store_true", help="screen heatmap mode")
    parser.add_argument("--test", action="store_true", help="16-dot accuracy test with error arrows")
    parser.add_argument("--stimulus", default=None,
                        help="image, or folder of images (slideshow), to show under the heatmap")
    parser.add_argument("--seconds", type=float, default=0,
                        help="slideshow: seconds per image, then save its heatmap and go on (0 = press n)")
    parser.add_argument("--blob-deg", type=float, default=2.0,
                        help="size of each gaze sample on the heatmap, in degrees of visual angle")
    parser.add_argument("--video", default=None,
                        help="video to watch; saves the video again with your gaze trail")
    parser.add_argument("--show-gaze", action="store_true",
                        help="video mode: show your gaze live (off by default, it pulls the eyes)")
    parser.add_argument("--no-inset", action="store_true",
                        help="video mode: leave the webcam picture out of the saved video")
    parser.add_argument("--image", default=None)
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--selftest-person", default="p12")
    parser.add_argument("--selftest-frames", type=int, default=30)
    parser.add_argument(
        "--assessment-session-id",
        "--attention-session-id",
        dest="assessment_session_id",
        default=None,
    )
    parser.add_argument(
        "--assessment-type",
        choices=("attention", "saccadic", "smooth_pursuit", "blink_monitoring", "memory_tracking"),
        default="attention",
    )
    parser.add_argument("--attention-results-dir", default=None)
    parser.add_argument("--attention-cancel-file", default=None)
    parser.add_argument(
        "--assessment-auto-start",
        "--attention-auto-start",
        dest="assessment_auto_start",
        action="store_true",
        help="start the assessment immediately (for webcam smoke tests)",
    )
    args = parser.parse_args()

    models = load_gaze_models(args.model_dir)
    face_model = load_face_model()

    if args.assessment_session_id:
        if not args.attention_results_dir or not args.attention_cancel_file:
            parser.error(
                "--attention-results-dir and --attention-cancel-file are required "
                "for an eye assessment session"
            )
        run_eye_assessment(args, models, face_model)
    elif args.selftest:
        run_selftest(args, models, face_model)
    elif args.test:
        run_test(args, models, face_model)
    elif args.video:
        run_video(args, models, face_model)
    elif args.heatmap:
        run_heatmap(args, models, face_model)
    elif args.image:
        run_image(args, models, face_model)
    else:
        run_camera(args, models, face_model)


if __name__ == "__main__":
    main()