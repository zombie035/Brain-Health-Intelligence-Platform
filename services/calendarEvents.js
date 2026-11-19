const EVENT_TYPES = {
    brain_guard_assessment: "BrainGuard AI assessment",
    doctor_appointment: "Doctor appointment",
    neurological_consultation: "Neurological consultation",
    health_checkup: "General health check-up",
    follow_up: "Follow-up",
    reminder: "Reminder",
};

const EVENT_STATUSES = new Set(["scheduled", "completed", "cancelled", "missed"]);
const MAX_SERIES_COUNT = 12;
const MAX_INTERVAL_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

function validationError(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
}

function validTimeZone(value) {
    if (typeof value !== "string" || value.length > 80) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

function parseUtcDate(value, label) {
    if (
        typeof value !== "string"
        || value.length > 40
        || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ) {
        throw validationError(`${label} must include an explicit time-zone offset.`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw validationError(`Enter a valid ${label.toLowerCase()}.`);
    }
    return date;
}

function validateCalendarEvent(input, { allowPast = false, now = new Date() } = {}) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const notes = typeof input.notes === "string" ? input.notes.trim() : "";
    const eventType = input.eventType;
    const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";

    if (!title || title.length > 120) {
        throw validationError("Enter an event title of 1 to 120 characters.");
    }
    if (!Object.hasOwn(EVENT_TYPES, eventType)) {
        throw validationError("Select a valid event type.");
    }
    if (notes.length > 2000) {
        throw validationError("Notes must be 2000 characters or fewer.");
    }
    if (!validTimeZone(timeZone)) {
        throw validationError("Select a valid time zone.");
    }

    const startAt = parseUtcDate(input.startAtUtc, "Start date and time");
    const endAt = parseUtcDate(input.endAtUtc, "End date and time");
    const durationMs = endAt.getTime() - startAt.getTime();
    if (durationMs <= 0 || durationMs > 30 * DAY_MS) {
        throw validationError("The end time must be after the start and within 30 days.");
    }
    if (!allowPast && startAt <= now) {
        throw validationError("Schedule the event for a future date and time.");
    }

    return {
        title,
        eventType,
        startAt,
        endAt,
        timeZone,
        notes,
    };
}

function validateRecurrence(input) {
    const intervalDays = Number(input.repeatEveryDays || 0);
    const count = Number(input.repeatCount || 1);
    if (
        !Number.isInteger(intervalDays)
        || intervalDays < 0
        || intervalDays > MAX_INTERVAL_DAYS
    ) {
        throw validationError(`Repeat interval must be between 1 and ${MAX_INTERVAL_DAYS} days, or 0 for no repeat.`);
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_SERIES_COUNT) {
        throw validationError(`Choose between 1 and ${MAX_SERIES_COUNT} occurrences.`);
    }
    if ((intervalDays === 0 && count !== 1) || (intervalDays > 0 && count < 2)) {
        throw validationError("Choose a repeat interval and at least two occurrences, or choose no repeat.");
    }
    return { intervalDays, count };
}

function validateOccurrences(input, event, recurrence, now = new Date()) {
    let occurrences = input;
    if (typeof occurrences === "string") {
        try {
            occurrences = JSON.parse(occurrences);
        } catch {
            throw validationError("The repeated schedule could not be read.");
        }
    }
    if (!Array.isArray(occurrences) || occurrences.length !== recurrence.count) {
        throw validationError("The repeated schedule has an invalid number of occurrences.");
    }

    const parsed = [];
    for (let index = 0; index < occurrences.length; index += 1) {
        const occurrence = occurrences[index];
        const startAt = parseUtcDate(occurrence?.startAtUtc, "Start date and time");
        const endAt = parseUtcDate(occurrence?.endAtUtc, "End date and time");
        if (
            endAt <= startAt
            || endAt.getTime() - startAt.getTime() !== event.endAt.getTime() - event.startAt.getTime()
        ) {
            throw validationError("Each occurrence must keep the original duration and end after its start.");
        }
        if (startAt <= now) {
            throw validationError("Every repeated event must be scheduled in the future.");
        }
        if (
            index === 0
            && (
                startAt.getTime() !== event.startAt.getTime()
                || endAt.getTime() !== event.endAt.getTime()
            )
        ) {
            throw validationError("The first repeated event must match the selected date and time.");
        }
        if (index > 0) {
            const difference = startAt.getTime() - parsed[index - 1].startAt.getTime();
            const expected = recurrence.intervalDays * DAY_MS;
            if (
                difference <= 0
                || Math.abs(difference - expected) > 60 * 60 * 1000
            ) {
                throw validationError("Repeated event dates do not match the selected interval.");
            }
        }
        parsed.push({ startAt, endAt });
    }

    return parsed;
}

function validateEventStatus(value) {
    if (!EVENT_STATUSES.has(value)) {
        throw validationError("Select a valid event status.");
    }
    return value;
}

function publicCalendarEvent(event) {
    return {
        id: String(event._id),
        title: event.title,
        eventType: event.eventType,
        startAt: new Date(event.startAt).toISOString(),
        endAt: new Date(event.endAt).toISOString(),
        timeZone: event.timeZone,
        notes: event.notes,
        status: event.status,
        seriesIndex: event.seriesIndex,
        seriesCount: event.seriesCount,
        repeatEveryDays: event.repeatEveryDays,
    };
}

module.exports = {
    EVENT_TYPES,
    MAX_INTERVAL_DAYS,
    MAX_SERIES_COUNT,
    publicCalendarEvent,
    validateCalendarEvent,
    validateEventStatus,
    validateOccurrences,
    validateRecurrence,
    validTimeZone,
};
