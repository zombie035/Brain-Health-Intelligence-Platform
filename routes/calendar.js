const express = require("express");
const mongoose = require("mongoose");

const Assessment = require("../models/Assessment");
const CalendarEvent = require("../models/CalendarEvent");
const {
    EVENT_TYPES,
    MAX_INTERVAL_DAYS,
    MAX_SERIES_COUNT,
    publicCalendarEvent,
    validateCalendarEvent,
    validateEventStatus,
    validateOccurrences,
    validateRecurrence,
} = require("../services/calendarEvents");

const router = express.Router();

function renderCalendarLookup(res, message = "") {
    return res.render("calendar", {
        title: "Health Calendar - BrainGuard AI",
        pageStylesheet: "calendar.css",
        assessment: null,
        events: [],
        calendarJson: "[]",
        editingEvent: null,
        prefillType: "brain_guard_assessment",
        eventTypes: EVENT_TYPES,
        errorMessage: message,
        maxIntervalDays: MAX_INTERVAL_DAYS,
        maxSeriesCount: MAX_SERIES_COUNT,
    });
}

async function findAssessment(id, res) {
    if (!mongoose.isValidObjectId(id)) {
        res.status(400).send("Invalid assessment ID.");
        return null;
    }
    const assessment = await Assessment.findById(id);
    if (!assessment) {
        res.status(404).send("Assessment not found.");
        return null;
    }
    return assessment;
}

function handleCalendarError(res, error, fallbackMessage) {
    if (error.status) {
        return res.status(error.status).send(error.message);
    }
    console.error("Calendar request error:", error);
    return res.status(500).send(fallbackMessage);
}

router.get("/calendar", (req, res) => renderCalendarLookup(res));

router.post("/calendar/open", async (req, res) => {
    const email = typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
        return renderCalendarLookup(res, "Enter the email address used for an assessment.");
    }

    try {
        const assessment = await Assessment.findOne({ email }).sort({ createdAt: -1 });
        if (!assessment) {
            return renderCalendarLookup(res, "No assessment was found for that email address.");
        }
        return res.redirect(`/calendar/${assessment._id}`);
    } catch (error) {
        console.error("Calendar lookup error:", error);
        return res.status(500).send("Unable to open the calendar.");
    }
});

router.get("/calendar/:id", async (req, res) => {
    try {
        const assessment = await findAssessment(req.params.id, res);
        if (!assessment) return;

        await CalendarEvent.updateMany(
            {
                ownerEmail: assessment.email,
                eventType: "brain_guard_assessment",
                status: "scheduled",
                startAt: { $lt: new Date() },
            },
            { $set: { status: "missed" } }
        );

        const events = await CalendarEvent.find({ ownerEmail: assessment.email })
            .sort({ startAt: -1 })
            .limit(500)
            .lean();
        let editingEvent = null;
        if (typeof req.query.edit === "string" && mongoose.isValidObjectId(req.query.edit)) {
            editingEvent = events.find(event => String(event._id) === req.query.edit) || null;
        }
        const serializedEvents = events.map(publicCalendarEvent);
        const requestedType = typeof req.query.new === "string" ? req.query.new : "";
        res.render("calendar", {
            title: "Health Calendar - BrainGuard AI",
            pageStylesheet: "calendar.css",
            assessment,
            events: serializedEvents,
            calendarJson: JSON.stringify(serializedEvents).replace(/</g, "\\u003c"),
            editingEvent: editingEvent ? publicCalendarEvent(editingEvent) : null,
            prefillType: Object.hasOwn(EVENT_TYPES, requestedType)
                ? requestedType
                : "brain_guard_assessment",
            eventTypes: EVENT_TYPES,
            errorMessage: "",
            maxIntervalDays: MAX_INTERVAL_DAYS,
            maxSeriesCount: MAX_SERIES_COUNT,
        });
    } catch (error) {
        console.error("Calendar page error:", error);
        res.status(500).send("Unable to load the calendar.");
    }
});

router.post("/calendar/:id/events", async (req, res) => {
    try {
        const assessment = await findAssessment(req.params.id, res);
        if (!assessment) return;

        const event = validateCalendarEvent(req.body);
        const recurrence = validateRecurrence(req.body);
        const occurrences = validateOccurrences(
            req.body.occurrences,
            event,
            recurrence
        );
        const seriesId = recurrence.count > 1
            ? new mongoose.Types.ObjectId().toString()
            : null;
        await CalendarEvent.insertMany(occurrences.map((occurrence, index) => ({
            ...event,
            ownerEmail: assessment.email,
            sourceAssessmentId: assessment._id,
            startAt: occurrence.startAt,
            endAt: occurrence.endAt,
            status: "scheduled",
            seriesId,
            seriesIndex: seriesId ? index + 1 : null,
            seriesCount: seriesId ? recurrence.count : null,
            repeatEveryDays: seriesId ? recurrence.intervalDays : null,
        })));
        res.redirect(`/calendar/${assessment._id}`);
    } catch (error) {
        handleCalendarError(res, error, "Unable to save the calendar event.");
    }
});

router.post("/calendar/:id/events/:eventId", async (req, res) => {
    try {
        const assessment = await findAssessment(req.params.id, res);
        if (!assessment) return;
        if (!mongoose.isValidObjectId(req.params.eventId)) {
            return res.status(400).send("Invalid event ID.");
        }
        const existingEvent = await CalendarEvent.findOne({
            _id: req.params.eventId,
            ownerEmail: assessment.email,
        });
        if (!existingEvent) {
            return res.status(404).send("Calendar event not found.");
        }

        const event = validateCalendarEvent(req.body, { allowPast: true });
        existingEvent.set(event);
        if (existingEvent.status === "missed" && event.startAt > new Date()) {
            existingEvent.status = "scheduled";
        }
        await existingEvent.save();
        res.redirect(`/calendar/${assessment._id}`);
    } catch (error) {
        handleCalendarError(res, error, "Unable to update the calendar event.");
    }
});

router.post("/calendar/:id/events/:eventId/status", async (req, res) => {
    try {
        const assessment = await findAssessment(req.params.id, res);
        if (!assessment) return;
        if (!mongoose.isValidObjectId(req.params.eventId)) {
            return res.status(400).send("Invalid event ID.");
        }
        const status = validateEventStatus(req.body.status);
        if (!["scheduled", "completed"].includes(status)) {
            return res.status(400).send("Events can only be marked scheduled or completed here.");
        }
        const existingEvent = await CalendarEvent.findOne({
            _id: req.params.eventId,
            ownerEmail: assessment.email,
        });
        if (!existingEvent || existingEvent.status === "cancelled") {
            return res.status(404).send("Calendar event not found.");
        }
        if (status === "scheduled" && existingEvent.startAt <= new Date()) {
            return res.status(400).send("Edit the event to choose a future date before marking it scheduled.");
        }
        const event = await CalendarEvent.findOneAndUpdate(
            {
                _id: req.params.eventId,
                ownerEmail: assessment.email,
                status: { $nin: ["cancelled"] },
            },
            { $set: { status } },
            { new: true, runValidators: true }
        );
        if (!event) {
            return res.status(404).send("Calendar event not found.");
        }
        res.redirect(`/calendar/${assessment._id}`);
    } catch (error) {
        handleCalendarError(res, error, "Unable to update the event status.");
    }
});

router.post("/calendar/:id/events/:eventId/cancel", async (req, res) => {
    try {
        const assessment = await findAssessment(req.params.id, res);
        if (!assessment) return;
        if (!mongoose.isValidObjectId(req.params.eventId)) {
            return res.status(400).send("Invalid event ID.");
        }
        const event = await CalendarEvent.findOneAndUpdate(
            {
                _id: req.params.eventId,
                ownerEmail: assessment.email,
                status: { $nin: ["cancelled", "completed"] },
            },
            { $set: { status: "cancelled" } },
            { new: true, runValidators: true }
        );
        if (!event) {
            return res.status(404).send("Calendar event not found.");
        }
        res.redirect(`/calendar/${assessment._id}`);
    } catch (error) {
        handleCalendarError(res, error, "Unable to cancel the event.");
    }
});

module.exports = router;
