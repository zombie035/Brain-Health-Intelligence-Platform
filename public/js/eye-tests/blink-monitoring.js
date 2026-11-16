document.addEventListener("DOMContentLoaded", () => {
    const runner = document.getElementById("blinkMonitoringTest");
    if (!runner) return;

    const assessmentId = runner.dataset.assessmentId;
    const websocketUrl = runner.dataset.gazeWsUrl;
    const startButton = document.getElementById("startBlinkTest");
    const cancelButton = document.getElementById("cancelBlinkTest");
    const statusText = document.getElementById("blinkStatus");
    const progressTrack = document.querySelector(".eye-progress-track");
    const progressFill = document.getElementById("blinkProgress");
    const progressText = document.getElementById("blinkProgressText");
    const stage = document.getElementById("blinkStage");
    const video = document.getElementById("blinkVideo");
    const signalCanvas = document.getElementById("blinkSignalCanvas");
    const eyePreviewCanvas = document.getElementById("blinkEyePreview");
    const readingParagraph = document.getElementById("blinkReadingParagraph");
    const earReadout = document.getElementById("blinkEarReadout");
    const cameraStatus = document.getElementById("blinkCameraStatus");
    const faceStatus = document.getElementById("blinkFaceStatus");

    const testDurationMs = 30_000;
    const frameIntervalMs = 85;
    const captureCanvas = document.createElement("canvas");
    const captureContext = captureCanvas.getContext("2d");
    const samples = [];
    const pendingRequests = new Map();
    let stream = null;
    let socket = null;
    let sessionId = null;
    let requestSequence = 0;
    let testStartedAt = 0;
    let latestLeftEyeLandmarks = null;
    let latestRightEyeLandmarks = null;
    let sampleTimer = null;
    let active = false;
    let finishing = false;

    function setProgress(value) {
        const progress = Math.max(0, Math.min(100, Number(value) || 0));
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${Math.round(progress)}%`;
        progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
    }

    function hasValidEyeLandmarks(landmarks) {
        return Array.isArray(landmarks)
            && landmarks.length === 16
            && landmarks.every(point =>
                Array.isArray(point)
                && point.length === 2
                && Number.isFinite(point[0])
                && Number.isFinite(point[1])
                && point[0] >= 0
                && point[0] <= 1
                && point[1] >= 0
                && point[1] <= 1
            );
    }

    function isEyeVisible(result, flag, landmarks, eyeRatio) {
        if (typeof result[flag] === "boolean") return result[flag];
        return hasValidEyeLandmarks(landmarks)
            && Number.isFinite(eyeRatio)
            && eyeRatio >= 0
            && eyeRatio <= 1;
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
            const timeout = window.setTimeout(
                () => reject(new Error("Timed out connecting to the GazeMap service.")),
                8000
            );
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
                pendingRequests.delete(message.requestId);
                window.clearTimeout(pending.timeout);
                if (message.type === "error" || message.error) {
                    pending.reject(new Error(message.message || message.error));
                } else {
                    pending.resolve(message);
                }
            });
            socket.addEventListener("close", () => {
                window.clearTimeout(timeout);
                rejectPendingRequests("The connection to GazeMap was closed.");
            });
        });
    }

    function sendSocketRequest(type, data = {}) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("The connection to GazeMap is not open."));
        }

        const requestId = `blink-${++requestSequence}`;
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                pendingRequests.delete(requestId);
                reject(new Error("GazeMap did not respond to a camera frame in time."));
            }, 10000);
            pendingRequests.set(requestId, { resolve, reject, timeout });
            socket.send(JSON.stringify({ type, requestId, ...data }));
        });
    }

    function closeSocket() {
        if (!socket) return;
        rejectPendingRequests("The browser camera session has ended.");
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close();
        }
        socket = null;
    }

    function stopCamera() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        video.srcObject = null;
        stage.classList.remove("eye-camera-active");
        cameraStatus.textContent = "Camera Off";
    }

    function releaseFullscreen() {
        if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        }
    }

    function cleanup() {
        active = false;
        window.clearTimeout(sampleTimer);
        closeSocket();
        stopCamera();
        releaseFullscreen();
    }

    function drawSignal() {
        const rect = signalCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const pixelRatio = window.devicePixelRatio || 1;
        const canvasWidth = Math.round(rect.width * pixelRatio);
        const canvasHeight = Math.round(rect.height * pixelRatio);
        if (signalCanvas.width !== canvasWidth || signalCanvas.height !== canvasHeight) {
            signalCanvas.width = canvasWidth;
            signalCanvas.height = canvasHeight;
        }

        const context = signalCanvas.getContext("2d");
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        context.fillStyle = "#0b1220";
        context.fillRect(0, 0, rect.width, rect.height);
        context.strokeStyle = "rgba(148, 163, 184, 0.32)";
        context.lineWidth = 1;
        for (let row = 1; row < 4; row += 1) {
            const y = (rect.height * row) / 4;
            context.beginPath();
            context.moveTo(0, y);
            context.lineTo(rect.width, y);
            context.stroke();
        }

        const plotSamples = samples.slice(-180);
        const drawEye = (key, color) => {
            context.beginPath();
            context.strokeStyle = color;
            context.lineWidth = 2.5;
            let started = false;
            plotSamples.forEach((sample, index) => {
                const eyeVisible = key === "leftEAR"
                    ? sample.leftEyeVisible
                    : sample.rightEyeVisible;
                const value = eyeVisible && Number.isFinite(sample[key])
                    ? sample[key]
                    : null;
                if (value === null) {
                    started = false;
                    return;
                }
                const x = plotSamples.length <= 1
                    ? 0
                    : (index / (plotSamples.length - 1)) * rect.width;
                const y = rect.height - (Math.min(value, 0.8) / 0.8) * rect.height;
                if (started) context.lineTo(x, y);
                else {
                    context.moveTo(x, y);
                    started = true;
                }
            });
            context.stroke();
        };
        drawEye("leftEAR", "#60a5fa");
        drawEye("rightEAR", "#34d399");
    }

    function drawEyePreview(leftLandmarks, rightLandmarks) {
        const rect = eyePreviewCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const pixelRatio = window.devicePixelRatio || 1;
        const canvasWidth = Math.round(rect.width * pixelRatio);
        const canvasHeight = Math.round(rect.height * pixelRatio);
        if (eyePreviewCanvas.width !== canvasWidth || eyePreviewCanvas.height !== canvasHeight) {
            eyePreviewCanvas.width = canvasWidth;
            eyePreviewCanvas.height = canvasHeight;
        }

        const context = eyePreviewCanvas.getContext("2d");
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.fillStyle = "#0b1220";
        context.fillRect(0, 0, rect.width, rect.height);

        const visibleEyes = [
            { landmarks: leftLandmarks, color: "#38bdf8" },
            { landmarks: rightLandmarks, color: "#a3e635" },
        ].filter(eye => hasValidEyeLandmarks(eye.landmarks));
        if (visibleEyes.length === 0) {
            context.fillStyle = "#cbd5e1";
            context.font = "13px sans-serif";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText("Eyes not visible. Look directly into camera.", rect.width / 2, rect.height / 2);
            return;
        }

        const allLandmarks = visibleEyes.flatMap(eye => eye.landmarks);
        const sourceWidth = captureCanvas.width;
        const sourceHeight = captureCanvas.height;
        const xs = allLandmarks.map(point => point[0] * sourceWidth);
        const ys = allLandmarks.map(point => point[1] * sourceHeight);
        const pointWidth = Math.max(...xs) - Math.min(...xs);
        const pointHeight = Math.max(...ys) - Math.min(...ys);
        const aspectRatio = rect.width / rect.height;
        let cropWidth = pointWidth + Math.max(24, pointWidth * 0.16);
        let cropHeight = pointHeight + Math.max(38, pointHeight * 1.8);
        if (cropWidth / cropHeight < aspectRatio) {
            cropWidth = cropHeight * aspectRatio;
        } else {
            cropHeight = cropWidth / aspectRatio;
        }
        cropWidth = Math.min(sourceWidth, cropWidth);
        cropHeight = Math.min(sourceHeight, cropHeight);
        const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
        const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
        const cropX = Math.max(0, Math.min(sourceWidth - cropWidth, centerX - cropWidth / 2));
        const cropY = Math.max(0, Math.min(sourceHeight - cropHeight, centerY - cropHeight / 2));

        context.drawImage(
            captureCanvas,
            cropX,
            cropY,
            cropWidth,
            cropHeight,
            0,
            0,
            rect.width,
            rect.height
        );

        const drawEye = (landmarks, color) => {
            const points = landmarks.map(point => ({
                x: ((point[0] * sourceWidth - cropX) / cropWidth) * rect.width,
                y: ((point[1] * sourceHeight - cropY) / cropHeight) * rect.height,
            }));
            context.save();
            context.strokeStyle = color;
            context.lineWidth = 2;
            context.shadowColor = color;
            context.shadowBlur = 4;
            context.beginPath();
            points.forEach((point, index) => {
                if (index === 0) context.moveTo(point.x, point.y);
                else context.lineTo(point.x, point.y);
            });
            context.closePath();
            context.stroke();
            context.shadowBlur = 0;
            points.forEach(point => {
                context.beginPath();
                context.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
                context.fillStyle = "#f8fafc";
                context.fill();
                context.strokeStyle = color;
                context.stroke();
            });
            context.restore();
        };
        visibleEyes.forEach(eye => drawEye(eye.landmarks, eye.color));
    }

    function updateLiveReadout(sample) {
        const leftVisible = sample.leftEyeVisible === true;
        const rightVisible = sample.rightEyeVisible === true;
        if (!leftVisible && !rightVisible) {
            faceStatus.textContent =
                "Eyes not visible. Please look directly into the camera. Adjust your face or camera position.";
            earReadout.textContent = "--";
            return;
        }
        if (leftVisible !== rightVisible) {
            faceStatus.textContent =
                "Only one eye is detected. Center your face and adjust the camera so both eyes are visible.";
            earReadout.textContent = "--";
            return;
        }
        if (!sample.valid || !Number.isFinite(sample.avgEAR)) {
            faceStatus.textContent =
                "Eyes are not reliably tracked. Look directly into the camera and adjust your position.";
            earReadout.textContent = "--";
            return;
        }
        faceStatus.textContent = "Both eyes visible and tracked. Blink normally.";
        earReadout.textContent = sample.avgEAR.toFixed(3);
    }

    function encodeCaptureFrame() {
        if (!video.videoWidth || !video.videoHeight) {
            return Promise.reject(new Error("The browser camera has not produced a video frame yet."));
        }
        const scale = Math.min(1, 640 / video.videoWidth);
        const captureWidth = Math.max(1, Math.round(video.videoWidth * scale));
        const captureHeight = Math.max(1, Math.round(video.videoHeight * scale));
        if (captureCanvas.width !== captureWidth || captureCanvas.height !== captureHeight) {
            captureCanvas.width = captureWidth;
            captureCanvas.height = captureHeight;
        }
        captureContext.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
        return new Promise((resolve, reject) => {
            captureCanvas.toBlob(blob => {
                if (!blob) {
                    reject(new Error("Could not encode the browser camera frame."));
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error("Could not read the encoded camera frame."));
                reader.readAsDataURL(blob);
            }, "image/jpeg", 0.68);
        });
    }

    async function captureNextFrame() {
        if (!active) return;
        const captureTime = performance.now();
        const elapsedSeconds = Math.max(0, (captureTime - testStartedAt) / 1000);
        if (captureTime - testStartedAt >= testDurationMs) {
            await completeAssessment();
            return;
        }

        try {
            const imageBase64 = await encodeCaptureFrame();
            const result = await sendSocketRequest("frame", {
                imageBase64,
                timestampMs: Math.round(captureTime),
                includeEar: true,
            });
            const eyeValue = value => Number.isFinite(value) ? value : null;
            const leftEyeVisible = isEyeVisible(
                result,
                "leftEyeVisible",
                result.leftEyeLandmarks,
                result.leftEAR
            );
            const rightEyeVisible = isEyeVisible(
                result,
                "rightEyeVisible",
                result.rightEyeLandmarks,
                result.rightEAR
            );
            const sample = {
                timeSeconds: elapsedSeconds,
                leftEAR: eyeValue(result.leftEAR),
                rightEAR: eyeValue(result.rightEAR),
                avgEAR: eyeValue(result.avgEAR),
                faceDetected: result.faceDetected === true,
                leftEyeVisible,
                rightEyeVisible,
                valid: result.valid === true
                    && result.faceDetected === true
                    && leftEyeVisible
                    && rightEyeVisible
                    && Number.isFinite(result.leftEAR)
                    && Number.isFinite(result.rightEAR)
                    && Number.isFinite(result.avgEAR),
            };
            samples.push(sample);
            latestLeftEyeLandmarks = result.leftEyeLandmarks || null;
            latestRightEyeLandmarks = result.rightEyeLandmarks || null;
            updateLiveReadout(sample);
            drawEyePreview(result.leftEyeLandmarks, result.rightEyeLandmarks);
            drawSignal();

            const progress = ((performance.now() - testStartedAt) / testDurationMs) * 100;
            setProgress(progress);
            statusText.textContent = "Recording live eye-openness measurements. Blink naturally.";
            const delay = Math.max(0, frameIntervalMs - (performance.now() - captureTime));
            sampleTimer = window.setTimeout(captureNextFrame, delay);
        } catch (error) {
            if (active) await failAssessment(error);
        }
    }

    async function completeAssessment() {
        if (finishing || !sessionId) return;
        finishing = true;
        active = false;
        cancelButton.hidden = true;
        setProgress(100);
        statusText.textContent = "Analyzing the measured eye-openness samples...";
        closeSocket();
        stopCamera();
        releaseFullscreen();

        try {
            const result = await requestJson(
                `/eye-assessment/${encodeURIComponent(assessmentId)}/blink-monitoring/browser/${encodeURIComponent(sessionId)}/complete`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        samples,
                        widthPx: Math.max(100, Math.round(window.innerWidth)),
                        heightPx: Math.max(100, Math.round(window.innerHeight)),
                    }),
                }
            );
            statusText.textContent = "Blink monitoring complete. Opening your results...";
            if (result.resultUrl) window.location.assign(result.resultUrl);
        } catch (error) {
            finishing = false;
            await failAssessment(error);
        }
    }

    async function failAssessment(error) {
        cleanup();
        if (sessionId) {
            try {
                await requestJson(
                    `/eye-assessment/${encodeURIComponent(assessmentId)}/blink-monitoring/browser/${encodeURIComponent(sessionId)}/cancel`,
                    { method: "POST" }
                );
            } catch (cancelError) {
                console.error("Could not mark the blink session incomplete:", cancelError);
            }
        }
        statusText.textContent = `Unable to complete the test: ${error.message}`;
        cameraStatus.textContent = "Camera Off";
        cancelButton.hidden = true;
        startButton.disabled = false;
        runner.classList.remove("eye-test-active");
        stage.classList.remove("eye-test-active", "eye-camera-active");
        sessionId = null;
    }

    startButton.addEventListener("click", async () => {
        active = true;
        startButton.disabled = true;
        setProgress(0);
        statusText.textContent = "Requesting camera access...";
        cameraStatus.textContent = "Camera Off";
        faceStatus.textContent = "Waiting for camera.";
        samples.length = 0;
        readingParagraph.hidden = true;
        latestLeftEyeLandmarks = null;
        latestRightEyeLandmarks = null;
        drawEyePreview(null, null);
        drawSignal();

        try {
            if (
                document.fullscreenEnabled
                && typeof runner.requestFullscreen === "function"
                && !document.fullscreenElement
            ) {
                await runner.requestFullscreen();
            }
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Camera access requires a secure browser context (HTTPS or localhost).");
            }
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: "user",
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                },
            });
            stream.getVideoTracks().forEach(track => {
                track.addEventListener("ended", () => {
                    cameraStatus.textContent = "Camera Off";
                    if (!active) return;
                    void failAssessment(new Error("Camera disconnected. Restart the test and grant camera access."));
                }, { once: true });
            });
            video.srcObject = stream;
            await video.play();
            if (!active) return;
            stage.classList.add("eye-test-active", "eye-camera-active");
            runner.classList.add("eye-test-active");
            cameraStatus.textContent = "Camera Active";
            faceStatus.textContent = "Connecting to GazeMap...";

            const session = await requestJson(
                `/eye-assessment/${encodeURIComponent(assessmentId)}/blink-monitoring/browser/start`,
                { method: "POST" }
            );
            sessionId = session.sessionId;
            cancelButton.hidden = false;
            cancelButton.disabled = false;

            await connectSocket();
            if (!active) return;
            testStartedAt = performance.now();
            readingParagraph.hidden = false;
            statusText.textContent = "Read the passage naturally and blink as you normally would.";
            await captureNextFrame();
        } catch (error) {
            if (!active && !finishing) return;
            await failAssessment(error);
        }
    });

    cancelButton.addEventListener("click", async () => {
        if (!sessionId) return;
        const cancellingSessionId = sessionId;
        cancelButton.disabled = true;
        cleanup();
        statusText.textContent = "Blink monitoring cancelled.";
        runner.classList.remove("eye-test-active");
        stage.classList.remove("eye-test-active", "eye-camera-active");
        cancelButton.hidden = true;
        startButton.disabled = false;
        sessionId = null;
        try {
            await requestJson(
                `/eye-assessment/${encodeURIComponent(assessmentId)}/blink-monitoring/browser/${encodeURIComponent(cancellingSessionId)}/cancel`,
                { method: "POST" }
            );
        } catch (error) {
            statusText.textContent = `Unable to save cancellation: ${error.message}`;
        }
    });

    drawEyePreview(null, null);
    window.addEventListener("resize", () => {
        drawSignal();
        drawEyePreview(latestLeftEyeLandmarks, latestRightEyeLandmarks);
    });
});
