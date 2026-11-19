(() => {
    const root = document.getElementById("eyeReportChatbot");
    const initialDataElement = document.getElementById("eyeAiInitialData");
    const shareForm = document.getElementById("doctorShareForm");
    if (!root || !initialDataElement || !shareForm) return;

    const consent = document.getElementById("eyeAiConsent");
    const healthConsent = document.getElementById("eyeAiHealthConsent");
    const analyzeButton = document.getElementById("eyeAiAnalyze");
    const demoButton = document.getElementById("eyeAiDemo");
    const demoStatus = document.getElementById("eyeAiDemoStatus");
    const demoPreview = document.getElementById("eyeAiDemoPreview");
    const status = document.getElementById("eyeAiStatus");
    const chatHint = document.querySelector(".eye-ai-chat-hint");
    const analysisElement = document.getElementById("eyeAiAnalysis");
    const conversation = document.getElementById("eyeAiConversation");
    const chatForm = document.getElementById("eyeAiChatForm");
    const messageInput = document.getElementById("eyeAiMessage");
    const sendButton = document.getElementById("eyeAiSend");
    const shareConsent = document.getElementById("doctorShareConsent");
    const doctorEmail = document.getElementById("doctorEmail");
    const shareStatus = document.getElementById("doctorShareStatus");
    let analysis;
    let history = [];
    let busy = false;

    try {
        analysis = JSON.parse(initialDataElement.textContent || "null");
    } catch (error) {
        console.error("Could not read the saved AI report analysis:", error);
        status.textContent = "The saved AI analysis could not be loaded.";
    }

    const configuredProvider = () => Boolean(root.dataset.aiProvider);

    demoButton.addEventListener("click", () => {
        demoButton.disabled = true;
        demoPreview.hidden = true;
        demoStatus.textContent = "Preparing a sample message. This is not analyzing your results…";

        window.setTimeout(() => {
            const label = document.createElement("strong");
            label.className = "eye-ai-demo-label";
            label.textContent = "SAMPLE PREVIEW — NOT AN AI ANALYSIS";
            const heading = document.createElement("h3");
            heading.textContent = "Nice work completing your assessment";
            const message = document.createElement("p");
            message.textContent = "You completed all four eye-assessment activities, and your report is ready to review.";
            const limitation = document.createElement("p");
            limitation.textContent = "This sample does not analyze your measurements or indicate whether results are normal. It is not a medical assessment.";
            demoPreview.replaceChildren(label, heading, message, limitation);
            demoPreview.hidden = false;
            demoStatus.textContent = "Sample ready. No AI request was made and nothing was saved.";
            demoButton.disabled = false;
        }, 10000);
    });

    function updateControls() {
        const enabled = consent.checked && configuredProvider() && !busy;
        analyzeButton.disabled = !enabled;
        const healthContextUnavailable = Boolean(
            analysis?.includesQuestionnaire && !healthConsent.checked
        );
        messageInput.disabled = !enabled || !analysis || healthContextUnavailable;
        sendButton.disabled = !enabled || !analysis || healthContextUnavailable;
        if (chatHint) {
            chatHint.hidden = false;
            if (healthContextUnavailable) {
                chatHint.textContent = "Regenerate the analysis with questionnaire consent off before continuing without those answers.";
            } else if (analysis) {
                chatHint.hidden = true;
            } else {
                chatHint.textContent = "Generate an interpretation before asking follow-up questions.";
            }
        }
    }

    function formatAnalysis(value) {
        const findings = (value.keyFindings || []).map(item =>
            `${item.title}: ${item.explanation} ${item.evidence}`.trim()
        );
        const comparisons = (value.baselineComparisons || []).map(item =>
            `${item.assessment} · ${item.measurement}: current ${item.currentValue}, personal mean ${item.baselineMean} across ${item.sessions} sessions. ${item.explanation}`
        );
        return [
            `Summary\n${value.summary}`,
            `Key findings\n${findings.length ? findings.join("\n") : "No additional supported findings."}`,
            `Personal baseline\n${value.baselineAvailable
                ? (comparisons.length ? comparisons.join("\n") : "No comparable measurements were identified.")
                : "There is not enough history to establish an eye-measurement baseline."}`,
            `Suggested next steps\n${(value.nextSteps || []).join("\n") || "No specific next steps were generated."}`,
            `Limitations\n${value.limitations}`,
        ].join("\n\n").slice(0, 6000);
    }

    function addMessage(role, text) {
        const article = document.createElement("article");
        article.className = `eye-ai-message eye-ai-message-${role}`;
        const label = document.createElement("strong");
        label.textContent = role === "user" ? "You" : "BrainGuard AI";
        const body = document.createElement("p");
        body.textContent = text;
        article.append(label, body);
        conversation.append(article);
        article.scrollIntoView({ block: "nearest" });
    }

    function renderAnalysis(value) {
        analysisElement.replaceChildren();

        const heading = document.createElement("h3");
        heading.textContent = "AI-generated interpretation";
        analysisElement.append(heading);

        const summary = document.createElement("p");
        summary.textContent = value.summary;
        analysisElement.append(summary);

        if (!value.baselineAvailable) {
            const note = document.createElement("p");
            note.textContent = "No eye-measurement baseline could be established; at least two prior completed sessions per measurement are required.";
            analysisElement.append(note);
        }

        const appendList = (title, items, renderItem) => {
            if (!items.length) return;
            const listHeading = document.createElement("h4");
            listHeading.textContent = title;
            const list = document.createElement("ul");
            items.forEach(item => {
                const listItem = document.createElement("li");
                listItem.textContent = renderItem(item);
                list.append(listItem);
            });
            analysisElement.append(listHeading, list);
        };

        appendList("Key findings", value.keyFindings || [], item =>
            `${item.title}: ${item.explanation} ${item.evidence}`.trim()
        );
        appendList("Personal baseline", value.baselineComparisons || [], item =>
            `${item.assessment} · ${item.measurement}: current ${item.currentValue}, personal mean ${item.baselineMean} across ${item.sessions} sessions. ${item.explanation}`
        );
        appendList("Suggested next steps", value.nextSteps || [], item => item);

        const limitationsHeading = document.createElement("h4");
        limitationsHeading.textContent = "Limitations";
        const limitations = document.createElement("p");
        limitations.textContent = value.limitations;
        const disclaimer = document.createElement("p");
        disclaimer.className = "disclaimer";
        disclaimer.textContent = "This AI-generated interpretation is informational and is not a medical diagnosis or professional medical advice.";
        analysisElement.append(limitationsHeading, limitations, disclaimer);
    }

    async function requestAi(mode, message) {
        if (!consent.checked || !configuredProvider()) {
            status.textContent = !configuredProvider()
                ? "Configure an AI provider on the server to enable the assistant."
                : "Give consent before requesting AI analysis.";
            return null;
        }
        if (
            mode === "chat"
            && analysis?.includesQuestionnaire
            && !healthConsent.checked
        ) {
            status.textContent = "Regenerate the analysis without questionnaire answers before continuing without that data.";
            return null;
        }

        busy = true;
        root.classList.add("is-thinking");
        root.setAttribute("aria-busy", "true");
        status.textContent = mode === "analysis"
            ? "Analyzing the completed measurements…"
            : "Preparing an answer…";
        updateControls();

        try {
            const response = await fetch(root.dataset.aiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode,
                    message,
                    history: mode === "analysis" ? [] : history,
                    consent: consent.checked,
                    includeHealthProfile: healthConsent.checked,
                }),
            });
            let result;
            try {
                result = await response.json();
            } catch {
                throw new Error("The server returned an unreadable response. Please try again.");
            }
            if (!response.ok || !result.success) {
                throw new Error(result.message || "The AI request failed. Please try again.");
            }

            if (mode === "analysis") {
                analysis = result.analysis;
                renderAnalysis(analysis);
                conversation.replaceChildren();
                history = [
                    { role: "user", content: message },
                    { role: "assistant", content: formatAnalysis(analysis) },
                ];
                status.textContent = `Analysis saved using ${root.dataset.aiProviderLabel}.`;
            } else {
                history.push(
                    { role: "user", content: message },
                    { role: "assistant", content: result.answer }
                );
                history = history.slice(-6);
                while (history.length && history[0].role !== "user") history.shift();
                addMessage("user", message);
                addMessage("assistant", result.answer);
                status.textContent = "Answer ready.";
            }
            return result;
        } catch (error) {
            status.textContent = error.message || "The AI request failed. Please try again.";
            return null;
        } finally {
            busy = false;
            root.classList.remove("is-thinking");
            root.setAttribute("aria-busy", "false");
            updateControls();
        }
    }

    analyzeButton.addEventListener("click", async () => {
        const prompt = "Interpret the four completed eye-assessment results in plain language. Explain supported measurements, data-quality limitations, and personal-baseline changes when sufficient history exists.";
        await requestAi("analysis", prompt);
    });

    chatForm.addEventListener("submit", async event => {
        event.preventDefault();
        const message = messageInput.value.trim();
        if (!message) return;
        const result = await requestAi("chat", message);
        if (result) messageInput.value = "";
    });

    consent.addEventListener("change", updateControls);
    healthConsent.addEventListener("change", updateControls);

    if (analysis) {
        history = [
            {
                role: "user",
                content: "Interpret the four completed eye-assessment results in plain language.",
            },
            { role: "assistant", content: formatAnalysis(analysis) },
        ];
    }
    updateControls();

    shareForm.addEventListener("submit", event => {
        event.preventDefault();
        if (!shareConsent.checked || !doctorEmail.validity.valid) {
            shareStatus.textContent = "Enter a valid email address and approve sharing before continuing.";
            return;
        }

        const downloadUrl = root.dataset.downloadUrl;
        if (!downloadUrl) {
            shareStatus.textContent = "The report download link is unavailable.";
            return;
        }

        const downloadLink = document.createElement("a");
        downloadLink.href = downloadUrl;
        downloadLink.download = "BrainGuard-eye-assessment-report.pdf";
        downloadLink.hidden = true;
        document.body.append(downloadLink);
        downloadLink.click();
        downloadLink.remove();

        const subject = "BrainGuard AI eye assessment report";
        const body = [
            "Hello,",
            "",
            "I am sharing my BrainGuard AI eye assessment report for your review.",
            "I have attached the report PDF.",
            "",
            "The report contains experimental measurements and is not a medical diagnosis.",
        ].join("\n");
        const mailto = `mailto:${encodeURIComponent(doctorEmail.value.trim()).replace(/%40/gi, "@")}`
            + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        shareStatus.textContent = "Your email draft is ready. Review it, attach the downloaded PDF, and send it only if you choose.";
        window.location.href = mailto;
    });
})();
