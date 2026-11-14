const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

const Assessment = require("../models/Assessment");
const EyeAssessmentResult = require("../models/EyeAssessmentResult");
const BlinkMonitoringResult = require("../models/BlinkMonitoringResult");
const MemoryEyeTracking = require("../models/MemoryEyeTracking");

const router = express.Router();
const GAZE_API = process.env.GAZE_API_URL || "http://127.0.0.1:8001";

async function gazeRequest(endpoint, options = {}) {
    const response = await fetch(`${GAZE_API}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...options.headers,
        },
    });
    const data = await response.json();

    if (!response.ok) {
        const error = new Error(
            data.detail || "GazeMap assessment request failed."
        );
        error.status = response.status;
        throw error;
    }

    return data;
}

function validateAssessmentId(id, res) {
    if (mongoose.isValidObjectId(id)) {
        return true;
    }
    res.status(400).send("Invalid assessment ID.");
    return false;
}

function sendApiError(res, error, context) {
    console.error(`${context}:`, error);
    res.status(error.status || 500).json({
        success: false,
        message: error.message || "Unable to complete the eye assessment request.",
    });
}

async function loadAssessment(id, res) {
    const assessment = await Assessment.findById(id);
    if (!assessment) {
        res.status(404).send("Assessment not found.");
        return null;
    }
    return assessment;
}

async function saveCompletedResult(assessment, sessionId, data) {
    return EyeAssessmentResult.findOneAndUpdate(
        {
            assessment: assessment._id,
            sessionId,
        },
        {
            $set: {
                status: data.status,
                message: data.message,
                startedAt: data.startedAt || undefined,
                endedAt: data.endedAt || new Date(),
                durationSeconds: data.durationSeconds ?? null,
                coordinateSpace: data.coordinateSpace || null,
                screen: data.screen || {},
                calibration: data.calibration || {},
                measurements: data.measurements || {},
                sampleQuality: data.sampleQuality || {},
                metricExplanations: data.metricExplanations || {},
                targets: data.targetMeasurements && data.targetMeasurements.length
                    ? data.targetMeasurements
                    : data.targets || [],
                samples: data.samples || [],
            },
        },
        {
            new: true,
            runValidators: true,
        }
    );
}

// ── Dedicated persistence for blink monitoring results ──────────────
async function saveBlinkCompletedResult(assessment, sessionId, data) {
    return BlinkMonitoringResult.findOneAndUpdate(
        { assessment: assessment._id, sessionId },
        {
            $set: {
                status: data.status,
                message: data.message,
                startedAt: data.startedAt || undefined,
                endedAt: data.endedAt || new Date(),
                durationSeconds: data.durationSeconds ?? null,
                coordinateSpace: data.coordinateSpace || "fullscreen_window_pixels",
                screen: data.screen || {},
                calibration: {
                    available: true,
                    method: data.calibration && data.calibration.mappingMethod,
                    earThreshold: data.sampleQuality && data.sampleQuality.earThreshold,
                    baselineEAR: data.sampleQuality && data.sampleQuality.baselineEAR,
                },
                measurements: data.measurements || {},
                sampleQuality: data.sampleQuality || {},
                observations: data.observations || [],
                samples: data.samples || [],
                blinkEvents: data.blinkEvents || [],
                closureEvents: data.closureEvents || [],
            },
            $setOnInsert: {
                assessment: assessment._id,
                email: assessment.email,
                sessionId,
                assessmentType: "blink_monitoring",
            },
        },
        {
            upsert: true,
            returnDocument: "after",
            runValidators: true,
            setDefaultsOnInsert: true,
        }
    );
}

// ── NEW: Dedicated persistence for memory tracking results ──────────
async function saveMemoryCompletedResult(assessment, sessionId, data) {
    return MemoryEyeTracking.findOneAndUpdate(
        { assessment: assessment._id, sessionId },
        {
            $set: {
                status: data.status,
                message: data.message,
                endedAt: data.endedAt || new Date(),
                durationSeconds: data.durationSeconds ?? null,
                coordinateSpace: data.coordinateSpace || null,
                screen: data.screen || {},
                calibration: data.calibration || {},
                measurements: data.measurements || {},
                sampleQuality: data.sampleQuality || {},
                trials: data.targets || [], // GazeMap passes trials into 'targets'
                samples: data.samples || [],
            },
            $setOnInsert: {
                assessment: assessment._id,
                email: assessment.email,
                sessionId,
                assessmentType: "memory_tracking",
            },
        },
        { upsert: true, returnDocument: "after", runValidators: true }
    );
}

async function startEyeAssessment(req, res, assessmentType) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found.",
            });
        }

        const started = await gazeRequest("/assessment/start", {
            method: "POST",
            body: JSON.stringify({ assessment_type: assessmentType }),
        });

        try {
            await EyeAssessmentResult.create({
                assessment: assessment._id,
                email: assessment.email,
                sessionId: started.sessionId,
                assessmentType,
                status: "running",
                message: started.message,
            });
        } catch (error) {
            try {
                await gazeRequest(
                    `/assessment/cancel/${started.sessionId}`,
                    { method: "POST" }
                );
            } catch (cancelError) {
                console.error("Could not cancel unpersisted gaze session:", cancelError);
            }
            throw error;
        }

        res.status(202).json({
            success: true,
            sessionId: started.sessionId,
            status: started.status,
            message: started.message,
        });
    } catch (error) {
        sendApiError(
            res,
            error,
            `${assessmentType[0].toUpperCase()}${assessmentType.slice(1)} assessment start error`
        );
    }
}

async function eyeAssessmentStatus(req, res, assessmentType) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found.",
            });
        }

        const saved = await EyeAssessmentResult.findOne({
            assessment: assessment._id,
            sessionId: req.params.sessionId,
        });
        if (!saved || saved.assessmentType !== assessmentType) {
            return res.status(404).json({
                success: false,
                message: "Eye assessment session not found.",
            });
        }

        const status = await gazeRequest(
            `/assessment/status/${encodeURIComponent(req.params.sessionId)}`
        );
        if (["completed", "incomplete", "failed"].includes(status.status)) {
            try {
                const result = await gazeRequest(
                    `/assessment/results/${encodeURIComponent(req.params.sessionId)}`
                );
                // ── Branch save by assessment type ──
                if (assessmentType === "blink_monitoring") {
                    await saveBlinkCompletedResult(
                        assessment,
                        req.params.sessionId,
                        result
                    );
                } else if (assessmentType === "memory_tracking") {
                    await saveMemoryCompletedResult(
                        assessment,
                        req.params.sessionId,
                        result
                    );
                } else {
                    await saveCompletedResult(
                        assessment,
                        req.params.sessionId,
                        result
                    );
                }
            } catch (error) {
                if (error.status !== 404) throw error;
                await EyeAssessmentResult.updateOne(
                    {
                        assessment: assessment._id,
                        sessionId: req.params.sessionId,
                    },
                    {
                        $set: {
                            status: "failed",
                            message: status.message,
                            endedAt: new Date(),
                        },
                    }
                );
            }
        }

        res.json({
            success: true,
            status: status.status,
            message: status.message,
            progress: status.progress,
            running: status.running,
            resultUrl: `/eye-assessment/${assessment._id}/results/${req.params.sessionId}`,
        });
    } catch (error) {
        sendApiError(
            res,
            error,
            `${assessmentType[0].toUpperCase()}${assessmentType.slice(1)} assessment status error`
        );
    }
}

async function cancelEyeAssessment(req, res, assessmentType) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const result = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
        });
        if (!result || result.assessmentType !== assessmentType) {
            return res.status(404).json({
                success: false,
                message: "Eye assessment session not found.",
            });
        }

        const response = await gazeRequest(
            `/assessment/cancel/${encodeURIComponent(req.params.sessionId)}`,
            { method: "POST" }
        );
        res.json(response);
    } catch (error) {
        sendApiError(
            res,
            error,
            `${assessmentType[0].toUpperCase()}${assessmentType.slice(1)} assessment cancel error`
        );
    }
}

async function startBrowserSaccadicAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found.",
            });
        }

        const sessionId = crypto.randomBytes(16).toString("hex");
        await EyeAssessmentResult.create({
            assessment: assessment._id,
            email: assessment.email,
            sessionId,
            assessmentType: "saccadic",
            status: "running",
            message: "Browser-based saccadic assessment started.",
            coordinateSpace: "browser_fullscreen_css_pixels",
        });

        res.status(202).json({
            success: true,
            sessionId,
            status: "running",
            message: "Browser-based saccadic assessment started.",
        });
    } catch (error) {
        sendApiError(res, error, "Saccadic browser assessment start error");
    }
}

async function startBrowserMemoryAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found.",
            });
        }

        const sessionId = crypto.randomBytes(16).toString("hex");
        const startedAt = new Date();
        const message = "Browser-based memory tracking started.";
        const eyeResult = await EyeAssessmentResult.create({
            assessment: assessment._id,
            email: assessment.email,
            sessionId,
            assessmentType: "memory_tracking",
            status: "running",
            message,
            startedAt,
            coordinateSpace: "browser_fullscreen_stage_pixels",
        });
        try {
            await MemoryEyeTracking.create({
                assessment: assessment._id,
                email: assessment.email,
                sessionId,
                status: "running",
                message,
                startedAt,
                coordinateSpace: "browser_fullscreen_stage_pixels",
            });
        } catch (error) {
            try {
                await EyeAssessmentResult.deleteOne({ _id: eyeResult._id });
            } catch (cleanupError) {
                console.error("Could not remove incomplete memory session:", cleanupError);
            }
            throw error;
        }

        res.status(202).json({
            success: true,
            sessionId,
            status: "running",
            message,
        });
    } catch (error) {
        sendApiError(res, error, "Memory browser assessment start error");
    }
}

async function completeBrowserMemoryAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "memory_tracking",
            coordinateSpace: "browser_fullscreen_stage_pixels",
            status: "running",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Running browser memory session not found.",
            });
        }

        const {
            samples,
            trials,
            widthPx,
            heightPx,
            calibrationPointCount,
            mappingMethod,
        } = req.body || {};
        const finite = value => typeof value === "number" && Number.isFinite(value);
        const validNullableNumber = value => value === null || finite(value);
        const validScreenSize = value =>
            Number.isInteger(value) && value >= 100 && value <= 10000;
        if (
            !Array.isArray(samples)
            || samples.length < 1
            || samples.length > 5000
            || !Array.isArray(trials)
            || trials.length !== 24
            || !validScreenSize(widthPx)
            || !validScreenSize(heightPx)
            || !Number.isInteger(calibrationPointCount)
            || calibrationPointCount < 6
            || calibrationPointCount > 20
            || mappingMethod !== "affine"
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid memory tracking result.",
            });
        }

        const validSamples = samples.every((sample, index) =>
            sample
            && finite(sample.timeSeconds)
            && sample.timeSeconds >= 0
            && sample.timeSeconds <= 180
            && (index === 0 || sample.timeSeconds >= samples[index - 1].timeSeconds)
            && ["encoding", "recognition", "retention"].includes(sample.phase)
            && (sample.imageId === null || typeof sample.imageId === "string")
            && typeof sample.valid === "boolean"
            && validNullableNumber(sample.xPx)
            && validNullableNumber(sample.yPx)
            && (!sample.valid || (
                finite(sample.xPx)
                && finite(sample.yPx)
                && sample.xPx >= 0
                && sample.xPx <= widthPx
                && sample.yPx >= 0
                && sample.yPx <= heightPx
            ))
        );
        const validTrials = trials.every(trial =>
            trial
            && typeof trial.imageId === "string"
            && /^[A-Z]+$/.test(trial.imageId)
            && ["encoding", "recognition"].includes(trial.phase)
            && typeof trial.isOld === "boolean"
            && (trial.userResponse === null
                || ["seen", "not_seen"].includes(trial.userResponse))
            && (trial.isCorrect === null || typeof trial.isCorrect === "boolean")
            && (trial.responseTimeMs === null
                || (finite(trial.responseTimeMs)
                    && trial.responseTimeMs >= 0
                    && trial.responseTimeMs <= 5000))
            && Number.isInteger(trial.fixationCount)
            && trial.fixationCount >= 0
            && finite(trial.fixationDurationMs)
            && trial.fixationDurationMs >= 0
            && trial.fixationDurationMs <= 5000
            && (trial.phase !== "encoding" || (
                trial.isOld
                && trial.userResponse === null
                && trial.isCorrect === null
                && trial.responseTimeMs === null
            ))
            && (trial.phase !== "recognition" || (
                (trial.userResponse === null && trial.responseTimeMs === null)
                || (trial.userResponse !== null && finite(trial.responseTimeMs))
            ))
        );
        const encodingTrials = trials.filter(trial => trial && trial.phase === "encoding");
        const recognitionTrials = trials.filter(trial => trial && trial.phase === "recognition");
        const encodedWords = new Set(encodingTrials.map(trial => trial.imageId));
        const oldRecognitionWords = new Set(
            recognitionTrials.filter(trial => trial.isOld).map(trial => trial.imageId)
        );
        const newRecognitionWords = recognitionTrials
            .filter(trial => !trial.isOld)
            .map(trial => trial.imageId);
        if (
            !validSamples
            || !validTrials
            || encodingTrials.length !== 8
            || encodedWords.size !== 8
            || recognitionTrials.length !== 16
            || recognitionTrials.filter(trial => trial.isOld).length !== 8
            || oldRecognitionWords.size !== 8
            || [...encodedWords].some(word => !oldRecognitionWords.has(word))
            || new Set(newRecognitionWords).size !== 8
            || newRecognitionWords.some(word => encodedWords.has(word))
        ) {
            return res.status(400).json({
                success: false,
                message: "Memory samples or trials contain invalid values.",
            });
        }

        const analysis = await gazeRequest("/memory/analyze", {
            method: "POST",
            body: JSON.stringify({ samples, trials }),
        });
        const endedAt = new Date();
        const durationSeconds = samples[samples.length - 1].timeSeconds;
        const data = {
            status: "completed",
            message: "Browser-based memory tracking completed.",
            endedAt,
            durationSeconds,
            coordinateSpace: "browser_fullscreen_stage_pixels",
            screen: { widthPx, heightPx },
            calibration: {
                available: true,
                mappingMethod,
                calibrationPointCount,
            },
            measurements: analysis.measurements,
            sampleQuality: analysis.sampleQuality,
            targets: trials,
            samples,
        };
        const updated = await EyeAssessmentResult.findOneAndUpdate(
            { _id: saved._id, status: "running" },
            {
                $set: {
                    status: data.status,
                    message: data.message,
                    endedAt,
                    durationSeconds,
                    coordinateSpace: data.coordinateSpace,
                    screen: data.screen,
                    calibration: data.calibration,
                    measurements: {
                        totalSamples: analysis.sampleQuality.totalSamples,
                        validGazeSamples: analysis.sampleQuality.validSamples,
                        invalidGazeSamples:
                            analysis.sampleQuality.totalSamples
                            - analysis.sampleQuality.validSamples,
                    },
                    sampleQuality: {
                        qualityNotes: analysis.sampleQuality.qualityNotes || [],
                    },
                },
            },
            { returnDocument: "after", runValidators: true }
        );
        if (!updated) {
            return res.status(409).json({
                success: false,
                message: "The memory session is no longer running.",
            });
        }
        await saveMemoryCompletedResult(
            { _id: saved.assessment, email: saved.email },
            saved.sessionId,
            data
        );

        res.json({
            success: true,
            resultUrl: `/eye-assessment/${saved.assessment}/results/${saved.sessionId}`,
        });
    } catch (error) {
        sendApiError(res, error, "Memory browser assessment save error");
    }
}

async function cancelBrowserMemoryAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "memory_tracking",
            coordinateSpace: "browser_fullscreen_stage_pixels",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Memory assessment session not found.",
            });
        }
        if (saved.status !== "running") {
            return res.status(409).json({
                success: false,
                message: "The memory session is no longer running.",
            });
        }

        const endedAt = new Date();
        const message = "Memory tracking cancelled by the user.";
        await Promise.all([
            EyeAssessmentResult.updateOne(
                { _id: saved._id, status: "running" },
                { $set: { status: "incomplete", message, endedAt } }
            ),
            MemoryEyeTracking.updateOne(
                { assessment: saved.assessment, sessionId: saved.sessionId, status: "running" },
                { $set: { status: "incomplete", message, endedAt } }
            ),
        ]);
        res.json({ success: true, message });
    } catch (error) {
        sendApiError(res, error, "Memory browser assessment cancel error");
    }
}

async function startBrowserBlinkAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found.",
            });
        }

        const sessionId = crypto.randomBytes(16).toString("hex");
        const startedAt = new Date();
        const message = "Browser-based blink monitoring started.";
        const eyeResult = await EyeAssessmentResult.create({
            assessment: assessment._id,
            email: assessment.email,
            sessionId,
            assessmentType: "blink_monitoring",
            status: "running",
            message,
            startedAt,
            coordinateSpace: "browser_camera_frames",
        });

        try {
            await BlinkMonitoringResult.create({
                assessment: assessment._id,
                email: assessment.email,
                sessionId,
                status: "running",
                message,
                startedAt,
                coordinateSpace: "browser_camera_frames",
            });
        } catch (error) {
            try {
                await EyeAssessmentResult.deleteOne({ _id: eyeResult._id });
            } catch (cleanupError) {
                console.error("Could not remove incomplete blink session:", cleanupError);
            }
            throw error;
        }

        res.status(202).json({
            success: true,
            sessionId,
            status: "running",
            message,
        });
    } catch (error) {
        sendApiError(res, error, "Blink browser assessment start error");
    }
}

async function completeBrowserBlinkAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "blink_monitoring",
            coordinateSpace: "browser_camera_frames",
            status: "running",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Running browser blink session not found.",
            });
        }

        const { samples, widthPx, heightPx } = req.body || {};
        const finite = value => typeof value === "number" && Number.isFinite(value);
        const validEar = value =>
            value === null || (finite(value) && value >= 0 && value <= 2);
        const validScreenSize = value =>
            Number.isInteger(value) && value >= 100 && value <= 10000;
        if (
            !Array.isArray(samples)
            || samples.length < 2
            || samples.length > 5000
            || !validScreenSize(widthPx)
            || !validScreenSize(heightPx)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid blink monitoring result.",
            });
        }

        const validSamples = samples.every((sample, index) =>
            sample
            && finite(sample.timeSeconds)
            && sample.timeSeconds >= 0
            && sample.timeSeconds <= 60
            && (index === 0 || sample.timeSeconds >= samples[index - 1].timeSeconds)
            && validEar(sample.leftEAR)
            && validEar(sample.rightEAR)
            && validEar(sample.avgEAR)
            && typeof sample.faceDetected === "boolean"
            && typeof sample.valid === "boolean"
            && (!sample.valid || (
                sample.faceDetected
                && (sample.leftEAR !== null || sample.rightEAR !== null)
                && sample.avgEAR !== null
            ))
        );
        if (!validSamples) {
            return res.status(400).json({
                success: false,
                message: "Blink samples contain invalid values.",
            });
        }

        const analysis = await gazeRequest("/blink/analyze", {
            method: "POST",
            body: JSON.stringify({ samples }),
        });
        const endedAt = new Date();
        const durationSeconds = Math.max(
            0,
            (endedAt.getTime() - saved.startedAt.getTime()) / 1000
        );
        const data = {
            status: "completed",
            message: "Browser-based blink monitoring completed.",
            startedAt: saved.startedAt,
            endedAt,
            durationSeconds,
            coordinateSpace: "browser_camera_frames",
            screen: { widthPx, heightPx },
            calibration: { mappingMethod: "mediapipe_face_landmarker_ear" },
            measurements: analysis.measurements,
            sampleQuality: analysis.sampleQuality,
            observations: analysis.observations,
            blinkEvents: analysis.blinkEvents,
            closureEvents: analysis.closureEvents,
            samples,
        };
        const updated = await EyeAssessmentResult.findOneAndUpdate(
            { _id: saved._id, status: "running" },
            {
                $set: {
                    status: data.status,
                    message: data.message,
                    endedAt,
                    durationSeconds,
                    coordinateSpace: data.coordinateSpace,
                    screen: data.screen,
                    calibration: {
                        available: true,
                        mappingMethod: "mediapipe_face_landmarker_ear",
                    },
                    sampleQuality: {
                        qualityNotes: analysis.sampleQuality.qualityNotes || [],
                    },
                },
            },
            { returnDocument: "after", runValidators: true }
        );
        if (!updated) {
            return res.status(409).json({
                success: false,
                message: "The blink session is no longer running.",
            });
        }
        await saveBlinkCompletedResult(
            { _id: saved.assessment, email: saved.email },
            saved.sessionId,
            data
        );

        res.json({
            success: true,
            resultUrl: `/eye-assessment/${saved.assessment}/results/${saved.sessionId}`,
        });
    } catch (error) {
        sendApiError(res, error, "Blink browser assessment save error");
    }
}

async function cancelBrowserBlinkAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "blink_monitoring",
            coordinateSpace: "browser_camera_frames",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Eye assessment session not found.",
            });
        }
        if (saved.status !== "running") {
            return res.status(409).json({
                success: false,
                message: "The blink session is no longer running.",
            });
        }

        const endedAt = new Date();
        const message = "Blink monitoring cancelled by the user.";
        await Promise.all([
            EyeAssessmentResult.updateOne(
                { _id: saved._id, status: "running" },
                { $set: { status: "incomplete", message, endedAt } }
            ),
            BlinkMonitoringResult.updateOne(
                { assessment: saved.assessment, sessionId: saved.sessionId, status: "running" },
                { $set: { status: "incomplete", message, endedAt } }
            ),
        ]);
        res.json({ success: true, message });
    } catch (error) {
        sendApiError(res, error, "Blink browser assessment cancel error");
    }
}

async function completeBrowserSaccadicAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "saccadic",
            coordinateSpace: "browser_fullscreen_css_pixels",
            status: "running",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Running browser saccadic session not found.",
            });
        }

        const {
            samples,
            targets,
            widthPx,
            heightPx,
            calibrationPointCount,
            mappingMethod,
        } = req.body || {};
        const finite = value => typeof value === "number" && Number.isFinite(value);
        const validNullableNumber = value => value === null || finite(value);
        const validScreenSize = value =>
            Number.isInteger(value) && value >= 100 && value <= 10000;
        if (
            !Array.isArray(samples)
            || samples.length < 1
            || samples.length > 5000
            || !Array.isArray(targets)
            || targets.length !== 12
            || !validScreenSize(widthPx)
            || !validScreenSize(heightPx)
            || !Number.isInteger(calibrationPointCount)
            || calibrationPointCount < 6
            || calibrationPointCount > 20
            || mappingMethod !== "affine"
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid saccadic assessment result.",
            });
        }

        const validSamples = samples.every(sample =>
            sample
            && finite(sample.timeSeconds)
            && sample.timeSeconds >= 0
            && typeof sample.valid === "boolean"
            && typeof sample.onScreen === "boolean"
            && validNullableNumber(sample.xPx)
            && validNullableNumber(sample.yPx)
            && validNullableNumber(sample.distanceMm)
            && (!sample.valid || (
                sample.onScreen
                && finite(sample.xPx)
                && finite(sample.yPx)
                && sample.xPx >= 0
                && sample.xPx <= widthPx
                && sample.yPx >= 0
                && sample.yPx <= heightPx
            ))
            && (sample.reason == null || typeof sample.reason === "string")
        );
        const validTargets = targets.every(target =>
            target
            && typeof target.id === "string"
            && ["left", "right"].includes(target.side)
            && finite(target.xPx)
            && finite(target.yPx)
            && target.xPx >= 0
            && target.xPx <= widthPx
            && target.yPx >= 0
            && target.yPx <= heightPx
            && finite(target.cueOnsetAtSeconds)
            && finite(target.appearedAtSeconds)
            && finite(target.disappearedAtSeconds)
            && target.cueOnsetAtSeconds <= target.appearedAtSeconds
            && target.appearedAtSeconds <= target.disappearedAtSeconds
        );
        const balancedTrials =
            targets.filter(target => target && target.side === "left").length === 6
            && targets.filter(target => target && target.side === "right").length === 6;
        if (!validSamples || !validTargets || !balancedTrials) {
            return res.status(400).json({
                success: false,
                message: "Saccadic samples or targets contain invalid values.",
            });
        }

        const analysis = await gazeRequest("/saccadic/analyze", {
            method: "POST",
            body: JSON.stringify({
                samples,
                targets,
                mmPerPx: 345 / widthPx,
            }),
        });
        const endedAt = new Date();
        const result = await EyeAssessmentResult.findOneAndUpdate(
            { _id: saved._id, status: "running" },
            {
                $set: {
                    status: "completed",
                    message: "Browser-based saccadic assessment completed.",
                    endedAt,
                    durationSeconds: Math.max(
                        0,
                        (endedAt.getTime() - saved.startedAt.getTime()) / 1000
                    ),
                    coordinateSpace: "browser_fullscreen_css_pixels",
                    screen: { widthPx, heightPx },
                    calibration: {
                        available: true,
                        mappingMethod,
                        calibrationPointCount,
                    },
                    measurements: analysis.measurements,
                    sampleQuality: analysis.sampleQuality,
                    metricExplanations: analysis.metricExplanations,
                    targets: analysis.targetMeasurements,
                    samples,
                },
            },
            { returnDocument: "after", runValidators: true }
        );
        if (!result) {
            return res.status(409).json({
                success: false,
                message: "The saccadic session is no longer running.",
            });
        }

        res.json({
            success: true,
            resultUrl: `/eye-assessment/${saved.assessment}/results/${saved.sessionId}`,
        });
    } catch (error) {
        sendApiError(res, error, "Saccadic browser assessment save error");
    }
}

async function cancelBrowserSaccadicAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "saccadic",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Eye assessment session not found.",
            });
        }
        if (saved.coordinateSpace !== "browser_fullscreen_css_pixels") {
            return cancelEyeAssessment(req, res, "saccadic");
        }
        if (saved.status !== "running") {
            return res.status(409).json({
                success: false,
                message: "The saccadic session is no longer running.",
            });
        }

        await EyeAssessmentResult.updateOne(
            { _id: saved._id, status: "running" },
            {
                $set: {
                    status: "incomplete",
                    message: "Saccadic assessment cancelled by the user.",
                    endedAt: new Date(),
                },
            }
        );
        res.json({ success: true, message: "Saccadic assessment cancelled." });
    } catch (error) {
        sendApiError(res, error, "Saccadic browser assessment cancel error");
    }
}

async function startBrowserSmoothPursuitAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).json({
                success: false,
                message: "Assessment not found.",
            });
        }

        const sessionId = crypto.randomBytes(16).toString("hex");
        await EyeAssessmentResult.create({
            assessment: assessment._id,
            email: assessment.email,
            sessionId,
            assessmentType: "smooth_pursuit",
            status: "running",
            message: "Browser-based smooth pursuit assessment started.",
            coordinateSpace: "browser_fullscreen_css_pixels",
        });

        res.status(202).json({
            success: true,
            sessionId,
            status: "running",
            message: "Browser-based smooth pursuit assessment started.",
        });
    } catch (error) {
        sendApiError(res, error, "Smooth pursuit browser assessment start error");
    }
}

async function completeBrowserSmoothPursuitAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "smooth_pursuit",
            coordinateSpace: "browser_fullscreen_css_pixels",
            status: "running",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Running browser smooth pursuit session not found.",
            });
        }

        const {
            samples,
            widthPx,
            heightPx,
            calibrationPointCount,
            mappingMethod,
        } = req.body || {};
        const finite = value => typeof value === "number" && Number.isFinite(value);
        const validNullableNumber = value => value === null || finite(value);
        const validScreenSize = value =>
            Number.isInteger(value) && value >= 100 && value <= 10000;
        if (
            !Array.isArray(samples)
            || samples.length < 1
            || samples.length > 5000
            || !validScreenSize(widthPx)
            || !validScreenSize(heightPx)
            || !Number.isInteger(calibrationPointCount)
            || calibrationPointCount < 6
            || calibrationPointCount > 20
            || mappingMethod !== "affine"
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid smooth pursuit assessment result.",
            });
        }

        const validSamples = samples.every(sample =>
            sample
            && finite(sample.timeSeconds)
            && sample.timeSeconds >= 0
            && sample.timeSeconds <= 45
            && typeof sample.valid === "boolean"
            && typeof sample.onScreen === "boolean"
            && finite(sample.targetXPx)
            && finite(sample.targetYPx)
            && sample.targetXPx >= 0
            && sample.targetXPx <= widthPx
            && sample.targetYPx >= 0
            && sample.targetYPx <= heightPx
            && validNullableNumber(sample.xPx)
            && validNullableNumber(sample.yPx)
            && validNullableNumber(sample.distanceMm)
            && (!sample.valid || (
                sample.onScreen
                && finite(sample.xPx)
                && finite(sample.yPx)
                && sample.xPx >= 0
                && sample.xPx <= widthPx
                && sample.yPx >= 0
                && sample.yPx <= heightPx
            ))
            && (sample.reason == null || typeof sample.reason === "string")
        );
        if (!validSamples) {
            return res.status(400).json({
                success: false,
                message: "Smooth pursuit samples contain invalid values.",
            });
        }

        const analysis = await gazeRequest("/smooth-pursuit/analyze", {
            method: "POST",
            body: JSON.stringify({
                samples,
                mmPerPx: 345 / widthPx,
            }),
        });
        const endedAt = new Date();
        const result = await EyeAssessmentResult.findOneAndUpdate(
            { _id: saved._id, status: "running" },
            {
                $set: {
                    status: "completed",
                    message: "Browser-based smooth pursuit assessment completed.",
                    endedAt,
                    durationSeconds: Math.max(
                        0,
                        (endedAt.getTime() - saved.startedAt.getTime()) / 1000
                    ),
                    coordinateSpace: "browser_fullscreen_css_pixels",
                    screen: { widthPx, heightPx },
                    calibration: {
                        available: true,
                        mappingMethod,
                        calibrationPointCount,
                    },
                    measurements: analysis.measurements,
                    sampleQuality: analysis.sampleQuality,
                    metricExplanations: analysis.metricExplanations,
                    targets: [],
                    samples,
                },
            },
            { returnDocument: "after", runValidators: true }
        );
        if (!result) {
            return res.status(409).json({
                success: false,
                message: "The smooth pursuit session is no longer running.",
            });
        }

        res.json({
            success: true,
            resultUrl: `/eye-assessment/${saved.assessment}/results/${saved.sessionId}`,
        });
    } catch (error) {
        sendApiError(res, error, "Smooth pursuit browser assessment save error");
    }
}

async function cancelBrowserSmoothPursuitAssessment(req, res) {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const saved = await EyeAssessmentResult.findOne({
            assessment: req.params.id,
            sessionId: req.params.sessionId,
            assessmentType: "smooth_pursuit",
        });
        if (!saved) {
            return res.status(404).json({
                success: false,
                message: "Eye assessment session not found.",
            });
        }
        if (saved.coordinateSpace !== "browser_fullscreen_css_pixels") {
            return cancelEyeAssessment(req, res, "smooth_pursuit");
        }
        if (saved.status !== "running") {
            return res.status(409).json({
                success: false,
                message: "The smooth pursuit session is no longer running.",
            });
        }

        await EyeAssessmentResult.updateOne(
            { _id: saved._id, status: "running" },
            {
                $set: {
                    status: "incomplete",
                    message: "Smooth pursuit assessment cancelled by the user.",
                    endedAt: new Date(),
                },
            }
        );
        res.json({ success: true, message: "Smooth pursuit assessment cancelled." });
    } catch (error) {
        sendApiError(res, error, "Smooth pursuit browser assessment cancel error");
    }
}

router.get("/eye-assessment/:id", async (req, res) => {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await loadAssessment(req.params.id, res);
        if (!assessment) return;

        const results = await EyeAssessmentResult.find({
            assessment: assessment._id,
        })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        res.render("eye-assessment", {
            title: "Eye Assessment - BrainGuard AI",
            assessment,
            results,
            pageStylesheet: "eye-assessment.css",
        });
    } catch (error) {
        console.error("Eye assessment page error:", error);
        res.status(500).send("Unable to load the eye assessment page.");
    }
});

router.get("/eye-assessment/:id/attention", async (req, res) => {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await loadAssessment(req.params.id, res);
        if (!assessment) return;

        res.render("eye-attention", {
            title: "Attention Tracking Test - BrainGuard AI",
            assessment,
            gazeWsUrl: process.env.GAZE_WS_URL || "ws://127.0.0.1:8001/ws/gaze",
            pageStylesheet: "eye-assessment.css",
        });
    } catch (error) {
        console.error("Attention test page error:", error);
        res.status(500).send("Unable to load the attention test.");
    }
});

router.get("/eye-assessment/:id/saccadic", async (req, res) => {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await loadAssessment(req.params.id, res);
        if (!assessment) return;

        res.render("eye-saccadic", {
            title: "Saccadic Eye Movement Test - BrainGuard AI",
            assessment,
            gazeWsUrl: process.env.GAZE_WS_URL || "ws://127.0.0.1:8001/ws/gaze",
            pageStylesheet: "eye-assessment.css",
        });
    } catch (error) {
        console.error("Saccadic test page error:", error);
        res.status(500).send("Unable to load the saccadic eye movement test.");
    }
});

// ── Smooth Pursuit instruction page ──────────────────────────────────
router.get("/eye-assessment/:id/smooth-pursuit", async (req, res) => {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await loadAssessment(req.params.id, res);
        if (!assessment) return;

        res.render("eye-smooth-pursuit", {
            title: "Smooth Pursuit Test - BrainGuard AI",
            assessment,
            gazeWsUrl: process.env.GAZE_WS_URL || "ws://127.0.0.1:8001/ws/gaze",
            pageStylesheet: "eye-assessment.css",
        });
    } catch (error) {
        console.error("Smooth pursuit page error:", error);
        res.status(500).send("Unable to load the smooth pursuit test.");
    }
});

// ── Blink monitoring instruction page ────────────────────────────────
router.get("/eye-assessment/:id/blink-monitoring", async (req, res) => {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await loadAssessment(req.params.id, res);
        if (!assessment) return;

        res.render("eye-blink-monitoring", {
            title: "Blink & Fatigue Monitoring - BrainGuard AI",
            assessment,
            gazeWsUrl: process.env.GAZE_WS_URL || "ws://127.0.0.1:8001/ws/gaze",
            pageStylesheet: "eye-assessment.css",
        });
    } catch (error) {
        console.error("Blink monitoring page error:", error);
        res.status(500).send("Unable to load the blink monitoring test.");
    }
});

// ── Memory tracking instruction page ─────────────────────────────────
router.get("/eye-assessment/:id/memory-tracking", async (req, res) => {
    try {
        if (!validateAssessmentId(req.params.id, res)) return;
        const assessment = await loadAssessment(req.params.id, res);
        if (!assessment) return;

        res.render("eye-memory-tracking", {
            title: "Memory Eye Tracking - BrainGuard AI",
            assessment,
            gazeWsUrl: process.env.GAZE_WS_URL || "ws://127.0.0.1:8001/ws/gaze",
            pageStylesheet: "eye-assessment.css",
        });
    } catch (error) {
        res.status(500).send("Unable to load memory test.");
    }
});

// ── API routing loop for assessments that still use the legacy runner ─
router.post(
    "/eye-assessment/:id/memory-tracking/browser/start",
    startBrowserMemoryAssessment
);
router.post(
    "/eye-assessment/:id/memory-tracking/browser/:sessionId/complete",
    completeBrowserMemoryAssessment
);
router.post(
    "/eye-assessment/:id/memory-tracking/browser/:sessionId/cancel",
    cancelBrowserMemoryAssessment
);
router.post("/eye-assessment/:id/memory_tracking/start", (req, res) => {
    res.status(410).json({
        success: false,
        message: "Memory tracking now uses the browser camera. Reload this page to start.",
    });
});
router.post(
    "/eye-assessment/:id/saccadic/start",
    startBrowserSaccadicAssessment
);
router.post(
    "/eye-assessment/:id/blink-monitoring/browser/start",
    startBrowserBlinkAssessment
);
router.post(
    "/eye-assessment/:id/blink-monitoring/browser/:sessionId/complete",
    completeBrowserBlinkAssessment
);
router.post(
    "/eye-assessment/:id/blink-monitoring/browser/:sessionId/cancel",
    cancelBrowserBlinkAssessment
);
router.post("/eye-assessment/:id/blink_monitoring/start", (req, res) => {
    res.status(410).json({
        success: false,
        message: "Blink monitoring now uses the browser camera. Reload this page to start.",
    });
});
router.post(
    "/eye-assessment/:id/saccadic/:sessionId/complete",
    completeBrowserSaccadicAssessment
);
router.post(
    "/eye-assessment/:id/saccadic/:sessionId/cancel",
    cancelBrowserSaccadicAssessment
);
router.get(
    "/eye-assessment/:id/saccadic/:sessionId/status",
    (req, res) => eyeAssessmentStatus(req, res, "saccadic")
);
router.post(
    "/eye-assessment/:id/smooth-pursuit/browser/start",
    startBrowserSmoothPursuitAssessment
);
router.post(
    "/eye-assessment/:id/smooth-pursuit/browser/:sessionId/complete",
    completeBrowserSmoothPursuitAssessment
);
router.post(
    "/eye-assessment/:id/smooth-pursuit/browser/:sessionId/cancel",
    cancelBrowserSmoothPursuitAssessment
);
router.post("/eye-assessment/:id/smooth_pursuit/start", (req, res) => {
    res.status(410).json({
        success: false,
        message: "Smooth pursuit now uses the browser camera. Reload this page to start.",
    });
});
router.get(
    "/eye-assessment/:id/smooth_pursuit/:sessionId/status",
    (req, res) => eyeAssessmentStatus(req, res, "smooth_pursuit")
);

for (const assessmentType of ["attention"]) {
    router.post(
        `/eye-assessment/:id/${assessmentType}/start`,
        (req, res) => startEyeAssessment(req, res, assessmentType)
    );
    router.get(
        `/eye-assessment/:id/${assessmentType}/:sessionId/status`,
        (req, res) => eyeAssessmentStatus(req, res, assessmentType)
    );
    router.post(
        `/eye-assessment/:id/${assessmentType}/:sessionId/cancel`,
        (req, res) => cancelEyeAssessment(req, res, assessmentType)
    );
}

router.get(
    "/eye-assessment/:id/memory_tracking/:sessionId/status",
    (req, res) => eyeAssessmentStatus(req, res, "memory_tracking")
);
router.post(
    "/eye-assessment/:id/memory_tracking/:sessionId/cancel",
    (req, res) => cancelEyeAssessment(req, res, "memory_tracking")
);

router.get(
    "/eye-assessment/:id/blink_monitoring/:sessionId/status",
    (req, res) => eyeAssessmentStatus(req, res, "blink_monitoring")
);
router.post(
    "/eye-assessment/:id/blink_monitoring/:sessionId/cancel",
    (req, res) => cancelEyeAssessment(req, res, "blink_monitoring")
);

// ── Results page — dispatches by assessment type ────────────────────
router.get(
    "/eye-assessment/:id/results/:sessionId",
    async (req, res) => {
        try {
            if (!validateAssessmentId(req.params.id, res)) return;
            const assessment = await Assessment.findById(req.params.id);
            if (!assessment) {
                return res.status(404).send("Assessment not found.");
            }

            const result = await EyeAssessmentResult.findOne({
                assessment: assessment._id,
                sessionId: req.params.sessionId,
            }).lean();
            if (!result) {
                return res.status(404).send("Eye assessment result not found.");
            }

            result.measurements = result.measurements || {};
            result.sampleQuality = result.sampleQuality || {};
            result.sampleQuality.qualityNotes =
                result.sampleQuality.qualityNotes || [];
            result.calibration = result.calibration || {};
            result.metricExplanations = result.metricExplanations || {};
            result.targets = result.targets || [];

            const saccadic = result.assessmentType === "saccadic";
            const smoothPursuit = result.assessmentType === "smooth_pursuit";
            const blinkMonitoring = result.assessmentType === "blink_monitoring";
            const memoryTracking = result.assessmentType === "memory_tracking";

            let template = "eye-results";
            let title = "Attention Test Results - BrainGuard AI";

            if (saccadic) {
                template = "eye-saccadic-results";
                title = "Saccadic Eye Movement Results - BrainGuard AI";
            } else if (smoothPursuit) {
                template = "eye-smooth-pursuit-results";
                title = "Smooth Pursuit Results - BrainGuard AI";
            } else if (blinkMonitoring) {
                // Load blink result from the dedicated model
                const blinkResult = await BlinkMonitoringResult.findOne({
                    assessment: assessment._id,
                    sessionId: req.params.sessionId,
                }).lean();
                if (!blinkResult) {
                    return res.status(404).send("Blink monitoring result not found.");
                }
                blinkResult.measurements = blinkResult.measurements || {};
                blinkResult.sampleQuality = blinkResult.sampleQuality || {};
                blinkResult.sampleQuality.qualityNotes = blinkResult.sampleQuality.qualityNotes || [];
                blinkResult.observations = blinkResult.observations || [];
                blinkResult.samples = blinkResult.samples || [];
                blinkResult.blinkEvents = blinkResult.blinkEvents || [];
                blinkResult.closureEvents = blinkResult.closureEvents || [];
                return res.render("eye-blink-results", {
                    title: "Blink & Fatigue Monitoring Results - BrainGuard AI",
                    assessment,
                    result: blinkResult,
                    pageStylesheet: "eye-assessment.css",
                });
            } else if (memoryTracking) {
                // Load memory result from the dedicated model
                const memResult = await MemoryEyeTracking.findOne({
                    assessment: assessment._id,
                    sessionId: req.params.sessionId,
                }).lean();
                if (!memResult) {
                    return res.status(404).send("Memory tracking result not found.");
                }
                memResult.measurements = memResult.measurements || {};
                memResult.sampleQuality = memResult.sampleQuality || {};
                memResult.sampleQuality.qualityNotes = memResult.sampleQuality.qualityNotes || [];
                memResult.trials = memResult.trials || [];
                memResult.samples = memResult.samples || [];
                return res.render("eye-memory-results", {
                    title: "Memory Tracking Results - BrainGuard AI",
                    assessment,
                    result: memResult,
                    pageStylesheet: "eye-assessment.css",
                });
            }

            res.render(template, {
                title: title,
                assessment,
                result,
                pageStylesheet: "eye-assessment.css",
            });
        } catch (error) {
            console.error("Eye assessment results page error:", error);
            res.status(500).send("Unable to load eye assessment results.");
        }
    }
);

module.exports = router;