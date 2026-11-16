
const mongoose = require("mongoose");

const healthProfileSchema = new mongoose.Schema({
    assessmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Assessment",
        required: true,
        unique: true
    },

    age: {
        type: Number,
        required: true
    },

    language: {
        type: String,
        required: true
    },

    educationLevel: {
        type: String,
        required: true
    },

    sleepHours: {
        type: Number,
        required: true
    },

    exerciseMinutes: {
        type: Number,
        required: true
    },

    stressLevel: {
        type: Number,
        required: true
    },

    familyHistory: {
        type: String,
        required: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model(
    "HealthProfile",
    healthProfileSchema
);
