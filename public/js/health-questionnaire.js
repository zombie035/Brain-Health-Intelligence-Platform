(() => {
    const form = document.getElementById("healthQuestionnaireForm");
    const dataElement = document.getElementById("healthQuestionnaireData");
    if (!form || !dataElement) return;

    const content = document.getElementById("healthQuestionContent");
    const count = document.getElementById("healthQuestionCount");
    const progress = document.getElementById("healthQuestionProgress");
    const progressPercent = document.getElementById("healthProgressPercent");
    const errorMessage = document.getElementById("healthQuestionError");
    const previousButton = document.getElementById("healthPrevious");
    const nextButton = document.getElementById("healthNext");
    const submitButton = document.getElementById("healthSubmit");
    const responseInput = document.getElementById("questionnaireResponses");

    let questions;
    try {
        questions = JSON.parse(dataElement.textContent);
    } catch (error) {
        console.error("Could not load the health questionnaire:", error);
        errorMessage.textContent = "The questionnaire could not be loaded. Refresh the page to try again.";
        errorMessage.hidden = false;
        nextButton.disabled = true;
        return;
    }

    const answers = {};
    let currentQuestionId = questions[0]?.id;
    let isReviewing = false;

    function visibleQuestions() {
        return questions.filter(question => {
            if (!question.when) return true;
            const parentAnswers = answers[question.when.questionId] || [];
            return parentAnswers.some(value => question.when.values.includes(value));
        });
    }

    function removeHiddenAnswers() {
        const visibleIds = new Set(visibleQuestions().map(question => question.id));
        Object.keys(answers).forEach(questionId => {
            if (!visibleIds.has(questionId)) delete answers[questionId];
        });
    }

    function setProgress(questionIndex, questionCount) {
        const percentage = questionCount
            ? Math.round((questionIndex / questionCount) * 100)
            : 0;
        progress.value = percentage;
        progressPercent.textContent = `${percentage}% complete`;
    }

    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.hidden = false;
    }

    function clearError() {
        errorMessage.textContent = "";
        errorMessage.hidden = true;
    }

    function createOption(question, option, selectedValues) {
        const label = document.createElement("label");
        label.className = "health-option";
        const input = document.createElement("input");
        input.type = question.type === "multiple" ? "checkbox" : "radio";
        input.name = `answer-${question.id}`;
        input.value = option.value;
        input.checked = selectedValues.includes(option.value);
        const text = document.createElement("span");
        text.textContent = option.label;
        label.classList.toggle("is-selected", input.checked);
        label.append(input, text);

        input.addEventListener("change", () => {
            const selected = answers[question.id] || [];
            if (question.type === "single") {
                answers[question.id] = [option.value];
            } else if (input.checked) {
                answers[question.id] = question.exclusiveOptions?.includes(option.value)
                    ? [option.value]
                    : [...selected, option.value];
            } else {
                answers[question.id] = selected.filter(value => value !== option.value);
            }
            removeHiddenAnswers();
            refreshOptionSelection(question);
            refreshQuestionProgress();
            clearError();
        });
        return label;
    }

    function refreshOptionSelection(question) {
        const selectedValues = answers[question.id] || [];
        content.querySelectorAll(".health-option").forEach(optionLabel => {
            const input = optionLabel.querySelector("input");
            input.checked = selectedValues.includes(input.value);
            optionLabel.classList.toggle("is-selected", input.checked);
            if (question.type === "multiple") {
                const exclusive = question.exclusiveOptions || [];
                const exclusiveSelected = selectedValues.some(value => exclusive.includes(value));
                const selectedIsExclusive = exclusive.includes(input.value);
                input.disabled = exclusiveSelected
                    ? !selectedIsExclusive
                    : selectedValues.some(value => exclusive.includes(value));
            }
        });
    }

    function refreshQuestionProgress() {
        const visible = visibleQuestions();
        const index = visible.findIndex(question => question.id === currentQuestionId);
        const completedCount = visible.filter(question =>
            answers[question.id]?.length
        ).length;
        const percentage = visible.length
            ? Math.round((completedCount / visible.length) * 100)
            : 0;
        progress.value = percentage;
        progressPercent.textContent = `${percentage}% complete`;
        count.textContent = index >= 0
            ? `Question ${index + 1} of ${visible.length}`
            : "Questionnaire";
    }

    function renderQuestion() {
        removeHiddenAnswers();
        const visible = visibleQuestions();
        const questionIndex = visible.findIndex(question => question.id === currentQuestionId);
        if (questionIndex < 0) {
            currentQuestionId = visible[0]?.id;
            isReviewing = false;
            return renderQuestion();
        }

        const question = visible[questionIndex];
        const selectedValues = answers[question.id] || [];
        const fieldset = document.createElement("fieldset");
        fieldset.className = "health-question-fieldset";
        const legend = document.createElement("legend");
        legend.id = "healthQuestionTitle";
        legend.tabIndex = -1;
        legend.textContent = question.prompt;
        fieldset.append(legend);

        if (question.type === "multiple") {
            const hint = document.createElement("p");
            hint.className = "health-question-hint";
            hint.textContent = "Select all that apply.";
            fieldset.append(hint);
        }

        const options = document.createElement("div");
        options.className = "health-options";
        question.options.forEach(option => {
            options.append(createOption(question, option, selectedValues));
        });
        fieldset.append(options);

        content.replaceChildren(fieldset);
        refreshOptionSelection(question);
        content.classList.remove("health-question-enter");
        void content.offsetWidth;
        content.classList.add("health-question-enter");
        count.textContent = `Question ${questionIndex + 1} of ${visible.length}`;
        refreshQuestionProgress();
        previousButton.hidden = questionIndex === 0;
        nextButton.hidden = false;
        submitButton.hidden = true;
        isReviewing = false;
        clearError();
        legend.focus?.();
    }

    function renderReview() {
        removeHiddenAnswers();
        const visible = visibleQuestions();
        const heading = document.createElement("h2");
        heading.id = "healthQuestionTitle";
        heading.tabIndex = -1;
        heading.textContent = "Review your answers";
        const intro = document.createElement("p");
        intro.className = "health-question-hint";
        intro.textContent = "Change an answer if needed, or save to continue to the eye assessments.";
        const list = document.createElement("div");
        list.className = "health-answer-review";

        visible.forEach(question => {
            const item = document.createElement("article");
            item.className = "health-answer-review-item";
            const prompt = document.createElement("h3");
            prompt.textContent = question.prompt;
            const selected = new Set(answers[question.id] || []);
            const answer = document.createElement("p");
            answer.textContent = question.options
                .filter(option => selected.has(option.value))
                .map(option => option.label)
                .join(", ");
            const changeButton = document.createElement("button");
            changeButton.type = "button";
            changeButton.className = "health-change-answer";
            changeButton.textContent = "Change";
            changeButton.setAttribute("aria-label", `Change answer: ${question.prompt}`);
            changeButton.addEventListener("click", () => {
                currentQuestionId = question.id;
                renderQuestion();
                document.getElementById("healthQuestionTitle").focus();
            });
            item.append(prompt, answer, changeButton);
            list.append(item);
        });

        content.replaceChildren(heading, intro, list);
        content.classList.remove("health-question-enter");
        void content.offsetWidth;
        content.classList.add("health-question-enter");
        count.textContent = "Review your answers";
        setProgress(visible.length, visible.length);
        previousButton.hidden = false;
        nextButton.hidden = true;
        submitButton.hidden = false;
        isReviewing = true;
        clearError();
        heading.focus();
    }

    nextButton.addEventListener("click", () => {
        const visible = visibleQuestions();
        const question = visible.find(item => item.id === currentQuestionId);
        if (!question || !answers[question.id]?.length) {
            showError("Choose an answer to continue.");
            return;
        }
        const index = visible.findIndex(item => item.id === currentQuestionId);
        if (index >= visible.length - 1) {
            renderReview();
            return;
        }
        currentQuestionId = visible[index + 1].id;
        renderQuestion();
        document.getElementById("healthQuestionTitle").focus();
    });

    previousButton.addEventListener("click", () => {
        if (isReviewing) {
            const visible = visibleQuestions();
            currentQuestionId = visible[visible.length - 1]?.id;
            renderQuestion();
            document.getElementById("healthQuestionTitle").focus();
            return;
        }
        const visible = visibleQuestions();
        const index = visible.findIndex(item => item.id === currentQuestionId);
        if (index > 0) {
            currentQuestionId = visible[index - 1].id;
            renderQuestion();
            document.getElementById("healthQuestionTitle").focus();
        }
    });

    form.addEventListener("submit", event => {
        if (!isReviewing) {
            event.preventDefault();
            showError("Review your selected answers before continuing.");
            return;
        }
        const visible = visibleQuestions();
        const missing = visible.find(question => !answers[question.id]?.length);
        if (missing) {
            event.preventDefault();
            currentQuestionId = missing.id;
            renderQuestion();
            showError("Choose an answer to continue.");
            return;
        }
        responseInput.value = JSON.stringify(answers);
        submitButton.disabled = true;
        submitButton.textContent = "Saving your answers…";
    });

    renderQuestion();
})();
