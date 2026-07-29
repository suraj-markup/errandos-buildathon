package ai.errandos.overlay;

/**
 * Closed Android execution policy for server-backed recovery actions.
 */
final class RecoveryActionPolicy {
    private RecoveryActionPolicy() {
    }

    static boolean canSubmit(
        CompanionIssueV2 issue,
        CompanionIssueV2.RecoveryAction action
    ) {
        if (
            issue == null
                || issue.recoveryInteraction == null
                || action == null
        ) {
            return false;
        }
        if ("unlock_phone".equals(action.actionId)) {
            // Unlock is always a manual instruction. Android must never imply
            // that this control can bypass the secure keyguard.
            return false;
        }
        if (
            "mutation_ambiguous".equals(issue.code)
                || "reconciliation_required".equals(issue.code)
        ) {
            return "check_cart_again".equals(action.actionId)
                || "stop_task".equals(action.actionId);
        }
        if ("verified_not_applied_only".equals(action.safety)) {
            // The current recovery route intentionally does not accept a
            // mutation retry. Keep it visible as guidance, but fail closed.
            return false;
        }
        return "check_cart_again".equals(action.actionId)
            || "refresh_choices".equals(action.actionId)
            || "reconnect_appium".equals(action.actionId)
            || "reconnect_phone".equals(action.actionId)
            || "reconnect_server".equals(action.actionId)
            || "stop_task".equals(action.actionId);
    }

    static String disabledReason(
        CompanionIssueV2 issue,
        CompanionIssueV2.RecoveryAction action
    ) {
        if (action != null && "unlock_phone".equals(action.actionId)) {
            return "Unlock the phone manually. JaldiAI cannot bypass the device lock.";
        }
        if (issue == null || issue.recoveryInteraction == null) {
            return "Waiting for a current server recovery action.";
        }
        if (
            action != null
                && "verified_not_applied_only".equals(action.safety)
        ) {
            return "Hold to speak before retrying this cart change.";
        }
        return "This recovery action is not available.";
    }
}
