const mongoose = require("mongoose");

const findingSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, maxlength: 160 },
        explanation: { type: String, required: true, maxlength: 1200 },
        evidence: { type: String, required: true, maxlength: 600 },
    },
    { _id: false }
);

const baselineComparisonSchema = new mongoose.Schema(
    {
        assessment: { type: String, required: true, maxlength: 120 },
        measurement: { type: String, required: true, maxlength: 120 },
        currentValue: { type: String, required: true, maxlength: 100 },
        baselineMean: { type: String, required: true, maxlength: 100 },
        sessions: { type: Number, required: true, min: 2 },
        explanation: { type: String, required: true, maxlength: 800 },
    },
    { _id: false }
);

const eyeAssessmentAiAnalysisSchema = new mongoose.Schema(
    {
        assessment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Assessment",
            required: true,
            unique: true,
            index: true,
        },
        email: { type: String, required: true, lowercase: true, trim: true },
        provider: {
            type: String,
            enum: ["gemini", "openai", "deepseek"],
            required: true,
        },
        summary: { type: String, required: true, maxlength: 5000 },
        includesQuestionnaire: { type: Boolean, default: false },
        baselineAvailable: { type: Boolean, required: true, default: false },
        keyFindings: { type: [findingSchema], default: [] },
        baselineComparisons: { type: [baselineComparisonSchema], default: [] },
        nextSteps: { type: [String], default: [] },
        limitations: { type: String, required: true, maxlength: 2000 },
    },
    { timestamps: true }
);

module.exports = mongoose.model("EyeAssessmentAiAnalysis", eyeAssessmentAiAnalysisSchema);
