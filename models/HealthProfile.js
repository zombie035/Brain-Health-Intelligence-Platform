
const mongoose = require("mongoose");

const healthProfileSchema = new mongoose.Schema({
    assessmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Assessment",
        required: true,
        unique: true
    },

    age: {
        type: Number
    },

    ageRange: {
        type: String
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
        type: Number
    },

    sleepDuration: {
        type: String
    },

    exerciseMinutes: {
        type: Number
    },

    activityLevel: {
        type: String
    },

    stressLevel: {
        type: Number
    },

    stressFrequency: {
        type: String
    },

    familyHistory: {
        type: String,
        required: true
    },

    questionnaireVersion: {
        type: Number
    },

    responses: {
        type: [{
            _id: false,
            questionId: { type: String, required: true },
            selectedOptions: { type: [String], required: true },
        }],
        default: []
    }
}, {
    timestamps: true
});

module.exports = mongoose.model(
    "HealthProfile",
    healthProfileSchema
);
