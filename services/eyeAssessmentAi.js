const PROVIDERS = {
    gemini: {
        label: "Google Gemini",
        keyEnv: "GEMINI_API_KEY",
        modelEnv: "GEMINI_MODEL",
        defaultModel: "gemini-2.5-flash",
    },
    openai: {
        label: "OpenAI",
        keyEnv: "OPENAI_API_KEY",
        modelEnv: "OPENAI_MODEL",
        defaultModel: "gpt-4o-mini",
    },
    deepseek: {
        label: "DeepSeek",
        keyEnv: "DEEPSEEK_API_KEY",
        modelEnv: "DEEPSEEK_MODEL",
        defaultModel: "deepseek-chat",
    },
};

const ANALYSIS_RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        summary: { type: "string" },
        keyFindings: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    explanation: { type: "string" },
                    evidence: { type: "string" },
                },
                required: ["title", "explanation", "evidence"],
            },
        },
        baselineComparisons: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    assessment: { type: "string" },
                    measurement: { type: "string" },
                    currentValue: { type: "string" },
                    baselineMean: { type: "string" },
                    sessions: { type: "integer" },
                    explanation: { type: "string" },
                },
                required: [
                    "assessment",
                    "measurement",
                    "currentValue",
                    "baselineMean",
                    "sessions",
                    "explanation",
                ],
            },
        },
        nextSteps: {
            type: "array",
            items: { type: "string" },
        },
        limitations: { type: "string" },
    },
    required: [
        "summary",
        "keyFindings",
        "baselineComparisons",
        "nextSteps",
        "limitations",
    ],
};

function createAiError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function getConfiguredAiProvider() {
    let providerId = process.env.AI_PROVIDER?.trim().toLowerCase();
    if (providerId && !PROVIDERS[providerId]) {
        return {
            id: null,
            label: null,
            configured: false,
            message: "AI_PROVIDER must be gemini, openai, or deepseek.",
        };
    }

    if (!providerId) {
        providerId = Object.keys(PROVIDERS).find(id =>
            Boolean(process.env[PROVIDERS[id].keyEnv])
        );
    }
    if (!providerId) return null;

    const provider = PROVIDERS[providerId];
    return {
        id: providerId,
        label: provider.label,
        configured: Boolean(process.env[provider.keyEnv]),
        message: process.env[provider.keyEnv]
            ? null
            : `${provider.label} is selected by AI_PROVIDER but its API key is not configured.`,
    };
}

function providerFailure(responseStatus, providerId, payload, apiKey) {
    const provider = PROVIDERS[providerId];
    const providerError = payload?.error || {};
    const providerMessage = typeof providerError.message === "string"
        ? providerError.message
            .split(apiKey).join("[redacted]")
            .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 400)
        : "";
    let error;

    if (responseStatus === 401) {
        error = createAiError(
            "invalid_provider_key",
            "The configured AI provider rejected its API key. Check the server environment variable and key permissions.",
            502
        );
    } else if (responseStatus === 403) {
        error = createAiError(
            "provider_access_denied",
            `${provider.label} denied access to this request. Check the API key's project permissions, model access, and billing settings.`,
            502
        );
    } else if (responseStatus === 429) {
        error = createAiError(
            "provider_rate_limited",
            "The configured AI provider is rate-limiting requests. Try again later.",
            503
        );
    } else if (responseStatus >= 500) {
        error = createAiError(
            "provider_unavailable",
            "The configured AI provider is temporarily unavailable.",
            503
        );
    } else if (responseStatus === 404) {
        error = createAiError(
            "provider_model_not_found",
            `${provider.label} could not find the configured model. Check ${provider.modelEnv}.`,
            502
        );
    } else if (responseStatus === 400 && providerMessage) {
        error = createAiError(
            "provider_request_failed",
            `${provider.label} rejected the request: ${providerMessage}`,
            502
        );
    } else {
        error = createAiError(
            "provider_request_failed",
            `${provider.label} rejected the request (HTTP ${responseStatus}). Check its model configuration.`,
            502
        );
    }

    error.providerStatus = responseStatus;
    error.providerCode = typeof providerError.status === "string"
        ? providerError.status.slice(0, 80)
        : null;
    error.providerMessage = providerMessage || null;
    return error;
}

function analysisSystemPrompt(reportContext, baseline) {
    return [
        "You are BrainGuard AI, an educational explainer for webcam-based eye-assessment measurements.",
        "Use only the verified assessment data and personal baseline supplied below. Never invent values, diagnoses, clinical reference ranges, or history.",
        "Do not diagnose, screen for, rule out, or predict any disease. Do not prescribe treatment or imply the measurements reveal brain activity.",
        "If optional self-reported questionnaire answers are supplied, clearly label them as self-reported context, not measured findings. Describe differences from prior answers neutrally; do not infer clinical improvement, worsening, or a diagnosis.",
        "Describe unusual patterns only as differences within the supplied measurements or compared with a personal baseline that has at least two prior completed sessions for that measurement. If evidence is insufficient, say so plainly.",
        "Use simple, respectful language. Explain what each important value represents and distinguish measured data from interpretation.",
        "For an analysis request, return exactly one JSON object matching the required response schema. Do not add Markdown fences or surrounding prose.",
        '{"summary":"string","keyFindings":[{"title":"string","explanation":"string","evidence":"string"}],"baselineComparisons":[{"assessment":"string","measurement":"string","currentValue":"string","baselineMean":"string","sessions":2,"explanation":"string"}],"nextSteps":["string"],"limitations":"string"}',
        "Use empty arrays when there are no supported findings or comparisons. Include a clear non-diagnostic limitation.",
        `Verified current assessment data: ${JSON.stringify(reportContext)}`,
        `Verified personal baseline data (only measurements with at least two prior sessions are included): ${JSON.stringify(baseline)}`,
    ].join("\n\n");
}

function chatSystemPrompt(reportContext, baseline) {
    return [
        "You are BrainGuard AI, an educational explainer for webcam-based eye-assessment measurements.",
        "Answer the user's follow-up using only the verified assessment data, baseline, and conversation provided.",
        "Never invent values, diagnoses, clinical reference ranges, or history. Do not diagnose, screen for, rule out, or predict a disease. Do not prescribe treatment or imply the measurements reveal brain activity.",
        "If optional self-reported questionnaire answers are supplied, label them as self-reported context and describe differences from prior answers neutrally, without diagnosing or implying clinical improvement or worsening.",
        "Explain uncertainty and data-quality limits. Use clear, respectful language and concise headings when useful.",
        "State that the information is descriptive and not medical advice when relevant.",
        `Verified current assessment data: ${JSON.stringify(reportContext)}`,
        `Verified personal baseline data: ${JSON.stringify(baseline)}`,
    ].join("\n\n");
}

function parseAnalysis(text) {
    const candidate = text.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    let data;
    try {
        data = JSON.parse(candidate);
    } catch {
        let objectStart = -1;
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = 0; index < candidate.length; index += 1) {
            const character = candidate[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') inString = false;
                continue;
            }
            if (character === '"') {
                inString = true;
            } else if (character === "{") {
                if (depth === 0) objectStart = index;
                depth += 1;
            } else if (character === "}" && depth > 0) {
                depth -= 1;
                if (depth === 0) {
                    try {
                        data = JSON.parse(candidate.slice(objectStart, index + 1));
                        break;
                    } catch {
                        objectStart = -1;
                    }
                }
            }
        }
        if (data === undefined) {
            throw createAiError(
                "invalid_provider_response",
                "The AI provider returned an unreadable analysis. Try again.",
                502
            );
        }
    }

    const hasStrings = (items, keys) => Array.isArray(items)
        && items.every(item => item && keys.every(key => typeof item[key] === "string"));
    if (
        !data
        || typeof data.summary !== "string"
        || !hasStrings(data.keyFindings, ["title", "explanation", "evidence"])
        || !hasStrings(
            data.baselineComparisons,
            ["assessment", "measurement", "currentValue", "baselineMean", "explanation"]
        )
        || data.baselineComparisons.some(item =>
            !Number.isInteger(item.sessions) || item.sessions < 2
        )
        || !Array.isArray(data.nextSteps)
        || !data.nextSteps.every(item => typeof item === "string")
        || typeof data.limitations !== "string"
    ) {
        throw createAiError(
            "invalid_provider_response",
            "The AI provider returned an incomplete analysis. Try again.",
            502
        );
    }

    return {
        summary: data.summary.slice(0, 5000),
        keyFindings: data.keyFindings.slice(0, 12).map(item => ({
            title: item.title.slice(0, 160),
            explanation: item.explanation.slice(0, 1200),
            evidence: item.evidence.slice(0, 600),
        })),
        baselineComparisons: data.baselineComparisons.slice(0, 12).map(item => ({
            assessment: item.assessment.slice(0, 120),
            measurement: item.measurement.slice(0, 120),
            currentValue: item.currentValue.slice(0, 100),
            baselineMean: item.baselineMean.slice(0, 100),
            sessions: item.sessions,
            explanation: item.explanation.slice(0, 800),
        })),
        nextSteps: data.nextSteps.slice(0, 8).map(item => item.slice(0, 500)),
        limitations: data.limitations.slice(0, 2000),
    };
}

function extractProviderText(providerId, payload) {
    if (providerId === "gemini") {
        const parts = payload?.candidates?.[0]?.content?.parts;
        return Array.isArray(parts)
            ? parts
                .filter(part => part && part.thought !== true)
                .map(part => typeof part.text === "string" ? part.text : "")
                .join("\n")
                .trim()
            : "";
    }
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : "";
}

async function generateAiResponse(providerId, {
    mode,
    reportContext,
    baseline,
    message,
    history,
}) {
    const provider = PROVIDERS[providerId];
    if (!provider) {
        throw createAiError("unsupported_provider", "Select a supported AI provider.", 400);
    }

    const apiKey = process.env[provider.keyEnv];
    if (!apiKey) {
        throw createAiError(
            "provider_not_configured",
            `${provider.label} is not configured on the server.`,
            503
        );
    }

    const model = process.env[provider.modelEnv] || provider.defaultModel;
    const system = mode === "analysis"
        ? analysisSystemPrompt(reportContext, baseline)
        : chatSystemPrompt(reportContext, baseline);
    const chatHistory = history.map(item => ({
        role: item.role,
        content: item.content,
    }));
    let url;
    let headers;
    let body;

    if (providerId === "gemini") {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
        };
        body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [
                ...chatHistory.map(item => ({
                    role: item.role === "assistant" ? "model" : "user",
                    parts: [{ text: item.content }],
                })),
                { role: "user", parts: [{ text: message }] },
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: mode === "analysis" ? 4096 : 1400,
                ...(mode === "analysis"
                    ? {
                        responseMimeType: "application/json",
                        responseJsonSchema: ANALYSIS_RESPONSE_SCHEMA,
                    }
                    : {}),
            },
        };
    } else {
        url = providerId === "openai"
            ? "https://api.openai.com/v1/chat/completions"
            : "https://api.deepseek.com/chat/completions";
        headers = {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        };
        body = {
            model,
            messages: [
                { role: "system", content: system },
                ...chatHistory,
                { role: "user", content: message },
            ],
            temperature: 0.2,
            max_tokens: 1400,
            ...(providerId === "openai" && mode === "analysis"
                ? { response_format: { type: "json_object" } }
                : {}),
        };
    }

    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
    } catch (error) {
        if (error.name === "TimeoutError" || error.name === "AbortError") {
            throw createAiError(
                "provider_timeout",
                "The AI provider took too long to respond. Try again.",
                504
            );
        }
        throw createAiError(
            "provider_unavailable",
            "Could not connect to the selected AI provider.",
            503
        );
    }

    if (!response.ok) {
        let errorPayload = null;
        try {
            errorPayload = await response.json();
        } catch {
            errorPayload = null;
        }
        throw providerFailure(response.status, providerId, errorPayload, apiKey);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw createAiError(
            "invalid_provider_response",
            "The AI provider returned an unreadable response. Try again.",
            502
        );
    }

    if (
        providerId === "gemini"
        && mode === "analysis"
        && payload?.candidates?.[0]?.finishReason === "MAX_TOKENS"
    ) {
        throw createAiError(
            "provider_output_truncated",
            "Gemini cut off the analysis before completing its structured report. Try again.",
            502
        );
    }

    const text = extractProviderText(providerId, payload);
    if (typeof text !== "string" || !text) {
        throw createAiError(
            "invalid_provider_response",
            "The AI provider returned no analysis. Try again.",
            502
        );
    }

    return mode === "analysis"
        ? { analysis: parseAnalysis(text) }
        : { answer: text.slice(0, 8000) };
}

module.exports = {
    generateAiResponse,
    getConfiguredAiProvider,
};
