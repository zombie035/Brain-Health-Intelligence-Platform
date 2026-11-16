document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("eyeTrackingControls");

    if (!container) return;

    const assessmentId = container.dataset.assessmentId;

    const startBtn = document.getElementById("startGazeBtn");
    const saveBtn = document.getElementById("saveGazeBtn");
    const durationSelect = document.getElementById("gazeDuration");
    const statusText = document.getElementById("gazeStatus");
    const progressBar = document.getElementById("gazeProgress");

    let polling = false;
    let recordingComplete = false;
    let pollStartTime = null;

    const POLL_INTERVAL = 1500;
    const MAX_WAIT_TIME = 310000;

    function updateStatus(message) {
        statusText.textContent = message;
    }

    function updateProgress(value) {
        const percentage = Math.min(100, Math.max(0, value));
        progressBar.style.width = `${percentage}%`;
    }

    async function apiRequest(url, options = {}) {
        const response = await fetch(url, options);

        const data = await response.json().catch(() => ({}));

        if (!response.ok || data.success === false) {
            throw new Error(
                data.message || `Request failed (${response.status})`
            );
        }

        return data;
    }

    // START RECORDING
    startBtn.addEventListener("click", async () => {
        if (polling) return;

        const seconds = Number(durationSelect.value);

        startBtn.disabled = true;
        saveBtn.disabled = true;
        saveBtn.style.display = "none";

        recordingComplete = false;
        polling = true;
        pollStartTime = Date.now();

        updateProgress(0);
        updateStatus("Starting GazeMap recording...");

        try {
            await apiRequest(
                `/eye-tracking/${assessmentId}/start`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        stimulus: "test-image.jpg",
                        seconds
                    })
                }
            );

            updateStatus(
                "Recording started. Please look at the stimulus and keep your face visible."
            );

            pollRecordingStatus(seconds);

        } catch (error) {
            polling = false;
            startBtn.disabled = false;

            updateStatus(`Unable to start recording: ${error.message}`);
        }
    });

    // CHECK RECORDING STATUS
    async function pollRecordingStatus(duration) {
        if (!polling) return;

        if (Date.now() - pollStartTime > MAX_WAIT_TIME) {
            polling = false;
            startBtn.disabled = false;

            updateStatus(
                "Recording timed out. Check the GazeMap service before trying again."
            );

            return;
        }

        try {
            const status = await apiRequest(
                `/eye-tracking/${assessmentId}/status`
            );

            const elapsedSeconds = (Date.now() - pollStartTime) / 1000;

            updateProgress(
                Math.min((elapsedSeconds / duration) * 100, 95)
            );

            if (status.running) {
                updateStatus(
                    `Recording in progress... ${Math.min(
                        Math.floor(elapsedSeconds),
                        duration
                    )} / ${duration} seconds`
                );

                setTimeout(
                    () => pollRecordingStatus(duration),
                    POLL_INTERVAL
                );

                return;
            }

            const returnCode = status.returnCode ?? status.return_code;

            if (returnCode === 0) {
                polling = false;
                recordingComplete = true;

                updateProgress(100);

                updateStatus(
                    "Recording completed successfully. You can now save the results."
                );

                saveBtn.style.display = "inline-block";
                saveBtn.disabled = false;

                return;
            }

            polling = false;
            startBtn.disabled = false;

            updateStatus(
                `Recording did not complete successfully. Exit code: ${returnCode ?? "unknown"}`
            );

        } catch (error) {
            polling = false;
            startBtn.disabled = false;

            updateStatus(
                `Unable to check recording status: ${error.message}`
            );
        }
    }

    // SAVE RECORDING
    saveBtn.addEventListener("click", async () => {
        if (!recordingComplete) return;

        saveBtn.disabled = true;

        updateStatus("Saving eye-tracking measurements to MongoDB...");

        try {
            const result = await apiRequest(
                `/eye-tracking/${assessmentId}/save`,
                {
                    method: "POST"
                }
            );

            updateStatus(
                result.message || "Eye-tracking results saved successfully."
            );

            updateProgress(100);

            setTimeout(() => {
                window.location.reload();
            }, 1200);

        } catch (error) {
            saveBtn.disabled = false;

            updateStatus(
                `Unable to save results: ${error.message}`
            );
        }
    });
});