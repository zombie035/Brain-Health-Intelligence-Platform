const mongoose = require("mongoose");

const targetSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        side: { type: String, enum: ["left", "right"], default: null },
        xPx: { type: Number, required: true },
        yPx: { type: Number, required: true },
        cueOnsetAtSeconds: { type: Number, default: null },
        appearedAtSeconds: { type: Number, default: null },
        disappearedAtSeconds: { type: Number, default: null },
        averageGazeToTargetDistancePx: { type: Number, default: null },
        fixationCount: { type: Number, default: null },
        fixationDetected: { type: Boolean, default: null },
        fixationDurationMs: { type: Number, default: null },
        validSampleCount: { type: Number, default: null },
        endpointErrorPx: { type: Number, default: null },
        acquired: { type: Boolean, default: null },
        responseLatencyMs: { type: Number, default: null },
    },
    { _id: false }
);

const sampleSchema = new mongoose.Schema(
    {
        timeSeconds: { type: Number, required: true },
        xPx: { type: Number, default: null },
        yPx: { type: Number, default: null },
        valid: { type: Boolean, required: true },
        onScreen: { type: Boolean, required: true },
        distanceMm: { type: Number, default: null },
        reason: { type: String, default: null },
    },
    { _id: false }
);

const eyeAssessmentResultSchema = new mongoose.Schema(
    {
        assessment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Assessment",
            required: true,
            index: true,
        },
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },
        sessionId: {
            type: String,
            required: true,
            unique: true,
        },
        assessmentType: {
            type: String,
            enum: ["attention", "saccadic"],
            required: true,
        },
        status: {
            type: String,
            enum: ["running", "completed", "incomplete", "failed"],
            default: "running",
            required: true,
        },
        message: { type: String, default: null },
        startedAt: { type: Date, default: Date.now },
        endedAt: { type: Date, default: null },
        durationSeconds: { type: Number, default: null },
        coordinateSpace: { type: String, default: null },
        screen: {
            widthPx: { type: Number, default: null },
            heightPx: { type: Number, default: null },
        },
        calibration: {
            available: { type: Boolean, default: false },
            mappingMethod: { type: String, default: null },
            calibrationPointCount: { type: Number, default: 0 },
        },
        measurements: {
            totalSamples: { type: Number, default: null },
            validGazeSamples: { type: Number, default: null },
            invalidGazeSamples: { type: Number, default: null },
            onScreenGazeSamples: { type: Number, default: null },
            numberOfTargetsDisplayed: { type: Number, default: null },
            fixationCount: { type: Number, default: null },
            averageFixationDurationMs: { type: Number, default: null },
            averageGazeToTargetDistancePx: { type: Number, default: null },
            targetFixationConsistencyPct: { type: Number, default: null },
            missingSamplePercentage: { type: Number, default: null },
            totalTrials: { type: Number, default: null },
            trialsWithEnoughGazeSamples: { type: Number, default: null },
            targetsWithEndpointError: { type: Number, default: null },
            successfulTargetAcquisitions: { type: Number, default: null },
            targetAcquisitionRatePct: { type: Number, default: null },
            meanResponseLatencyMs: { type: Number, default: null },
            medianResponseLatencyMs: { type: Number, default: null },
            meanEndpointErrorPx: { type: Number, default: null },
        },
        sampleQuality: {
            sampleRateHz: { type: Number, default: null },
            validSampleFraction: { type: Number, default: null },
            fixationAnalysisSupported: { type: Boolean, default: null },
            targetAcquisitionSupported: { type: Boolean, default: null },
            latencyAnalysisSupported: { type: Boolean, default: null },
            fixationMethod: { type: String, default: null },
            dispersionThresholdDegrees: { type: Number, default: null },
            minimumFixationDurationMs: { type: Number, default: null },
            minimumFixationSamples: { type: Number, default: null },
            targetFixationRadiusDegrees: { type: Number, default: null },
            targetRadiusDegrees: { type: Number, default: null },
            targetsWithSufficientGazeSamples: { type: Number, default: null },
            qualityNotes: { type: [String], default: [] },
        },
        metricExplanations: {
            averageGazeToTargetDistancePx: { type: String, default: null },
            averageFixationDurationMs: { type: String, default: null },
            targetFixationConsistencyPct: { type: String, default: null },
            fixationAnalysis: { type: String, default: null },
            responseLatency: { type: String, default: null },
            endpointError: { type: String, default: null },
            targetAcquisition: { type: String, default: null },
        },
        targets: { type: [targetSchema], default: [] },
        samples: { type: [sampleSchema], default: [] },
    },
    { timestamps: true }
);

module.exports = mongoose.model(
    "EyeAssessmentResult",
    eyeAssessmentResultSchema
);
