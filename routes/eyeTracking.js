const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

const Assessment = require("../models/Assessment");
const EyeTracking = require("../models/EyeTracking");

const router = express.Router();

const GAZE_API =
    process.env.GAZE_API_URL || "http://127.0.0.1:8001";

// Tracks which GazeMap session was present before each new recording.
// This prevents accidentally saving an older recording.
const pendingSessions = new Map();

async function gazeRequest(endpoint, options = {}) {
    const response = await fetch(`${GAZE_API}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...options.headers
        }
    });

    const data = await response.json();

    if (!response.ok) {
        const error = new Error(
            data.detail || "GazeMap API request failed."
        );
        error.status = response.status;
        throw error;
    }

    return data;
}

// START RECORDING
router.post("/eye-tracking/:id/start", async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid assessment ID."
            });
        }

        const assessment = await Assessment.findById(id);

        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found."
            });
        }

        // Do not allow a second recording while one is active.
        const status = await gazeRequest("/record/status");

        if (status.running) {
            return res.status(409).json({
                success: false,
                message: "A GazeMap recording is already running."
            });
        }

        // Remember the previous session to identify the new one.
        let previousSession = null;

        try {
            const previous = await gazeRequest("/sessions/latest");
            previousSession = previous.session;
        } catch (error) {
            if (error.status !== 404) {
                throw error;
            }
        }

        const stimulus = req.body?.stimulus || "test-image.jpg";
        const seconds = Number(req.body?.seconds || 20);

        if (
            !Number.isInteger(seconds) ||
            seconds < 5 ||
            seconds > 300
        ) {
            return res.status(400).json({
                success: false,
                message: "Recording duration must be 5–300 seconds."
            });
        }

        const result = await gazeRequest("/record/start", {
            method: "POST",
            body: JSON.stringify({
                stimulus,
                seconds
            })
        });

        pendingSessions.set(id, {
            previousSession,
            startedAt: Date.now(),
            stimulus
        });

        res.status(202).json({
            success: true,
            message: "GazeMap recording started.",
            assessmentId: id,
            durationSeconds: seconds,
            gazeMap: result
        });

    } catch (error) {
        console.error("Gaze recording start error:", error);

        res.status(error.status || 500).json({
            success: false,
            message: error.message
        });
    }
});

// CHECK RECORDING STATUS
router.get("/eye-tracking/:id/status", async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid assessment ID."
            });
        }

        const pending = pendingSessions.get(id);

        if (!pending) {
            return res.status(404).json({
                success: false,
                message: "No recording was started for this assessment."
            });
        }

        const status = await gazeRequest("/record/status");

        res.json({
            success: true,
            running: status.running,
            returnCode: status.return_code,
            recordingStartedAt: pending.startedAt
        });

    } catch (error) {
        console.error("Gaze recording status error:", error);

        res.status(error.status || 500).json({
            success: false,
            message: error.message
        });
    }
});

// SAVE COMPLETED RECORDING (file-based GazeMap)
router.post("/eye-tracking/:id/save", async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid assessment ID."
            });
        }

        const assessment = await Assessment.findById(id);

        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found."
            });
        }

        const pending = pendingSessions.get(id);

        if (!pending) {
            return res.status(404).json({
                success: false,
                message: "No recording is pending for this assessment."
            });
        }

        const status = await gazeRequest("/record/status");

        if (status.running) {
            return res.status(409).json({
                success: false,
                message: "Recording is still running. Try again after it finishes."
            });
        }

        if (status.return_code !== 0) {
            pendingSessions.delete(id);

            return res.status(500).json({
                success: false,
                message: "GazeMap recording did not finish successfully."
            });
        }

        const sessionData = await gazeRequest("/sessions/latest");

        // Do not save an old recording as a new assessment.
        if (sessionData.session === pending.previousSession) {
            return res.status(409).json({
                success: false,
                message: "The new recording has not produced a session yet."
            });
        }

        if (
            !Array.isArray(sessionData.points) ||
            sessionData.points.length === 0 ||
            sessionData.points.length !== sessionData.sample_count
        ) {
            return res.status(422).json({
                success: false,
                message: "GazeMap returned invalid or empty gaze data."
            });
        }

        // Prevent saving the same GazeMap session twice.
        const existing = await EyeTracking.findOne({
            session: sessionData.session
        });

        if (existing) {
            pendingSessions.delete(id);

            return res.status(409).json({
                success: false,
                message: "This GazeMap session has already been saved."
            });
        }

        const eyeTracking = await EyeTracking.create({
            assessment: assessment._id,
            email: assessment.email,
            session: sessionData.session,
            stimulus: pending.stimulus,
            sampleCount: sessionData.sample_count,
            durationSeconds: sessionData.duration_seconds,
            heatmapFilename: sessionData.heatmap,
            points: sessionData.points,
            source: "GazeMap"
        });

        pendingSessions.delete(id);

        res.status(201).json({
            success: true,
            message: "Eye-tracking session saved successfully.",
            eyeTracking: {
                id: eyeTracking._id,
                assessmentId: eyeTracking.assessment,
                session: eyeTracking.session,
                sampleCount: eyeTracking.sampleCount,
                durationSeconds: eyeTracking.durationSeconds,
                heatmapFilename: eyeTracking.heatmapFilename
            }
        });

    } catch (error) {
        console.error("Eye-tracking save error:", error);

        res.status(error.status || 500).json({
            success: false,
            message: error.message
        });
    }
});

// GET SAVED EYE-TRACKING SESSIONS FOR AN ASSESSMENT
router.get("/eye-tracking/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid assessment ID."
            });
        }

        const sessions = await EyeTracking.find({
            assessment: id
        }).sort({ createdAt: -1 }).lean();

        res.json({
            success: true,
            count: sessions.length,
            sessions
        });

    } catch (error) {
        console.error("Eye-tracking retrieval error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to retrieve eye-tracking sessions."
        });
    }
});


// SERVE GAZEMAP HEATMAP IMAGE
router.get("/eye-tracking/heatmap/:filename", async (req, res) => {
    try {
        const { filename } = req.params;

        // Allow only safe PNG filenames.
        if (!/^[a-zA-Z0-9_-]+\.png$/.test(filename)) {
            return res.status(400).send("Invalid heatmap filename.");
        }

        const response = await fetch(
            `${GAZE_API}/heatmaps/${encodeURIComponent(filename)}`
        );

        if (!response.ok) {
            return res.status(response.status).send(
                "Heatmap image not found."
            );
        }

        const imageBuffer = Buffer.from(
            await response.arrayBuffer()
        );

        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "no-store");

        return res.send(imageBuffer);

    } catch (error) {
        console.error("Heatmap retrieval error:", error);

        return res.status(500).send(
            "Unable to load heatmap image."
        );
    }
});


// ── PROXY LIVE FRAME TO PYTHON GAZEMAP ──────────────────────────────
router.post("/eye-tracking/process-frame", async (req, res) => {
    try {
        // Forward the base64 frame to Python GazeMap
        const response = await fetch(`${GAZE_API}/process_frame`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── SAVE A BROWSER-RECORDED SESSION ─────────────────────────────────
// FIXED: converts fraction coords → pixel coords using widthPx/heightPx
//        and converts ms timestamps → relative seconds
router.post("/eye-tracking/:id/save-session", async (req, res) => {
    let heatmapPath;
    try {
        const { points, widthPx, heightPx, heatmapDataUrl } = req.body;
        const calibrationStatus = req.body.calibrationStatus;
        const calibrationPointCount = Number(req.body.calibrationPointCount);

        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid assessment ID."
            });
        }

        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).json({ success: false, message: "Assessment not found." });
        }

        const width = Number(widthPx);
        const height = Number(heightPx);
        if (
            !Array.isArray(points)
            || points.length === 0
            || points.length > 20000
            || !Number.isFinite(width)
            || !Number.isFinite(height)
            || width < 100
            || width > 10000
            || height < 100
            || height > 10000
            || calibrationStatus !== "completed"
            || !Number.isInteger(calibrationPointCount)
            || calibrationPointCount < 6
        ) {
            return res.status(400).json({
                success: false,
                message: "The gaze session or calibration data is invalid."
            });
        }

        const validPoints = [];
        let previousTime = -Infinity;
        for (const point of points) {
            const x = Number(point?.x);
            const y = Number(point?.y);
            const time = Number(point?.time);
            if (
                !Number.isFinite(x)
                || !Number.isFinite(y)
                || x < 0
                || x > 1
                || y < 0
                || y > 1
                || !Number.isFinite(time)
                || time < previousTime
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Gaze points must contain ordered timestamps and finite normalized coordinates."
                });
            }
            previousTime = time;
            validPoints.push({ x, y, time });
        }

        const imageMatch = typeof heatmapDataUrl === "string"
            ? heatmapDataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/)
            : null;
        if (!imageMatch || imageMatch[1].length > 4_000_000) {
            return res.status(400).json({
                success: false,
                message: "A valid PNG heatmap is required."
            });
        }

        const heatmap = Buffer.from(imageMatch[1], "base64");
        if (
            heatmap.length < 8
            || heatmap.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        ) {
            return res.status(400).json({
                success: false,
                message: "The heatmap image is not a valid PNG."
            });
        }

        const sessionId = crypto.randomBytes(16).toString("hex");
        const heatmapFilename = `web_${sessionId}.png`;
        const heatmapDirectory = path.join(__dirname, "..", "GazeMap", "heatmaps");
        const generatedHeatmapPath = path.join(heatmapDirectory, heatmapFilename);
        await fs.mkdir(heatmapDirectory, { recursive: true });
        await fs.writeFile(generatedHeatmapPath, heatmap, { flag: "wx" });
        heatmapPath = generatedHeatmapPath;

        const firstTime = validPoints[0].time;
        const lastTime = validPoints[validPoints.length - 1].time;
        const session = await EyeTracking.create({
            assessment: assessment._id,
            email: assessment.email,
            session: sessionId,
            stimulus: "browser-attention-test",
            sampleCount: validPoints.length,
            durationSeconds: Math.max(0, (lastTime - firstTime) / 1000),
            coordinateSpace: "browser_stage_pixels",
            calibrationStatus,
            calibrationPointCount,
            heatmapFilename,
            points: validPoints.map(point => ({
                x_px: point.x * width,
                y_px: point.y * height,
                seconds: (point.time - firstTime) / 1000
            })),
            source: "GazeMap-Web"
        });

        res.status(201).json({
            success: true,
            sessionId: session._id,
            session: session.session,
            sampleCount: session.sampleCount,
            calibrationStatus: session.calibrationStatus,
            heatmapFilename: session.heatmapFilename
        });
    } catch (error) {
        if (heatmapPath) {
            await fs.unlink(heatmapPath).catch(cleanupError => {
                if (cleanupError.code !== "ENOENT") {
                    console.error("Could not remove unsaved gaze heatmap:", cleanupError);
                }
            });
        }
        console.error("save-session error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// ── NEW: PROXY /init_screen ─────────────────────────────────────────
router.post("/eye-tracking/init-screen", async (req, res) => {
    try {
        const response = await fetch(`${GAZE_API}/init_screen`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body)
        });
        res.json(await response.json());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── NEW: PROXY /calibrate ───────────────────────────────────────────
router.post("/eye-tracking/calibrate", async (req, res) => {
    try {
        const response = await fetch(`${GAZE_API}/calibrate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body)
        });
        res.json(await response.json());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


module.exports = router;