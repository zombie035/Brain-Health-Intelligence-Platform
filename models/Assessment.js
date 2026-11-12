
const mongoose = require("mongoose");

const assessmentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },

    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },

    memoryCorrect: {
        type: Number,
        required: true
    },

    memoryTotal: {
        type: Number,
        default: 5
    },

    attentionCorrect: {
        type: Boolean,
        required: true
    },

    reactionMs: {
        type: Number,
        required: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model(
    "Assessment",
    assessmentSchema
);
