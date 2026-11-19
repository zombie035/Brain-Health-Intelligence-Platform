const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");

const Assessment = require("../models/Assessment");
const CalendarEvent = require("../models/CalendarEvent");
const calendarRoutes = require("../routes/calendar");

test("calendar writes use the assessment email and event lookups are email-scoped", async t => {
    const assessmentId = "64a000000000000000000001";
    const eventId = "64a000000000000000000002";
    const assessment = { _id: assessmentId, email: "calendar-owner@example.test" };
    const originalFindById = Assessment.findById;
    const originalInsertMany = CalendarEvent.insertMany;
    const originalFindOne = CalendarEvent.findOne;
    let insertedDocuments;
    let eventLookup;

    Assessment.findById = async id => id === assessmentId ? assessment : null;
    CalendarEvent.insertMany = async documents => {
        insertedDocuments = documents;
        return documents;
    };
    CalendarEvent.findOne = async filter => {
        eventLookup = filter;
        return null;
    };

    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use("/", calendarRoutes);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        Assessment.findById = originalFindById;
        CalendarEvent.insertMany = originalInsertMany;
        CalendarEvent.findOne = originalFindOne;
        await new Promise(resolve => server.close(resolve));
    });

    const origin = `http://127.0.0.1:${server.address().port}`;
    const startAtUtc = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const endAtUtc = new Date(new Date(startAtUtc).getTime() + 60 * 60 * 1000).toISOString();
    const response = await fetch(`${origin}/calendar/${assessmentId}/events`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            title: "Next assessment",
            eventType: "brain_guard_assessment",
            startAtUtc,
            endAtUtc,
            timeZone: "UTC",
            repeatEveryDays: "",
            repeatCount: "",
            occurrences: JSON.stringify([{ startAtUtc, endAtUtc }]),
        }),
        redirect: "manual",
    });

    assert.equal(response.status, 302);
    assert.equal(insertedDocuments.length, 1);
    assert.equal(insertedDocuments[0].ownerEmail, assessment.email);
    assert.equal(String(insertedDocuments[0].sourceAssessmentId), assessmentId);

    const editResponse = await fetch(`${origin}/calendar/${assessmentId}/events/${eventId}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            title: "Changed event",
            eventType: "brain_guard_assessment",
            startAtUtc,
            endAtUtc,
            timeZone: "UTC",
            notes: "",
        }),
        redirect: "manual",
    });

    assert.equal(editResponse.status, 404);
    assert.deepEqual(eventLookup, { _id: eventId, ownerEmail: assessment.email });
});
