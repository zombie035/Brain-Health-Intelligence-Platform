
from datetime import datetime
from typing import Optional, Any

import numpy as np

import fastapi  # pyright: ignore[reportMissingImports]
from pydantic import BaseModel, Field

from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import IsolationForest


app = fastapi.FastAPI(
    title="BrainGuard AI ML Service",
    description="Experimental cognitive performance trend analysis",
    version="1.0.0"
)


# ==========================================
# INPUT MODELS
# ==========================================

class AssessmentRecord(BaseModel):
    createdAt: Optional[datetime] = None
    memoryCorrect: int = Field(ge=0)
    memoryTotal: int = Field(default=5, gt=0)
    attentionCorrect: bool
    reactionMs: float = Field(gt=0)


class AnalysisRequest(BaseModel):
    history: list[AssessmentRecord]
    health_profile: Optional[dict[str, Any]] = None


# ==========================================
# FEATURE ENGINEERING
# ==========================================

def prepare_features(history):

    features = []

    for item in history:

        memory_percentage = (
            item.memoryCorrect / item.memoryTotal
        ) * 100

        attention_score = (
            1 if item.attentionCorrect else 0
        )

        reaction_time = np.log1p(item.reactionMs)

        features.append([
            memory_percentage,
            attention_score,
            reaction_time
        ])

    return np.array(features, dtype=float)


# ==========================================
# BASELINE CALCULATION
# ==========================================

def calculate_baseline(history):

    baseline_sessions = history[:3]

    features = prepare_features(baseline_sessions)

    return {
        "sessions": len(baseline_sessions),

        "memoryPct": round(
            float(np.median(features[:, 0])), 2
        ),

        "attentionRatePct": round(
            float(np.median(features[:, 1])) * 100, 2
        ),

        "reactionMs": round(
            float(np.median([
                item.reactionMs
                for item in baseline_sessions
            ])), 2
        )
    }


# ==========================================
# BASELINE COMPARISON
# ==========================================

def compare_with_baseline(baseline, latest):

    memory_pct = (
        latest.memoryCorrect / latest.memoryTotal
    ) * 100

    attention_pct = (
        100 if latest.attentionCorrect else 0
    )

    memory_change = (
        memory_pct - baseline["memoryPct"]
    )

    attention_change = (
        attention_pct - baseline["attentionRatePct"]
    )

    reaction_change = (
        latest.reactionMs - baseline["reactionMs"]
    )

    reaction_change_pct = (
        reaction_change / baseline["reactionMs"] * 100
        if baseline["reactionMs"] > 0 else 0
    )

    return {
        "memoryPctPoints": round(memory_change, 2),

        "attentionPoints": round(attention_change, 2),

        "reactionMs": round(reaction_change, 2),

        "reactionPercent": round(reaction_change_pct, 2)
    }


# ==========================================
# LINEAR REGRESSION TREND ANALYSIS
# ==========================================

def calculate_trends(history):

    if len(history) < 3:
        return None

    features = prepare_features(history)

    x = np.arange(len(history)).reshape(-1, 1)

    def get_slope(values):

        model = LinearRegression()
        model.fit(x, values)

        return float(model.coef_[0])

    memory_slope = get_slope(features[:, 0])

    attention_slope = get_slope(features[:, 1])

    reaction_slope = get_slope(
        np.array([
            item.reactionMs for item in history
        ])
    )

    def classify(value, threshold):

        if value > threshold:
            return "upward"

        if value < -threshold:
            return "downward"

        return "stable"

    return {
        "memory": {
            "slopePerSession": round(memory_slope, 2),
            "direction": classify(memory_slope, 1.0)
        },

        "attention": {
            "slopePerSession": round(attention_slope, 3),
            "direction": classify(attention_slope, 0.03)
        },

        "reaction": {
            "slopeMsPerSession": round(reaction_slope, 2),
            "direction": (
                "slower" if reaction_slope > 10
                else "faster" if reaction_slope < -10
                else "stable"
            )
        }
    }


# ==========================================
# ISOLATION FOREST ANOMALY DETECTION
# ==========================================

def detect_anomaly(history):

    # Need at least 8 previous sessions
    # plus one latest session.

    if len(history) < 9:

        return {
            "status": "not_enough_history",
            "isUnusual": None,
            "score": None,
            "message": (
                "At least 9 sessions are required "
                "for experimental anomaly detection."
            )
        }

    features = prepare_features(history)

    previous_sessions = features[:-1]

    latest_session = features[-1].reshape(1, -1)

    scaler = StandardScaler()

    previous_scaled = scaler.fit_transform(
        previous_sessions
    )

    latest_scaled = scaler.transform(
        latest_session
    )

    model = IsolationForest(
        n_estimators=200,
        contamination=0.15,
        random_state=42
    )

    model.fit(previous_scaled)

    prediction = model.predict(latest_scaled)

    score = model.decision_function(latest_scaled)[0]

    is_unusual = bool(prediction[0] == -1)

    return {
        "status": "completed",
        "isUnusual": is_unusual,
        "score": round(float(score), 4),

        "message": (
            "This session differs from previous personal measurements."
            if is_unusual
            else "No unusual session pattern was detected."
        )
    }


# ==========================================
# HEALTH CONTEXT
# ==========================================

def get_health_context(profile):

    if not profile:

        return {
            "available": False
        }

    return {
        "available": True,
        "sleepHours": profile.get("sleepHours"),
        "stressLevel": profile.get("stressLevel"),
        "exerciseMinutes": profile.get("exerciseMinutes"),
        "familyHistory": profile.get("familyHistory")
    }


# ==========================================
# MAIN ANALYSIS ENDPOINT
# ==========================================

@app.post("/analyze")
def analyze_brain_health(request: AnalysisRequest):

    history = sorted(
        request.history,
        key=lambda item: item.createdAt or datetime.min
    )

    if not history:

        return {
            "success": False,
            "message": "No assessment history available."
        }

    # Current session
    latest = history[-1]

    latest_result = {
        "memoryPct": round(
            latest.memoryCorrect / latest.memoryTotal * 100, 2
        ),

        "attentionCorrect": latest.attentionCorrect,

        "reactionMs": round(latest.reactionMs, 2)
    }

    # Baseline
    baseline = None
    comparison = None

    if len(history) >= 3:

        baseline = calculate_baseline(history)

    # Compare only sessions AFTER the first 3 baseline sessions
    if len(history) >= 4:

        comparison = compare_with_baseline(
            baseline,
            latest
        )

    # Trend
    trends = calculate_trends(history)

    # Anomaly detection
    anomaly = detect_anomaly(history)

    # Reported health context
    health_context = get_health_context(
        request.health_profile
    )

    return {
        "success": True,

        "sessionCount": len(history),

        "baselineAvailable": baseline is not None,

        "baseline": baseline,

        "latest": latest_result,

        "comparison": comparison,

        "trends": trends,

        "anomaly": anomaly,

        "healthContext": health_context,

        "disclaimer": (
            "Experimental performance analysis only. "
            "Not a diagnosis or clinically validated screening result."
        )
    }


# ==========================================
# HEALTH CHECK
# ==========================================

@app.get("/")
def home():

    return {
        "message": "BrainGuard AI ML Service is running",
        "status": "healthy"
    }
