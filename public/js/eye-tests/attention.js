document.addEventListener("DOMContentLoaded", () => {
    const runner = document.getElementById("attentionTest");
    if (!runner) return;

    const assessmentId = runner.dataset.assessmentId;
    const websocketUrl = runner.dataset.gazeWsUrl;
    const stage = document.getElementById("gazeStage");
    const canvas = document.getElementById("gazeStageCanvas");
    const context = canvas.getContext("2d");
    const calibrationUI = window.EyeCalibrationUI.create(stage);
    const video = document.getElementById("gazeVideo");
    const stageMessage = document.getElementById("gazeStageMessage");
    const startButton = document.getElementById("startAttentionTest");
    const cancelButton = document.getElementById("cancelAttentionTest");
    const statusText = document.getElementById("attentionStatus");
    const progressTrack = document.querySelector(".eye-progress-track");
    const progressFill = document.getElementById("attentionProgress");
    const progressText = document.getElementById("attentionProgressText");

    const targets = calibrationUI.targets;
    const calibrationDwellMs = 850;
    const calibrationFrameCount = 5;
    const testDurationMs = 18000;
    const sampleIntervalMs = 120;
    const gazeSmoothingMs = 75;
    const pendingRequests = new Map();

    let stream = null;
    let socket = null;
    let requestCounter = 0;
    let active = false;
    let interruptionMessage = null;
    let testPoints = [];
    let displayTrail = [];
    let currentTarget = null;
    let latestGaze = null;
    let smoothedGaze = null;
    let lastRenderTime = 0;
    let lastTrailTime = 0;
    let stageAnimationFrame = null;
    let canvasWidth = 0;
    let canvasHeight = 0;

    function setProgress(value) {
        const progress = Math.max(0, Math.min(100, Number(value) || 0));
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${Math.round(progress)}%`;
        progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
    }

    function resizeCanvas() {
        const bounds = stage.getBoundingClientRect();
        const pixelRatio = window.devicePixelRatio || 1;
        canvasWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
        canvasHeight = Math.max(1, Math.round(bounds.height * pixelRatio));
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        context.setTransform(1, 0, 0, 1, 0, 0);
    }

    function drawStage(timestamp = performance.now()) {
        const frameDelta = lastRenderTime
            ? Math.min(timestamp - lastRenderTime, 100)
            : 16;
        lastRenderTime = timestamp;

        if (latestGaze) {
            if (!smoothedGaze) {
                smoothedGaze = { x: latestGaze.x, y: latestGaze.y };
            } else {
                const blend = 1 - Math.exp(-frameDelta / gazeSmoothingMs);
                smoothedGaze.x += (latestGaze.x - smoothedGaze.x) * blend;
                smoothedGaze.y += (latestGaze.y - smoothedGaze.y) * blend;
            }

            if (timestamp - lastTrailTime >= 32) {
                displayTrail.push({ x: smoothedGaze.x, y: smoothedGaze.y });
                if (displayTrail.length > 180) displayTrail.shift();
                lastTrailTime = timestamp;
            }
        }

        context.clearRect(0, 0, canvasWidth, canvasHeight);

        if (displayTrail.length > 1) {
            context.beginPath();
            displayTrail.forEach((point, index) => {
                const x = point.x * canvasWidth;
                const y = point.y * canvasHeight;
                if (index === 0) context.moveTo(x, y);
                else context.lineTo(x, y);
            });
            context.strokeStyle = "rgba(45, 212, 191, 0.75)";
            context.lineWidth = Math.max(2, canvasWidth / 500);
            context.lineCap = "round";
            context.lineJoin = "round";
            context.stroke();
        }

        if (currentTarget) {
            const x = currentTarget[0] * canvasWidth;
            const y = currentTarget[1] * canvasHeight;
            const radius = Math.max(9, canvasWidth / 90);
            context.beginPath();
            context.arc(x, y, radius, 0, Math.PI * 2);
            context.fillStyle = "#fbbf24";
            context.fill();
            context.strokeStyle = "#fff";
            context.lineWidth = Math.max(2, radius / 5);
            context.stroke();
        }

        if (smoothedGaze) {
            const x = smoothedGaze.x * canvasWidth;
            const y = smoothedGaze.y * canvasHeight;
            const radius = Math.max(7, canvasWidth / 120);
            context.beginPath();
            context.arc(x, y, radius, 0, Math.PI * 2);
            context.fillStyle = "rgba(16, 185, 129, 0.9)";
            context.fill();
            context.strokeStyle = "#fff";
            context.lineWidth = Math.max(2, radius / 4);
            context.stroke();
        }
    }

    function animateStage(timestamp) {
        drawStage(timestamp);
        if (active) {
            stageAnimationFrame = window.requestAnimationFrame(animateStage);
        } else {
            stageAnimationFrame = null;
        }
    }

    function startStageAnimation() {
        if (stageAnimationFrame === null) {
            stageAnimationFrame = window.requestAnimationFrame(animateStage);
        }
    }

    function requestSocket(type, payload = {}, expectedType) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("GazeMap connection is not available."));
        }

        const requestId = String(++requestCounter);
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                pendingRequests.delete(requestId);
                reject(new Error("GazeMap did not respond in time."));
            }, 20000);
            pendingRequests.set(requestId, {
                expectedType,
                resolve,
                reject,
                timeout
            });
            socket.send(JSON.stringify({ type, requestId, ...payload }));
        });
    }

    function connectSocket() {
        return new Promise((resolve, reject) => {
            socket = new WebSocket(websocketUrl);
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", () => {
                reject(new Error("Could not connect to the GazeMap service."));
            }, { once: true });
            socket.addEventListener("message", event => {
                let message;
                try {
                    message = JSON.parse(event.data);
                } catch {
                    return;
                }

                const pending = pendingRequests.get(message.requestId);
                if (!pending) return;
                window.clearTimeout(pending.timeout);
                pendingRequests.delete(message.requestId);

                if (message.type === "error") {
                    pending.reject(new Error(message.message || "GazeMap request failed."));
                } else if (message.type !== pending.expectedType) {
                    pending.reject(new Error("Unexpected response from GazeMap."));
                } else {
                    pending.resolve(message);
                }
            });
            socket.addEventListener("close", () => {
                const error = new Error("GazeMap connection was closed.");
                pendingRequests.forEach(pending => {
                    window.clearTimeout(pending.timeout);
                    pending.reject(error);
                });
                pendingRequests.clear();
                if (active) {
                    active = false;
                    interruptionMessage = error.message;
                    stopCamera();
                    startButton.disabled = false;
                    cancelButton.hidden = true;
                    stage.classList.remove("eye-test-active");
                    stageMessage.textContent = interruptionMessage;
                    statusText.textContent = error.message;
                }
            });
        });
    }

    async function captureFrame(returnRaw = false) {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            throw new Error("Waiting for the camera image.");
        }

        const scale = Math.min(1, 640 / video.videoWidth);
        const captureCanvas = document.createElement("canvas");
        captureCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        captureCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        captureCanvas.getContext("2d").drawImage(
            video,
            0,
            0,
            captureCanvas.width,
            captureCanvas.height
        );

        const frame = await requestSocket(
            "frame",
            {
                imageBase64: captureCanvas.toDataURL("image/jpeg", 0.68),
                timestampMs: Math.round(performance.now()),
                returnRaw
            },
            "frame"
        );
        return frame;
    }

    function stopCamera() {
        calibrationUI.hide();
        if (socket) {
            const currentSocket = socket;
            socket = null;
            currentSocket.close();
        }
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        video.srcObject = null;
        stage.classList.remove("eye-camera-active");
    }

    function wait(milliseconds) {
        return new Promise(resolve => window.setTimeout(resolve, milliseconds));
    }

    async function calibrate() {
        const calibrationPoints = [];
        calibrationUI.begin();
        for (let index = 0; index < targets.length; index += 1) {
            currentTarget = targets[index];
            calibrationUI.showTarget(index + 1, currentTarget);
            stageMessage.textContent =
                `Calibration ${index + 1} of ${targets.length}: look at the dot.`;
            drawStage();
            await wait(calibrationDwellMs);

            const features = [];
            for (let frameIndex = 0; frameIndex < calibrationFrameCount; frameIndex += 1) {
                const frame = await captureFrame(true);
                if (frame.error) throw new Error(frame.error);
                if (frame.valid && Array.isArray(frame.features)) {
                    features.push(frame.features);
                }
                await wait(60);
            }

            calibrationPoints.push({
                targetX: currentTarget[0],
                targetY: currentTarget[1],
                features
            });
            calibrationUI.completeTarget(index + 1);
            setProgress(((index + 1) / targets.length) * 40);
        }

        calibrationUI.fitting();
        stageMessage.textContent = "Fitting your GazeMap calibration...";
        currentTarget = null;
        drawStage();
        const calibration = await requestSocket(
            "calibrate",
            { points: calibrationPoints },
            "calibration"
        );
        if (!calibration.success) {
            throw new Error(calibration.message || "Calibration failed.");
        }
        calibrationUI.complete();
        return calibration;
    }

    function makeHeatmap() {
        const heatmap = document.createElement("canvas");
        heatmap.width = canvasWidth;
        heatmap.height = canvasHeight;
        const heatContext = heatmap.getContext("2d");
        heatContext.fillStyle = "#0b1220";
        heatContext.fillRect(0, 0, heatmap.width, heatmap.height);

        const radius = Math.max(18, Math.round(heatmap.width / 22));
        testPoints.forEach(point => {
            const x = point.x * heatmap.width;
            const y = point.y * heatmap.height;
            const gradient = heatContext.createRadialGradient(
                x, y, 0, x, y, radius
            );
            gradient.addColorStop(0, "rgba(255, 40, 30, 0.48)");
            gradient.addColorStop(0.35, "rgba(255, 190, 30, 0.28)");
            gradient.addColorStop(1, "rgba(255, 220, 30, 0)");
            heatContext.fillStyle = gradient;
            heatContext.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        });

        if (testPoints.length > 1) {
            heatContext.beginPath();
            testPoints.forEach((point, index) => {
                const x = point.x * heatmap.width;
                const y = point.y * heatmap.height;
                if (index === 0) heatContext.moveTo(x, y);
                else heatContext.lineTo(x, y);
            });
            heatContext.strokeStyle = "rgba(255, 255, 255, 0.9)";
            heatContext.lineWidth = Math.max(2, heatmap.width / 600);
            heatContext.lineJoin = "round";
            heatContext.stroke();
        }

        return heatmap.toDataURL("image/png");
    }

    async function runTracking(calibration) {
        const startedAt = performance.now();
        const targetDuration = testDurationMs / targets.length;
        stageMessage.textContent = "Follow the target with your eyes.";

        while (active && performance.now() - startedAt < testDurationMs) {
            const elapsed = performance.now() - startedAt;
            const targetIndex = Math.min(
                targets.length - 1,
                Math.floor(elapsed / targetDuration)
            );
            currentTarget = targets[targetIndex];
            setProgress(40 + (elapsed / testDurationMs) * 60);

            const frame = await captureFrame();
            if (frame.error) throw new Error(frame.error);
            if (
                frame.valid
                && Number.isFinite(frame.xFraction)
                && Number.isFinite(frame.yFraction)
                && frame.xFraction >= 0
                && frame.xFraction <= 1
                && frame.yFraction >= 0
                && frame.yFraction <= 1
            ) {
                const point = {
                    x: frame.xFraction,
                    y: frame.yFraction,
                    time: Date.now(),
                    targetX: currentTarget[0],
                    targetY: currentTarget[1]
                };
                testPoints.push(point);
                latestGaze = point;
                statusText.textContent =
                    `Tracking gaze: ${testPoints.length} valid samples.`;
            } else if (frame.reason === "face_not_detected") {
                statusText.textContent =
                    "Face not detected. Keep your face visible to the camera.";
            } else if (frame.valid) {
                statusText.textContent =
                    "Gaze is outside the calibrated screen area. Look back at the target.";
            } else {
                statusText.textContent =
                    "Gaze unavailable for this frame. Keep looking at the target.";
            }
            drawStage();
            await wait(sampleIntervalMs);
        }

        if (!active) return;
        if (testPoints.length === 0) {
            throw new Error("No valid gaze samples were captured. Please try again.");
        }
        await saveResults(calibration);
    }

    async function saveResults(calibration) {
        active = false;
        cancelButton.hidden = true;
        currentTarget = null;
        drawStage();
        statusText.textContent = "Generating the gaze heatmap and saving results...";
        stageMessage.textContent = "Preparing your gaze map...";
        const heatmapDataUrl = makeHeatmap();
        stopCamera();

        const response = await fetch(
            `/eye-tracking/${encodeURIComponent(assessmentId)}/save-session`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    points: testPoints,
                    widthPx: canvasWidth,
                    heightPx: canvasHeight,
                    calibrationStatus: "completed",
                    calibrationPointCount: calibration.calibrationPointCount,
                    heatmapDataUrl
                })
            }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.message || `Saving failed (${response.status}).`);
        }
        setProgress(100);
        statusText.textContent =
            "Gaze tracking saved. Opening your session summary...";
        stageMessage.textContent = "Gaze map complete.";
        window.location.assign(`/dashboard/${assessmentId}#eyeTrackingAnalysis`);
    }

    async function startTest() {
        if (active) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            statusText.textContent =
                "Camera access is unavailable. Use a secure connection or localhost.";
            return;
        }

        startButton.disabled = true;
        cancelButton.hidden = false;
        active = true;
        interruptionMessage = null;
        testPoints = [];
        displayTrail = [];
        latestGaze = null;
        smoothedGaze = null;
        lastRenderTime = 0;
        lastTrailTime = 0;
        currentTarget = null;
        startStageAnimation();
        setProgress(0);
        statusText.textContent = "Requesting camera permission...";
        stageMessage.textContent = "Starting the browser camera...";

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: "user"
                },
                audio: false
            });
            stream.getVideoTracks().forEach(track => {
                track.addEventListener("ended", () => {
                    if (!active) return;
                    active = false;
                    interruptionMessage =
                        "Camera disconnected. Restart the test and grant camera access.";
                    stopCamera();
                    startButton.disabled = false;
                    cancelButton.hidden = true;
                    stage.classList.remove("eye-test-active");
                    stageMessage.textContent = interruptionMessage;
                    statusText.textContent = interruptionMessage;
                }, { once: true });
            });
            video.srcObject = stream;
            await video.play();
            stage.classList.add("eye-camera-active");
            stage.classList.add("eye-test-active");
            resizeCanvas();
            await connectSocket();

            statusText.textContent = "Connecting to GazeMap...";
            await requestSocket(
                "init",
                {
                    widthPx: canvasWidth,
                    heightPx: canvasHeight,
                    widthMm: 345
                },
                "initialized"
            );

            statusText.textContent = "Calibrating. Follow each on-screen dot.";
            const calibration = await calibrate();
            stageMessage.textContent = "Calibration complete. The test is starting.";
            statusText.textContent =
                `Calibration complete (${calibration.calibrationPointCount} targets).`;
            await wait(350);
            calibrationUI.hide();
            await runTracking(calibration);
        } catch (error) {
            active = false;
            stopCamera();
            currentTarget = null;
            drawStage();
            stage.classList.remove("eye-test-active");
            startButton.disabled = false;
            cancelButton.hidden = true;
            if (interruptionMessage) {
                stageMessage.textContent = interruptionMessage;
                statusText.textContent = interruptionMessage;
                interruptionMessage = null;
                return;
            }
            stageMessage.textContent = error.message;
            statusText.textContent = `Unable to complete the test: ${error.message}`;
        }
    }

    startButton.addEventListener("click", startTest);
    cancelButton.addEventListener("click", () => {
        active = false;
        interruptionMessage = "Test cancelled. Your samples were not saved.";
        stopCamera();
        currentTarget = null;
        drawStage();
        stage.classList.remove("eye-test-active");
        startButton.disabled = false;
        cancelButton.hidden = true;
        setProgress(0);
        stageMessage.textContent = interruptionMessage;
        statusText.textContent = interruptionMessage;
    });

    window.addEventListener("resize", () => {
        if (active) {
            active = false;
            interruptionMessage =
                "Screen size changed. Restart the test to recalibrate.";
            stopCamera();
            startButton.disabled = false;
            cancelButton.hidden = true;
            stage.classList.remove("eye-test-active");
            stageMessage.textContent = interruptionMessage;
            statusText.textContent = interruptionMessage;
        }
        resizeCanvas();
        drawStage();
    });

    resizeCanvas();
});
