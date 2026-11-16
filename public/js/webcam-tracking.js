document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("webcamApp");
    if (!container) return; // Exit if not on the dashboard

    const assessmentId = container.dataset.assessmentId;
    if (!assessmentId) {
        console.error("webcam-tracking: missing data-assessment-id on #webcamApp");
        return;
    }

    const video = document.getElementById("webcam");
    const canvas = document.getElementById("gazeCanvas");
    const ctx = canvas.getContext("2d");
    const statusText = document.getElementById("cameraStatus");

    const btnStart = document.getElementById("btnStart");
    const btnCalibrate = document.getElementById("btnCalibrate");
    const btnStop = document.getElementById("btnStop");

    const calibOverlay = document.getElementById("calibrationOverlay");
    const calibDot = document.getElementById("calibrationDot");
    const calibTitle = document.getElementById("calibTitle");
    const calibSub = document.getElementById("calibSub");

    let stream = null;
    let isTracking = false;
    let isCalibrating = false;
    let gazePoints = [];
    let processTimeout = null;

    // ── 1. Start Webcam ─────────────────────────────────────────────
    btnStart.addEventListener("click", async () => {
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: "user"
                },
                audio: false
            });
            video.srcObject = stream;

            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                statusText.textContent = "Camera active. Not calibrated.";
                btnStart.disabled = true;
                btnCalibrate.disabled = false;
                btnStop.disabled = false;

                // Tell the backend how big the screen is
                fetch("/eye-tracking/init-screen", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        widthPx: window.screen.width,
                        heightPx: window.screen.height
                    })
                }).catch(err => console.warn("init-screen failed:", err));

                startProcessing();
            };
        } catch (err) {
            statusText.textContent = "Camera Error: " + err.message;
            console.error(err);
        }
    });

    // ── 2. Frame processing loop (~10 FPS) ──────────────────────────
    async function startProcessing() {
        if (!stream) return;

        if (!isCalibrating) {
            const offCanvas = document.createElement("canvas");
            offCanvas.width = video.videoWidth;
            offCanvas.height = video.videoHeight;
            offCanvas.getContext("2d").drawImage(video, 0, 0);
            const b64 = offCanvas.toDataURL("image/jpeg", 0.7);

            try {
                const res = await fetch("/eye-tracking/process-frame", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        imageBase64: b64,
                        timestampMs: Date.now(),
                        returnRaw: false
                    })
                });
                const data = await res.json();

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (data.valid) {
                    // Video is CSS-mirrored (scaleX(-1)) → invert X for the dot
                    const px = (1 - data.xFraction) * canvas.width;
                    const py = data.yFraction * canvas.height;

                    ctx.beginPath();
                    ctx.arc(px, py, 15, 0, Math.PI * 2);
                    ctx.fillStyle = "rgba(255, 0, 0, 0.8)";
                    ctx.fill();
                    ctx.strokeStyle = "white";
                    ctx.lineWidth = 2;
                    ctx.stroke();

                    gazePoints.push({
                        x: data.xFraction,
                        y: data.yFraction,
                        time: Date.now()
                    });
                    statusText.textContent = `Tracking... (${gazePoints.length} samples)`;
                } else if (data.reason === "face_not_detected") {
                    statusText.textContent = "Face not detected. Please look at the camera.";
                } else {
                    statusText.textContent = "Tracking lost...";
                }
            } catch (e) {
                console.error("Frame processing failed:", e);
            }
        }

        processTimeout = setTimeout(startProcessing, 100);
    }

    // ── 3. 9-dot calibration ────────────────────────────────────────
    btnCalibrate.addEventListener("click", async () => {
        if (isCalibrating) return;
        isCalibrating = true;
        btnCalibrate.disabled = true;
        calibOverlay.style.display = "block";
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const grid = [
            [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
            [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
            [0.1, 0.9], [0.5, 0.9], [0.9, 0.9]
        ];

        const collectedData = [];

        for (let i = 0; i < grid.length; i++) {
            const [tx, ty] = grid[i];

            calibDot.style.display = "block";
            calibDot.style.left = `${tx * 100}%`;
            calibDot.style.top = `${ty * 100}%`;
            calibTitle.textContent = `Target ${i + 1} / 9`;
            calibSub.textContent = "Keep your head still";

            // Give the user 1.5s to fixate
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Capture 5 raw frames for this dot
            const featuresForThisDot = [];
            for (let f = 0; f < 5; f++) {
                const offCanvas = document.createElement("canvas");
                offCanvas.width = video.videoWidth;
                offCanvas.height = video.videoHeight;
                offCanvas.getContext("2d").drawImage(video, 0, 0);
                const b64 = offCanvas.toDataURL("image/jpeg", 0.7);

                try {
                    const res = await fetch("/eye-tracking/process-frame", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            imageBase64: b64,
                            timestampMs: Date.now(),
                            returnRaw: true
                        })
                    });
                    const data = await res.json();
                    if (data.valid && data.features) {
                        featuresForThisDot.push(...data.features);
                    }
                } catch (e) {
                    console.warn("Calibration frame failed:", e);
                }
                await new Promise(r => setTimeout(r, 100));
            }

            if (featuresForThisDot.length > 0) {
                collectedData.push({
                    targetX: tx,
                    targetY: ty,
                    features: featuresForThisDot
                });
            }
        }

        calibDot.style.display = "none";
        calibTitle.textContent = "Calculating calibration...";

        try {
            const res = await fetch("/eye-tracking/calibrate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ points: collectedData })
            });
            const data = await res.json();

            if (data.success) {
                statusText.textContent = "Calibrated successfully!";
                calibTitle.textContent = "Success!";
                calibSub.textContent = "You can close this overlay.";
            } else {
                calibTitle.textContent = "Calibration Failed";
                calibSub.textContent = data.message || "Unknown error";
            }
        } catch (e) {
            calibTitle.textContent = "Error";
            calibSub.textContent = "Server connection failed.";
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        calibOverlay.style.display = "none";
        isCalibrating = false;
        btnCalibrate.disabled = false;
        gazePoints = []; // drop pre-calibration samples
        statusText.textContent = "Tracking... (Calibrated)";
    });

    // ── 4. Stop and save ────────────────────────────────────────────
    btnStop.addEventListener("click", async () => {
        isTracking = false;
        clearTimeout(processTimeout);
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            video.srcObject = null;
        }
        btnStart.disabled = false;
        btnCalibrate.disabled = true;
        btnStop.disabled = true;
        statusText.textContent = `Saving ${gazePoints.length} samples...`;

        if (gazePoints.length === 0) {
            statusText.textContent = "No samples recorded. Nothing to save.";
            return;
        }

        try {
            const res = await fetch(`/eye-tracking/${assessmentId}/save-web-session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    points: gazePoints,
                    widthPx: canvas.width,
                    heightPx: canvas.height
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || data.error || "Save failed");
            }
            statusText.textContent = `Saved ${data.sampleCount} samples. Reloading...`;
            setTimeout(() => window.location.reload(), 600);
        } catch (e) {
            statusText.textContent = "Failed to save: " + e.message;
            console.error("save-web-session failed:", e);
            // Re-enable Start so the user can retry without a full page reload
            btnStart.disabled = false;
        }
    });
});