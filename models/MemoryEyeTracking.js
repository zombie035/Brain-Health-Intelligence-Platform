const mongoose = require("mongoose");

const gazeSampleSchema = new mongoose.Schema(
    {
        timeSeconds: { type: Number, required: true },
        xPx: { type: Number, default: null },
        yPx: { type: Number, default: null },
        valid: { type: Boolean, required: true },
        phase: { type: String, enum: ["encoding", "recognition", "retention"], required: true },
        imageId: { type: String, default: null },
    },
    { _id: false }
);

const memoryEyeTrackingSchema = new mongoose.Schema(
    {
        assessment: { type: mongoose.Schema.Types.ObjectId, ref: "Assessment", required: true, index: true },
        email: { type: String, required: true, lowercase: true, trim: true },
        sessionId: { type: String, required: true, unique: true },
        status: { type: String, enum: ["running", "completed", "incomplete", "failed"], default: "running" },
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
            recognitionAccuracy: { type: Number, default: null },
            hits: { type: Number, default: null },
            misses: { type: Number, default: null },
            correctRejections: { type: Number, default: null },
            falseAlarms: { type: Number, default: null },
            meanResponseTimeMs: { type: Number, default: null },
            dPrime: { type: Number, default: null },
            
            meanEncodingFixationMs: { type: Number, default: null },
            meanRecognitionFixationMs: { type: Number, default: null },
        },
        
        sampleQuality: {
            totalSamples: { type: Number, default: null },
            validSamples: { type: Number, default: null },
            validTrackingPct: { type: Number, default: null },
            qualityNotes: { type: [String], default: [] },
        },
        
        trials: [{
            imageId: String,
            phase: String, // "encoding" or "recognition"
            isOld: Boolean,
            userResponse: String, // "seen" or "not_seen"
            isCorrect: Boolean,
            responseTimeMs: Number,
            fixationCount: Number,
            fixationDurationMs: Number
        }],
        
        samples: { type: [gazeSampleSchema], default: [] },
    },
    { timestamps: true }
);

module.exports = mongoose.model("MemoryEyeTracking", memoryEyeTrackingSchema);