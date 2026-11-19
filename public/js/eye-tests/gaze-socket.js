(function (global) {
    function createGazeSocket(url, options = {}) {
        let connection = null;
        let requestCounter = 0;
        const pendingRequests = new Map();

        function rejectPendingRequests(error) {
            for (const [requestId, pending] of pendingRequests) {
                global.clearTimeout(pending.timeout);
                pendingRequests.delete(requestId);
                pending.reject(error);
            }
        }

        function connect(timeoutMs = 12000) {
            if (connection?.socket.readyState === global.WebSocket.OPEN) {
                return Promise.resolve();
            }
            if (connection) return connection.promise;
            if (!url) {
                return Promise.reject(
                    new Error("The GazeMap WebSocket URL is not configured.")
                );
            }

            let socket;
            try {
                socket = new global.WebSocket(url);
            } catch {
                return Promise.reject(
                    new Error("The configured GazeMap WebSocket URL is invalid.")
                );
            }

            const current = {
                socket,
                promise: null,
                rejectConnect: null,
                opened: false,
                intentionalClose: false,
            };
            connection = current;

            current.promise = new Promise((resolve, reject) => {
                let settled = false;
                const timeout = global.setTimeout(() => {
                    const error = new Error(
                        "Timed out connecting to GazeMap. Check that the service is running and BRAINGUARD_ORIGINS allows this website."
                    );
                    if (current.rejectConnect) current.rejectConnect(error);
                    socket.close();
                }, timeoutMs);

                const settle = (callback, value) => {
                    if (settled) return false;
                    settled = true;
                    global.clearTimeout(timeout);
                    current.rejectConnect = null;
                    callback(value);
                    return true;
                };
                current.rejectConnect = error => settle(reject, error);

                socket.addEventListener("open", () => {
                    current.opened = true;
                    settle(resolve);
                }, { once: true });

                socket.addEventListener("error", () => {
                    if (current.opened) {
                        rejectPendingRequests(new Error(
                            "GazeMap encountered a connection error."
                        ));
                        socket.close();
                        return;
                    }

                    current.rejectConnect(new Error(
                        "Could not connect to GazeMap. Check that the service is running and BRAINGUARD_ORIGINS allows this website."
                    ));
                    socket.close();
                }, { once: true });

                socket.addEventListener("message", event => {
                    let message;
                    try {
                        message = JSON.parse(event.data);
                    } catch {
                        rejectPendingRequests(new Error(
                            "GazeMap returned an unreadable response."
                        ));
                        return;
                    }

                    const requestId = String(message.requestId);
                    const pending = pendingRequests.get(requestId);
                    if (!pending) return;

                    pendingRequests.delete(requestId);
                    global.clearTimeout(pending.timeout);
                    if (message.type === "error" || message.error) {
                        pending.reject(new Error(
                            message.message || message.error || "GazeMap request failed."
                        ));
                    } else if (
                        pending.expectedType
                        && message.type !== pending.expectedType
                    ) {
                        pending.reject(new Error("Unexpected response from GazeMap."));
                    } else {
                        pending.resolve(message);
                    }
                });

                socket.addEventListener("close", event => {
                    const error = new Error(
                        event.reason || "GazeMap connection was closed."
                    );
                    if (!current.opened && current.rejectConnect) {
                        current.rejectConnect(error);
                    }
                    rejectPendingRequests(error);
                    if (connection === current) connection = null;
                    if (
                        current.opened
                        && !current.intentionalClose
                        && options.onClose
                    ) {
                        options.onClose(error);
                    }
                });
            });

            return current.promise;
        }

        function request(type, payload = {}, expectedType = type, timeoutMs = 20000) {
            if (!connection || connection.socket.readyState !== global.WebSocket.OPEN) {
                return Promise.reject(
                    new Error("GazeMap connection is not available.")
                );
            }

            const requestId = String(++requestCounter);
            return new Promise((resolve, reject) => {
                const timeout = global.setTimeout(() => {
                    pendingRequests.delete(requestId);
                    reject(new Error("GazeMap did not respond in time."));
                }, timeoutMs);
                pendingRequests.set(requestId, {
                    expectedType,
                    resolve,
                    reject,
                    timeout,
                });
                try {
                    connection.socket.send(JSON.stringify({
                        ...payload,
                        type,
                        requestId,
                    }));
                } catch (error) {
                    global.clearTimeout(timeout);
                    pendingRequests.delete(requestId);
                    reject(error);
                }
            });
        }

        function close() {
            const current = connection;
            if (!current) return;

            current.intentionalClose = true;
            connection = null;
            const error = new Error("The browser camera session has ended.");
            if (!current.opened) current.rejectConnect(error);
            rejectPendingRequests(error);
            if (
                current.socket.readyState === global.WebSocket.CONNECTING
                || current.socket.readyState === global.WebSocket.OPEN
            ) {
                current.socket.close(1000, "Session ended.");
            }
        }

        return { connect, request, close };
    }

    global.GazeSocket = { create: createGazeSocket };
})(window);
