const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");
const { displayFamilyHistory } = require("./healthQuestionnaire");

const PAGE_MARGIN = 52;
const FOOTER_SPACE = 48;
const HEATMAP_DIR = path.resolve(__dirname, "..", "GazeMap", "heatmaps");

function displayValue(value) {
    if (value === null || value === undefined || value === "") {
        return "Not recorded";
    }
    return String(value);
}

function displayDate(value) {
    if (!value) return "Unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? "Unavailable"
        : date.toLocaleString("en-IN");
}

function ensureSpace(document, height) {
    const bottom = document.page.height - document.page.margins.bottom;
    if (document.y + height > bottom) {
        document.addPage();
    }
}

function addHeading(document, text, size = 12) {
    ensureSpace(document, size + 20);
    document.moveDown(0.5);
    document.font("Helvetica-Bold")
        .fontSize(size)
        .fillColor("#17324d")
        .text(text);
    document.moveDown(0.2);
}

function tableDimensions(document) {
    const width = document.page.width - PAGE_MARGIN * 2;
    const labelWidth = width * 0.44;
    return {
        left: PAGE_MARGIN,
        width,
        labelWidth,
        valueWidth: width - labelWidth,
    };
}

function drawTableHeader(document, dimensions) {
    const rowHeight = 24;
    ensureSpace(document, rowHeight);
    const top = document.y;
    const cells = [
        { x: dimensions.left, width: dimensions.labelWidth, label: "Metric" },
        {
            x: dimensions.left + dimensions.labelWidth,
            width: dimensions.valueWidth,
            label: "Value",
        },
    ];

    for (const cell of cells) {
        document.fillColor("#edf2f7")
            .rect(cell.x, top, cell.width, rowHeight)
            .fill();
        document.strokeColor("#cbd5e1")
            .lineWidth(0.5)
            .rect(cell.x, top, cell.width, rowHeight)
            .stroke();
        document.font("Helvetica-Bold")
            .fontSize(9)
            .fillColor("#17324d")
            .text(cell.label, cell.x + 8, top + 7, {
                width: cell.width - 16,
                lineBreak: false,
            });
    }

    document.y = top + rowHeight;
}

function measureTableRow(document, label, value, dimensions) {
    const horizontalPadding = 16;
    const verticalPadding = 10;
    document.font("Helvetica-Bold").fontSize(9);
    const labelHeight = document.heightOfString(label, {
        width: dimensions.labelWidth - horizontalPadding,
        lineGap: 1,
    });
    document.font("Helvetica").fontSize(9);
    const valueHeight = document.heightOfString(value, {
        width: dimensions.valueWidth - horizontalPadding,
        lineGap: 1,
    });
    return Math.max(22, labelHeight, valueHeight) + verticalPadding;
}

function drawTableRow(document, row, dimensions, rowHeight, index) {
    const top = document.y;
    const labelX = dimensions.left;
    const valueX = dimensions.left + dimensions.labelWidth;
    const background = index % 2 === 0 ? "#ffffff" : "#f8fafc";

    document.fillColor(background)
        .rect(labelX, top, dimensions.labelWidth, rowHeight)
        .fill();
    document.fillColor(background)
        .rect(valueX, top, dimensions.valueWidth, rowHeight)
        .fill();
    document.strokeColor("#dbe3ec")
        .lineWidth(0.5)
        .rect(labelX, top, dimensions.labelWidth, rowHeight)
        .stroke()
        .rect(valueX, top, dimensions.valueWidth, rowHeight)
        .stroke();

    document.font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#334155")
        .text(row.label, labelX + 8, top + 5, {
            width: dimensions.labelWidth - 16,
            lineGap: 1,
        });
    document.font("Helvetica")
        .fontSize(9)
        .fillColor("#334155")
        .text(row.value, valueX + 8, top + 5, {
            width: dimensions.valueWidth - 16,
            align: row.numeric ? "right" : "left",
            lineGap: 1,
        });
    document.y = top + rowHeight;
}

function addEntries(document, title, entries) {
    if (!entries.length) return;

    const dimensions = tableDimensions(document);
    const rows = entries.map(entry => {
        const label = displayValue(entry.label);
        const value = displayValue(entry.value);
        return {
            label,
            value,
            numeric: typeof entry.value === "number"
                || (
                    typeof entry.value === "string"
                    && /^-?(?:\d+\.?\d*|\.\d+)$/.test(entry.value)
                ),
            height: measureTableRow(document, label, value, dimensions),
        };
    });
    ensureSpace(document, 60 + rows[0].height);
    addHeading(document, title, 11);
    drawTableHeader(document, dimensions);
    for (const [index, row] of rows.entries()) {
        const bottom = document.page.height - document.page.margins.bottom;
        if (document.y + row.height > bottom) {
            document.addPage();
            drawTableHeader(document, dimensions);
        }
        drawTableRow(document, row, dimensions, row.height, index);
    }
}

function addNotes(document, title, notes) {
    if (!notes.length) return;

    const width = document.page.width - PAGE_MARGIN * 2 - 12;
    const noteHeights = notes.map(note => {
        const text = `- ${displayValue(note)}`;
        document.font("Helvetica").fontSize(9);
        return document.heightOfString(text, { width, lineGap: 2 }) + 8;
    });
    ensureSpace(document, 40 + noteHeights[0]);
    addHeading(document, title, 11);
    for (const [index, note] of notes.entries()) {
        const text = `- ${displayValue(note)}`;
        ensureSpace(document, noteHeights[index]);
        document.font("Helvetica")
            .fontSize(9)
            .fillColor("#334155")
            .text(text, { indent: 10, width, lineGap: 2 });
    }
}

function addSampleChart(document, section) {
    const samples = section.samples;
    const series = section.type === "blink_monitoring"
        ? [
            { label: "Left eye EAR", key: "leftEAR", color: "#3b82f6" },
            { label: "Right eye EAR", key: "rightEAR", color: "#f59e0b" },
            { label: "Average EAR", key: "avgEAR", color: "#10b981" },
        ]
        : [
            { label: "Gaze X", key: "xPx", color: "#3b82f6", validOnly: true },
            { label: "Gaze Y", key: "yPx", color: "#10b981", validOnly: true },
            { label: "Target X", key: "targetXPx", color: "#ef4444" },
        ];
    const xValues = samples.map((sample, index) => {
        const time = sample.timeSeconds ?? sample.time ?? index;
        return Number.isFinite(Number(time)) ? Number(time) : index;
    });
    const chartSeries = series.map(item => ({
        ...item,
        values: samples.map(sample => (
            (!item.validOnly || sample.valid)
            && Number.isFinite(sample[item.key])
                ? sample[item.key]
                : null
        )),
    })).filter(item => item.values.some(value => value !== null));
    const allValues = chartSeries.flatMap(item =>
        item.values.filter(value => value !== null)
    );
    if (!allValues.length) return;

    ensureSpace(document, 190);
    addHeading(document, "Recorded sample visualization", 11);

    const chartLeft = PAGE_MARGIN + 36;
    const chartTop = document.y + 26;
    const chartWidth = document.page.width - PAGE_MARGIN * 2 - 48;
    const chartHeight = 112;
    const chartBottom = chartTop + chartHeight;
    let minX = Math.min(...xValues);
    let maxX = Math.max(...xValues);
    let minY = Math.min(...allValues);
    let maxY = Math.max(...allValues);
    if (minX === maxX) maxX = minX + 1;
    if (minY === maxY) {
        minY -= 0.5;
        maxY += 0.5;
    }

    document.font("Helvetica")
        .fontSize(7)
        .fillColor("#64748b");
    for (let tick = 0; tick <= 4; tick += 1) {
        const y = chartTop + (chartHeight * tick) / 4;
        const value = maxY - ((maxY - minY) * tick) / 4;
        document.strokeColor("#e2e8f0")
            .lineWidth(0.5)
            .moveTo(chartLeft, y)
            .lineTo(chartLeft + chartWidth, y)
            .stroke();
        document.text(value.toFixed(2), PAGE_MARGIN, y - 4, {
            width: 30,
            align: "right",
            lineBreak: false,
        });
    }
    document.strokeColor("#94a3b8")
        .lineWidth(0.7)
        .moveTo(chartLeft, chartTop)
        .lineTo(chartLeft, chartBottom)
        .lineTo(chartLeft + chartWidth, chartBottom)
        .stroke();
    document.text(minX.toFixed(1), chartLeft, chartBottom + 4, {
        lineBreak: false,
    });
    document.text(maxX.toFixed(1), chartLeft + chartWidth - 30, chartBottom + 4, {
        width: 30,
        align: "right",
        lineBreak: false,
    });

    for (const item of chartSeries) {
        let previousPoint = null;
        document.strokeColor(item.color).lineWidth(1.2);
        for (let index = 0; index < item.values.length; index += 1) {
            const value = item.values[index];
            if (value === null) {
                previousPoint = null;
                continue;
            }
            const point = {
                x: chartLeft + ((xValues[index] - minX) / (maxX - minX)) * chartWidth,
                y: chartBottom - ((value - minY) / (maxY - minY)) * chartHeight,
            };
            if (previousPoint) {
                document.moveTo(previousPoint.x, previousPoint.y)
                    .lineTo(point.x, point.y)
                    .stroke();
            }
            previousPoint = point;
        }
    }

    const legendY = chartBottom + 18;
    let legendX = chartLeft;
    document.font("Helvetica").fontSize(7);
    for (const item of chartSeries) {
        document.fillColor(item.color).text("-", legendX, legendY, {
            lineBreak: false,
        });
        legendX += 12;
        document.fillColor("#475569").text(item.label, legendX, legendY, {
            lineBreak: false,
        });
        legendX += document.widthOfString(item.label) + 18;
    }
    document.y = legendY + 10;
}

function addAiAnalysis(document, analysis) {
    if (!analysis) return;

    ensureSpace(document, 140);
    addHeading(document, "AI-generated report interpretation", 14);
    document.font("Helvetica")
        .fontSize(9)
        .fillColor("#475569")
        .text(`Provider: ${displayValue(analysis.provider)}`)
        .text(`Generated: ${displayDate(analysis.updatedAt)}`)
        .moveDown(0.3)
        .fillColor("#334155")
        .text(displayValue(analysis.summary), { lineGap: 2 });

    if (analysis.includesQuestionnaire) {
        document.moveDown(0.3)
            .font("Helvetica-Oblique")
            .fontSize(9)
            .fillColor("#64748b")
            .text("This interpretation also used the participant's self-reported questionnaire answers, shared with consent.");
    }

    if (!analysis.baselineAvailable) {
        document.moveDown(0.3)
            .font("Helvetica-Oblique")
            .fontSize(9)
            .fillColor("#64748b")
            .text("There was not enough historical data to establish a personal baseline.");
    }

    addNotes(
        document,
        "Key findings",
        analysis.keyFindings.map(finding =>
            `${finding.title}: ${finding.explanation} Evidence: ${finding.evidence}`
        )
    );
    addEntries(
        document,
        "Personal baseline comparisons",
        analysis.baselineComparisons.map(comparison => ({
            label: `${comparison.assessment} - ${comparison.measurement}`,
            value: `Current: ${comparison.currentValue}; personal mean: ${comparison.baselineMean} across ${comparison.sessions} sessions. ${comparison.explanation}`,
        }))
    );
    addNotes(document, "Suggested next steps", analysis.nextSteps);
    addHeading(document, "AI limitations", 11);
    document.font("Helvetica")
        .fontSize(9)
        .fillColor("#334155")
        .text(displayValue(analysis.limitations), { lineGap: 2 })
        .moveDown(0.3)
        .font("Helvetica-Bold")
        .text("This AI-generated interpretation is informational and is not a medical diagnosis or professional medical advice.");
}

function createEyeAssessmentPdf({
    assessment,
    healthProfile,
    questionnaireAnswers = [],
    questionnaireChanges = [],
    previousQuestionnaireDate,
    reportSections,
    heatmaps,
    aiAnalysis,
}) {
    const document = new PDFDocument({
        size: "A4",
        margins: {
            top: PAGE_MARGIN,
            right: PAGE_MARGIN,
            bottom: PAGE_MARGIN + FOOTER_SPACE,
            left: PAGE_MARGIN,
        },
        bufferPages: true,
        info: {
            Title: "Consolidated Eye Assessment Report",
            Author: "BrainGuard AI",
            Subject: `Eye assessment report for ${assessment.name}`,
        },
    });

    document.font("Helvetica-Bold")
        .fontSize(20)
        .fillColor("#17324d")
        .text("BrainGuard AI", { align: "center" });
    document.moveDown(0.3);
    document.fontSize(15)
        .text("Consolidated Eye Assessment Report", { align: "center" });
    document.moveDown(0.6);
    document.font("Helvetica")
        .fontSize(11)
        .fillColor("#334155")
        .text(`Assessment for ${displayValue(assessment.name)}`, { align: "center" });
    document.fontSize(9)
        .fillColor("#64748b")
        .text(`Generated ${displayDate(new Date())}`, { align: "center" });
    document.moveDown(0.8);

    addHeading(document, "Session summary", 14);
    addEntries(document, "Health profile", [
        { label: "Age range", value: healthProfile.ageRange || healthProfile.age },
        { label: "Preferred language", value: healthProfile.language },
        { label: "Education", value: healthProfile.educationLevel },
        {
            label: "Sleep duration",
            value: healthProfile.sleepDuration
                || (healthProfile.sleepHours != null ? `${healthProfile.sleepHours} hours/day` : "Not recorded"),
        },
        {
            label: "Physical activity",
            value: healthProfile.activityLevel
                || (healthProfile.exerciseMinutes != null ? `${healthProfile.exerciseMinutes} minutes/day` : "Not recorded"),
        },
        {
            label: "Stress frequency",
            value: healthProfile.stressFrequency
                || (healthProfile.stressLevel != null ? `${healthProfile.stressLevel} / 5` : "Not recorded"),
        },
        { label: "Family history", value: displayFamilyHistory(healthProfile.familyHistory) },
    ]);
    addEntries(
        document,
        "Self-reported questionnaire answers",
        questionnaireAnswers.map(item => ({
            label: item.question,
            value: item.answers.join(", "),
        }))
    );
    if (questionnaireChanges.length) {
        addEntries(
            document,
            `Answer differences from previous session (${displayDate(previousQuestionnaireDate)})`,
            questionnaireChanges.map(item => ({
                label: item.question,
                value: `Previous: ${item.previous.join(", ")}; current: ${item.current.join(", ")}`,
            }))
        );
    }

    for (const section of reportSections) {
        ensureSpace(document, 140);
        addHeading(document, `${section.number} - ${section.title}`, 14);
        document.font("Helvetica")
            .fontSize(9)
            .fillColor("#475569")
            .text(`Result session: ${displayValue(section.sessionId)}`)
            .text(`Recorded: ${displayDate(section.startedAt)}`)
            .text(`Duration: ${section.durationSeconds == null
                ? "Unavailable"
                : `${section.durationSeconds} seconds`}`);

        addEntries(document, "Derived measurements", section.measurements);
        addEntries(document, "Calibration", section.calibration);
        addEntries(document, "Tracking quality", section.quality);
        addNotes(document, "Tracking quality notes", section.qualityNotes);
        addNotes(document, "Algorithm-generated observations", section.observations);

        addSampleChart(document, section);
    }

    addAiAnalysis(document, aiAnalysis);

    if (heatmaps.length) {
        ensureSpace(document, 100);
        addHeading(document, "Available gaze heatmaps", 14);
        for (const heatmap of heatmaps) {
            ensureSpace(document, 300);
            document.font("Helvetica")
                .fontSize(9)
                .fillColor("#334155")
                .text(
                    `${displayValue(heatmap.stimulus)} - ${displayValue(heatmap.sampleCount)} samples - ${displayDate(heatmap.createdAt)}`,
                    { indent: 10, lineGap: 2 }
                );
            const filename = path.basename(displayValue(heatmap.heatmapFilename));
            const imagePath = path.join(HEATMAP_DIR, filename);
            if (filename !== "Not recorded" && fs.existsSync(imagePath)) {
                document.image(imagePath, {
                    fit: [document.page.width - PAGE_MARGIN * 2, 250],
                    align: "center",
                });
                document.moveDown(0.5);
            } else {
                document.font("Helvetica-Oblique")
                    .fontSize(8)
                    .fillColor("#64748b")
                    .text("Heatmap image is not available on this server.", { indent: 10 });
            }
        }
    }

    ensureSpace(document, 100);
    addHeading(document, "Limitations and next steps", 14);
    document.font("Helvetica")
        .fontSize(9)
        .fillColor("#334155")
        .text(
            "Camera position, lighting, glasses, head movement, screen size, and tracking quality can affect results. Measurements are not clinically validated and cannot diagnose, screen for, or rule out neurological or other medical conditions."
        )
        .moveDown(0.4)
        .text(
            "If you have a health concern or persistent symptoms, discuss them with a qualified healthcare professional. Repeat measurements under similar conditions only as a descriptive personal comparison."
        )
        .moveDown(0.6)
        .font("Helvetica-Bold")
        .text(
            "BrainGuard AI is a research prototype, not a medical device. No result in this report is a confirmed medical finding."
        );

    const pages = document.bufferedPageRange();
    for (let pageIndex = pages.start; pageIndex < pages.start + pages.count; pageIndex += 1) {
        document.switchToPage(pageIndex);
        document.save();
        document.strokeColor("#dbe3ec")
            .lineWidth(0.5)
            .moveTo(PAGE_MARGIN, document.page.height - 38)
            .lineTo(document.page.width - PAGE_MARGIN, document.page.height - 38)
            .stroke();
        document.font("Helvetica")
            .fontSize(8)
            .fillColor("#64748b")
            .text(
                `BrainGuard AI - Page ${pageIndex + 1} of ${pages.count}`,
                PAGE_MARGIN,
                document.page.height - 28,
                { width: document.page.width - PAGE_MARGIN * 2, align: "center" }
            );
        document.restore();
    }

    return document;
}

module.exports = createEyeAssessmentPdf;
