# BrainGuard AI – Eye Assessment Monitoring (Research Prototype)

BrainGuard AI collects a self-reported, option-based health questionnaire, then guides each assessment session through four eye-tracking tasks and produces one consolidated report.

> This is a research prototype, not a medical device. It is not clinically validated and must not be used to diagnose, screen for, or rule out any condition. Measurements can be affected by lighting, camera position, head movement, glasses, and chance. Contact a qualified healthcare professional about health concerns.

## User workflow

**Home → Guided Health Questionnaire → Eye Assessment → Saccadic → Smooth Pursuit → Blink and Fatigue → Memory-Based Eye Tracking → Consolidated Report → Dashboard / Assessment History**

The questionnaire presents one question at a time, saves selected options as structured responses under that assessment session, and uses local rules to show relevant follow-ups. Users can review or change answers before continuing. The server validates the selected options and only creates the assessment profile after the full applicable questionnaire is complete. Health answers are not sent to an AI provider unless separately consented to on the report page.

The health questionnaire currently displays in English. A preferred language is recorded, but translated questionnaire copy is not yet available.

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

Set `GAZE_SERVICE_URL` and `BRAINGUARD_ORIGINS` if the defaults are not appropriate for your setup. `GAZE_API_URL` remains supported as a legacy alias. Unless explicitly set, `GAZE_WS_URL` is derived from the service URL (`http` → `ws`, `https` → `wss`) and uses `/ws/gaze`. GazeMap model files and the MediaPipe `face_landmarker.task` file may be downloaded on first run; see `GazeMap/README.md` if automatic downloads fail.

The browser opens the GazeMap WebSocket only after you start an assessment and grant camera permission. If the connection fails, confirm that GazeMap is running on the configured URL and that `BRAINGUARD_ORIGINS` includes the exact site origin (by default, `http://localhost:3000` and `http://127.0.0.1:3000`).

### Deploy to Render

Deploy BrainGuard and GazeMap as two separate Render Web Services. The Node service runs from the repository root with build command `npm install` and start command `npm start`. The Python service uses `GazeMap` as its root directory, build command `pip install -r requirements.txt`, and start command `uvicorn gaze_service:app --host 0.0.0.0 --port $PORT`. Set the Python service's `PYTHON_VERSION` to `3.12.10` to match the tested project environment. The checked-in `GazeMap/requirements.txt` already includes FastAPI, `uvicorn[standard]` (including WebSocket support), PyTorch, OpenCV, and MediaPipe; keep it intact for deployment.

In the Node service environment, set `MONGODB_URI` and `GAZE_SERVICE_URL` to the deployed GazeMap service's HTTPS base URL, for example `https://your-gazemap-service.onrender.com` (no `/ws/gaze` suffix). Optionally set `GAZE_WS_URL` to its `wss://.../ws/gaze` endpoint; otherwise BrainGuard derives it from `GAZE_SERVICE_URL`. In the GazeMap service environment, set `BRAINGUARD_ORIGINS` to the exact public BrainGuard origin, such as `https://your-brainguard-site.onrender.com`, without a trailing slash. Add any custom domains you use as comma-separated origins. The browser connects directly to GazeMap over WebSocket, so setting only the server-to-server HTTP URL is not sufficient if the GazeMap origin allowlist is wrong.

The small required face-model file at `GazeMap/dataset/6 points-based face model.mat` must be included in the repository; the root ignore rules allow that file while continuing to exclude the rest of the MPIIGaze dataset. GazeMap can download the trained model weights and MediaPipe face landmarker at startup, so the first deploy or restart may take longer and requires outbound access to their download hosts. Use the Render-assigned `PORT`; do not hardcode port 8001 in its start command. Render free services may sleep while idle, making the first health check or WebSocket attempt slow; use an always-on instance for predictable assessment startup. Confirm `https://your-gazemap-service.onrender.com/health` responds before testing from BrainGuard. Camera access also requires HTTPS on the deployed BrainGuard site.

After all four eye assessments are complete, the consolidated report page offers a downloadable PDF containing the health profile, selected questionnaire answers and any available prior-session differences, measurements, calibration and tracking quality, observations, and limitations.

### Optional AI interpretation

The report page includes an AI chat assistant that can use Google Gemini, OpenAI, or DeepSeek. Configure one or more provider keys in the server's untracked `.env` file; see `.env.example` for the supported variable names and default models. Provider keys are never sent to the browser. If multiple keys are set, `AI_PROVIDER` optionally selects `gemini`, `openai`, or `deepseek`; otherwise, the first configured provider is used. Model names can be overridden with `GEMINI_MODEL`, `OPENAI_MODEL`, and `DEEPSEEK_MODEL`.

The user must explicitly consent before each AI request. The standard consent sends de-identified derived eye measurements, tracking quality, supported eye-measurement baseline summaries, and chat messages; it does not send the name, email, camera frames, or raw gaze samples. A separate optional consent includes structured self-reported questionnaire answers and any available previous-session answer comparison. The AI is used for an optional final report interpretation, not for choosing follow-up questions. Users should not include identifying details in chat messages. AI output is informational, not a medical assessment. Eye-measurement baselines are calculated from prior sessions associated with the same email address and require at least two recorded values per measurement. Questionnaire comparisons report differences in selected answers only and do not imply clinical change.

The **Watch Integration** option is a placeholder; smartwatch connectivity and health-data monitoring are not implemented yet.

The **Send Report to Doctor** form requires explicit approval, then downloads the PDF and opens an email draft. BrainGuard does not send email or share a public report link. Review the draft, attach the PDF, and send it manually if appropriate.

## Health calendar

The Calendar page stores assessment sessions, manually entered appointments, and follow-up reminders in MongoDB. It supports month, week, and upcoming views; editing, cancellation, completion status, and bounded repeat schedules (up to 12 occurrences). Event dates are submitted as UTC instants with the browser's IANA time-zone identifier. Upcoming and overdue items are shown in the app; email, push, and provider-contact reminders are not sent.

Calendar lookup uses an assessment email because this prototype has no accounts. This is not authentication or secure user-specific access: anyone who knows an assessment email or has its calendar URL may be able to view or change events. Do not use this feature with real health information or confidential appointment notes, and do not expose the prototype to the internet until authentication and suitable privacy protections are added. Scheduling always requires the user to review and submit an event; no appointment is booked automatically.

## Eye assessments

All four tasks run in the browser with on-page calibration where applicable. In this flow, the FastAPI service processes browser-captured frames and does not open a second camera window.

- **Saccadic:** 12 center-to-side target trials; reports measured gaze, target acquisition, and response timing when sample quality supports them.
- **Smooth pursuit:** a 30-second moving-target task with five tracking cycles.
- **Blink and fatigue:** approximately 30 seconds of eye-openness sampling and blink/closure analysis.
- **Memory-based tracking:** eight encoding words, a five-second retention interval, and 16 recognition trials with gaze samples.

These are experimental observations, not clinically validated measurements.

## Data and limitations

- Each assessment is linked to its structured health-questionnaire responses and eye results through an assessment ID; history is grouped by email.
- Accounts and authentication are not implemented. Report and AI endpoints are not access-controlled; do not expose this prototype to the internet or use it with real health data until authentication and suitable privacy protections are added.
- Webcam gaze accuracy depends on lighting, camera, glasses, and head pose. Comparisons are meaningful only under similar conditions.
- Eye movement and blink measurements are experimental observations, not confirmed medical findings.
- The GazeMap trained model weights are derived from MPIIGaze and are licensed CC BY-NC-SA 4.0 for non-commercial use only.

## Credits and licences

- GazeMap by Fuad Mammadov: <https://github.com/fammad/GazeMap>, included under Apache License 2.0 (see `GazeMap/LICENSE` and `GazeMap/NOTICE`).
- MediaPipe provides face landmarks.

BrainGuard's own code does not yet have a licence file; add one before accepting contributions or reuse.
