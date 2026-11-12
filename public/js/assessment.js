
const memoryStart = document.getElementById("memoryStart");
const wordList = document.getElementById("wordList");
const memoryTimer = document.getElementById("memoryTimer");
const recallSection = document.getElementById("recallSection");
const recallWords = document.getElementById("recallWords");

const reactionStart = document.getElementById("reactionStart");
const reactionTarget = document.getElementById("reactionTarget");
const reactionStatus = document.getElementById("reactionStatus");
const reactionInput = document.getElementById("reactionMs");

const attentionInput = document.getElementById("attentionCount");
const submitBtn = document.getElementById("submitBtn");

let memoryDone = false;
let reactionDone = false;
let reactionStartedAt = 0;
let reactionTimeout;

// Update submission availability
function updateSubmitButton() {
    submitBtn.disabled = !(
        memoryDone &&
        reactionDone &&
        attentionInput.value !== ""
    );
}

attentionInput.addEventListener("input", updateSubmitButton);

// Memory test
memoryStart.addEventListener("click", () => {

    memoryStart.disabled = true;
    wordList.hidden = false;

    let seconds = 15;

    memoryTimer.textContent = `Memorize the words: ${seconds}s`;

    const timer = setInterval(() => {

        seconds--;

        memoryTimer.textContent = `Time remaining: ${seconds}s`;

        if (seconds <= 0) {

            clearInterval(timer);

            wordList.hidden = true;
            recallSection.hidden = false;

            recallWords.disabled = false;
            recallWords.focus();

            memoryTimer.textContent =
                "Enter the words you remember.";

            memoryDone = true;

            updateSubmitButton();
        }

    }, 1000);
});

// Reaction time test
reactionStart.addEventListener("click", () => {

    reactionStart.disabled = true;

    reactionStatus.textContent =
        "Wait for the button to appear...";

    reactionTimeout = setTimeout(() => {

        reactionTarget.hidden = false;
        reactionStartedAt = performance.now();

    }, Math.random() * 3000 + 1500);

});

reactionTarget.addEventListener("click", () => {

    if (!reactionStartedAt) return;

    const reactionTime =
        Math.round(performance.now() - reactionStartedAt);

    reactionInput.value = reactionTime;

    reactionStartedAt = 0;
    reactionTarget.hidden = true;

    reactionStatus.textContent =
        `Your reaction time: ${reactionTime} ms`;

    reactionDone = true;

    updateSubmitButton();
});

// Prevent incomplete submissions
document.getElementById("assessmentForm")
    .addEventListener("submit", (event) => {

        if (!memoryDone || !reactionDone) {
            event.preventDefault();
            alert("Complete all cognitive activities first.");
        }

    });
