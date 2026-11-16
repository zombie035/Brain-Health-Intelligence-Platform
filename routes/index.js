const express = require("express");
<<<<<<< HEAD
const mongoose = require("mongoose");

const Assessment = require("../models/Assessment");
const HealthProfile = require("../models/HealthProfile");
const EyeAssessmentResult = require("../models/EyeAssessmentResult");
const BlinkMonitoringResult = require("../models/BlinkMonitoringResult");
const MemoryEyeTracking = require("../models/MemoryEyeTracking");
const {
    ASSESSMENT_STEPS,
    getAssessmentProgress,
} = require("../services/assessmentWorkflow");

const router = express.Router();

const LANGUAGES = ["English", "Arabic", "Tamil", "Hindi", "Other"];
const EDUCATION_LEVELS = ["School", "Undergraduate", "Postgraduate", "Other"];

router.get("/", (req, res) => {
    res.render("index", { title: "BrainGuard AI - Home" });
});

router.get("/health", (req, res) => {
    res.render("health", {
        title: "Health Profile - BrainGuard AI",
        profile: null,
    });
});

router.post("/health", async (req, res) => {
    let assessment;

    try {
        const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
        const email = typeof req.body.email === "string"
            ? req.body.email.trim().toLowerCase()
            : "";
        const language = req.body.language;
        const educationLevel = req.body.educationLevel;
        const familyHistory = req.body.familyHistory;
        const age = Number(req.body.age);
        const sleepHours = Number(req.body.sleepHours);
        const exerciseMinutes = Number(req.body.exerciseMinutes);
        const stressLevel = Number(req.body.stressLevel);

        if (!name || name.length > 80) {
            return res.status(400).send("Enter a name of 1 to 80 characters.");
        }
        if (
            email.length > 120
            || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
            return res.status(400).send("Enter a valid email address.");
        }
        if (!Number.isInteger(age) || age < 18 || age > 120) {
            return res.status(400).send("Age must be between 18 and 120.");
        }
        if (!LANGUAGES.includes(language)) {
            return res.status(400).send("Select a supported preferred language.");
        }
        if (!EDUCATION_LEVELS.includes(educationLevel)) {
            return res.status(400).send("Select a supported education level.");
        }
        if (!Number.isFinite(sleepHours) || sleepHours < 0 || sleepHours > 24) {
            return res.status(400).send("Sleep duration must be between 0 and 24 hours.");
        }
        if (
            !Number.isInteger(exerciseMinutes)
            || exerciseMinutes < 0
            || exerciseMinutes > 1440
        ) {
            return res.status(400).send("Physical activity must be between 0 and 1440 minutes.");
        }
        if (!Number.isInteger(stressLevel) || stressLevel < 1 || stressLevel > 5) {
            return res.status(400).send("Stress level must be between 1 and 5.");
        }
        if (!["yes", "no", "unknown"].includes(familyHistory)) {
            return res.status(400).send("Select a valid family history response.");
        }

        assessment = await Assessment.create({ name, email });
        await HealthProfile.create({
            assessmentId: assessment._id,
=======
const router = express.Router();

const Assessment = require("../models/Assessment");
const HealthProfile = require("../models/HealthProfile");
const EyeTracking = require("../models/EyeTracking");

// ==========================================
// HOME PAGE
// ==========================================

router.get("/", (req, res) => {
    res.render("index", {
        title: "BrainGuard AI - Home"
    });
});

// ==========================================
// COGNITIVE ASSESSMENT PAGE
// ==========================================

router.get("/assessment", (req, res) => {
    res.render("assessment", {
        title: "Cognitive Assessment - BrainGuard AI"
    });
});

// ==========================================
// SUBMIT COGNITIVE ASSESSMENT
// ==========================================

router.post("/assessment", async (req, res) => {
    try {
        const { name, email, recallWords, attentionCount, reactionMs } = req.body;

        const targetWords = [
            "river",
            "apple",
            "chair",
            "window",
            "garden"
        ];

        const recalledWords = (recallWords || "")
            .toLowerCase()
            .split(/[\s,]+/)
            .filter(Boolean);

        const memoryCorrect = targetWords.filter(word =>
            recalledWords.includes(word)
        ).length;

        const attentionCorrect = Number(attentionCount) === 3;
        const reactionTime = Number(reactionMs);

        if (!name || !email || !recallWords) {
            return res.status(400).send("Please complete all required fields.");
        }

        if (
            !Number.isFinite(reactionTime) ||
            reactionTime < 100 ||
            reactionTime > 5000
        ) {
            return res.status(400).send("Invalid reaction time.");
        }

        const assessment = await Assessment.create({
            name: name.trim(),
            email: email.trim().toLowerCase(),
            memoryCorrect,
            memoryTotal: 5,
            attentionCorrect,
            reactionMs: reactionTime
        });

        res.redirect(`/health?assessmentId=${assessment._id}`);

    } catch (error) {
        console.error("Assessment submission error:", error);
        res.status(500).send("Unable to save assessment.");
    }
});

// ==========================================
// HEALTH PROFILE PAGE
// ==========================================

router.get("/health", async (req, res) => {
    try {
        const { assessmentId } = req.query;

        if (!assessmentId) {
            return res.redirect("/assessment");
        }

        const assessment = await Assessment.findById(assessmentId);

        if (!assessment) {
            return res.status(404).send("Assessment not found.");
        }

        res.render("health", {
            title: "Health Profile - BrainGuard AI",
            assessmentId
        });

    } catch (error) {
        console.error("Health page error:", error);
        res.status(500).send("Unable to load health profile.");
    }
});

// ==========================================
// SUBMIT HEALTH PROFILE
// ==========================================

router.post("/health", async (req, res) => {
    try {
        const {
            assessmentId,
>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914
            age,
            language,
            educationLevel,
            sleepHours,
            exerciseMinutes,
            stressLevel,
<<<<<<< HEAD
            familyHistory,
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
=======
            familyHistory
        } = req.body;

        if (!assessmentId) {
            return res.status(400).send("Assessment ID is required.");
        }

        const assessment = await Assessment.findById(assessmentId);

>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914
        if (!assessment) {
            return res.status(404).send("Assessment not found.");
        }

<<<<<<< HEAD
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

=======
        const ageValue = Number(age);
        const sleepValue = Number(sleepHours);
        const exerciseValue = Number(exerciseMinutes);
        const stressValue = Number(stressLevel);

        if (
            !Number.isInteger(ageValue) ||
            ageValue < 18 ||
            ageValue > 120
        ) {
            return res.status(400).send("Age must be between 18 and 120.");
        }

        if (
            !Number.isFinite(sleepValue) ||
            sleepValue < 0 ||
            sleepValue > 24
        ) {
            return res.status(400).send("Invalid sleep hours.");
        }

        if (
            !Number.isFinite(exerciseValue) ||
            exerciseValue < 0 ||
            exerciseValue > 1440
        ) {
            return res.status(400).send("Invalid exercise duration.");
        }

        if (
            !Number.isInteger(stressValue) ||
            stressValue < 1 ||
            stressValue > 5
        ) {
            return res.status(400).send("Stress level must be between 1 and 5.");
        }

        if (!language || !educationLevel) {
            return res.status(400).send("Please complete your health profile.");
        }

        if (!["yes", "no", "unknown"].includes(familyHistory)) {
            return res.status(400).send("Invalid family history value.");
        }

        await HealthProfile.findOneAndUpdate(
            { assessmentId: assessment._id },
            {
                assessmentId: assessment._id,
                age: ageValue,
                language,
                educationLevel,
                sleepHours: sleepValue,
                exerciseMinutes: exerciseValue,
                stressLevel: stressValue,
                familyHistory
            },
            {
                upsert: true,
                returnDocument: "after",
                runValidators: true,
                setDefaultsOnInsert: true
            }
        );

        res.redirect(`/dashboard/${assessment._id}`);

    } catch (error) {
        console.error("Health profile submission error:", error);
        res.status(500).send("Unable to save health profile.");
    }
});

// ==========================================
// DASHBOARD WITH ML INTEGRATION
// ==========================================

router.get("/dashboard/:id", async (req, res) => {
    let analysis = null;
    let mlError = null;

    try {
        // 1. Retrieve current assessment FIRST (everything else depends on it)
        const assessment = await Assessment.findById(req.params.id);

        if (!assessment) {
            return res.status(404).send("Assessment not found.");
        }

        // 2. Retrieve health profile
        const healthProfile = await HealthProfile.findOne({
            assessmentId: assessment._id
        });

        if (!healthProfile) {
            return res.redirect(`/health?assessmentId=${assessment._id}`);
        }

        // 3. Retrieve saved eye-tracking sessions
        //    (safe now — assessment exists; degrade gracefully on failure)
        let eyeTrackingSessions = [];
        try {
            eyeTrackingSessions = await EyeTracking.find({
                assessment: assessment._id
            })
                .sort({ createdAt: -1 })
                .lean();
        } catch (eyeErr) {
            console.error("Eye-tracking fetch failed:", eyeErr.message);
            eyeTrackingSessions = [];
        }

        // 4. Retrieve previous assessments for this user
        const history = await Assessment.find({
            email: assessment.email
        }).sort({ createdAt: 1 });

        // Prepare data for Chart.js
        const chartData = history.map((item, index) => ({
            session: index + 1,
            date: item.createdAt
                ? new Date(item.createdAt).toLocaleDateString("en-IN")
                : `Session ${index + 1}`,
            memory: Number(
                ((item.memoryCorrect / item.memoryTotal) * 100).toFixed(2)
            ),
            attention: item.attentionCorrect ? 100 : 0,
            reaction: Number(item.reactionMs)
        }));

        // 5. Send assessment history to Python ML service
        try {
            const mlApiUrl =
                process.env.ML_API_URL || "http://127.0.0.1:8000";

            const response = await fetch(`${mlApiUrl}/analyze`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    history,
                    health_profile: healthProfile
                })
            });

            if (!response.ok) {
                throw new Error(
                    `ML API returned status ${response.status}`
                );
            }

            // 6. Receive ML analysis
            analysis = await response.json();

            if (!analysis.success) {
                throw new Error(
                    analysis.message || "ML analysis failed."
                );
            }

            console.log("ML analysis completed successfully.");

        } catch (error) {
            console.error("ML API Error:", error.message);
            mlError = error.message;
        }

        // 7. Render dashboard
>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914
        res.render("dashboard", {
            title: "BrainGuard AI - Dashboard",
            assessment,
            healthProfile,
<<<<<<< HEAD
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
=======
            analysis,
            mlError,
            chartData,
            eyeTrackingSessions
        });

    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).send("Unable to load dashboard.");
    }
});

// ==========================================
// ASSESSMENT HISTORY
// ==========================================

router.get("/history/:id", async (req, res) => {
    try {
        // Find the assessment used to identify the user
        const currentAssessment = await Assessment.findById(
            req.params.id
        );

>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914
        if (!currentAssessment) {
            return res.status(404).send("Assessment not found.");
        }

<<<<<<< HEAD
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
=======
        // Retrieve all previous assessments
        const history = await Assessment.find({
            email: currentAssessment.email
        })
            .sort({ createdAt: -1 })
            .lean();

        // Prepare assessment history data
        const historyData = history.map((item, index) => ({
            ...item,
            session: history.length - index,
            memoryPct: Number(
                ((item.memoryCorrect / item.memoryTotal) * 100).toFixed(2)
            ),
            attentionPct: item.attentionCorrect ? 100 : 0
        }));
>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914

        res.render("history", {
            title: "Assessment History - BrainGuard AI",
            history: historyData,
<<<<<<< HEAD
            currentAssessment,
        });
=======
            currentAssessment
        });

>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914
    } catch (error) {
        console.error("Assessment history error:", error);
        res.status(500).send("Unable to load assessment history.");
    }
});

<<<<<<< HEAD
module.exports = router;
=======
// ==========================================
// EXPORT ROUTER
// ==========================================

module.exports = router;
>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914
