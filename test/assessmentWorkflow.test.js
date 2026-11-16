const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ASSESSMENT_STEPS,
    getCompletedTypes,
    getNextAssessment,
} = require("../services/assessmentWorkflow");

test("eye assessments unlock in the required order", () => {
    assert.deepEqual(
        ASSESSMENT_STEPS.map(step => step.type),
        ["saccadic", "smooth_pursuit", "blink_monitoring", "memory_tracking"]
    );
    const completed = new Set();

    for (const step of ASSESSMENT_STEPS) {
        assert.equal(getNextAssessment(completed).type, step.type);
        completed.add(step.type);
    }

    assert.equal(getNextAssessment(completed), null);
});

test("later completed tests do not skip an incomplete earlier test", () => {
    const completed = new Set(["smooth_pursuit", "memory_tracking"]);

    assert.equal(getNextAssessment(completed).type, "saccadic");
});

test("legacy attention results do not count toward the current workflow", () => {
    const completed = getCompletedTypes([
        "attention",
        "smooth_pursuit",
        "memory_tracking",
    ]);

    assert.deepEqual([...completed], ["smooth_pursuit", "memory_tracking"]);
    assert.equal(getNextAssessment(completed).type, "saccadic");
});
