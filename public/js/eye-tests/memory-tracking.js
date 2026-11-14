document.addEventListener("DOMContentLoaded", () => {
    const runner = document.getElementById("memoryTrackingTest");
    if (!runner) return;

    const assessmentId = runner.dataset.assessmentId;
    const websocketUrl = runner.dataset.gazeWsUrl;
    const stage = document.getElementById("memoryStage");
    const canvas = document.getElementById("memoryCanvas");
    const context = canvas.getContext("2d");
    const calibrationUI = window.EyeCalibrationUI.create(stage);
    const video = document.getElementById("memoryVideo");
    const stageMessage = document.getElementById("memoryStageMessage");
    const stimulus = document.getElementById("memoryStimulus");
    const phaseLabel = document.getElementById("memoryPhaseLabel");
    const wordElement = document.getElementById("memoryWord");
    const instruction = document.getElementById("memoryInstruction");
    const responseButtons = document.getElementById("memoryResponses");
    const seenButton = document.getElementById("memorySeenButton");
    const notSeenButton = document.getElementById("memoryNotSeenButton");
    const startButton = document.getElementById("startMemoryTest");
    const cancelButton = document.getElementById("cancelMemoryTest");
    const statusText = document.getElementById("memoryStatus");
    const cameraStatus = document.getElementById("memoryCameraStatus");
    const faceStatus = document.getElementById("memoryFaceStatus");
    const progressTrack = document.querySelector(".eye-progress-track");
    const progressFill = document.getElementById("memoryProgress");
    const progressText = document.getElementById("memoryProgressText");

    const calibrationTargets = calibrationUI.targets;
    const encodingDurationMs = 3000;
    const retentionDurationMs = 5000;
    const recognitionTimeoutMs = 5000;
    const frameIntervalMs = 90;
    const pendingRequests = new Map();
    const captureCanvas = document.createElement("canvas");
    let captureContext = captureCanvas.getContext("2d");

    let active = false;
    let stream = null;
    let socket = null;
    let requestCounter = 0;
    let sessionId = null;
    let samples = [];
    let trials = [];
    let currentStimulus = null;
    let currentPhase = null;
    let currentImageId = null;
    let currentResponse = null;
    let currentResponseAt = 0;
    let currentTrialStartedAt = 0;
    let calibrationPointCount = 0;
    let mappingMethod = null;
    let screenInitialized = false;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let pixelRatio = 1;
    let testStartedAt = 0;
    let completing = false;

    function setProgress(value) {
        const progress = Math.max(0, Math.min(100, Number(value) || 0));
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${Math.round(progress)}%`;
        progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
    }

    function wait(milliseconds) {
        return new Promise(resolve => window.setTimeout(resolve, milliseconds));
    }

    function ensureActive() {
        if (!active) throw new Error("The assessment was interrupted.");
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
        if (!currentStimulus) return;

        const [fractionX, fractionY] = currentStimulus.position;
        const x = fractionX * canvasWidth;
        const y = fractionY * canvasHeight;
        const radius = Math.max(10, Math.min(19, canvasWidth / 55));
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = "#fbbf24";
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.stroke();
        context.beginPath();
        context.arc(x, y, 3, 0, Math.PI * 2);
        context.fillStyle = "#0f172a";
        context.fill();
    }

    async function requestJson(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...options.headers,
            },
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
            pendingRequests.set(requestId, { expectedType, resolve, reject, timeout });
            try {
                socket.send(JSON.stringify({ type, requestId, ...payload }));
            } catch (error) {
                window.clearTimeout(timeout);
                pendingRequests.delete(requestId);
                reject(error);
            }
        });
    }

    function rejectPendingRequests(message) {
        for (const [requestId, pending] of pendingRequests) {
            window.clearTimeout(pending.timeout);
            pending.reject(new Error(message));
            pendingRequests.delete(requestId);
        }
    }

    function connectSocket() {
        return new Promise((resolve, reject) => {
            if (!websocketUrl) {
                reject(new Error("The GazeMap WebSocket URL is not configured."));
                return;
            }
            socket = new WebSocket(websocketUrl);
            const timeout = window.setTimeout(() => {
                reject(new Error("Timed out connecting to GazeMap."));
                socket.close();
            }, 12000);
            socket.addEventListener("open", () => {
                window.clearTimeout(timeout);
                resolve();
            }, { once: true });
            socket.addEventListener("error", () => {
                window.clearTimeout(timeout);
                reject(new Error("Could not connect to GazeMap. Check that the Python service is running."));
            }, { once: true });
            socket.addEventListener("message", event => {
                let message;
                try {
                    message = JSON.parse(event.data);
                } catch {
                    rejectPendingRequests("GazeMap returned an unreadable response.");
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
                rejectPendingRequests("GazeMap connection was closed.");
                if (active) interruptTest("GazeMap connection was closed. Restart the test.");
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
        cameraStatus.textContent = "Camera is off.";
    }

    async function exitFullscreen() {
        if (document.fullscreenElement === runner) {
            try {
                await document.exitFullscreen();
            } catch (error) {
                console.error("Could not exit memory assessment fullscreen:", error);
            }
        }
    }

    async function cancelServerSession() {
        if (!sessionId) return;
        const cancellingSessionId = sessionId;
        sessionId = null;
        try {
            await requestJson(
                `/eye-assessment/${encodeURIComponent(assessmentId)}/memory-tracking/browser/${encodeURIComponent(cancellingSessionId)}/cancel`,
                { method: "POST" }
            );
        } catch (error) {
            console.error("Could not cancel the memory session:", error);
        }
    }

    function clearStimulus() {
        currentStimulus = null;
        currentPhase = null;
        currentImageId = null;
        stimulus.hidden = true;
        responseButtons.hidden = true;
        stageMessage.hidden = false;
        drawStage();
    }

    function interruptTest(message) {
        if (!active) return;
        active = false;
        stopCamera();
        clearStimulus();
        stage.classList.remove("eye-test-active");
        startButton.disabled = false;
        cancelButton.hidden = true;
        stageMessage.textContent = message;
        statusText.textContent = message;
        void cancelServerSession();
        void exitFullscreen();
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
        captureContext.drawImage(video, 0, 0, captureWidth, captureHeight);
        const capturedAt = performance.now();
        const frame = await requestSocket(
            "frame",
            {
                imageBase64: await encodeCaptureFrame(),
                timestampMs: Math.round(capturedAt),
                returnRaw,
            },
            "frame"
        );
        if (frame.error) throw new Error(frame.error);
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
        stageMessage.hidden = true;
        for (let index = 0; index < calibrationTargets.length && active; index += 1) {
            const position = calibrationTargets[index];
            calibrationUI.showTarget(index + 1, position);
            currentStimulus = { phase: "calibration", position };
            statusText.textContent =
                `Calibration ${index + 1} of ${calibrationTargets.length}: look at the dot.`;
            drawStage();
            await wait(600);

            const features = [];
            for (let frameIndex = 0; frameIndex < 5 && active; frameIndex += 1) {
                const frameStartedAt = performance.now();
                const frame = await captureFrame(true);
                if (frame.valid && Array.isArray(frame.features)) {
                    features.push(frame.features);
                }
                await wait(Math.max(0, frameIntervalMs - (performance.now() - frameStartedAt)));
            }
            calibrationPoints.push({
                targetX: position[0],
                targetY: position[1],
                features,
            });
            calibrationUI.completeTarget(index + 1);
            setProgress(((index + 1) / calibrationTargets.length) * 20);
        }
        ensureActive();

        calibrationUI.fitting();
        currentStimulus = null;
        stageMessage.hidden = false;
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

    function showStimulus(label, word, instructionText, showResponses = false) {
        stageMessage.hidden = true;
        stimulus.hidden = false;
        phaseLabel.textContent = label;
        wordElement.textContent = word;
        instruction.textContent = instructionText;
        responseButtons.hidden = !showResponses;
        if (showResponses) {
            seenButton.disabled = false;
            notSeenButton.disabled = false;
        }
    }

    function shuffle(items) {
        const shuffled = [...items];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [shuffled[index], shuffled[swapIndex]] =
                [shuffled[swapIndex], shuffled[index]];
        }
        return shuffled;
    }

    function submitResponse(response) {
        if (!active || currentPhase !== "recognition" || currentResponse !== null) return;
        currentResponse = response;
        currentResponseAt = performance.now();
        seenButton.disabled = true;
        notSeenButton.disabled = true;
    }

    function handleKeydown(event) {
        if (event.repeat || currentPhase !== "recognition") return;
        const key = event.key.toLowerCase();
        if (key === "y") submitResponse("seen");
        else if (key === "n") submitResponse("not_seen");
    }

    function createGazeSample(frame, phase, imageId) {
        const valid = frame.valid
            && Number.isFinite(frame.xFraction)
            && Number.isFinite(frame.yFraction)
            && frame.xFraction >= 0
            && frame.xFraction <= 1
            && frame.yFraction >= 0
            && frame.yFraction <= 1;
        const sample = {
            timeSeconds: Math.max(0, (frame.capturedAt - testStartedAt) / 1000),
            xPx: valid ? frame.xFraction * canvasWidth : null,
            yPx: valid ? frame.yFraction * canvasHeight : null,
            valid,
            phase,
            imageId: imageId || null,
        };
        samples.push(sample);
        if (frame.reason === "face_not_detected") {
            faceStatus.textContent = "Face not detected. Adjust your position and lighting.";
        } else if (valid && samples.length % 20 === 0) {
            faceStatus.textContent = `${samples.length} gaze samples recorded.`;
        }
        return sample;
    }

    async function captureMemorySample(phase, imageId) {
        const frameStartedAt = performance.now();
        const frame = await captureFrame();
        createGazeSample(frame, phase, imageId);
        const delay = Math.max(0, frameIntervalMs - (performance.now() - frameStartedAt));
        await wait(delay);
    }

    function trialFixations(phase, imageId, startedAt, endedAt) {
        const stageBounds = stage.getBoundingClientRect();
        const wordBounds = stimulus.getBoundingClientRect();
        const left = wordBounds.left - stageBounds.left;
        const top = wordBounds.top - stageBounds.top;
        const right = left + wordBounds.width;
        const bottom = top + wordBounds.height;
        const trialSamples = samples.filter(sample =>
            sample.phase === phase
            && sample.imageId === imageId
            && sample.timeSeconds >= startedAt
            && sample.timeSeconds <= endedAt
        );
        const fixationSamples = trialSamples.filter(sample =>
            sample.valid
            && sample.xPx >= left
            && sample.xPx <= right
            && sample.yPx >= top
            && sample.yPx <= bottom
        );
        const sampleIntervalMs = trialSamples.length > 1
            ? ((trialSamples[trialSamples.length - 1].timeSeconds
                - trialSamples[0].timeSeconds) * 1000) / (trialSamples.length - 1)
            : frameIntervalMs;
        const trialDurationMs = Math.max(0, (endedAt - startedAt) * 1000);
        return {
            fixationCount: fixationSamples.length,
            fixationDurationMs: Math.min(
                5000,
                trialDurationMs,
                fixationSamples.length * sampleIntervalMs
            ),
        };
    }

    async function observeFor(durationMs, phase, imageId, progressCallback) {
        const startedAt = performance.now();
        const endAt = startedAt + durationMs;
        while (active && performance.now() < endAt) {
            await captureMemorySample(phase, imageId);
            if (progressCallback) {
                progressCallback(Math.min(1, (performance.now() - startedAt) / durationMs));
            }
        }
        ensureActive();
        return {
            startedAt: (startedAt - testStartedAt) / 1000,
            endedAt: (performance.now() - testStartedAt) / 1000,
        };
    }

    async function runRecognitionTrial(word, isOld, index) {
        currentPhase = "recognition";
        currentImageId = word;
        currentResponse = null;
        currentResponseAt = 0;
        currentTrialStartedAt = performance.now();
        showStimulus(
            `Recognition ${index + 1} of 16`,
            word,
            "Have you seen this word before? Choose an answer within five seconds.",
            true
        );
        statusText.textContent = "Choose Seen or Not seen. You can also press Y or N.";
        const endAt = currentTrialStartedAt + recognitionTimeoutMs;
        while (active && currentResponse === null && performance.now() < endAt) {
            const remaining = endAt - performance.now();
            await captureMemorySample(
                "recognition",
                word
            );
            setProgress(50 + ((index + 1 - remaining / recognitionTimeoutMs) / 16) * 50);
        }
        ensureActive();

        const response = currentResponse;
        const responseTimeMs = response === null
            ? null
            : Math.min(
                recognitionTimeoutMs,
                currentResponseAt - currentTrialStartedAt
            );
        const trialStartedAtSeconds =
            (currentTrialStartedAt - testStartedAt) / 1000;
        const trialEndedAtSeconds = (performance.now() - testStartedAt) / 1000;
        const fixation = trialFixations(
            "recognition",
            word,
            trialStartedAtSeconds,
            trialEndedAtSeconds
        );
        trials.push({
            imageId: word,
            phase: "recognition",
            isOld,
            userResponse: response,
            isCorrect: response === null
                ? false
                : (response === "seen") === isOld,
            responseTimeMs,
            ...fixation,
        });
        currentPhase = null;
        currentImageId = null;
        responseButtons.hidden = true;
    }

    async function runMemoryTask() {
        samples = [];
        trials = [];
        testStartedAt = performance.now();
        const oldWords = shuffle([
            "APPLE", "BICYCLE", "CLOCK", "CHAIR", "CAR",
            "BOOK", "FLOWER", "CUP", "UMBRELLA", "CAMERA",
        ]).slice(0, 8);
        const newWords = shuffle([
            "TRAIN", "BRIDGE", "PIANO", "ORANGE", "RIVER",
            "MOUNTAIN", "PENCIL", "WINDOW", "PLANT", "TELEPHONE",
        ]).slice(0, 8);
        const recognitionWords = shuffle([
            ...oldWords.map(word => ({ word, isOld: true })),
            ...newWords.map(word => ({ word, isOld: false })),
        ]);

        for (let index = 0; index < oldWords.length; index += 1) {
            ensureActive();
            const word = oldWords[index];
            currentPhase = "encoding";
            currentImageId = word;
            showStimulus(
                `Study ${index + 1} of 8`,
                word,
                "Read this word and try to remember it."
            );
            statusText.textContent = "Study each word as it appears.";
            const interval = await observeFor(
                encodingDurationMs,
                "encoding",
                word,
                fraction => setProgress(20 + ((index + fraction) / 8) * 25)
            );
            const fixation = trialFixations(
                "encoding",
                word,
                interval.startedAt,
                interval.endedAt
            );
            trials.push({
                imageId: word,
                phase: "encoding",
                isOld: true,
                userResponse: null,
                isCorrect: null,
                responseTimeMs: null,
                ...fixation,
            });
            await wait(120);
        }

        ensureActive();
        currentPhase = "retention";
        currentImageId = null;
        showStimulus(
            "Retention interval",
            "Take a short pause",
            "Keep the words in mind. Recognition begins in a few seconds."
        );
        statusText.textContent = "Short retention interval.";
        await observeFor(
            retentionDurationMs,
            "retention",
            null,
            fraction => setProgress(45 + fraction * 5)
        );

        for (let index = 0; index < recognitionWords.length; index += 1) {
            ensureActive();
            const trial = recognitionWords[index];
            await runRecognitionTrial(trial.word, trial.isOld, index);
            setProgress(50 + ((index + 1) / recognitionWords.length) * 50);
            await wait(120);
        }

        ensureActive();
        await completeAssessment();
    }

    async function completeAssessment() {
        completing = true;
        active = false;
        stopCamera();
        stage.classList.remove("eye-test-active");
        cancelButton.hidden = true;
        clearStimulus();
        statusText.textContent = "Analyzing gaze and recognition results...";
        stageMessage.textContent = "Preparing your memory tracking results...";
        stageMessage.hidden = false;

        const result = await requestJson(
            `/eye-assessment/${encodeURIComponent(assessmentId)}/memory-tracking/browser/${encodeURIComponent(sessionId)}/complete`,
            {
                method: "POST",
                body: JSON.stringify({
                    samples,
                    trials,
                    widthPx: canvasWidth,
                    heightPx: canvasHeight,
                    calibrationPointCount,
                    mappingMethod,
                }),
            }
        );
        sessionId = null;
        setProgress(100);
        statusText.textContent = "Assessment saved. Opening your results...";
        await exitFullscreen();
        window.location.assign(result.resultUrl);
    }

    async function startTest() {
        if (active) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
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
        trials = [];
        calibrationPointCount = 0;
        mappingMethod = null;
        completing = false;
        setProgress(0);
        statusText.textContent = "Entering fullscreen...";

        try {
            if (!runner.requestFullscreen) {
                throw new Error("Fullscreen mode is not supported by this browser.");
            }
            await runner.requestFullscreen();
            ensureActive();
            resizeCanvas();
            stage.classList.add("eye-test-active");
            stageMessage.hidden = false;
            stageMessage.textContent = "Starting the browser camera...";
            statusText.textContent = "Requesting camera permission...";

            const cameraStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: "user",
                },
                audio: false,
            });
            if (!active) {
                cameraStream.getTracks().forEach(track => track.stop());
                return;
            }
            stream = cameraStream;
            stream.getVideoTracks().forEach(track => {
                track.addEventListener("ended", () => {
                    interruptTest("Camera disconnected. Restart the test and grant camera access.");
                }, { once: true });
            });
            video.srcObject = stream;
            await video.play();
            ensureActive();
            stage.classList.add("eye-camera-active");
            cameraStatus.textContent = "Browser camera is live.";
            faceStatus.textContent = "Connecting to GazeMap...";

            const started = await requestJson(
                `/eye-assessment/${encodeURIComponent(assessmentId)}/memory-tracking/browser/start`,
                { method: "POST" }
            );
            sessionId = started.sessionId;
            ensureActive();
            await initializeGazeMap();
            ensureActive();
            statusText.textContent = "Calibration: look at each dot as it appears.";
            await calibrate();
            ensureActive();
            currentStimulus = null;
            stageMessage.textContent = "Calibration complete. The memory sequence is starting.";
            drawStage();
            await wait(350);
            calibrationUI.hide();
            ensureActive();
            await runMemoryTask();
        } catch (error) {
            const wasCancelled = !active && !completing;
            active = false;
            stopCamera();
            clearStimulus();
            stage.classList.remove("eye-test-active");
            startButton.disabled = false;
            cancelButton.hidden = true;
            if (!wasCancelled) {
                completing = false;
                stageMessage.hidden = false;
                stageMessage.textContent =
                    error.message || "The assessment could not be completed.";
                statusText.textContent =
                    `Unable to complete the test: ${stageMessage.textContent}`;
            }
            if (sessionId) await cancelServerSession();
            await exitFullscreen();
        }
    }

    async function cancelTest() {
        if (!active) return;
        active = false;
        stopCamera();
        clearStimulus();
        stage.classList.remove("eye-test-active");
        startButton.disabled = false;
        cancelButton.hidden = true;
        statusText.textContent = "Memory tracking cancelled.";
        stageMessage.hidden = false;
        stageMessage.textContent = "The test was cancelled. You can start again when ready.";
        await cancelServerSession();
        await exitFullscreen();
    }

    function handleResize() {
        resizeCanvas();
    }

    function handleFullscreenChange() {
        if (active && document.fullscreenElement !== runner) {
            interruptTest("Fullscreen was exited. Restart the test to continue.");
        }
    }

    startButton.addEventListener("click", startTest);
    cancelButton.addEventListener("click", cancelTest);
    seenButton.addEventListener("click", () => submitResponse("seen"));
    notSeenButton.addEventListener("click", () => submitResponse("not_seen"));
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize", handleResize);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    resizeCanvas();
});
