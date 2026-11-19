const assert = require("node:assert/strict");
const test = require("node:test");
const HealthProfile = require("../models/HealthProfile");

const {
    compareQuestionnaireResponses,
    displayFamilyHistory,
    getLegacyProfileFields,
    getQuestionnaireAnswers,
    getVisibleQuestions,
    validateQuestionnaireResponses,
} = require("../services/healthQuestionnaire");

const basicAnswers = {
    age_range: "30_39",
    language: "english",
    education_level: "undergraduate",
    memory_change: "none",
    sleep_duration: "six_seven",
    sleep_quality: "good",
    stress_frequency: "occasionally",
    activity_level: "moderate",
    family_history: "no",
    vision_change: "no",
};

test("follow-up questions appear only for matching selected answers", () => {
    const initial = getVisibleQuestions({});
    assert.ok(initial.some(question => question.id === "memory_change"));
    assert.ok(!initial.some(question => question.id === "memory_onset"));
    assert.ok(!initial.some(question => question.id === "family_conditions"));

    const answers = {
        ...basicAnswers,
        memory_change: ["affecting_daily"],
        family_history: ["yes"],
        vision_change: ["yes"],
    };
    const visibleIds = getVisibleQuestions(answers).map(question => question.id);
    assert.ok(visibleIds.includes("memory_onset"));
    assert.ok(visibleIds.includes("memory_activities"));
    assert.ok(visibleIds.includes("memory_worsening"));
    assert.ok(visibleIds.includes("family_conditions"));
    assert.ok(visibleIds.includes("family_relationship"));
    assert.ok(visibleIds.includes("vision_change_onset"));

    const notSureAnswers = { ...answers, memory_change: ["not_sure"] };
    assert.ok(!getVisibleQuestions(notSureAnswers).some(
        question => question.id.startsWith("memory_") && question.id !== "memory_change"
    ));
});

test("validates complete option answers and accepts prefer-not responses", () => {
    const submitted = {
        ...basicAnswers,
        age_range: "prefer_not",
        memory_change: "prefer_not",
        family_history: "prefer_not",
    };
    const responses = validateQuestionnaireResponses(JSON.stringify(submitted));

    assert.equal(responses.length, Object.keys(basicAnswers).length);
    assert.deepEqual(
        responses.find(response => response.questionId === "family_history").selectedOptions,
        ["prefer_not"]
    );
    assert.deepEqual(
        getQuestionnaireAnswers(responses).find(item => item.questionId === "family_history").answers,
        ["Prefer not to answer"]
    );
});

test("validates conditional and multi-select answers without retaining hidden branches", () => {
    const submitted = {
        ...basicAnswers,
        memory_change: "affecting_daily",
        memory_onset: "one_to_three_months",
        memory_frequency: "several_weekly",
        memory_activities: ["appointments", "household"],
        memory_worsening: "not_sure",
        memory_assistance: "sometimes",
        family_history: "yes",
        family_conditions: ["memory_condition", "neurological_condition"],
        family_relationship: "close_relative",
        vision_change: "yes",
        vision_change_onset: "few_weeks",
    };
    const responses = validateQuestionnaireResponses(submitted);
    assert.ok(responses.some(response => response.questionId === "memory_activities"));
    assert.deepEqual(
        responses.find(response => response.questionId === "family_conditions").selectedOptions,
        ["memory_condition", "neurological_condition"]
    );

    assert.throws(
        () => validateQuestionnaireResponses({
            ...basicAnswers,
            memory_onset: "few_weeks",
        }),
        /no longer apply/
    );
    assert.throws(
        () => validateQuestionnaireResponses({
            ...submitted,
            family_conditions: ["memory_condition", "prefer_not"],
        }),
        /Choose only one response/
    );
});

test("maps selectable profile values without inventing exact measurements", () => {
    const responses = validateQuestionnaireResponses({
        ...basicAnswers,
        age_range: "40_49",
        sleep_duration: "eight_nine",
        activity_level: "light",
        stress_frequency: "frequently",
        family_history: "not_sure",
    });
    const profile = getLegacyProfileFields(responses);

    assert.equal(profile.ageRange, "40–49");
    assert.equal(profile.age, undefined);
    assert.equal(profile.sleepDuration, "8–9 hours");
    assert.equal(profile.sleepHours, undefined);
    assert.equal(profile.activityLevel, "Light activity");
    assert.equal(profile.exerciseMinutes, undefined);
    assert.equal(profile.stressFrequency, "Frequently");
    assert.equal(profile.familyHistory, "unknown");
    assert.equal(displayFamilyHistory(profile.familyHistory), "Not sure");
    assert.equal(profile.responses.length, responses.length);
});

test("stores structured responses on a valid per-assessment health profile", async () => {
    const responses = validateQuestionnaireResponses(basicAnswers);
    const profile = new HealthProfile({
        assessmentId: new HealthProfile.base.Types.ObjectId(),
        ...getLegacyProfileFields(responses),
    });

    await assert.doesNotReject(profile.validate());
    assert.equal(profile.responses[0].questionId, "age_range");
    assert.deepEqual(profile.responses[0].selectedOptions, ["30_39"]);
});

test("compares only answers shared with the previous questionnaire session", () => {
    const previous = validateQuestionnaireResponses({
        ...basicAnswers,
        memory_change: "occasional",
        memory_onset: "over_six_months",
    });
    const current = validateQuestionnaireResponses({
        ...basicAnswers,
        memory_change: "frequent",
        memory_onset: "few_weeks",
        memory_frequency: "weekly",
    });
    const changes = compareQuestionnaireResponses(current, previous);

    assert.deepEqual(changes.map(change => change.questionId), [
        "memory_change",
        "memory_onset",
    ]);
    assert.deepEqual(changes[0].previous, ["I occasionally forget things"]);
    assert.deepEqual(changes[0].current, ["I frequently forget things"]);
    assert.ok(!changes.some(change => change.questionId === "memory_frequency"));
});
