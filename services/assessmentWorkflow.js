const HealthProfile = require("../models/HealthProfile");
const EyeAssessmentResult = require("../models/EyeAssessmentResult");
const BlinkMonitoringResult = require("../models/BlinkMonitoringResult");
const MemoryEyeTracking = require("../models/MemoryEyeTracking");

const ASSESSMENT_STEPS = [
    { type: "saccadic", path: "saccadic", title: "Saccadic Eye Movement Test" },
    { type: "smooth_pursuit", path: "smooth-pursuit", title: "Smooth Pursuit Test" },
    { type: "blink_monitoring", path: "blink-monitoring", title: "Blink and Fatigue Monitoring Test" },
    { type: "memory_tracking", path: "memory-tracking", title: "Memory-Based Eye Tracking Test" },
];

function getCompletedTypes(assessmentTypes) {
    const activeTypes = new Set(ASSESSMENT_STEPS.map(step => step.type));
    return new Set(assessmentTypes.filter(type => activeTypes.has(type)));
}

function getNextAssessment(completedTypes) {
    return ASSESSMENT_STEPS.find(step => !completedTypes.has(step.type)) || null;
}

async function getAssessmentProgress(assessmentId) {
    const [healthProfile, results, blinkResult, memoryResult] = await Promise.all([
        HealthProfile.findOne({ assessmentId }).select("_id").lean(),
        EyeAssessmentResult.find({
            assessment: assessmentId,
            status: "completed",
        }).select("assessmentType").lean(),
        BlinkMonitoringResult.findOne({
            assessment: assessmentId,
            status: "completed",
        }).select("_id").lean(),
        MemoryEyeTracking.findOne({
            assessment: assessmentId,
            status: "completed",
        }).select("_id").lean(),
    ]);

    const completedTypes = getCompletedTypes(
        results.map(result => result.assessmentType)
    );
    if (!blinkResult) completedTypes.delete("blink_monitoring");
    if (!memoryResult) completedTypes.delete("memory_tracking");

    return {
        profileComplete: Boolean(healthProfile),
        completedTypes,
        nextAssessment: getNextAssessment(completedTypes),
        complete: ASSESSMENT_STEPS.every(step => completedTypes.has(step.type)),
    };
}

module.exports = {
    ASSESSMENT_STEPS,
    getAssessmentProgress,
    getCompletedTypes,
    getNextAssessment,
};
