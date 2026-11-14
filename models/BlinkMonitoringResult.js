const mongoose = require("mongoose");

const opennessSampleSchema = new mongoose.Schema(
    {
        timeSeconds: { type: Number, required: true },
        leftEAR: { type: Number, default: null },
        rightEAR: { type: Number, default: null },
        avgEAR: { type: Number, default: null },
        faceDetected: { type: Boolean, required: true },
        valid: { type: Boolean, required: true },
    },
    { _id: false }
);

const closureEventSchema = new mongoose.Schema(
    {
        startTimeSeconds: { type: Number, required: true },
        endTimeSeconds: { type: Number, required: true },
        durationMs: { type: Number, required: true },
        category: {
            type: String,
            enum: ["blink", "longer_closure", "prolonged_closure", "uncertain_incomplete"],
            required: true,
        },
    },
    { _id: false }
);

const blinkMonitoringResultSchema = new mongoose.Schema(
    {
        assessment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Assessment",
            required: true,
            index: true,
        },
        email: { type: String, required: true, lowercase: true, trim: true },
        sessionId: { type: String, required: true, unique: true },
        assessmentType: {
            type: String,
            enum: ["blink_monitoring"],
            default: "blink_monitoring",
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
        coordinateSpace: { type: String, default: "fullscreen_window_pixels" },
        screen: {
            widthPx: { type: Number, default: null },
            heightPx: { type: Number, default: null },
        },
        calibration: {
            available: { type: Boolean, default: false },
            method: { type: String, default: null },
            earThreshold: { type: Number, default: null },
            baselineEAR: { type: Number, default: null },
        },
        measurements: {
            totalBlinks: { type: Number, default: null },
            blinksPerMinute: { type: Number, default: null },
            avgBlinkDurationMs: { type: Number, default: null },
            medianBlinkDurationMs: { type: Number, default: null },
            minBlinkDurationMs: { type: Number, default: null },
            maxBlinkDurationMs: { type: Number, default: null },
            longestClosureMs: { type: Number, default: null },
            prolongedClosureCount: { type: Number, default: null },
            longerClosureCount: { type: Number, default: null },
            totalClosureEvents: { type: Number, default: null },
            validTrackingPct: { type: Number, default: null },
            totalFrames: { type: Number, default: null },
            validFrames: { type: Number, default: null },
        },
        sampleQuality: {
            earThreshold: { type: Number, default: null },
            baselineEAR: { type: Number, default: null },
            qualityNotes: { type: [String], default: [] },
        },
        observations: { type: [String], default: [] },
        samples: { type: [opennessSampleSchema], default: [] },
        blinkEvents: { type: [closureEventSchema], default: [] },
        closureEvents: { type: [closureEventSchema], default: [] },
    },
    { timestamps: true }
);

module.exports = mongoose.model("BlinkMonitoringResult", blinkMonitoringResultSchema);