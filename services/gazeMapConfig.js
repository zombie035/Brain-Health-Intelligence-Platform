function parseUrl(value, label) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${label} must be an absolute URL.`);
    }

    if (
        url.username
        || url.password
        || url.search
        || url.hash
    ) {
        throw new Error(`${label} must not contain credentials, a query, or a fragment.`);
    }
    return url;
}

function getGazeMapConfig(env = process.env) {
    const serviceUrl = (
        env.GAZE_SERVICE_URL
        || env.GAZE_API_URL
        || "http://127.0.0.1:8001"
    ).trim().replace(/\/+$/, "");
    const apiUrl = parseUrl(serviceUrl, "GAZE_SERVICE_URL");
    if (!["http:", "https:"].includes(apiUrl.protocol)) {
        throw new Error("GAZE_SERVICE_URL must use http or https.");
    }

    const explicitWsUrl = typeof env.GAZE_WS_URL === "string"
        ? env.GAZE_WS_URL.trim()
        : "";
    let websocketUrl;
    if (explicitWsUrl) {
        websocketUrl = parseUrl(explicitWsUrl, "GAZE_WS_URL");
        if (!["ws:", "wss:"].includes(websocketUrl.protocol)) {
            throw new Error("GAZE_WS_URL must use ws or wss.");
        }
    } else {
        websocketUrl = new URL(apiUrl.toString());
        websocketUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    }

    if (!explicitWsUrl) {
        websocketUrl.pathname = "/ws/gaze";
        websocketUrl.search = "";
        websocketUrl.hash = "";
    }

    return {
        apiUrl: serviceUrl,
        websocketUrl: websocketUrl.toString(),
    };
}

module.exports = { getGazeMapConfig };
