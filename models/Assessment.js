
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
<<<<<<< HEAD
=======
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
>>>>>>> f79453bff5602c6cbe713327b5054c4db7d00914
    }
}, {
    timestamps: true
});

module.exports = mongoose.model(
    "Assessment",
    assessmentSchema
);
