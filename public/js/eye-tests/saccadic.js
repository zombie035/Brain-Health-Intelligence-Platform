document.addEventListener("DOMContentLoaded", () => {
    const runner = document.getElementById("saccadicTest");
    if (!runner) return;

    const assessmentId = runner.dataset.assessmentId;
    const websocketUrl = runner.dataset.gazeWsUrl;
    const stage = document.getElementById("saccadicStage");
    const canvas = document.getElementById("saccadicCanvas");
    const context = canvas.getContext("2d");
    const calibrationUI = window.EyeCalibrationUI.create(stage);
    const video = document.getElementById("saccadicVideo");
    const startButton = document.getElementById("startSaccadicTest");
    const cancelButton = document.getElementById("cancelSaccadicTest");
    const statusText = document.getElementById("saccadicStatus");
    const stageMessage = document.getElementById("saccadicStageMessage");
    const progressTrack = document.querySelector(".eye-progress-track");
    const progressFill = document.getElementById("saccadicProgress");
    const progressText = document.getElementById("saccadicProgressText");

    const calibrationTargets = calibrationUI.targets;
    const trialCount = 12;
    const fixationDurationMs = 450;
    const targetDurationMs = 850;
    const frameIntervalMs = 90;
    const pendingRequests = new Map();

    let active = false;
    let stream = null;
    let socket = null;
    let requestCounter = 0;
    let sessionId = null;
    let samples = [];
    let targets = [];
    let currentStimulus = null;
    let calibrationPointCount = 0;
    let mappingMethod = null;
    let screenInitialized = false;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let pixelRatio = 1;
    let testStartedAt = 0;
    let captureCanvas = document.createElement("canvas");
    let captureContext = captureCanvas.getContext("2d");

    function setProgress(value) {
        const progress = Math.max(0, Math.min(100, Number(value) || 0));
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${Math.round(progress)}%`;
        progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
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
        context.fillStyle = "#10233a";
        context.fillRect(0, 0, canvasWidth / 2, canvasHeight);
        context.fillStyle = "#3a1c2a";
        context.fillRect(canvasWidth / 2, 0, canvasWidth / 2, canvasHeight);

        if (!currentStimulus) return;
        const [fractionX, fractionY] = currentStimulus.position;
        const x = fractionX * canvasWidth;
        const y = fractionY * canvasHeight;
        const radius = Math.max(9, Math.min(18, canvasWidth / 55));

        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = currentStimulus.phase === "calibration"
            ? "#fbbf24"
            : "#ffffff";
        context.fill();
        context.strokeStyle = "rgba(255, 255, 255, 0.9)";
        context.lineWidth = 2;
        context.stroke();
    }

    function wait(milliseconds) {
        return new Promise(resolve => window.setTimeout(resolve, milliseconds));
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
                `/eye-assessment/${encodeURIComponent(assessmentId)}/saccadic/${encodeURIComponent(cancellingSessionId)}/cancel`,
                { method: "POST" }
            );
        } catch (error) {
            console.error("Could not cancel the saccadic session:", error);
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
        captureCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        captureCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        captureContext.drawImage(
            video,
            0,
            0,
            captureCanvas.width,
            captureCanvas.height
        );
        const capturedAt = performance.now();
        const frame = await requestSocket(
            "frame",
            {
                imageBase64: captureCanvas.toDataURL("image/jpeg", 0.68),
                timestampMs: Math.round(capturedAt),
                returnRaw
            },
            "frame"
        );
        return { ...frame, capturedAt };
    }

    async function initializeGazeMap() {
        await connectSocket();
        const initialized = await requestSocket(
            "init",
            { widthPx: canvasWidth, heightPx: canvasHeight, widthMm: 345 },
            "initialized"
        );
        if (!initialized) throw new Error("GazeMap could not initialize the screen.");
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
        stageMessage.textContent = "Fitting gaze calibration...";
        currentStimulus = null;
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
        return calibration;
    }

    function createTargets() {
        const sides = Array(6).fill("left").concat(Array(6).fill("right"));
        for (let index = sides.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [sides[index], sides[swapIndex]] = [sides[swapIndex], sides[index]];
        }
        return sides.map((side, index) => ({
            id: `trial-${index + 1}`,
            side,
            xPx: Math.round((side === "left" ? 0.2 : 0.8) * canvasWidth),
            yPx: Math.round(0.5 * canvasHeight),
            cueOnsetAtSeconds: null,
            appearedAtSeconds: null,
            disappearedAtSeconds: null
        }));
    }

    function relativeSeconds(time) {
        return Math.max(0, (time - testStartedAt) / 1000);
    }

    async function collectSamples(durationMs, target) {
        const endAt = performance.now() + durationMs;
        while (active && performance.now() < endAt) {
            const frameStartedAt = performance.now();
            const frame = await captureFrame();
            if (frame.error) throw new Error(frame.error);
            const xFraction = frame.xFraction;
            const yFraction = frame.yFraction;
            const valid = frame.valid
                && Number.isFinite(xFraction)
                && Number.isFinite(yFraction)
                && xFraction >= 0
                && xFraction <= 1
                && yFraction >= 0
                && yFraction <= 1;

            samples.push({
                timeSeconds: relativeSeconds(frame.capturedAt),
                xPx: valid ? xFraction * canvasWidth : null,
                yPx: valid ? yFraction * canvasHeight : null,
                targetXPx: target.xPx,
                targetYPx: target.yPx,
                valid,
                onScreen: valid,
                distanceMm: Number.isFinite(frame.distanceMm) ? frame.distanceMm : null,
                reason: valid ? null : (frame.reason || "invalid_gaze")
            });
            if (!valid && frame.reason === "face_not_detected") {
                statusText.textContent = "Face not detected. Keep your face visible to the camera.";
            } else if (valid) {
                statusText.textContent = `Recording gaze samples: ${samples.length}.`;
            }
            await wait(Math.max(0, frameIntervalMs - (performance.now() - frameStartedAt)));
        }
        if (!active) throw new Error("Assessment was interrupted.");
    }

    async function runTrials() {
        samples = [];
        targets = createTargets();
        testStartedAt = performance.now();
        stageMessage.textContent = "Look at the center mark, then quickly look at the side target.";

        for (let index = 0; index < targets.length && active; index += 1) {
            const target = targets[index];
            target.cueOnsetAtSeconds = relativeSeconds(performance.now());
            currentStimulus = { phase: "cue", position: [0.5, 0.5] };
            drawStage();
            await collectSamples(fixationDurationMs, target);

            target.appearedAtSeconds = relativeSeconds(performance.now());
            currentStimulus = {
                phase: "target",
                position: [target.xPx / canvasWidth, target.yPx / canvasHeight]
            };
            drawStage();
            await collectSamples(targetDurationMs, target);
            target.disappearedAtSeconds = relativeSeconds(performance.now());
            currentStimulus = null;
            drawStage();
            setProgress(25 + ((index + 1) / trialCount) * 75);
        }

        if (!active) throw new Error("Assessment was interrupted.");
        await saveResults();
    }

    async function saveResults() {
        active = false;
        currentStimulus = null;
        stopCamera();
        stage.classList.remove("eye-test-active");
        cancelButton.hidden = true;
        statusText.textContent = "Analyzing gaze samples and saving your results...";
        stageMessage.textContent = "Preparing your saccadic assessment results...";
        drawStage();

        const result = await requestJson(
            `/eye-assessment/${encodeURIComponent(assessmentId)}/saccadic/${encodeURIComponent(sessionId)}/complete`,
            {
                method: "POST",
                body: JSON.stringify({
                    samples,
                    targets,
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
        targets = [];
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
                `/eye-assessment/${encodeURIComponent(assessmentId)}/saccadic/start`,
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

            statusText.textContent = "Calibration complete. Beginning the trials...";
            await wait(350);
            calibrationUI.hide();
            await runTrials();
        } catch (error) {
            active = false;
            stopCamera();
            currentStimulus = null;
            stage.classList.remove("eye-test-active");
            startButton.disabled = false;
            cancelButton.hidden = true;
            stageMessage.textContent = error.message || "The assessment could not be completed.";
            statusText.textContent = `Unable to complete the test: ${stageMessage.textContent}`;
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

    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("beforeunload", stopCamera);
    resizeCanvas();
});
