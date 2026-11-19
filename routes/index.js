const express = require("express");
const mongoose = require("mongoose");

const Assessment = require("../models/Assessment");
const CalendarEvent = require("../models/CalendarEvent");
const HealthProfile = require("../models/HealthProfile");
const EyeAssessmentResult = require("../models/EyeAssessmentResult");
const BlinkMonitoringResult = require("../models/BlinkMonitoringResult");
const MemoryEyeTracking = require("../models/MemoryEyeTracking");
const {
    ASSESSMENT_STEPS,
    getAssessmentProgress,
} = require("../services/assessmentWorkflow");
const {
    QUESTIONNAIRE,
    displayFamilyHistory,
    getLegacyProfileFields,
    validateQuestionnaireResponses,
} = require("../services/healthQuestionnaire");

const router = express.Router();

router.get("/", (req, res) => {
    res.render("index", { title: "BrainGuard AI - Home" });
});

router.get("/assessment", (req, res) => {
    res.redirect("/health");
});

router.get("/health", (req, res) => {
    res.render("health", {
        title: "Health Profile - BrainGuard AI",
        profile: null,
        questionnaireJson: JSON.stringify(QUESTIONNAIRE).replace(/</g, "\\u003c"),
    });
});

router.post("/health", async (req, res) => {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    if (!name || name.length > 80) {
        return res.status(400).send("Enter a name of 1 to 80 characters.");
    }
    if (
        email.length > 120
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        return res.status(400).send("Enter a valid email address.");
    }

    let responses;
    try {
        responses = validateQuestionnaireResponses(req.body.questionnaireResponses);
    } catch (error) {
        return res.status(400).send(error.message);
    }

    let assessment;
    try {
        assessment = await Assessment.create({ name, email });
        await HealthProfile.create({
            assessmentId: assessment._id,
            ...getLegacyProfileFields(responses),
        });

        res.redirect(`/eye-assessment/${assessment._id}`);
    } catch (error) {
        if (assessment) {
            try {
                await Assessment.deleteOne({ _id: assessment._id });
            } catch (cleanupError) {
                console.error("Could not remove assessment after profile save failure:", cleanupError);
            }
        }
        console.error("Health profile submission error:", error);
        res.status(500).send("Unable to save the health profile. Please try again.");
    }
});

router.get("/dashboard/:id", async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).send("Invalid assessment ID.");
        }
        const assessment = await Assessment.findById(req.params.id);
        if (!assessment) {
            return res.status(404).send("Assessment not found.");
        }

        const progress = await getAssessmentProgress(assessment._id);
        if (!progress.profileComplete) {
            return res.redirect("/health");
        }
        if (!progress.complete) {
            return res.redirect(`/eye-assessment/${assessment._id}`);
        }

        const healthProfile = await HealthProfile.findOne({
            assessmentId: assessment._id,
        }).lean();
        const nextCalendarEvent = await CalendarEvent.findOne({
            ownerEmail: assessment.email,
            eventType: "brain_guard_assessment",
            status: "scheduled",
            startAt: { $gte: new Date() },
        }).sort({ startAt: 1 }).lean();

        res.render("dashboard", {
            title: "BrainGuard AI - Dashboard",
            assessment,
            healthProfile,
            nextCalendarEvent,
            familyHistoryLabel: displayFamilyHistory(healthProfile.familyHistory),
            completedCount: progress.completedTypes.size,
        });
    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).send("Unable to load the dashboard.");
    }
});

router.get("/history/:id", async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).send("Invalid assessment ID.");
        }
        const currentAssessment = await Assessment.findById(req.params.id);
        if (!currentAssessment) {
            return res.status(404).send("Assessment not found.");
        }

        const currentProgress = await getAssessmentProgress(currentAssessment._id);
        if (!currentProgress.complete) {
            return res.redirect(`/eye-assessment/${currentAssessment._id}`);
        }

        const history = await Assessment.find({
            email: currentAssessment.email,
        }).sort({ createdAt: -1 }).lean();
        const ids = history.map(item => item._id);
        const [results, blinkResults, memoryResults] = await Promise.all([
            EyeAssessmentResult.find({
                assessment: { $in: ids },
                status: "completed",
            }).select("assessment assessmentType").lean(),
            BlinkMonitoringResult.find({
                assessment: { $in: ids },
                status: "completed",
            }).select("assessment").lean(),
            MemoryEyeTracking.find({
                assessment: { $in: ids },
                status: "completed",
            }).select("assessment").lean(),
        ]);

        const completedByAssessment = new Map();
        for (const result of results) {
            const key = String(result.assessment);
            if (!completedByAssessment.has(key)) {
                completedByAssessment.set(key, new Set());
            }
            completedByAssessment.get(key).add(result.assessmentType);
        }
        const blinkIds = new Set(blinkResults.map(result => String(result.assessment)));
        const memoryIds = new Set(memoryResults.map(result => String(result.assessment)));
        const historyData = history.map((item, index) => {
            const completedTypes = completedByAssessment.get(String(item._id)) || new Set();
            const reportReady = ASSESSMENT_STEPS.every(step => {
                if (!completedTypes.has(step.type)) return false;
                if (step.type === "blink_monitoring") return blinkIds.has(String(item._id));
                if (step.type === "memory_tracking") return memoryIds.has(String(item._id));
                return true;
            });
            return { ...item, session: history.length - index, reportReady };
        });

        res.render("history", {
            title: "Assessment History - BrainGuard AI",
            history: historyData,
            currentAssessment,
        });
    } catch (error) {
        console.error("Assessment history error:", error);
        res.status(500).send("Unable to load assessment history.");
    }
});

module.exports = router;
