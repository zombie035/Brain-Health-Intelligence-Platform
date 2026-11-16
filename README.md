# BrainGuard AI – Eye Assessment Monitoring (Research Prototype)

BrainGuard AI collects a self-reported health profile, then guides each assessment session through four eye-tracking tasks and produces one consolidated report.

> This is a research prototype, not a medical device. It is not clinically validated and must not be used to diagnose, screen for, or rule out any condition. Measurements can be affected by lighting, camera position, head movement, glasses, and chance. Contact a qualified healthcare professional about health concerns.

## User workflow

**Home → Health Profile → Eye Assessment → Saccadic → Smooth Pursuit → Blink and Fatigue → Memory-Based Eye Tracking → Consolidated Report → Dashboard / Assessment History**

The health profile and eye-test results are saved in MongoDB under the same assessment session. The server enforces the order and only renders the consolidated report after all four results have completed successfully.

## Architecture

```
Browser ──► Express app (Node.js, port 3000) ──► MongoDB Atlas
   │
   └──────► GazeMap service (FastAPI, port 8001): gaze tracking and eye-test analysis
Browser ◄──WebSocket── GazeMap service (/ws/gaze, live gaze data)
```

`app.js`, `routes/`, `models/`, `views/`, and `public/` contain the Express application and eye-assessment interface. `GazeMap/gaze_service.py` provides gaze estimation and analysis endpoints.

## Run locally

Requirements: Node.js 20+, Python, a MongoDB database configured with `MONGODB_URI`, and a webcam.

### 1. Start the Express application

```bash
npm install
npm start
```

Open <http://localhost:3000>.

### 2. Start the GazeMap service

Use a separate virtual environment because GazeMap installs PyTorch, OpenCV, and MediaPipe.

```bash
cd GazeMap
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn gaze_service:app --host 127.0.0.1 --port 8001
```

Set `GAZE_API_URL`, `GAZE_WS_URL`, and `BRAINGUARD_ORIGINS` if the defaults are not appropriate for your setup. GazeMap model files and the MediaPipe `face_landmarker.task` file may be downloaded on first run; see `GazeMap/README.md` if automatic downloads fail.

## Data and limitations

- Each assessment is linked to its health profile and eye results through an assessment ID; history is grouped by email.
- Accounts and authentication are not implemented. Do not expose this prototype to the internet or use it to store real health data until authentication, consent, and privacy protections are added.
- Webcam gaze accuracy depends on lighting, camera, glasses, and head pose. Comparisons are meaningful only under similar conditions.
- Eye movement and blink measurements are experimental observations, not confirmed medical findings.
- The GazeMap trained model weights are derived from MPIIGaze and are licensed CC BY-NC-SA 4.0 for non-commercial use only.

## Credits and licences

- GazeMap by Fuad Mammadov: <https://github.com/fammad/GazeMap>, included under Apache License 2.0 (see `GazeMap/LICENSE` and `GazeMap/NOTICE`).
- MediaPipe provides face landmarks.

BrainGuard's own code does not yet have a licence file; add one before accepting contributions or reuse.
