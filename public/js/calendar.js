(() => {
    const eventData = document.getElementById("calendar-event-data");
    const eventForm = document.getElementById("calendarEventForm");
    const timeZoneField = document.getElementById("calendarTimeZone");

    function browserTimeZone() {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }

    function toLocalInputValue(value) {
        const date = new Date(value);
        const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return localDate.toISOString().slice(0, 16);
    }

    if (eventForm && timeZoneField) {
        const timeZoneNote = document.getElementById("calendarTimeZoneNote");
        const startInput = document.getElementById("calendarStart");
        const endInput = document.getElementById("calendarEnd");
        const startUtcField = document.getElementById("calendarStartUtc");
        const endUtcField = document.getElementById("calendarEndUtc");
        const repeatDaysInput = document.getElementById("calendarRepeatDays");
        const repeatCountInput = document.getElementById("calendarRepeatCount");
        const occurrencesField = document.getElementById("calendarOccurrences");
        const editDataElement = document.getElementById("calendar-edit-data");
        const editingEvent = editDataElement
            ? JSON.parse(editDataElement.textContent)
            : null;
        const zone = browserTimeZone();

        timeZoneField.value = zone;
        if (timeZoneNote) {
            timeZoneNote.textContent = `Times are entered in ${zone} and saved with that time zone.`;
        }

        if (editingEvent) {
            startInput.value = toLocalInputValue(editingEvent.startAt);
            endInput.value = toLocalInputValue(editingEvent.endAt);
        } else {
            const start = new Date();
            start.setDate(start.getDate() + 1);
            start.setHours(start.getHours() + 1, 0, 0, 0);
            const end = new Date(start);
            end.setHours(end.getHours() + 1);
            startInput.value = toLocalInputValue(start);
            endInput.value = toLocalInputValue(end);
        }

        function updateRepeatFields() {
            if (repeatCountInput) {
                repeatCountInput.disabled = !repeatDaysInput.value;
            }
        }

        if (repeatDaysInput) {
            repeatDaysInput.addEventListener("input", updateRepeatFields);
            updateRepeatFields();
        }

        eventForm.addEventListener("submit", event => {
            const start = new Date(startInput.value);
            const end = new Date(endInput.value);
            if (
                Number.isNaN(start.getTime())
                || Number.isNaN(end.getTime())
                || end <= start
            ) {
                event.preventDefault();
                endInput.setCustomValidity("Choose an end time after the start time.");
                endInput.reportValidity();
                return;
            }
            endInput.setCustomValidity("");
            timeZoneField.value = zone;
            startUtcField.value = start.toISOString();
            endUtcField.value = end.toISOString();

            if (editingEvent) {
                occurrencesField.value = "";
                return;
            }

            const intervalDays = repeatDaysInput && repeatDaysInput.value
                ? Number(repeatDaysInput.value)
                : 0;
            const count = intervalDays
                ? Number(repeatCountInput.value)
                : 1;
            const durationMs = end.getTime() - start.getTime();
            const occurrences = [];
            for (let index = 0; index < count; index += 1) {
                const occurrenceStart = new Date(start);
                occurrenceStart.setDate(start.getDate() + intervalDays * index);
                const occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);
                occurrences.push({
                    startAtUtc: occurrenceStart.toISOString(),
                    endAtUtc: occurrenceEnd.toISOString(),
                });
            }
            occurrencesField.value = JSON.stringify(occurrences);
        });
    }

    if (!eventData) return;

    const grid = document.getElementById("calendarGrid");
    const upcoming = document.getElementById("calendarUpcoming");
    const emptyMessage = document.getElementById("calendarEmpty");
    if (!grid || !upcoming || !emptyMessage) return;

    const events = JSON.parse(eventData.textContent);
    const assessmentId = window.location.pathname.split("/").filter(Boolean).pop();
    const eventLabels = {
        brain_guard_assessment: "BrainGuard AI assessment",
        doctor_appointment: "Doctor appointment",
        neurological_consultation: "Neurological consultation",
        health_checkup: "General health check-up",
        follow_up: "Follow-up",
        reminder: "Reminder",
    };
    const statusLabels = {
        scheduled: "Scheduled",
        completed: "Completed",
        cancelled: "Cancelled",
        missed: "Overdue",
    };
    const displayTimeZone = browserTimeZone();
    const eventByDate = new Map();
    const now = new Date();
    let activeView = "month";
    let visibleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    function dateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function eventDateKey(event) {
        const date = new Date(event.startAt);
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: displayTimeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(date);
    }

    function formatDate(event) {
        return new Intl.DateTimeFormat(undefined, {
            timeZone: displayTimeZone,
            dateStyle: "medium",
            timeStyle: "short",
        }).format(new Date(event.startAt));
    }

    function eventAnchor(event) {
        const link = document.createElement("a");
        link.className = `calendar-grid-event ${event.eventType}`;
        link.href = `#event-${encodeURIComponent(event.id)}`;
        link.textContent = `${new Intl.DateTimeFormat(undefined, {
            timeZone: displayTimeZone,
            hour: "numeric",
            minute: "2-digit",
        }).format(new Date(event.startAt))} · ${event.title}`;
        link.title = `${eventLabels[event.eventType] || "Event"}: ${event.title}`;
        return link;
    }

    function appendActionForm(card, event, action, label, statusValue) {
        const form = document.createElement("form");
        form.method = "post";
        form.action = `/calendar/${encodeURIComponent(assessmentId)}/events/${encodeURIComponent(event.id)}${action}`;
        if (statusValue) {
            const status = document.createElement("input");
            status.type = "hidden";
            status.name = "status";
            status.value = statusValue;
            form.append(status);
        }
        const button = document.createElement("button");
        button.type = "submit";
        button.className = "calendar-action-button";
        button.textContent = label;
        form.append(button);
        if (action === "/cancel") {
            form.addEventListener("submit", submitEvent => {
                if (!window.confirm(`Cancel "${event.title}"?`)) {
                    submitEvent.preventDefault();
                }
            });
        }
        card.querySelector(".calendar-event-actions").append(form);
    }

    function makeEventCard(event) {
        const card = document.createElement("article");
        card.className = `calendar-event-card ${event.eventType} status-${event.status}`;
        card.id = `event-${event.id}`;

        const heading = document.createElement("h3");
        heading.textContent = event.title;
        card.append(heading);

        const details = document.createElement("p");
        details.className = "calendar-event-details";
        const zoneNote = event.timeZone !== displayTimeZone
            ? ` · originally scheduled in ${event.timeZone}`
            : "";
        details.textContent = `${eventLabels[event.eventType] || "Event"} · ${formatDate(event)}${zoneNote}`;
        card.append(details);

        const status = document.createElement("span");
        status.className = `calendar-status status-${event.status}`;
        status.textContent = statusLabels[event.status] || event.status;
        card.append(status);

        if (event.seriesCount > 1) {
            const repeat = document.createElement("p");
            repeat.className = "calendar-event-repeat";
            repeat.textContent = `Occurrence ${event.seriesIndex} of ${event.seriesCount}`;
            card.append(repeat);
        }
        if (event.notes) {
            const notes = document.createElement("p");
            notes.className = "calendar-event-notes";
            notes.textContent = event.notes;
            card.append(notes);
        }

        const actions = document.createElement("div");
        actions.className = "calendar-event-actions";
        const edit = document.createElement("a");
        edit.className = "calendar-action-button";
        edit.href = `/calendar/${encodeURIComponent(assessmentId)}?edit=${encodeURIComponent(event.id)}#calendarEditor`;
        edit.textContent = "Edit";
        actions.append(edit);
        card.append(actions);

        if (event.status !== "cancelled") {
            if (event.status !== "completed" || new Date(event.startAt) > now) {
                appendActionForm(
                    card,
                    event,
                    "/status",
                    event.status === "completed" ? "Mark scheduled" : "Mark complete",
                    event.status === "completed" ? "scheduled" : "completed"
                );
            }
            if (event.status !== "completed") {
                appendActionForm(card, event, "/cancel", "Cancel event");
            }
        }
        return card;
    }

    function eventsOn(date) {
        return eventByDate.get(dateKey(date)) || [];
    }

    function renderGrid() {
        grid.replaceChildren();
        grid.className = `calendar-month-grid view-${activeView}`;
        grid.hidden = activeView === "upcoming";
        if (activeView === "upcoming") return;

        const headings = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        for (const label of headings) {
            const weekday = document.createElement("div");
            weekday.className = "calendar-weekday";
            weekday.textContent = label;
            grid.append(weekday);
        }

        let firstDate;
        let daysToRender;
        if (activeView === "week") {
            firstDate = new Date(visibleDate);
            firstDate.setDate(firstDate.getDate() - firstDate.getDay());
            daysToRender = 7;
            const lastDate = new Date(firstDate);
            lastDate.setDate(lastDate.getDate() + 6);
            document.getElementById("calendarHeading").textContent =
                `${firstDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${lastDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
        } else {
            firstDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth(), 1);
            firstDate.setDate(firstDate.getDate() - firstDate.getDay());
            daysToRender = Math.ceil(
                (new Date(visibleDate.getFullYear(), visibleDate.getMonth() + 1, 0).getDate()
                    + new Date(visibleDate.getFullYear(), visibleDate.getMonth(), 1).getDay()) / 7
            ) * 7;
            document.getElementById("calendarHeading").textContent =
                visibleDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        }

        for (let index = 0; index < daysToRender; index += 1) {
            const date = new Date(firstDate);
            date.setDate(firstDate.getDate() + index);
            const day = document.createElement("section");
            day.className = "calendar-day";
            if (dateKey(date) === dateKey(now)) day.classList.add("is-today");
            if (activeView === "month" && date.getMonth() !== visibleDate.getMonth()) {
                day.classList.add("is-outside-month");
            }

            const dayHeading = document.createElement("h3");
            dayHeading.textContent = date.toLocaleDateString(undefined, {
                weekday: activeView === "week" ? "long" : undefined,
                day: "numeric",
                month: activeView === "week" ? "short" : undefined,
            });
            day.append(dayHeading);
            for (const event of eventsOn(date)) {
                day.append(eventAnchor(event));
            }
            grid.append(day);
        }
    }

    function renderUpcoming() {
        upcoming.replaceChildren();
        const upcomingEvents = events
            .filter(event => event.status === "scheduled" || event.status === "missed")
            .sort((left, right) => new Date(left.startAt) - new Date(right.startAt));
        emptyMessage.hidden = events.length > 0;

        if (upcomingEvents.length) {
            const heading = document.createElement("h3");
            heading.className = "calendar-list-heading";
            heading.textContent = "Upcoming and outstanding";
            upcoming.append(heading);
        } else if (events.length > 0) {
            const none = document.createElement("p");
            none.className = "calendar-no-upcoming";
            none.textContent = "No upcoming or outstanding events. Completed and cancelled items remain visible on the calendar.";
            upcoming.append(none);
        }
        for (const event of upcomingEvents) {
            upcoming.append(makeEventCard(event));
        }

        const reminders = upcomingEvents.filter(event => {
            const difference = new Date(event.startAt).getTime() - now.getTime();
            return event.status === "scheduled" && difference >= 0 && difference <= 24 * 60 * 60 * 1000;
        });
        const reminder = document.getElementById("calendarReminder");
        if (reminder) {
            reminder.hidden = reminders.length === 0;
            reminder.textContent = reminders.length
                ? `Coming up within 24 hours: ${reminders.map(event => event.title).join(", ")}.`
                : "";
        }
    }

    function render() {
        eventByDate.clear();
        for (const event of events) {
            const key = eventDateKey(event);
            if (!eventByDate.has(key)) eventByDate.set(key, []);
            eventByDate.get(key).push(event);
        }
        for (const list of eventByDate.values()) {
            list.sort((left, right) => new Date(left.startAt) - new Date(right.startAt));
        }
        renderGrid();
        renderUpcoming();
    }

    document.querySelectorAll("[data-calendar-view]").forEach(button => {
        button.addEventListener("click", () => {
            activeView = button.dataset.calendarView;
            document.querySelectorAll("[data-calendar-view]").forEach(item => {
                item.setAttribute("aria-pressed", String(item === button));
            });
            render();
        });
    });

    document.getElementById("calendarPrevious").addEventListener("click", () => {
        if (activeView === "week") visibleDate.setDate(visibleDate.getDate() - 7);
        else visibleDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth() - 1, 1);
        render();
    });
    document.getElementById("calendarNext").addEventListener("click", () => {
        if (activeView === "week") visibleDate.setDate(visibleDate.getDate() + 7);
        else visibleDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth() + 1, 1);
        render();
    });
    document.getElementById("calendarToday").addEventListener("click", () => {
        visibleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        render();
    });

    render();
})();
