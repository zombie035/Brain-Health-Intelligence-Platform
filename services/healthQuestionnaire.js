const QUESTIONNAIRE_VERSION = 1;

const QUESTIONNAIRE = [
    {
        id: "age_range",
        prompt: "Which age range best describes you?",
        type: "single",
        options: [
            { value: "18_29", label: "18–29" },
            { value: "30_39", label: "30–39" },
            { value: "40_49", label: "40–49" },
            { value: "50_59", label: "50–59" },
            { value: "60_69", label: "60–69" },
            { value: "70_plus", label: "70 or older" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "language",
        prompt: "Which language do you prefer? The questionnaire is currently displayed in English.",
        type: "single",
        options: ["English", "Arabic", "Tamil", "Hindi", "Other"]
            .map(label => ({ value: label.toLowerCase(), label })),
    },
    {
        id: "education_level",
        prompt: "What is the highest level of education you completed?",
        type: "single",
        options: [
            { value: "school", label: "School" },
            { value: "undergraduate", label: "Undergraduate" },
            { value: "postgraduate", label: "Postgraduate" },
            { value: "other", label: "Another level" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "memory_change",
        prompt: "Have you noticed any changes in your memory recently?",
        type: "single",
        options: [
            { value: "none", label: "No noticeable changes" },
            { value: "occasional", label: "I occasionally forget things" },
            { value: "frequent", label: "I frequently forget things" },
            {
                value: "affecting_daily",
                label: "Memory difficulties affect my daily activities",
            },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "memory_onset",
        prompt: "When did you first notice these memory changes?",
        type: "single",
        when: {
            questionId: "memory_change",
            values: ["occasional", "frequent", "affecting_daily"],
        },
        options: [
            { value: "few_weeks", label: "Within the past few weeks" },
            { value: "one_to_three_months", label: "1–3 months ago" },
            { value: "three_to_six_months", label: "3–6 months ago" },
            { value: "over_six_months", label: "More than 6 months ago" },
            { value: "long_time", label: "I have experienced this for a long time" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "memory_frequency",
        prompt: "How often do these memory changes happen?",
        type: "single",
        when: {
            questionId: "memory_change",
            values: ["frequent", "affecting_daily"],
        },
        options: [
            { value: "less_than_weekly", label: "Less than once a week" },
            { value: "weekly", label: "About once a week" },
            { value: "several_weekly", label: "Several times a week" },
            { value: "daily", label: "Almost every day" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "memory_activities",
        prompt: "Which activities are affected?",
        type: "multiple",
        when: {
            questionId: "memory_change",
            values: ["affecting_daily"],
        },
        exclusiveOptions: ["prefer_not"],
        options: [
            { value: "appointments", label: "Remembering appointments" },
            { value: "household", label: "Household tasks" },
            { value: "work_study", label: "Work or study" },
            { value: "finances", label: "Managing money or bills" },
            { value: "personal_care", label: "Personal care" },
            { value: "social", label: "Social activities" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "memory_worsening",
        prompt: "Have these memory changes become more noticeable over time?",
        type: "single",
        when: {
            questionId: "memory_change",
            values: ["affecting_daily"],
        },
        options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "memory_assistance",
        prompt: "Do you need help with activities because of these memory changes?",
        type: "single",
        when: {
            questionId: "memory_change",
            values: ["affecting_daily"],
        },
        options: [
            { value: "no", label: "No" },
            { value: "sometimes", label: "Sometimes" },
            { value: "often", label: "Often" },
            { value: "yes", label: "Yes, regularly" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "sleep_duration",
        prompt: "How many hours do you usually sleep each night?",
        type: "single",
        options: [
            { value: "under_four", label: "Less than 4 hours" },
            { value: "four_five", label: "4–5 hours" },
            { value: "six_seven", label: "6–7 hours" },
            { value: "eight_nine", label: "8–9 hours" },
            { value: "over_nine", label: "More than 9 hours" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "sleep_quality",
        prompt: "How would you describe your sleep quality?",
        type: "single",
        options: [
            { value: "very_good", label: "Very good" },
            { value: "good", label: "Good" },
            { value: "average", label: "Average" },
            { value: "poor", label: "Poor" },
            { value: "very_poor", label: "Very poor" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "stress_frequency",
        prompt: "How often do you experience stress?",
        type: "single",
        options: [
            { value: "rarely", label: "Rarely" },
            { value: "occasionally", label: "Occasionally" },
            { value: "frequently", label: "Frequently" },
            { value: "almost_daily", label: "Almost every day" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "activity_level",
        prompt: "How physically active are you during a typical week?",
        type: "single",
        options: [
            { value: "very_little", label: "Very little activity" },
            { value: "light", label: "Light activity" },
            { value: "moderate", label: "Moderate activity" },
            { value: "high", label: "Highly active" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "family_history",
        prompt: "Is there a history of cognitive or neurological conditions in your family?",
        type: "single",
        options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "family_conditions",
        prompt: "Which conditions have affected a family member?",
        type: "multiple",
        when: { questionId: "family_history", values: ["yes"] },
        exclusiveOptions: ["not_sure", "prefer_not"],
        options: [
            { value: "memory_condition", label: "Memory or cognitive condition" },
            { value: "neurological_condition", label: "Neurological condition" },
            { value: "other_condition", label: "Another condition" },
            { value: "not_sure", label: "Not sure which condition" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "family_relationship",
        prompt: "How closely related is the family member?",
        type: "single",
        when: { questionId: "family_history", values: ["yes"] },
        options: [
            { value: "close_relative", label: "Parent, sibling, or child" },
            { value: "other_relative", label: "Another relative" },
            { value: "more_than_one", label: "More than one relative" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "vision_change",
        prompt: "Have you noticed a change in your vision recently?",
        type: "single",
        options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
    {
        id: "vision_change_onset",
        prompt: "When did you first notice this vision change?",
        type: "single",
        when: { questionId: "vision_change", values: ["yes"] },
        options: [
            { value: "few_days", label: "Within the past few days" },
            { value: "few_weeks", label: "Within the past few weeks" },
            { value: "one_to_six_months", label: "1–6 months ago" },
            { value: "over_six_months", label: "More than 6 months ago" },
            { value: "not_sure", label: "Not sure" },
            { value: "prefer_not", label: "Prefer not to answer" },
        ],
    },
];

const questionsById = new Map(QUESTIONNAIRE.map(question => [question.id, question]));

function responseMap(responses) {
    if (Array.isArray(responses)) {
        return Object.fromEntries(responses.map(response => [
            response.questionId,
            response.selectedOptions,
        ]));
    }
    return responses || {};
}

function getVisibleQuestions(responses = {}) {
    const answers = responseMap(responses);
    return QUESTIONNAIRE.filter(question => {
        if (!question.when) return true;
        const selected = answers[question.when.questionId];
        return Array.isArray(selected)
            && selected.some(value => question.when.values.includes(value));
    });
}

function validateQuestionnaireResponses(input) {
    let submitted = input;
    if (typeof submitted === "string") {
        try {
            submitted = JSON.parse(submitted);
        } catch {
            throw new Error("The questionnaire answers could not be read. Please try again.");
        }
    }
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
        throw new Error("Complete the questionnaire before continuing.");
    }

    const answers = {};
    for (const [questionId, rawSelection] of Object.entries(submitted)) {
        const question = questionsById.get(questionId);
        if (!question) {
            throw new Error("The questionnaire contains an unsupported question.");
        }
        const selections = Array.isArray(rawSelection) ? rawSelection : [rawSelection];
        if (
            selections.length === 0
            || (question.type === "single" && selections.length !== 1)
            || selections.some(value =>
                typeof value !== "string"
                || !question.options.some(option => option.value === value)
            )
            || new Set(selections).size !== selections.length
        ) {
            throw new Error(`Select a valid answer for: ${question.prompt}`);
        }
        if (
            question.exclusiveOptions
            && selections.some(value => question.exclusiveOptions.includes(value))
            && selections.length > 1
        ) {
            throw new Error(`Choose only one response for: ${question.prompt}`);
        }
        answers[questionId] = selections;
    }

    const visibleQuestions = getVisibleQuestions(answers);
    const visibleIds = new Set(visibleQuestions.map(question => question.id));
    for (const question of visibleQuestions) {
        if (!answers[question.id]) {
            throw new Error(`Complete the question: ${question.prompt}`);
        }
    }
    if (Object.keys(answers).some(questionId => !visibleIds.has(questionId))) {
        throw new Error("Some answers no longer apply. Review the questionnaire and try again.");
    }

    return visibleQuestions.map(question => ({
        questionId: question.id,
        selectedOptions: answers[question.id],
    }));
}

function getQuestionnaireAnswers(responses = []) {
    return responses.map(response => {
        const question = questionsById.get(response.questionId);
        if (!question) return null;
        const selected = new Set(response.selectedOptions);
        return {
            questionId: question.id,
            question: question.prompt,
            answerIds: response.selectedOptions,
            answers: question.options
                .filter(option => selected.has(option.value))
                .map(option => option.label),
        };
    }).filter(Boolean);
}

function compareQuestionnaireResponses(currentResponses = [], previousResponses = []) {
    const previousById = new Map(previousResponses.map(response => [
        response.questionId,
        response.selectedOptions,
    ]));
    return currentResponses.flatMap(response => {
        const previous = previousById.get(response.questionId);
        if (!previous) return [];
        const currentAnswers = getQuestionnaireAnswers([response])[0];
        const previousAnswers = getQuestionnaireAnswers([{
            questionId: response.questionId,
            selectedOptions: previous,
        }])[0];
        if (
            JSON.stringify([...response.selectedOptions].sort())
            === JSON.stringify([...previous].sort())
        ) {
            return [];
        }
        return [{
            questionId: response.questionId,
            question: currentAnswers.question,
            current: currentAnswers.answers,
            previous: previousAnswers.answers,
        }];
    });
}

function getLegacyProfileFields(responses) {
    const answers = responseMap(responses);
    const first = questionId => answers[questionId]?.[0];
    const optionLabel = (questionId, value) =>
        questionsById.get(questionId)?.options
            .find(option => option.value === value)?.label;
    const familyHistory = first("family_history");

    return {
        ageRange: optionLabel("age_range", first("age_range")),
        language: optionLabel("language", first("language")),
        educationLevel: optionLabel("education_level", first("education_level")),
        sleepDuration: optionLabel("sleep_duration", first("sleep_duration")),
        activityLevel: optionLabel("activity_level", first("activity_level")),
        stressFrequency: optionLabel("stress_frequency", first("stress_frequency")),
        familyHistory: familyHistory === "not_sure"
            ? "unknown"
            : familyHistory || "unknown",
        questionnaireVersion: QUESTIONNAIRE_VERSION,
        responses,
    };
}

function displayFamilyHistory(value) {
    return {
        yes: "Yes",
        no: "No",
        unknown: "Not sure",
        prefer_not: "Prefer not to answer",
    }[value] || "Not recorded";
}

module.exports = {
    QUESTIONNAIRE,
    QUESTIONNAIRE_VERSION,
    compareQuestionnaireResponses,
    displayFamilyHistory,
    getLegacyProfileFields,
    getQuestionnaireAnswers,
    getVisibleQuestions,
    validateQuestionnaireResponses,
};
