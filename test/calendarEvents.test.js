const test = require("node:test");
const assert = require("node:assert/strict");

const {
    validateCalendarEvent,
    validateEventStatus,
    validateOccurrences,
    validateRecurrence,
} = require("../services/calendarEvents");

function futureIso(offsetDays, hour = 12) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
}

function validInput(overrides = {}) {
    const startAtUtc = futureIso(2);
    const endAtUtc = new Date(new Date(startAtUtc).getTime() + 60 * 60 * 1000).toISOString();
    return {
        title: "Eye assessment",
        eventType: "brain_guard_assessment",
        startAtUtc,
        endAtUtc,
        timeZone: "America/New_York",
        notes: "",
        ...overrides,
    };
}

test("calendar event validation accepts valid future events with an explicit time zone", () => {
    const event = validateCalendarEvent(validInput());

    assert.equal(event.title, "Eye assessment");
    assert.equal(event.eventType, "brain_guard_assessment");
    assert.equal(event.timeZone, "America/New_York");
    assert.ok(event.endAt > event.startAt);
});

test("calendar event validation rejects invalid types, zones, and time ranges", () => {
    assert.throws(
        () => validateCalendarEvent(validInput({ eventType: "unknown" })),
        /valid event type/
    );
    assert.throws(
        () => validateCalendarEvent(validInput({ timeZone: "Mars/Olympus" })),
        /valid time zone/
    );
    assert.throws(
        () => validateCalendarEvent(validInput({ startAtUtc: "2030-01-01T10:00" })),
        /explicit time-zone offset/
    );
    assert.throws(
        () => validateCalendarEvent(validInput({
            endAtUtc: new Date(new Date(futureIso(2)).getTime() - 1000).toISOString(),
        })),
        /end time must be after/
    );
});

test("repeat schedules are bounded and permit a daylight-saving time shift", () => {
    const firstStart = new Date("2027-03-13T14:00:00.000Z");
    const firstEnd = new Date("2027-03-13T15:00:00.000Z");
    const event = {
        startAt: firstStart,
        endAt: firstEnd,
    };
    const recurrence = validateRecurrence({
        repeatEveryDays: "1",
        repeatCount: "2",
    });
    const occurrences = validateOccurrences([
        {
            startAtUtc: firstStart.toISOString(),
            endAtUtc: firstEnd.toISOString(),
        },
        {
            startAtUtc: "2027-03-14T13:00:00.000Z",
            endAtUtc: "2027-03-14T14:00:00.000Z",
        },
    ], event, recurrence, new Date("2027-01-01T00:00:00.000Z"));

    assert.equal(occurrences.length, 2);
    assert.equal(occurrences[1].startAt.getTime() - occurrences[0].startAt.getTime(), 23 * 60 * 60 * 1000);
    assert.throws(
        () => validateRecurrence({ repeatEveryDays: "1", repeatCount: "13" }),
        /between 1 and 12/
    );
});

test("repeated event dates must match the selected recurrence interval", () => {
    const firstStart = new Date("2030-05-01T12:00:00.000Z");
    const firstEnd = new Date("2030-05-01T13:00:00.000Z");

    assert.throws(() => validateOccurrences([
        {
            startAtUtc: firstStart.toISOString(),
            endAtUtc: firstEnd.toISOString(),
        },
        {
            startAtUtc: "2030-05-03T12:00:00.000Z",
            endAtUtc: "2030-05-03T13:00:00.000Z",
        },
    ], { startAt: firstStart, endAt: firstEnd }, { intervalDays: 1, count: 2 }, new Date("2030-01-01T00:00:00.000Z")),
    /do not match the selected interval/);
});

test("event status validation only accepts supported states", () => {
    assert.equal(validateEventStatus("completed"), "completed");
    assert.throws(() => validateEventStatus("booked"), /valid event status/);
});
