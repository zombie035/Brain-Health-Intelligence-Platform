document.addEventListener("DOMContentLoaded", () => {
    const runner = document.getElementById("smoothPursuitTest");
    if (!runner) return;

    const assessmentId = runner.dataset.assessmentId;
    const websocketUrl = runner.dataset.gazeWsUrl;
    const stage = document.getElementById("smoothPursuitStage");
    const canvas = document.getElementById("smoothPursuitCanvas");
    const context = canvas.getContext("2d");
    const calibrationUI = window.EyeCalibrationUI.create(stage);
    const video = document.getElementById("smoothPursuitVideo");
    const startButton = document.getElementById("startSmoothPursuitTest");
    const cancelButton = document.getElementById("cancelSmoothPursuitTest");
    const statusText = document.getElementById("smoothPursuitStatus");
    const stageMessage = document.getElementById("smoothPursuitStageMessage");
    const progressTrack = document.querySelector(".eye-progress-track");
    const progressFill = document.getElementById("smoothPursuitProgress");
    const progressText = document.getElementById("smoothPursuitProgressText");

    const calibrationTargets = calibrationUI.targets;
    const testDurationMs = 30000;
    const frameIntervalMs = 90;
    const pursuitCycles = 5;
    const pursuitAmplitudeFraction = 0.35;
    const pendingRequests = new Map();

    let active = false;
    let stream = null;
    let socket = null;
    let requestCounter = 0;
    let sessionId = null;
    let samples = [];
    let currentStimulus = null;
    let calibrationPointCount = 0;
    let mappingMethod = null;
    let screenInitialized = false;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let pixelRatio = 1;
    let testStartedAt = 0;
    let animationFrame = null;
    let lastDrawnDot = null;
    let lastProgressValue = null;
    let captureCanvas = document.createElement("canvas");
    let captureContext = captureCanvas.getContext("2d");

    function setProgress(value) {
        const progress = Math.max(0, Math.min(100, Number(value) || 0));
        const roundedProgress = Math.round(progress);
        if (roundedProgress === lastProgressValue) return;
        lastProgressValue = roundedProgress;
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${roundedProgress}%`;
        progressTrack.setAttribute("aria-valuenow", String(roundedProgress));
    }

    function resizeCanvas() {
        const bounds = stage.getBoundingClientRect();
        const previousWidth = canvasWidth;
        const previousHeight = canvasHeight;
        pixelRatio = window.devicePixelRatio || 1;
        canvasWidth = Math.max(1, Math.round(bounds.width));
        canvasHeight = Math.max(1, Math.round(bounds.height));
        canvas.width = Math.round(canvasWidth * pixelRatio);
        canvas.height = Math.round(canvasHeight * pixelRatio);
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        lastDrawnDot = null;

        if (
            active
            && screenInitialized
            && (previousWidth !== canvasWidth || previousHeight !== canvasHeight)
        ) {
            interruptTest("Screen size changed. Restart the test to recalibrate.");
            return;
        }
        drawStage();
    }

    function drawStage() {
        context.clearRect(0, 0, canvasWidth, canvasHeight);
        lastDrawnDot = null;
        if (currentStimulus) {
            drawDot(currentStimulus.position, currentStimulus.phase);
        }
    }

    function drawDot(position, phase) {
        const x = position[0] * canvasWidth;
        const y = position[1] * canvasHeight;
        const radius = Math.max(9, Math.min(18, canvasWidth / 55));
        if (lastDrawnDot) {
            const padding = 4;
            context.clearRect(
                lastDrawnDot.x - lastDrawnDot.radius - padding,
                lastDrawnDot.y - lastDrawnDot.radius - padding,
                (lastDrawnDot.radius + padding) * 2,
                (lastDrawnDot.radius + padding) * 2
            );
        }
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = phase === "calibration"
            ? "#fbbf24"
            : "#ffffff";
        context.fill();
        if (phase === "pursuit") {
            context.beginPath();
            context.arc(x, y, Math.max(3, radius / 4), 0, Math.PI * 2);
            context.fillStyle = "#ef4444";
            context.fill();
        }
        lastDrawnDot = { x, y, radius };
    }

    function wait(milliseconds) {
        return new Promise(resolve => window.setTimeout(resolve, milliseconds));
    }

    function encodeCaptureFrame() {
        return new Promise((resolve, reject) => {
            captureCanvas.toBlob(blob => {
                if (!blob) {
                    reject(new Error("Could not encode the browser camera frame."));
                    return;
                }
                const reader = new FileReader();
                reader.addEventListener("load", () => {
                    if (typeof reader.result !== "string") {
                        reject(new Error("Could not encode the browser camera frame."));
                        return;
                    }
                    resolve(reader.result);
                }, { once: true });
                reader.addEventListener("error", () => {
                    reject(new Error("Could not read the encoded camera frame."));
                }, { once: true });
                reader.readAsDataURL(blob);
            }, "image/jpeg", 0.68);
        });
    }

    async function requestJson(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...options.headers
            }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error(data.message || `Request failed (${response.status}).`);
        }
        return data;
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
            try {
                socket.send(JSON.stringify({ type, requestId, ...payload }));
            } catch (error) {
                window.clearTimeout(timeout);
                pendingRequests.delete(requestId);
                reject(error);
            }
        });
    }

    function connectSocket() {
        return new Promise((resolve, reject) => {
            socket = new WebSocket(websocketUrl);
            const timeout = window.setTimeout(() => {
                reject(new Error("Timed out connecting to the GazeMap service."));
                socket.close();
            }, 12000);
            socket.addEventListener("open", () => {
                window.clearTimeout(timeout);
                resolve();
            }, { once: true });
            socket.addEventListener("error", () => {
                window.clearTimeout(timeout);
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
                window.clearTimeout(timeout);
                const error = new Error("GazeMap connection was closed.");
                pendingRequests.forEach(pending => {
                    window.clearTimeout(pending.timeout);
                    pending.reject(error);
                });
                pendingRequests.clear();
                if (active) interruptTest(error.message);
            });
        });
    }

    function stopCamera() {
        calibrationUI.hide();
        if (animationFrame !== null) {
            window.cancelAnimationFrame(animationFrame);
            animationFrame = null;
        }
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

    async function exitFullscreen() {
        if (document.fullscreenElement === runner) {
            try {
                await document.exitFullscreen();
            } catch (error) {
                console.error("Could not exit assessment fullscreen:", error);
            }
        }
    }

    async function cancelServerSession() {
        if (!sessionId) return;
        const cancellingSessionId = sessionId;
        sessionId = null;
        try {
            await requestJson(
                `/eye-assessment/${encodeURIComponent(assessmentId)}/smooth-pursuit/browser/${encodeURIComponent(cancellingSessionId)}/cancel`,
                { method: "POST" }
            );
        } catch (error) {
            console.error("Could not cancel the smooth pursuit session:", error);
        }
    }

    function interruptTest(message) {
        if (!active) return;
        active = false;
        stopCamera();
        currentStimulus = null;
        stage.classList.remove("eye-test-active");
        startButton.disabled = false;
        cancelButton.hidden = true;
        stageMessage.textContent = message;
        statusText.textContent = message;
        void cancelServerSession();
        void exitFullscreen();
        drawStage();
    }

    async function captureFrame(returnRaw = false) {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            throw new Error("Waiting for the camera image.");
        }
        const scale = Math.min(1, 640 / video.videoWidth);
        const captureWidth = Math.max(1, Math.round(video.videoWidth * scale));
        const captureHeight = Math.max(1, Math.round(video.videoHeight * scale));
        if (
            captureCanvas.width !== captureWidth
            || captureCanvas.height !== captureHeight
        ) {
            captureCanvas.width = captureWidth;
            captureCanvas.height = captureHeight;
            captureContext = captureCanvas.getContext("2d");
        }
        captureContext.drawImage(
            video,
            0,
            0,
            captureCanvas.width,
            captureCanvas.height
        );
        const capturedAt = performance.now();
        const imageBase64 = await encodeCaptureFrame();
        const frame = await requestSocket(
            "frame",
            {
                imageBase64,
                timestampMs: Math.round(capturedAt),
                returnRaw
            },
            "frame"
        );
        return { ...frame, capturedAt };
    }

    async function initializeGazeMap() {
        await connectSocket();
        await requestSocket(
            "init",
            { widthPx: canvasWidth, heightPx: canvasHeight, widthMm: 345 },
            "initialized"
        );
        screenInitialized = true;
    }

    async function calibrate() {
        const calibrationPoints = [];
        calibrationUI.begin();
        for (let index = 0; index < calibrationTargets.length && active; index += 1) {
            const position = calibrationTargets[index];
            calibrationUI.showTarget(index + 1, position);
            currentStimulus = { phase: "calibration", position };
            stageMessage.textContent =
                `Calibration ${index + 1} of ${calibrationTargets.length}: look at the dot.`;
            drawStage();
            await wait(600);

            const features = [];
            for (let frameIndex = 0; frameIndex < 5 && active; frameIndex += 1) {
                const frameStartedAt = performance.now();
                const frame = await captureFrame(true);
                if (frame.error) throw new Error(frame.error);
                if (frame.valid && Array.isArray(frame.features)) {
                    features.push(frame.features);
                }
                await wait(Math.max(0, frameIntervalMs - (performance.now() - frameStartedAt)));
            }
            calibrationPoints.push({
                targetX: position[0],
                targetY: position[1],
                features
            });
            calibrationUI.completeTarget(index + 1);
            setProgress(((index + 1) / calibrationTargets.length) * 25);
        }
        if (!active) throw new Error("Assessment was interrupted.");

        calibrationUI.fitting();
        currentStimulus = null;
        stageMessage.textContent = "Fitting gaze calibration...";
        drawStage();
        const calibration = await requestSocket(
            "calibrate",
            { points: calibrationPoints },
            "calibration"
        );
        if (!calibration.success) {
            throw new Error(calibration.message || "Gaze calibration failed.");
        }
        calibrationPointCount = calibration.calibrationPointCount;
        mappingMethod = calibration.mappingMethod;
        calibrationUI.complete();
    }

    function pursuitPosition(elapsedSeconds) {
        const phase = 2 * Math.PI
            * pursuitCycles
            * elapsedSeconds
            / (testDurationMs / 1000);
        return [
            0.5 - pursuitAmplitudeFraction * Math.cos(phase),
            0.5
        ];
    }

    function drawPursuit(timestamp) {
        if (!active) return;
        const elapsedSeconds = Math.max(0, (timestamp - testStartedAt) / 1000);
        currentStimulus = {
            phase: "pursuit",
            position: pursuitPosition(elapsedSeconds)
        };
        drawDot(currentStimulus.position, currentStimulus.phase);
        setProgress(25 + (elapsedSeconds / (testDurationMs / 1000)) * 75);
        if (elapsedSeconds < testDurationMs / 1000) {
            animationFrame = window.requestAnimationFrame(drawPursuit);
        } else {
            animationFrame = null;
        }
    }

    async function runTracking() {
        samples = [];
        testStartedAt = performance.now();
        stageMessage.textContent = "Follow the moving dot smoothly with your eyes.";
        currentStimulus = {
            phase: "pursuit",
            position: pursuitPosition(0)
        };
        drawStage();
        animationFrame = window.requestAnimationFrame(drawPursuit);
        const endAt = testStartedAt + testDurationMs;

        while (active && performance.now() < endAt) {
            const frameStartedAt = performance.now();
            const frame = await captureFrame();
            if (frame.error) throw new Error(frame.error);
            const elapsedSeconds = (frame.capturedAt - testStartedAt) / 1000;
            const targetPosition = pursuitPosition(
                Math.min(elapsedSeconds, testDurationMs / 1000)
            );
            const valid = frame.valid
                && Number.isFinite(frame.xFraction)
                && Number.isFinite(frame.yFraction)
                && frame.xFraction >= 0
                && frame.xFraction <= 1
                && frame.yFraction >= 0
                && frame.yFraction <= 1;

            samples.push({
                timeSeconds: elapsedSeconds,
                xPx: valid ? frame.xFraction * canvasWidth : null,
                yPx: valid ? frame.yFraction * canvasHeight : null,
                targetXPx: targetPosition[0] * canvasWidth,
                targetYPx: targetPosition[1] * canvasHeight,
                valid,
                onScreen: valid,
                distanceMm: Number.isFinite(frame.distanceMm) ? frame.distanceMm : null,
                reason: valid ? null : (frame.reason || "invalid_gaze")
            });
            if (!valid && frame.reason === "face_not_detected") {
                statusText.textContent =
                    "Face not detected. Keep your face visible to the camera.";
            } else if (valid && samples.length % 10 === 0) {
                statusText.textContent =
                    `Tracking gaze: ${samples.length} samples recorded.`;
            }
            await wait(Math.max(0, frameIntervalMs - (performance.now() - frameStartedAt)));
        }
        if (!active) throw new Error("Assessment was interrupted.");
        if (animationFrame !== null) {
            window.cancelAnimationFrame(animationFrame);
            animationFrame = null;
        }
        currentStimulus = null;
        drawStage();
        await saveResults();
    }

    async function saveResults() {
        active = false;
        stopCamera();
        stage.classList.remove("eye-test-active");
        cancelButton.hidden = true;
        statusText.textContent = "Analyzing gaze samples and saving your results...";
        stageMessage.textContent = "Preparing your smooth pursuit results...";
        drawStage();

        const result = await requestJson(
            `/eye-assessment/${encodeURIComponent(assessmentId)}/smooth-pursuit/browser/${encodeURIComponent(sessionId)}/complete`,
            {
                method: "POST",
                body: JSON.stringify({
                    samples,
                    widthPx: canvasWidth,
                    heightPx: canvasHeight,
                    calibrationPointCount,
                    mappingMethod
                })
            }
        );
        setProgress(100);
        statusText.textContent = "Assessment saved. Opening your results...";
        await exitFullscreen();
        window.location.assign(result.resultUrl);
    }

    async function startTest() {
        if (active) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            statusText.textContent =
                "Camera access is unavailable. Use a secure connection or localhost.";
            return;
        }

        active = true;
        startButton.disabled = true;
        cancelButton.hidden = false;
        screenInitialized = false;
        sessionId = null;
        samples = [];
        setProgress(0);
        statusText.textContent = "Entering fullscreen...";

        try {
            if (!runner.requestFullscreen) {
                throw new Error("Fullscreen mode is not supported by this browser.");
            }
            await runner.requestFullscreen();
            if (!active) return;
            resizeCanvas();
            stage.classList.add("eye-test-active");
            stageMessage.textContent = "Starting the browser camera...";
            statusText.textContent = "Requesting camera permission...";

            const cameraStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: "user"
                },
                audio: false
            });
            if (!active) {
                cameraStream.getTracks().forEach(track => track.stop());
                return;
            }
            stream = cameraStream;
            stream.getVideoTracks().forEach(track => {
                track.addEventListener("ended", () => {
                    interruptTest(
                        "Camera disconnected. Restart the test and grant camera access."
                    );
                }, { once: true });
            });
            video.srcObject = stream;
            await video.play();
            if (!active) return;
            stage.classList.add("eye-camera-active");

            const started = await requestJson(
                `/eye-assessment/${encodeURIComponent(assessmentId)}/smooth-pursuit/browser/start`,
                { method: "POST" }
            );
            sessionId = started.sessionId;
            if (!active) {
                await cancelServerSession();
                return;
            }
            await initializeGazeMap();
            if (!active) return;
            statusText.textContent = "Calibrating. Follow each on-screen dot.";
            await calibrate();
            if (!active) return;

            statusText.textContent = "Calibration complete. Follow the moving target.";
            await wait(350);
            calibrationUI.hide();
            if (active) await runTracking();
        } catch (error) {
            active = false;
            stopCamera();
            currentStimulus = null;
            stage.classList.remove("eye-test-active");
            startButton.disabled = false;
            cancelButton.hidden = true;
            stageMessage.textContent =
                error.message || "The assessment could not be completed.";
            statusText.textContent =
                `Unable to complete the test: ${stageMessage.textContent}`;
            drawStage();
            if (sessionId) await cancelServerSession();
            await exitFullscreen();
        }
    }

    async function cancelTest() {
        if (!active) return;
        active = false;
        cancelButton.disabled = true;
        statusText.textContent = "Cancelling the assessment...";
        stopCamera();
        currentStimulus = null;
        stage.classList.remove("eye-test-active");
        drawStage();
        await cancelServerSession();
        cancelButton.hidden = true;
        cancelButton.disabled = false;
        startButton.disabled = false;
        statusText.textContent = "Assessment cancelled. Select Start Test to try again.";
        stageMessage.textContent = "Assessment cancelled.";
        await exitFullscreen();
    }

    startButton.addEventListener("click", startTest);
    cancelButton.addEventListener("click", cancelTest);

    document.addEventListener("fullscreenchange", () => {
        if (active && document.fullscreenElement !== runner) {
            interruptTest("Fullscreen was exited. Restart the assessment to continue.");
        } else if (document.fullscreenElement === runner) {
            resizeCanvas();
        }
    });
    document.addEventListener("visibilitychange", () => {
        if (active && document.hidden) {
            interruptTest(
                "The browser tab was hidden. Restart the assessment to keep tracking synchronized."
            );
        }
    });

    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("beforeunload", stopCamera);
    resizeCanvas();
});
