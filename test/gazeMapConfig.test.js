const test = require("node:test");
const assert = require("node:assert/strict");

const { getGazeMapConfig } = require("../services/gazeMapConfig");

test("local GazeMap URLs remain the default", () => {
    assert.deepEqual(getGazeMapConfig({}), {
        apiUrl: "http://127.0.0.1:8001",
        websocketUrl: "ws://127.0.0.1:8001/ws/gaze",
    });
});

test("deployed HTTPS service derives a secure browser WebSocket URL", () => {
    assert.deepEqual(getGazeMapConfig({
        GAZE_SERVICE_URL: "https://gaze.example.onrender.com/",
    }), {
        apiUrl: "https://gaze.example.onrender.com",
        websocketUrl: "wss://gaze.example.onrender.com/ws/gaze",
    });
});

test("legacy API URL and explicit WebSocket overrides remain supported", () => {
    assert.deepEqual(getGazeMapConfig({
        GAZE_API_URL: "http://localhost:9000/api",
        GAZE_WS_URL: "wss://gaze.example.test/custom",
    }), {
        apiUrl: "http://localhost:9000/api",
        websocketUrl: "wss://gaze.example.test/custom",
    });
});

test("service URL takes precedence over the legacy API URL", () => {
    assert.deepEqual(getGazeMapConfig({
        GAZE_SERVICE_URL: "https://gaze.example.test",
        GAZE_API_URL: "http://localhost:8001",
    }), {
        apiUrl: "https://gaze.example.test",
        websocketUrl: "wss://gaze.example.test/ws/gaze",
    });
});

test("invalid service schemes and insecure WebSocket overrides are rejected", () => {
    assert.throws(
        () => getGazeMapConfig({ GAZE_SERVICE_URL: "ws://gaze.example.test" }),
        /must use http or https/
    );
    assert.throws(
        () => getGazeMapConfig({
            GAZE_SERVICE_URL: "https://gaze.example.test",
            GAZE_WS_URL: "https://gaze.example.test/ws/gaze",
        }),
        /must use ws or wss/
    );
    assert.throws(
        () => getGazeMapConfig({ GAZE_SERVICE_URL: "https://user:pass@gaze.example.test" }),
        /must not contain credentials/
    );
});
