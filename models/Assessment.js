
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
    }
}, {
    timestamps: true
});

module.exports = mongoose.model(
    "Assessment",
    assessmentSchema
);
