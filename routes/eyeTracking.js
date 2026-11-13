
const express = require("express");
const mongoose = require("mongoose");

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

// SAVE COMPLETED RECORDING
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


module.exports = router;
