document.addEventListener("DOMContentLoaded", () => {
    const runner = document.getElementById("attentionTest");
    if (!runner) return;

    const assessmentId = runner.dataset.assessmentId;
    const startButton = document.getElementById("startAttentionTest");
    const cancelButton = document.getElementById("cancelAttentionTest");
    const statusText = document.getElementById("attentionStatus");
    const progressTrack = document.querySelector(".eye-progress-track");
    const progressFill = document.getElementById("attentionProgress");
    const progressText = document.getElementById("attentionProgressText");

    function setProgress(value) {
        const progress = Math.max(0, Math.min(100, Number(value) || 0));
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${Math.round(progress)}%`;
        progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
    }

    async function requestJson(url, options = {}) {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error(
                data.message || `Request failed (${response.status}).`
            );
        }
        return data;
    }

    async function pollSession(sessionId) {
        try {
            const status = await requestJson(
                `/eye-assessment/${assessmentId}/attention/${encodeURIComponent(sessionId)}/status`
            );
            statusText.textContent = status.message || "Checking assessment status.";
            setProgress(status.progress);

            if (["completed", "incomplete", "failed"].includes(status.status)) {
                statusText.textContent = status.message;
                cancelButton.hidden = true;
                if (status.resultUrl) {
                    window.location.assign(status.resultUrl);
                }
                return;
            }
        } catch (error) {
            statusText.textContent =
                `Connection issue while checking progress: ${error.message} Retrying...`;
        }

        window.setTimeout(() => pollSession(sessionId), 1200);
    }

    startButton.addEventListener("click", async () => {
        startButton.disabled = true;
        statusText.textContent = "Starting the GazeMap process...";
        setProgress(0);

        try {
            const session = await requestJson(
                `/eye-assessment/${assessmentId}/attention/start`,
                { method: "POST" }
            );
            cancelButton.dataset.sessionId = session.sessionId;
            cancelButton.hidden = false;
            statusText.textContent =
                "The GazeMap stimulus window is opening. Keep this page open.";
            pollSession(session.sessionId);
        } catch (error) {
            statusText.textContent = `Unable to start the test: ${error.message}`;
            startButton.disabled = false;
        }
    });

    cancelButton.addEventListener("click", async () => {
        const sessionId = cancelButton.dataset.sessionId;
        if (!sessionId) return;

        cancelButton.disabled = true;
        statusText.textContent = "Requesting assessment cancellation...";
        try {
            const result = await requestJson(
                `/eye-assessment/${assessmentId}/attention/${encodeURIComponent(sessionId)}/cancel`,
                { method: "POST" }
            );
            statusText.textContent = result.message;
        } catch (error) {
            statusText.textContent = `Unable to cancel the test: ${error.message}`;
            cancelButton.disabled = false;
        }
    });
});
