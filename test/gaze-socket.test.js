const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
    path.join(__dirname, "..", "public", "js", "eye-tests", "gaze-socket.js"),
    "utf8"
);

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.listeners = new Map();
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener, options = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push({ listener, once: options.once === true });
        this.listeners.set(type, listeners);
    }

    dispatch(type, event = {}) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(type, listeners.filter(entry => !entry.once));
        listeners.forEach(entry => entry.listener(event));
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatch("open");
    }

    send(message) {
        this.sent.push(message);
    }

    receive(message) {
        this.dispatch("message", { data: JSON.stringify(message) });
    }

    close(code = 1000, reason = "") {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatch("close", { code, reason });
    }
}

function createClient(url, options = {}) {
    FakeWebSocket.instances = [];
    const window = {
        WebSocket: FakeWebSocket,
        setTimeout,
        clearTimeout,
    };
    vm.runInNewContext(source, { window });
    return window.GazeSocket.create(url, options);
}

test("creating a GazeMap client does not open a WebSocket", () => {
    const client = createClient("ws://127.0.0.1:8001/ws/gaze");
    assert.equal(FakeWebSocket.instances.length, 0);
    client.close();
    assert.equal(FakeWebSocket.instances.length, 0);
});

test("all four eye assessments connect only after camera access and session start", () => {
    const assessments = [
        {
            page: "eye-saccadic.ejs",
            script: "saccadic.js",
            start: "async function startTest()",
            connect: "await initializeGazeMap()",
        },
        {
            page: "eye-smooth-pursuit.ejs",
            script: "smooth-pursuit.js",
            start: "async function startTest()",
            connect: "await initializeGazeMap()",
        },
        {
            page: "eye-memory-tracking.ejs",
            script: "memory-tracking.js",
            start: "async function startTest()",
            connect: "await initializeGazeMap()",
        },
        {
            page: "eye-blink-monitoring.ejs",
            script: "blink-monitoring.js",
            start: "startButton.addEventListener(\"click\", async () => {",
            connect: "await connectSocket()",
        },
    ];

    for (const assessment of assessments) {
        const page = fs.readFileSync(
            path.join(__dirname, "..", "views", assessment.page),
            "utf8"
        );
        const script = fs.readFileSync(
            path.join(
                __dirname,
                "..",
                "public",
                "js",
                "eye-tests",
                assessment.script
            ),
            "utf8"
        );
        const startIndex = script.indexOf(assessment.start);
        const cameraIndex = script.indexOf("getUserMedia", startIndex);
        const connectIndex = script.indexOf(assessment.connect, startIndex);
        const sessionStartIndex = script.indexOf("await requestJson(", cameraIndex);

        assert.match(page, /\/js\/eye-tests\/gaze-socket\.js/);
        assert.match(script, /window\.GazeSocket\.create\(websocketUrl/);
        assert.match(script, /Still waiting for camera permission/);
        assert.match(script, /Camera permission granted/);
        assert.ok(startIndex >= 0, `${assessment.script} has a start handler`);
        assert.ok(cameraIndex > startIndex, `${assessment.script} requests camera`);
        assert.ok(sessionStartIndex > cameraIndex, `${assessment.script} starts a session`);
        assert.ok(connectIndex > sessionStartIndex, `${assessment.script} connects after session start`);
    }
});

test("connect opens once and matches replies to their request", async () => {
    const client = createClient("ws://127.0.0.1:8001/ws/gaze");
    const connecting = client.connect();
    const sameConnection = client.connect();
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.instances[0].url, "ws://127.0.0.1:8001/ws/gaze");

    const socket = FakeWebSocket.instances[0];
    socket.open();
    await Promise.all([connecting, sameConnection]);

    const responsePromise = client.request(
        "init",
        { widthPx: 1280, heightPx: 720 },
        "initialized"
    );
    const request = JSON.parse(socket.sent[0]);
    assert.equal(request.type, "init");
    assert.equal(request.widthPx, 1280);
    socket.receive({
        type: "initialized",
        requestId: request.requestId,
        widthPx: 1280,
    });

    const response = await responsePromise;
    assert.equal(response.type, "initialized");
    client.close();
});

test("intentional close rejects pending requests without a disconnect callback", async () => {
    const closeErrors = [];
    const client = createClient("ws://127.0.0.1:8001/ws/gaze", {
        onClose: error => closeErrors.push(error),
    });
    const connecting = client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connecting;

    const responsePromise = client.request("frame");
    const rejection = assert.rejects(
        responsePromise,
        /browser camera session has ended/
    );
    client.close();

    await rejection;
    assert.deepEqual(closeErrors, []);
});

test("unexpected disconnect rejects pending requests and notifies the owner", async () => {
    const closeErrors = [];
    const client = createClient("ws://127.0.0.1:8001/ws/gaze", {
        onClose: error => closeErrors.push(error.message),
    });
    const connecting = client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connecting;

    const responsePromise = client.request("frame");
    const rejection = assert.rejects(responsePromise, /service stopped/);
    socket.close(1011, "service stopped");

    await rejection;
    assert.deepEqual(closeErrors, ["service stopped"]);
});

test("failed connection reports service and origin configuration guidance", async () => {
    const client = createClient("ws://127.0.0.1:8001/ws/gaze");
    const connecting = client.connect();
    const socket = FakeWebSocket.instances[0];
    const rejection = assert.rejects(connecting, /BRAINGUARD_ORIGINS/);

    socket.dispatch("error");

    await rejection;
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});
