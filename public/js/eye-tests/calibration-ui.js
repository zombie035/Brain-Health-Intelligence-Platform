(() => {
    const targets = Object.freeze([
        Object.freeze([0.46, 0.06]),
        Object.freeze([0.7, 0.06]),
        Object.freeze([0.94, 0.06]),
        Object.freeze([0.06, 0.5]),
        Object.freeze([0.5, 0.5]),
        Object.freeze([0.94, 0.5]),
        Object.freeze([0.06, 0.94]),
        Object.freeze([0.5, 0.94]),
        Object.freeze([0.94, 0.94]),
    ]);

    function create(stage) {
        const panel = stage.querySelector("[data-calibration-panel]");
        const title = panel.querySelector("[data-calibration-title]");
        const targetText = panel.querySelector("[data-calibration-target]");
        const fill = panel.querySelector("[data-calibration-fill]");
        const progress = panel.querySelector("[data-calibration-progress]");
        const count = panel.querySelector("[data-calibration-count]");
        let totalTargets = targets.length;

        function setProgress(completed) {
            const percentage = Math.round((completed / totalTargets) * 100);
            fill.style.width = `${percentage}%`;
            progress.setAttribute("aria-valuenow", String(percentage));
            count.textContent = `${completed} of ${totalTargets} targets complete`;
        }

        return {
            targets,
            begin() {
                totalTargets = targets.length;
                panel.hidden = false;
                title.textContent = "Calibration starting";
                targetText.textContent =
                    "Keep your head still and follow each dot with your eyes. The test starts automatically after calibration.";
                setProgress(0);
            },
            showTarget(index, position) {
                const [x, y] = position;
                panel.hidden = false;
                title.textContent = `Calibration target ${index} of ${totalTargets}`;
                const horizontal = x < 0.34 ? "left" : x < 0.78 ? "center" : "right";
                const vertical = y < 0.48 ? "upper" : y < 0.78 ? "middle" : "lower";
                targetText.textContent =
                    `Look at the ${vertical} ${horizontal} dot (${Math.round(x * 100)}% from the left, ${Math.round(y * 100)}% from the top).`;
                setProgress(index - 1);
            },
            completeTarget(index) {
                setProgress(index);
            },
            fitting() {
                title.textContent = "Fitting gaze calibration";
                targetText.textContent =
                    "All targets captured. GazeMap is checking the calibration.";
                setProgress(totalTargets);
            },
            complete() {
                title.textContent = "Calibration complete";
                targetText.textContent = "Your test will begin automatically.";
                setProgress(totalTargets);
            },
            hide() {
                panel.hidden = true;
            },
        };
    }

    window.EyeCalibrationUI = { create };
})();
