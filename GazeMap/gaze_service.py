import asyncio
import csv
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from gaze_engine import engine
from blink_monitoring import calculate_blink_metrics
from memory_tracking_assessment import calculate_memory_metrics
from saccadic_assessment import calculate_saccadic_metrics
from smooth_pursuit_assessment import calculate_smooth_pursuit_metrics

BASE_DIR = Path(__file__).resolve().parent
GAZE_DEMO = BASE_DIR / "gaze_demo.py"
HEATMAP_DIR = BASE_DIR / "heatmaps"
ASSESSMENT_RESULTS_DIR = (
    Path(tempfile.gettempdir()) / "BrainGuard" / "attention-results"
)

app = FastAPI(title="BrainGuard GazeMap API")

allowed_origins = [
    origin.strip()
    for origin in os.environ.get(
        "BRAINGUARD_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

process = None
process_log = None
session_started = None
process_lock = threading.Lock()
assessment_sessions = {}
engine_lock = threading.Lock()
websocket_guard = threading.Lock()
websocket_active = False


class RecordingRequest(BaseModel):
    stimulus: str = "test-image.jpg"
    seconds: int = Field(default=20, ge=5, le=300)


class AssessmentStartRequest(BaseModel):
    assessment_type: str = "attention"


class ScreenInitRequest(BaseModel):
    widthPx: int
    heightPx: int
    widthMm: float = 345.0


class FrameProcessRequest(BaseModel):
    imageBase64: str
    timestampMs: int
    returnRaw: bool = False
    includeEar: bool = False


class CalibrationRequest(BaseModel):
    points: list


class SaccadicAnalysisRequest(BaseModel):
    samples: list[dict] = Field(max_length=5000)
    targets: list[dict] = Field(min_length=1, max_length=12)
    mmPerPx: float = Field(gt=0, le=50)


class SmoothPursuitAnalysisRequest(BaseModel):
    samples: list[dict] = Field(max_length=5000)
    mmPerPx: float = Field(gt=0, le=50)


class BlinkAnalysisRequest(BaseModel):
    samples: list[dict] = Field(min_length=2, max_length=5000)


class MemoryAnalysisRequest(BaseModel):
    samples: list[dict] = Field(max_length=5000)
    trials: list[dict] = Field(min_length=1, max_length=24)


def _active_assessment_process():
    return any(
        session["process"].poll() is None
        for session in assessment_sessions.values()
    )


def _valid_session_id(session_id):
    return re.fullmatch(r"[0-9a-f]{32}", session_id) is not None


def _read_json(path):
    try:
        with Path(path).open("r", encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        return None


def _read_log_tail(path):
    try:
        content = Path(path).read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None
    content = content.strip()
    return content[-2000:] if content else None


def get_latest_csv():
    files = list(HEATMAP_DIR.glob("*_points.csv"))

    if not files:
        return None

    return max(files, key=lambda file: file.stat().st_mtime)


def read_gaze_csv(file_path):
    points = []

    with open(file_path, "r", newline="") as file:
        reader = csv.DictReader(file)

        for row in reader:
            try:
                points.append({
                    "seconds": float(row["seconds"]),
                    "x_px": float(row["x_px"]),
                    "y_px": float(row["y_px"])
                })
            except (ValueError, KeyError, TypeError):
                continue

    return points


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "BrainGuard GazeMap API"
    }


@app.post("/record/start")
def start_recording(request: RecordingRequest):
    global process, process_log, session_started

    with process_lock:
        if process is not None and process.poll() is None:
            raise HTTPException(
                status_code=409,
                detail="A Gaze recording is already running."
            )
        if _active_assessment_process():
            raise HTTPException(
                status_code=409,
                detail="An eye assessment is already running."
            )

    if not GAZE_DEMO.exists():
        raise HTTPException(
            status_code=500,
            detail="gaze_demo.py was not found."
        )

    stimulus_path = Path(request.stimulus)

    if stimulus_path.name != request.stimulus:
        raise HTTPException(
            status_code=400,
            detail="Provide only an image filename."
        )

    if stimulus_path.suffix.lower() not in {
        ".jpg", ".jpeg", ".png", ".webp", ".bmp"
    }:
        raise HTTPException(
            status_code=400,
            detail="Unsupported stimulus image format."
        )

    full_stimulus_path = BASE_DIR / stimulus_path

    if not full_stimulus_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Stimulus image was not found."
        )

    HEATMAP_DIR.mkdir(exist_ok=True)

    command = [
        sys.executable,
        str(GAZE_DEMO),
        "--heatmap",
        "--stimulus",
        str(full_stimulus_path),
        "--seconds",
        str(request.seconds)
    ]

    with process_lock:
        if process is not None and process.poll() is None:
            raise HTTPException(
                status_code=409,
                detail="A Gaze recording is already running."
            )
        if _active_assessment_process():
            raise HTTPException(
                status_code=409,
                detail="An eye assessment is already running."
            )
        if process_log is not None:
            process_log.close()

        process_log = open(
            BASE_DIR / "gaze_service.log",
            "a",
            encoding="utf-8"
        )

        try:
            process = subprocess.Popen(
                command,
                cwd=str(BASE_DIR),
                stdout=process_log,
                stderr=subprocess.STDOUT
            )
            session_started = time.time()
        except Exception as error:
            process_log.close()
            process_log = None
            raise HTTPException(status_code=500, detail=str(error))

    return {
        "success": True,
        "message": "Gaze recording started.",
        "duration_seconds": request.seconds,
        "process_id": process.pid
    }


@app.get("/record/status")
def recording_status():
    global process, process_log

    with process_lock:
        running = process is not None and process.poll() is None

        if not running and process_log is not None:
            process_log.close()
            process_log = None

        return {
            "running": running,
            "return_code": process.poll() if process else None
        }


@app.post("/assessment/start", status_code=202)
def start_assessment(request: AssessmentStartRequest):
    global process_log

    if request.assessment_type in {
        "smooth_pursuit",
        "blink_monitoring",
        "memory_tracking",
    }:
        assessment_name = {
            "smooth_pursuit": "Smooth pursuit",
            "blink_monitoring": "Blink monitoring",
            "memory_tracking": "Memory tracking",
        }[request.assessment_type]
        raise HTTPException(
            status_code=410,
            detail=(
                f"{assessment_name} now runs in the browser. "
                "Use the website's browser-based assessment flow."
            ),
        )

    if request.assessment_type not in {"attention", "saccadic"}:
        raise HTTPException(
            status_code=400,
            detail="Unsupported assessment type.",
        )

    target_count = 12 if request.assessment_type == "saccadic" else 9

    session_id = uuid.uuid4().hex
    ASSESSMENT_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    status_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.status.json"
    result_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.json"
    log_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.log"
    cancel_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.cancel"
    command = [
        sys.executable,
        str(GAZE_DEMO),
        "--assessment-session-id",
        session_id,
        "--assessment-type",
        request.assessment_type,
        "--attention-results-dir",
        str(ASSESSMENT_RESULTS_DIR),
        "--attention-cancel-file",
        str(cancel_path),
    ]

    with process_lock:
        if process is not None and process.poll() is None:
            raise HTTPException(
                status_code=409,
                detail="A Gaze recording is already running."
            )
        if _active_assessment_process():
            raise HTTPException(
                status_code=409,
                detail="An eye assessment is already running."
            )
        if process_log is not None:
            process_log.close()
            process_log = None

        status_path.write_text(json.dumps({
            "sessionId": session_id,
            "status": "preparing",
            "message": f"Starting the GazeMap {request.assessment_type} assessment.",
            "progress": 0,
            "targetIndex": 0,
            "targetCount": target_count,
        }), encoding="utf-8")
        log_file = log_path.open("a", encoding="utf-8")
        try:
            child_process = subprocess.Popen(
                command,
                cwd=str(BASE_DIR),
                stdout=log_file,
                stderr=subprocess.STDOUT
            )
        except Exception as error:
            log_file.close()
            status_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=str(error))

        assessment_sessions[session_id] = {
            "process": child_process,
            "status_path": status_path,
            "result_path": result_path,
            "cancel_path": cancel_path,
            "log": log_file,
        }

    return {
        "success": True,
        "sessionId": session_id,
        "status": "preparing",
        "message": f"The GazeMap {request.assessment_type} assessment is starting."
    }


@app.get("/assessment/status/{session_id}")
def assessment_status(session_id: str):
    if not _valid_session_id(session_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid assessment session ID."
        )

    with process_lock:
        session = assessment_sessions.get(session_id)
        if session is None:
            status_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.status.json"
            result_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.json"
            log_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.log"
            if not status_path.is_file():
                raise HTTPException(
                    status_code=404,
                    detail="Assessment session not found."
                )
            process_return_code = 0 if result_path.is_file() else -1
        else:
            status_path = session["status_path"]
            result_path = session["result_path"]
            log_path = session["log"].name if session["log"] is not None else (
                ASSESSMENT_RESULTS_DIR / f"{session_id}.log"
            )
            process_return_code = session["process"].poll()
            if process_return_code is not None and session["log"] is not None:
                session["log"].close()
                session["log"] = None

        status = _read_json(status_path) or {}
        result = _read_json(result_path)

        if result is not None:
            status = {
                "sessionId": session_id,
                "status": result["status"],
                "message": result["message"],
                "progress": 100 if result["status"] == "completed" else 0,
                "targetIndex": len(result.get("targets", [])),
                "targetCount": len(result.get("targets", [])),
            }
        elif process_return_code is not None:
            log_message = _read_log_tail(log_path)
            status.update({
                "status": "failed",
                "message": log_message or (
                    "The assessment process exited before saving results "
                    f"(exit code {process_return_code})."
                ),
            })

        response = {
            "success": True,
            **status,
            "running": result is None and process_return_code is None,
            "returnCode": process_return_code,
        }
        if session is not None and process_return_code is not None:
            assessment_sessions.pop(session_id, None)
        return response


@app.post("/assessment/cancel/{session_id}")
def cancel_assessment(session_id: str):
        if not _valid_session_id(session_id):
            raise HTTPException(
                status_code=400,
                detail="Invalid assessment session ID."
            )

        with process_lock:
            session = assessment_sessions.get(session_id)
            if session is None:
                raise HTTPException(status_code=404, detail="Assessment session not found.")
            if session["process"].poll() is not None:
                return {
                    "success": True,
                    "cancelRequested": False,
                    "message": "The assessment process has already ended.",
                }

            session["cancel_path"].touch()
            return {
                "success": True,
                "cancelRequested": True,
                "message": "Assessment cancellation requested.",
            }


@app.get("/assessment/results/{session_id}")
def assessment_results(session_id: str):
    if not _valid_session_id(session_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid assessment session ID."
        )

    result_path = ASSESSMENT_RESULTS_DIR / f"{session_id}.json"
    result = _read_json(result_path)
    if result is not None:
        return result

    session = assessment_sessions.get(session_id)
    if session is not None and session["process"].poll() is None:
        raise HTTPException(status_code=409, detail="Assessment is still running.")
    raise HTTPException(status_code=404, detail="Assessment results not found.")


@app.get("/sessions/latest")
def latest_session():
    csv_file = get_latest_csv()

    if csv_file is None:
        raise HTTPException(
            status_code=404,
            detail="No gaze recordings found."
        )

    points = read_gaze_csv(csv_file)

    image_file = csv_file.with_name(
        csv_file.name.replace("_points.csv", ".png")
    )

    duration = (
        points[-1]["seconds"] - points[0]["seconds"]
        if len(points) > 1 else 0
    )

    return {
        "success": True,
        "session": csv_file.name.replace("_points.csv", ""),
        "sample_count": len(points),
        "duration_seconds": round(duration, 3),
        "heatmap": image_file.name if image_file.exists() else None,
        "points": points
    }


@app.get("/heatmaps/{filename}")
def get_heatmap(filename: str):
    if Path(filename).name != filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")

    if not filename.lower().endswith(".png"):
        raise HTTPException(status_code=400, detail="Only PNG images allowed.")

    image_path = HEATMAP_DIR / filename

    if not image_path.is_file():
        raise HTTPException(status_code=404, detail="Heatmap not found.")

    return FileResponse(image_path, media_type="image/png")


# ── NEW: Live gaze engine endpoints ──────────────────────────────────

@app.post("/init_screen")
def init_screen(request: ScreenInitRequest):
    try:
        with engine_lock:
            engine.set_screen(request.widthPx, request.heightPx, request.widthMm)
            engine.reset_calibration()
        return {
            "success": True,
            "message": f"Screen set to {request.widthPx}x{request.heightPx}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/process_frame")
def process_frame_endpoint(request: FrameProcessRequest):
    return process_live_frame(
        request.imageBase64,
        request.timestampMs,
        request.returnRaw,
        request.includeEar,
    )


@app.post("/calibrate")
def calibrate_endpoint(request: CalibrationRequest):
    return calibrate_live_session(request.points)


@app.post("/saccadic/analyze")
def analyze_saccadic_assessment(request: SaccadicAnalysisRequest):
    return calculate_saccadic_metrics(
        request.samples,
        request.targets,
        request.mmPerPx,
    )


@app.post("/smooth-pursuit/analyze")
def analyze_smooth_pursuit_assessment(request: SmoothPursuitAnalysisRequest):
    return calculate_smooth_pursuit_metrics(
        request.samples,
        [],
        request.mmPerPx,
    )


@app.post("/blink/analyze")
def analyze_blink_monitoring(request: BlinkAnalysisRequest):
    return calculate_blink_metrics(request.samples)


@app.post("/memory/analyze")
def analyze_memory_tracking(request: MemoryAnalysisRequest):
    return calculate_memory_metrics(request.samples, request.trials)


def process_live_frame(image, timestamp_ms, return_raw=False, include_ear=False):
    with engine_lock:
        return engine.process_base64_frame(
            image, timestamp_ms, return_raw, include_ear
        )


def calibrate_live_session(points):
    with engine_lock:
        return engine.calibrate(points)


@app.websocket("/ws/gaze")
async def gaze_websocket(websocket: WebSocket):
    global websocket_active

    origin = websocket.headers.get("origin")
    if origin not in allowed_origins:
        await websocket.close(code=1008, reason="Origin is not allowed.")
        return

    with websocket_guard:
        if websocket_active:
            await websocket.close(code=1013, reason="A gaze session is already active.")
            return
        websocket_active = True

    try:
        await websocket.accept()
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                await websocket.send_json({
                    "type": "error",
                    "message": "Messages must be JSON objects.",
                })
                continue

            message_type = message.get("type")
            request_id = message.get("requestId")

            if message_type == "init":
                width = message.get("widthPx")
                height = message.get("heightPx")
                width_mm = message.get("widthMm", 345.0)
                if (
                    not isinstance(width, int)
                    or not isinstance(height, int)
                    or not 100 <= width <= 10000
                    or not 100 <= height <= 10000
                    or not isinstance(width_mm, (int, float))
                    or not 100 <= width_mm <= 5000
                ):
                    await websocket.send_json({
                        "type": "error",
                        "requestId": request_id,
                        "message": "Invalid screen dimensions.",
                    })
                    continue
                with engine_lock:
                    engine.set_screen(width, height, float(width_mm))
                    engine.reset_calibration()
                await websocket.send_json({
                    "type": "initialized",
                    "requestId": request_id,
                    "widthPx": width,
                    "heightPx": height,
                })
                continue

            if message_type == "frame":
                image = message.get("imageBase64")
                timestamp = message.get("timestampMs")
                if (
                    not isinstance(image, str)
                    or len(image) > 2_000_000
                    or not isinstance(timestamp, (int, float))
                    or not isinstance(message.get("returnRaw", False), bool)
                    or not isinstance(message.get("includeEar", False), bool)
                ):
                    await websocket.send_json({
                        "type": "error",
                        "requestId": request_id,
                        "message": "Invalid or oversized frame payload.",
                    })
                    continue
                result = await asyncio.to_thread(
                    process_live_frame,
                    image,
                    int(timestamp),
                    message.get("returnRaw", False),
                    message.get("includeEar", False),
                )
                await websocket.send_json({
                    "type": "frame",
                    "requestId": request_id,
                    **result,
                })
                continue

            if message_type == "calibrate":
                points = message.get("points")
                if not isinstance(points, list) or len(points) > 20:
                    await websocket.send_json({
                        "type": "error",
                        "requestId": request_id,
                        "message": "Invalid calibration point list.",
                    })
                    continue
                result = await asyncio.to_thread(calibrate_live_session, points)
                await websocket.send_json({
                    "type": "calibration",
                    "requestId": request_id,
                    **result,
                })
                continue

            await websocket.send_json({
                "type": "error",
                "requestId": request_id,
                "message": "Unsupported WebSocket message type.",
            })
    except WebSocketDisconnect:
        pass
    finally:
        with websocket_guard:
            websocket_active = False


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)