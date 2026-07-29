package ai.errandos.overlay;

import org.json.JSONObject;

final class RecoveryActionResponse {
    enum Outcome {
        ACCEPTED,
        DUPLICATE,
        STALE,
        REJECTED
    }

    final Outcome outcome;
    final String reason;
    final String guidance;

    private RecoveryActionResponse(
        Outcome outcome,
        String reason,
        String guidance
    ) {
        this.outcome = outcome;
        this.reason = reason;
        this.guidance = guidance;
    }

    static RecoveryActionResponse parse(JSONObject response, int statusCode) {
        return parse(response, statusCode, null, null);
    }

    static RecoveryActionResponse parse(
        JSONObject response,
        int statusCode,
        RecoveryActionBinding expected,
        String expectedActionId
    ) {
        String acknowledgement = response.optString(
            "acknowledgement",
            "rejected"
        );
        String reason = response.optString(
            "reason",
            statusCode >= 500 ? "server_unavailable" : "rejected"
        );
        String guidance = null;
        JSONObject followup = response.optJSONObject("followup");
        if (
            followup != null
                && "guidance".equals(followup.optString("kind"))
        ) {
            guidance = followup.optString("message", null);
        }
        if ("accepted".equals(acknowledgement)) {
            if (!matchesExpected(response, expected, expectedActionId)) {
                return new RecoveryActionResponse(
                    Outcome.REJECTED,
                    "response_identity_mismatch",
                    null
                );
            }
            return new RecoveryActionResponse(
                Outcome.ACCEPTED,
                reason,
                guidance
            );
        }
        if ("duplicate".equals(acknowledgement)) {
            if (!matchesExpected(response, expected, expectedActionId)) {
                return new RecoveryActionResponse(
                    Outcome.REJECTED,
                    "response_identity_mismatch",
                    null
                );
            }
            return new RecoveryActionResponse(
                Outcome.DUPLICATE,
                reason,
                guidance
            );
        }
        if (
            "expired".equals(reason)
                || "stale_revision".equals(reason)
                || "stale_recovery_interaction".equals(reason)
                || "unknown_recovery_interaction".equals(reason)
                || "already_resolved".equals(reason)
                || "recovery_identity_mismatch".equals(reason)
        ) {
            return new RecoveryActionResponse(
                Outcome.STALE,
                reason,
                guidance
            );
        }
        return new RecoveryActionResponse(
            Outcome.REJECTED,
            reason,
            guidance
        );
    }

    private static boolean matchesExpected(
        JSONObject response,
        RecoveryActionBinding expected,
        String expectedActionId
    ) {
        if (expected == null || expectedActionId == null) return true;
        return response.optInt("version", -1) == 2
            && expectedActionId.equals(
                response.optString("actionId")
            )
            && expected.interactionId.equals(
                response.optString("interactionId")
            )
            && expected.operationId.equals(
                response.optString("operationId")
            )
            && expected.stepId.equals(response.optString("stepId"))
            && expected.taskId.equals(response.optString("taskId"))
            && response.optInt("taskRevision", -1) >= 0;
    }
}
