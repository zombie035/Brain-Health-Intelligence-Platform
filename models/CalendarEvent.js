const mongoose = require("mongoose");

const calendarEventSchema = new mongoose.Schema({
    ownerEmail: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
    },
    sourceAssessmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Assessment",
        required: true,
    },
    title: {
        type: String,
        required: true,
        maxlength: 120,
    },
    eventType: {
        type: String,
        enum: [
            "brain_guard_assessment",
            "doctor_appointment",
            "neurological_consultation",
            "health_checkup",
            "follow_up",
            "reminder",
        ],
        required: true,
    },
    startAt: {
        type: Date,
        required: true,
    },
    endAt: {
        type: Date,
        required: true,
    },
    timeZone: {
        type: String,
        required: true,
        maxlength: 80,
    },
    notes: {
        type: String,
        default: "",
        maxlength: 2000,
    },
    status: {
        type: String,
        enum: ["scheduled", "completed", "cancelled", "missed"],
        required: true,
        default: "scheduled",
    },
    seriesId: {
        type: String,
        default: null,
    },
    seriesIndex: {
        type: Number,
        min: 1,
        default: null,
    },
    seriesCount: {
        type: Number,
        min: 1,
        max: 12,
        default: null,
    },
    repeatEveryDays: {
        type: Number,
        min: 1,
        max: 365,
        default: null,
    },
}, {
    timestamps: true,
});

calendarEventSchema.index({ ownerEmail: 1, startAt: 1 });
calendarEventSchema.index({ seriesId: 1, seriesIndex: 1 });

module.exports = mongoose.model("CalendarEvent", calendarEventSchema);
