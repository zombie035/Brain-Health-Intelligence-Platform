
const mongoose = require("mongoose");

const gazePointSchema = new mongoose.Schema(
    {
        seconds: {
            type: Number,
            required: true
        },
        x_px: {
            type: Number,
            required: true
        },
        y_px: {
            type: Number,
            required: true
        }
    },
    { _id: false }
);

const eyeTrackingSchema = new mongoose.Schema(
    {
        assessment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Assessment",
            required: true,
            index: true
        },

        email: {
            type: String,
            required: true,
            lowercase: true
        },

        session: {
            type: String,
            required: true
        },

        stimulus: {
            type: String,
            default: "test-image.jpg"
        },

        sampleCount: {
            type: Number,
            required: true
        },

        durationSeconds: {
            type: Number,
            required: true
        },

        coordinateSpace: {
            type: String,
            default: "heatmap_pixels"
        },

        heatmapFilename: {
            type: String,
            default: null
        },

        points: {
            type: [gazePointSchema],
            default: []
        },

        source: {
            type: String,
            default: "GazeMap"
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model(
    "EyeTracking",
    eyeTrackingSchema
);
