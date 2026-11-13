const express = require("express");
const mongoose = require("mongoose");

const Assessment = require("../models/Assessment");
const EyeAssessmentResult = require("../models/EyeAssessmentResult");

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
                await saveCompletedResult(
                    assessment,
                    req.params.sessionId,
                    result
                );
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
            pageStylesheet: "eye-assessment.css",
        });
    } catch (error) {
        console.error("Saccadic test page error:", error);
        res.status(500).send("Unable to load the saccadic eye movement test.");
    }
});

for (const assessmentType of ["attention", "saccadic"]) {
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
            res.render(
                saccadic ? "eye-saccadic-results" : "eye-results",
                {
                    title: saccadic
                        ? "Saccadic Eye Movement Results - BrainGuard AI"
                        : "Attention Test Results - BrainGuard AI",
                    assessment,
                    result,
                    pageStylesheet: "eye-assessment.css",
                }
            );
        } catch (error) {
            console.error("Eye assessment results page error:", error);
            res.status(500).send("Unable to load eye assessment results.");
        }
    }
);

module.exports = router;
