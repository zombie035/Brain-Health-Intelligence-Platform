# Brain-Health-Intelligence-Platform

## Attention Tracking Assessment

The Attention Tracking Test uses the existing GazeMap models, saved calibration,
webcam, and a fullscreen OpenCV stimulus window. From the `GazeMap` directory,
activate its virtual environment and complete calibration before the first test:

```powershell
.\.venv\Scripts\Activate.ps1
python gaze_demo.py --calibrate
```

Keep that terminal in the `GazeMap` directory and start the API:

```powershell
python -m uvicorn gaze_service:app --host 127.0.0.1 --port 8001
```

In another terminal at the repository root, start the website:

```powershell
node app.js
```

Open the dashboard and choose **Open Eye Assessment**. Start the Attention
Tracking Test, then press Space in the GazeMap window to begin or Esc to cancel.
The browser shows progress and the saved experimental results. Keep both
services running during the test.

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
15 Hz, or inadequate target coverage. Mean response latency also requires
successful target acquisition on at least 70% of adequately sampled trials.
Peak saccade velocity is not reported because the webcam sampling rate is
insufficient for a reliable estimate.

Choose **Saccadic Eye Movement** from the Eye Assessment page. As with the
Attention Tracking Test, press Space in the GazeMap window to begin or Esc to
cancel. Keep both services running during the test. Results are experimental
observations, not a diagnosis or clinically validated screening result.