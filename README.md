# Brain-Health-Intelligence-Platform

## Browser-Based Attention Tracking

The Attention Tracking Test uses the GazeMap models and performs camera capture,
calibration, live gaze tracking, and heatmap visualization in the browser. Start
the FastAPI service from the `GazeMap` directory (it processes submitted browser
frames and does not open a camera window):

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn gaze_service:app --host 127.0.0.1 --port 8001
```

In another terminal at the repository root, start the website and open **Eye
Assessment → Attention Tracking Test**:

```powershell
node app.js
```

Click **Start Test** and grant camera access. The webpage calibrates to nine
on-screen points, tracks gaze during the target task, and saves the measured
coordinates and generated heatmap to MongoDB. Use `GAZE_WS_URL` if the browser
cannot reach the default `ws://127.0.0.1:8001/ws/gaze` endpoint. Keep both
services running during the test.
If the website uses a non-default origin, add it to the comma-separated
`BRAINGUARD_ORIGINS` setting for FastAPI and set `GAZE_WS_URL` for the website.

Fixation measurements use an I-DT dispersion threshold and are reported as
unavailable when sample-quality gates are not met.

## Saccadic Eye Movement Assessment

The Saccadic Eye Movement Test reuses the same calibrated fullscreen capture
pipeline. It presents 12 balanced left/right trials, each preceded by a
450 ms center cue and followed by an 850 ms side target. The target and gaze
coordinates share the fullscreen pixel coordinate system and use monotonic
timestamps.

Results include per-trial endpoint error (median gaze-to-target distance in
the final 250 ms), target acquisition, and response latency. Acquisition
requires three consecutive valid samples within 3 degrees of a target,
spanning at least 100 ms. Aggregate metrics are withheld when there are fewer
than 30 valid samples, less than 70% valid coverage, a sampling rate below
8 Hz, or inadequate target coverage. Mean response latency also requires
successful target acquisition on at least 70% of adequately sampled trials.
Peak saccade velocity is not reported because the webcam sampling rate is
insufficient for a reliable estimate.

Choose **Saccadic Eye Movement** from the Eye Assessment page, then click
**Start Test** and grant browser camera access. The test enters browser
fullscreen, performs its own on-page calibration, and streams browser-captured
frames to GazeMap over WebSockets. The Python service does not open a camera or
stimulus window. Keep both services running during the test. Results are
experimental observations, not a diagnosis or clinically validated screening
result.

## Smooth Pursuit Assessment

The Smooth Pursuit Test also runs in browser fullscreen with an on-page
calibration and browser camera preview. It presents a 30-second horizontal
sinusoidal target with five complete left-right cycles, streams captured
frames to the FastAPI WebSocket, and saves measured samples and existing
GazeMap metrics to the assessment results. The Python service does not open a
camera or stimulus window.

## Blink and Fatigue Monitoring

Blink monitoring runs in browser fullscreen and displays the browser webcam
preview as a small eye crop with continuously refreshed MediaPipe eye contours
and landmarks, alongside a readable passage and live eye-openness signal.
Captured frames are sent to the GazeMap WebSocket, where the existing MediaPipe
face landmarks and EAR-based blink metrics are used; the Python service does
not open a camera or desktop window.
The approximately 30-second sample stream and computed blink events are saved
to the dedicated `BlinkMonitoringResult` collection. Keep the website and
FastAPI services running during the test.

## Memory-Based Eye Tracking

Memory tracking runs in browser fullscreen with the browser webcam and an
on-page nine-point gaze calibration. It presents eight words during encoding,
a five-second retention interval, and 16 randomized recognition trials. Gaze
coordinates are sampled throughout the task and saved with trial responses to
the dedicated `MemoryEyeTracking` collection. The Python service processes
submitted browser frames and does not open a camera or desktop window.