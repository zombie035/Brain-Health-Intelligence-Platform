const assert = require("node:assert/strict");
const test = require("node:test");

const createEyeAssessmentPdf = require("../services/eyeAssessmentPdf");

test("creates a multipage-ready PDF for all completed eye assessments", async () => {
    const pdf = createEyeAssessmentPdf({
        assessment: { name: "Test participant" },
        healthProfile: {
            age: 30,
            language: "English",
            educationLevel: "College",
            sleepHours: 7,
            exerciseMinutes: 30,
            stressLevel: 2,
            familyHistory: "None",
        },
        questionnaireAnswers: [{
            questionId: "sleep_quality",
            question: "How would you describe your sleep quality?",
            answers: ["Good"],
        }],
        questionnaireChanges: [{
            questionId: "sleep_quality",
            question: "How would you describe your sleep quality?",
            previous: ["Average"],
            current: ["Good"],
        }],
        previousQuestionnaireDate: new Date("2025-12-01T10:00:00Z"),
        reportSections: [
            {
                number: "01",
                type: "saccadic",
                title: "Saccadic Eye Movement Test",
                sessionId: "saccadic-session",
                startedAt: new Date("2026-01-01T10:00:00Z"),
                durationSeconds: 60,
                measurements: [{ label: "Total Samples", value: 100 }],
                calibration: [{ label: "Available", value: true }],
                quality: [{ label: "Valid Sample Fraction", value: 0.9 }],
                qualityNotes: Array.from(
                    { length: 80 },
                    (_, index) => `Tracking note ${index + 1}: sample-quality context is preserved.`,
                ),
                observations: ["Example observation."],
                samples: [
                    { timeSeconds: 1, xPx: 100, yPx: 80, targetXPx: 110, valid: true },
                    { timeSeconds: 2, xPx: 110, yPx: 90, targetXPx: 120, valid: true },
                ],
            },
            ...[
                { type: "smooth_pursuit", title: "Smooth Pursuit Test" },
                { type: "blink_monitoring", title: "Blink Monitoring Test" },
                { type: "memory_tracking", title: "Memory Tracking Test" },
            ].map(({ type, title }, index) => ({
                    number: String(index + 2).padStart(2, "0"),
                    type,
                    title,
                    sessionId: `session-${index + 2}`,
                    startedAt: new Date("2026-01-01T10:00:00Z"),
                    durationSeconds: 60,
                    measurements: [],
                    calibration: [],
                    quality: [],
                    qualityNotes: [],
                    observations: [],
                    samples: type === "blink_monitoring"
                        ? [
                            { timeSeconds: 1, leftEAR: 0.3, rightEAR: 0.31, avgEAR: 0.305 },
                            { timeSeconds: 2, leftEAR: 0.28, rightEAR: 0.29, avgEAR: 0.285 },
                        ]
                        : [],
                })),
        ],
        heatmaps: [{
            stimulus: "sample-image.jpg",
            sampleCount: 20,
            heatmapFilename: "not-present.png",
            createdAt: new Date("2026-01-01T10:00:00Z"),
        }],
        aiAnalysis: {
            provider: "openai",
            updatedAt: new Date("2026-01-01T11:00:00Z"),
            summary: "The measurements are descriptive and have data-quality limits.",
            baselineAvailable: false,
            keyFindings: [{
                title: "Tracking quality",
                explanation: "Some recorded samples were valid.",
                evidence: "Based on the saved sample-quality measures.",
            }],
            baselineComparisons: [],
            nextSteps: ["Discuss concerns with a qualified healthcare professional."],
            limitations: "This is not a diagnosis.",
        },
    });
    const chunks = [];
    const completed = new Promise((resolve, reject) => {
        pdf.on("data", chunk => chunks.push(chunk));
        pdf.on("end", () => resolve(Buffer.concat(chunks)));
        pdf.on("error", reject);
    });

    assert.equal(pdf.info.Title, "Consolidated Eye Assessment Report");
    pdf.end();
    const output = await completed;

    assert.equal(output.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(output.length > 1000);
    assert.ok(output.toString("latin1").includes("%%EOF"));
    assert.ok((output.toString("latin1").match(/\/Type \/Page\b/g) || []).length > 1);
});
