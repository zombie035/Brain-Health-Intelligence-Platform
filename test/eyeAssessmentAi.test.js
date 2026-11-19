const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    generateAiResponse,
    getConfiguredAiProvider,
} = require("../services/eyeAssessmentAi");

const providerKeys = {
    gemini: "GEMINI_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
};

const validAnalysis = {
    summary: "The recorded measurements are available for descriptive review.",
    keyFindings: [],
    baselineComparisons: [],
    nextSteps: [],
    limitations: "This information is not a medical diagnosis.",
};

function providerPayload(provider, text) {
    return provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text }] } }] }
        : { choices: [{ message: { content: text } }] };
}

test("AI adapters send analysis requests to each configured provider", async () => {
    const previousFetch = global.fetch;
    const previousKeys = Object.fromEntries(
        Object.values(providerKeys).map(key => [key, process.env[key]])
    );
    const calls = [];

    try {
        Object.values(providerKeys).forEach(key => {
            process.env[key] = `test-${key.toLowerCase()}`;
        });
        global.fetch = async (url, options) => {
            calls.push({ url, options });
            const provider = url.includes("generativelanguage.googleapis.com")
                ? "gemini"
                : url.includes("api.openai.com")
                    ? "openai"
                    : "deepseek";
            return {
                ok: true,
                status: 200,
                json: async () => providerPayload(
                    provider,
                    JSON.stringify(validAnalysis)
                ),
            };
        };

        for (const provider of Object.keys(providerKeys)) {
            const result = await generateAiResponse(provider, {
                mode: "analysis",
                reportContext: { assessments: [] },
                baseline: { assessments: {} },
                message: "Explain the completed assessment.",
                history: [],
            });
            assert.equal(result.analysis.summary, validAnalysis.summary);

            const chatResponse = await generateAiResponse(provider, {
                mode: "chat",
                reportContext: { assessments: [] },
                baseline: { assessments: {} },
                message: "What does this summary mean?",
                history: [{ role: "user", content: "Explain the result." }],
            });
            assert.equal(chatResponse.answer, JSON.stringify(validAnalysis));
        }

        assert.equal(calls.length, 6);
        assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
        assert.match(calls[2].url, /api\.openai\.com/);
        assert.match(calls[4].url, /api\.deepseek\.com/);
        for (const call of calls) {
            assert.equal(call.options.method, "POST");
            assert.equal(call.options.headers["Content-Type"], "application/json");
            assert.equal(
                JSON.stringify(JSON.parse(call.options.body)).includes("test-"),
                false
            );
        }
    } finally {
        global.fetch = previousFetch;
        for (const [key, value] of Object.entries(previousKeys)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("Gemini analysis ignores thought parts and extracts structured JSON", async () => {
    const previousFetch = global.fetch;
    const previousKey = process.env.GEMINI_API_KEY;
    try {
        process.env.GEMINI_API_KEY = "test-gemini-key";
        global.fetch = async (url, options) => {
            assert.match(url, /generativelanguage\.googleapis\.com/);
            assert.equal(
                JSON.parse(options.body).generationConfig.responseMimeType,
                "application/json"
            );
            assert.deepEqual(
                JSON.parse(options.body).generationConfig.responseJsonSchema.required,
                ["summary", "keyFindings", "baselineComparisons", "nextSteps", "limitations"]
            );
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [
                                { thought: true, text: "Internal reasoning that is not report output." },
                                {
                                    text: `Here is the report:\n\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``,
                                },
                            ],
                        },
                    }],
                }),
            };
        };

        const result = await generateAiResponse("gemini", {
            mode: "analysis",
            reportContext: { assessments: [] },
            baseline: { assessments: {} },
            message: "Explain the completed assessment.",
            history: [],
        });
        assert.deepEqual(result.analysis, {
            ...validAnalysis,
            keyFindings: [],
            baselineComparisons: [],
            nextSteps: [],
        });
    } finally {
        global.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
    }
});

test("Gemini analysis prompt contains the report measurements and baseline", async () => {
    const previousFetch = global.fetch;
    const previousKey = process.env.GEMINI_API_KEY;
    const reportContext = {
        assessments: [{
            type: "saccadic",
            title: "Saccadic Eye Movement Test",
            durationSeconds: 42,
            measurements: [{ label: "Mean latency (ms)", value: 238.5 }],
            calibration: [{ label: "Mapping method", value: "affine" }],
            trackingQuality: [{ label: "Valid sample fraction", value: 0.91 }],
            qualityNotes: ["Lighting was stable."],
            observations: ["Targets were acquired in all trials."],
        }],
    };
    const baseline = {
        minimumSessionsForComparison: 2,
        assessments: {
            saccadic: {
                priorCompletedSessions: 3,
                measurements: {
                    meanLatencyMs: { mean: 251.2, sessionCount: 3 },
                },
            },
        },
    };

    try {
        process.env.GEMINI_API_KEY = "test-gemini-key";
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            const systemPrompt = body.systemInstruction.parts[0].text;
            assert.ok(systemPrompt.includes(JSON.stringify(reportContext)));
            assert.ok(systemPrompt.includes(JSON.stringify(baseline)));
            assert.match(systemPrompt, /Never invent values/);
            assert.match(systemPrompt, /Do not diagnose/);
            assert.deepEqual(body.contents, [{
                role: "user",
                parts: [{ text: "Interpret the completed eye-assessment report." }],
            }]);
            assert.equal(body.generationConfig.maxOutputTokens, 4096);
            assert.equal(body.generationConfig.responseJsonSchema.type, "object");
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: { parts: [{ text: JSON.stringify(validAnalysis) }] },
                    }],
                }),
            };
        };

        const result = await generateAiResponse("gemini", {
            mode: "analysis",
            reportContext,
            baseline,
            message: "Interpret the completed eye-assessment report.",
            history: [],
        });
        assert.equal(result.analysis.summary, validAnalysis.summary);
    } finally {
        global.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
    }
});

test("AI report prompt labels consented questionnaire answers as self-reported", async () => {
    const previousFetch = global.fetch;
    const previousKey = process.env.OPENAI_API_KEY;
    const reportContext = {
        assessments: [],
        selfReportedQuestionnaire: {
            currentAnswers: [{
                questionId: "sleep_quality",
                question: "How would you describe your sleep quality?",
                answers: ["Good"],
            }],
            previousAnswers: [],
            changesFromPreviousSession: [],
        },
    };

    try {
        process.env.OPENAI_API_KEY = "test-openai-key";
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            assert.ok(body.messages[0].content.includes(JSON.stringify(reportContext)));
            assert.match(body.messages[0].content, /self-reported context/);
            assert.match(body.messages[0].content, /do not infer clinical improvement/);
            return {
                ok: true,
                status: 200,
                json: async () => providerPayload("openai", JSON.stringify(validAnalysis)),
            };
        };

        const result = await generateAiResponse("openai", {
            mode: "analysis",
            reportContext,
            baseline: { assessments: {} },
            message: "Explain the report and my selected questionnaire answers.",
            history: [],
        });
        assert.equal(result.analysis.summary, validAnalysis.summary);
    } finally {
        global.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
    }
});

test("Gemini reports truncated structured analysis instead of a parse error", async () => {
    const previousFetch = global.fetch;
    const previousKey = process.env.GEMINI_API_KEY;
    try {
        process.env.GEMINI_API_KEY = "test-gemini-key";
        global.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{
                    finishReason: "MAX_TOKENS",
                    content: { parts: [{ text: '{"summary":"partial' }] },
                }],
            }),
        });

        await assert.rejects(
            generateAiResponse("gemini", {
                mode: "analysis",
                reportContext: { assessments: [] },
                baseline: { assessments: {} },
                message: "Interpret the report.",
                history: [],
            }),
            error => error.code === "provider_output_truncated"
                && /cut off/.test(error.message)
        );
    } finally {
        global.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
    }
});

test("Gemini request errors expose sanitized provider diagnostics", async () => {
    const previousFetch = global.fetch;
    const previousKey = process.env.GEMINI_API_KEY;
    const apiKey = "AIzaTestKeyThatMustNeverBeReturned123456";
    try {
        process.env.GEMINI_API_KEY = apiKey;
        global.fetch = async () => ({
            ok: false,
            status: 400,
            json: async () => ({
                error: {
                    status: "INVALID_ARGUMENT",
                    message: `Unknown schema field; key ${apiKey}`,
                },
            }),
        });

        await assert.rejects(
            generateAiResponse("gemini", {
                mode: "analysis",
                reportContext: { assessments: [] },
                baseline: { assessments: {} },
                message: "Interpret the report.",
                history: [],
            }),
            error => {
                assert.equal(error.code, "provider_request_failed");
                assert.equal(error.providerStatus, 400);
                assert.equal(error.providerCode, "INVALID_ARGUMENT");
                assert.match(error.message, /Unknown schema field/);
                assert.equal(error.message.includes(apiKey), false);
                assert.equal(error.providerMessage.includes(apiKey), false);
                return true;
            }
        );
    } finally {
        global.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousKey;
    }
});

test("AI adapters report missing and rejected provider credentials", async () => {
    const previousFetch = global.fetch;
    const previousKey = process.env.OPENAI_API_KEY;
    let fetchCalled = false;

    try {
        process.env.OPENAI_API_KEY = "";
        global.fetch = async () => {
            fetchCalled = true;
            throw new Error("Fetch should not run without a key.");
        };
        await assert.rejects(
            generateAiResponse("openai", {
                mode: "analysis",
                reportContext: {},
                baseline: {},
                message: "Analyze.",
                history: [],
            }),
            error => error.code === "provider_not_configured"
        );
        assert.equal(fetchCalled, false);

        process.env.OPENAI_API_KEY = "test-openai-key";
        global.fetch = async () => ({
            ok: false,
            status: 401,
            json: async () => ({ error: { message: "Unauthorized" } }),
        });
        await assert.rejects(
            generateAiResponse("openai", {
                mode: "analysis",
                reportContext: {},
                baseline: {},
                message: "Analyze.",
                history: [],
            }),
            error => error.code === "invalid_provider_key" && error.status === 502
        );

        global.fetch = async () => ({
            ok: false,
            status: 403,
            json: async () => ({
                error: { code: "insufficient_permissions", message: "Model access denied." },
            }),
        });
        await assert.rejects(
            generateAiResponse("openai", {
                mode: "analysis",
                reportContext: {},
                baseline: {},
                message: "Analyze.",
                history: [],
            }),
            error => error.code === "provider_access_denied"
                && /project permissions, model access, and billing/.test(error.message)
        );

        global.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => null,
        });
        await assert.rejects(
            generateAiResponse("openai", {
                mode: "analysis",
                reportContext: {},
                baseline: {},
                message: "Analyze.",
                history: [],
            }),
            error => error.code === "invalid_provider_response"
        );
    } finally {
        global.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
    }
});

test("AI provider selection is server-configured without exposing credentials", () => {
    const previousKeys = Object.fromEntries(
        Object.values(providerKeys).map(key => [key, process.env[key]])
    );
    const previousProvider = process.env.AI_PROVIDER;
    try {
        Object.values(providerKeys).forEach(key => delete process.env[key]);
        delete process.env.AI_PROVIDER;
        assert.equal(getConfiguredAiProvider(), null);

        process.env.GEMINI_API_KEY = "test-gemini-key";
        process.env.OPENAI_API_KEY = "test-openai-key";
        process.env.AI_PROVIDER = "openai";
        const selected = getConfiguredAiProvider();
        assert.deepEqual(selected, {
            id: "openai",
            label: "OpenAI",
            configured: true,
            message: null,
        });
        assert.equal("key" in selected, false);

        process.env.AI_PROVIDER = "unknown";
        assert.equal(getConfiguredAiProvider().configured, false);

        delete process.env.AI_PROVIDER;
        delete process.env.GEMINI_API_KEY;
        assert.equal(getConfiguredAiProvider().id, "openai");
    } finally {
        for (const [key, value] of Object.entries(previousKeys)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        if (previousProvider === undefined) delete process.env.AI_PROVIDER;
        else process.env.AI_PROVIDER = previousProvider;
    }
});
