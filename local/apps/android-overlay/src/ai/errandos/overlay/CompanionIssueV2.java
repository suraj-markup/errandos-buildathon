package ai.errandos.overlay;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Closed, presentation-safe mirror of the server CompanionIssueV2 contract.
 *
 * Raw provider errors never reach this model. The parser accepts only an exact
 * canonical policy so a retained event cannot change recovery safety or show a
 * mutation retry after an ambiguous outcome.
 */
final class CompanionIssueV2 {
    static final class RecoveryAction {
        final int version;
        final String actionId;
        final String label;
        final String safety;

        RecoveryAction(
            int version,
            String actionId,
            String label,
            String safety
        ) {
            this.version = version;
            this.actionId = actionId;
            this.label = label;
            this.safety = safety;
        }

        String safetyLabel() {
            if ("read_only".equals(safety)) return "READ-ONLY";
            if ("user_guidance".equals(safety)) return "ON YOUR PHONE";
            if ("stop_only".equals(safety)) return "SAFE STOP";
            return "VERIFIED RETRY";
        }

        String talkBackDescription() {
            return talkBackDescription(false, null);
        }

        String talkBackDescription(
            boolean actionable,
            String disabledReason
        ) {
            String guidance;
            if ("read_only".equals(safety)) {
                guidance = "Read-only recovery guidance.";
            } else if ("user_guidance".equals(safety)) {
                guidance = "Complete this step on your phone.";
            } else if ("stop_only".equals(safety)) {
                guidance = "Stops the task without another phone action.";
            } else {
                guidance =
                    "Retry is allowed only because a fresh check proved "
                        + "the cart change was not applied.";
            }
            if (actionable) {
                return label + ". " + guidance
                    + " Double tap to run this safe recovery action, "
                    + "or hold the companion to speak it.";
            }
            return label + ". " + guidance + " "
                + (
                    disabledReason == null
                        ? "Hold the companion to speak this option."
                        : disabledReason
                );
        }
    }

    final int version;
    final String code;
    final String treatment;
    final String queueBehavior;
    final String title;
    final String detail;
    final List<RecoveryAction> recoveryActions;
    final RecoveryActionBinding recoveryInteraction;

    private CompanionIssueV2(
        String code,
        String treatment,
        String queueBehavior,
        String title,
        String detail,
        RecoveryActionBinding recoveryInteraction,
        RecoveryAction... recoveryActions
    ) {
        this.version = 2;
        this.code = code;
        this.treatment = treatment;
        this.queueBehavior = queueBehavior;
        this.title = title;
        this.detail = detail;
        this.recoveryInteraction = recoveryInteraction;
        this.recoveryActions = Collections.unmodifiableList(
            new ArrayList<RecoveryAction>(Arrays.asList(recoveryActions))
        );
    }

    CompanionIssueV2 withRecoveryInteraction(
        RecoveryActionBinding interaction
    ) {
        return new CompanionIssueV2(
            code,
            treatment,
            queueBehavior,
            title,
            detail,
            interaction,
            recoveryActions.toArray(new RecoveryAction[0])
        );
    }

    static CompanionIssueV2 canonical(String code) {
        RecoveryAction stop = action(
            "stop_task",
            "Stop task",
            "stop_only"
        );
        if ("unknown_failure".equals(code)) {
            return issue(
                code,
                "safe_failure",
                "pause_task",
                "Task paused",
                "JaldiAI could not complete this step safely.",
                stop
            );
        }
        if ("server_unreachable".equals(code)) {
            return issue(
                code,
                "connection_blocked",
                "pause_task",
                "JaldiAI server unavailable",
                "Task updates are paused until the server reconnects.",
                action("reconnect_server", "Reconnect", "read_only"),
                stop
            );
        }
        if ("phone_disconnected".equals(code)) {
            return issue(
                code,
                "connection_blocked",
                "pause_task",
                "Phone connection lost",
                "No new phone action will run until the device reconnects.",
                action(
                    "reconnect_phone",
                    "Reconnect phone",
                    "read_only"
                ),
                stop
            );
        }
        if ("phone_unauthorized".equals(code)) {
            return issue(
                code,
                "user_attention",
                "pause_task",
                "Phone authorization required",
                "Approve the debugging connection on the phone to continue.",
                action(
                    "reconnect_phone",
                    "Check connection",
                    "read_only"
                ),
                stop
            );
        }
        if ("appium_unavailable".equals(code)) {
            return issue(
                code,
                "connection_blocked",
                "pause_task",
                "Phone control unavailable",
                "The phone automation service is not reachable.",
                action(
                    "reconnect_appium",
                    "Reconnect phone control",
                    "read_only"
                ),
                stop
            );
        }
        if ("appium_session_recovery_failed".equals(code)) {
            return issue(
                code,
                "connection_blocked",
                "pause_task",
                "Phone session needs recovery",
                "The existing phone session could not be restored safely.",
                action(
                    "reconnect_appium",
                    "Restore phone session",
                    "read_only"
                ),
                stop
            );
        }
        if ("device_locked".equals(code)) {
            return issue(
                code,
                "user_attention",
                "pause_task",
                "Unlock your phone",
                "The task is paused while the phone is locked.",
                action("unlock_phone", "Unlock phone", "user_guidance"),
                stop
            );
        }
        if ("blinkit_login_required".equals(code)) {
            return issue(
                code,
                "user_attention",
                "pause_task",
                "Blinkit sign-in required",
                "Sign in to Blinkit on the phone before the task continues.",
                action("open_blinkit", "Open Blinkit", "user_guidance"),
                stop
            );
        }
        if ("provider_screen_unavailable".equals(code)) {
            return issue(
                code,
                "user_attention",
                "pause_task",
                "Blinkit screen unavailable",
                "JaldiAI cannot safely identify the current Blinkit screen.",
                action(
                    "refresh_provider_screen",
                    "Check Blinkit again",
                    "read_only"
                ),
                stop
            );
        }
        if ("provider_screen_unexpected".equals(code)) {
            return issue(
                code,
                "user_attention",
                "pause_task",
                "Blinkit needs attention",
                "Open the expected Blinkit screen before continuing.",
                action("open_blinkit", "Open Blinkit", "user_guidance"),
                action(
                    "refresh_provider_screen",
                    "Check screen again",
                    "read_only"
                ),
                stop
            );
        }
        if ("speech_provider_unavailable".equals(code)) {
            return issue(
                code,
                "connection_blocked",
                "pause_task",
                "Voice service unavailable",
                "Voice input is temporarily unavailable. No phone action ran.",
                action("retry_speech", "Try voice again", "read_only"),
                stop
            );
        }
        if ("search_no_match".equals(code)) {
            return issue(
                code,
                "search_refinement",
                "pause_current_item",
                "No matching product found",
                "Refine this item or skip it before the task continues.",
                action("refine_search", "Refine search", "user_guidance"),
                stop
            );
        }
        if ("search_failed".equals(code)) {
            return issue(
                code,
                "safe_failure",
                "pause_current_item",
                "Blinkit search did not finish",
                "The search can be refreshed without changing the cart.",
                action("refresh_choices", "Search again", "read_only"),
                stop
            );
        }
        if ("search_choice_expired".equals(code)) {
            return issue(
                code,
                "search_refinement",
                "pause_current_item",
                "Product choices expired",
                "Refresh the choices before selecting a product.",
                action(
                    "refresh_choices",
                    "Refresh choices",
                    "read_only"
                ),
                stop
            );
        }
        if ("mutation_verified_not_applied".equals(code)) {
            return issue(
                code,
                "safe_failure",
                "pause_current_item",
                "Cart change was not applied",
                "A fresh check proved the requested cart change did not happen.",
                new RecoveryAction(
                    2,
                    "retry_verified_not_applied",
                    "Try the cart change again",
                    "verified_not_applied_only"
                ),
                stop
            );
        }
        if ("mutation_ambiguous".equals(code)) {
            return issue(
                code,
                "reconciliation",
                "stop_queue",
                "Checking what happened",
                "The cart change will not be repeated until its result is known.",
                action(
                    "check_cart_again",
                    "Check cart again",
                    "read_only"
                ),
                stop
            );
        }
        if ("reconciliation_required".equals(code)) {
            return issue(
                code,
                "reconciliation",
                "stop_queue",
                "Cart verification required",
                "JaldiAI must read the current cart before any retry.",
                action(
                    "check_cart_again",
                    "Check cart again",
                    "read_only"
                ),
                stop
            );
        }
        if ("checkout_changed".equals(code)) {
            return issue(
                code,
                "checkout_review",
                "pause_task",
                "Checkout details changed",
                "Review fresh checkout details before confirming anything.",
                action(
                    "refresh_checkout",
                    "Review checkout again",
                    "read_only"
                ),
                stop
            );
        }
        if ("checkout_expired".equals(code)) {
            return issue(
                code,
                "checkout_review",
                "pause_task",
                "Checkout review expired",
                "A fresh checkout review is required. Nothing was ordered.",
                action(
                    "refresh_checkout",
                    "Refresh checkout",
                    "read_only"
                ),
                stop
            );
        }
        if ("checkout_blocked".equals(code)) {
            return issue(
                code,
                "checkout_review",
                "pause_task",
                "Checkout needs attention",
                "Resolve the checkout issue in Blinkit before continuing.",
                action("open_blinkit", "Open Blinkit", "user_guidance"),
                action(
                    "refresh_checkout",
                    "Check checkout again",
                    "read_only"
                ),
                stop
            );
        }
        if ("final_dispatch_ambiguous".equals(code)) {
            return issue(
                code,
                "final_dispatch_attention",
                "terminal_hold",
                "Order status needs verification",
                "JaldiAI will not place the order again while its status is unknown.",
                action(
                    "check_order_status",
                    "Check recent orders",
                    "read_only"
                ),
                stop
            );
        }
        if ("final_dispatch_blocked".equals(code)) {
            return issue(
                code,
                "final_dispatch_attention",
                "terminal_hold",
                "Order was not placed",
                "Return to checkout review before attempting a new order.",
                action(
                    "refresh_checkout",
                    "Review checkout again",
                    "read_only"
                ),
                stop
            );
        }
        throw new IllegalArgumentException("unknown companion issue code");
    }

    static CompanionIssueV2 validateCanonical(
        int version,
        String code,
        String treatment,
        String queueBehavior,
        String title,
        String detail,
        List<RecoveryAction> actions,
        String eventKind
    ) {
        if (version != 2) {
            throw new IllegalArgumentException("unsupported companion issue");
        }
        CompanionIssueV2 expected = canonical(code);
        if (
            !expected.treatment.equals(treatment)
                || !expected.queueBehavior.equals(queueBehavior)
                || !expected.title.equals(title)
                || !expected.detail.equals(detail)
                || actions == null
                || actions.size() != expected.recoveryActions.size()
                || actions.size() > 3
        ) {
            throw new IllegalArgumentException(
                "noncanonical companion issue"
            );
        }
        for (int index = 0; index < actions.size(); index += 1) {
            RecoveryAction actual = actions.get(index);
            RecoveryAction wanted = expected.recoveryActions.get(index);
            if (
                actual.version != 2
                    || !wanted.actionId.equals(actual.actionId)
                    || !wanted.label.equals(actual.label)
                    || !wanted.safety.equals(actual.safety)
            ) {
                throw new IllegalArgumentException(
                    "unsafe recovery action"
                );
            }
        }
        boolean ambiguity =
            "mutation_ambiguous".equals(code)
                || "reconciliation_required".equals(code)
                || "final_dispatch_ambiguous".equals(code);
        if (
            ambiguity
                ? !"ambiguous".equals(eventKind)
                : !"blocked".equals(eventKind)
        ) {
            throw new IllegalArgumentException(
                "issue and event kind mismatch"
            );
        }
        if (
            ("reconciliation".equals(expected.treatment)
                || "final_dispatch_ambiguous".equals(code))
                && expected.hasMutationRetry()
        ) {
            throw new IllegalArgumentException(
                "ambiguous issue cannot retry mutation"
            );
        }
        return expected;
    }

    boolean hasMutationRetry() {
        for (RecoveryAction action : recoveryActions) {
            if ("retry_verified_not_applied".equals(action.actionId)) {
                return true;
            }
        }
        return false;
    }

    String eyebrow() {
        if ("connection_blocked".equals(treatment)) return "CONNECTION PAUSED";
        if ("user_attention".equals(treatment)) return "ACTION NEEDED";
        if ("search_refinement".equals(treatment)) return "REFINE SEARCH";
        if ("reconciliation".equals(treatment)) return "RECONCILING";
        if ("checkout_review".equals(treatment)) return "CHECKOUT REVIEW";
        if ("final_dispatch_attention".equals(treatment)) {
            return "ORDER STATUS";
        }
        return "TASK PAUSED SAFELY";
    }

    String talkBackDescription() {
        StringBuilder result = new StringBuilder();
        result.append(eyebrow()).append(". ")
            .append(title).append(". ")
            .append(detail);
        if ("stop_queue".equals(queueBehavior)) {
            result.append(
                " The queue is stopped until verification completes."
            );
        } else if ("terminal_hold".equals(queueBehavior)) {
            result.append(" No final order action will be repeated.");
        } else {
            result.append(" The task is paused.");
        }
        result.append(" Recovery options: ");
        for (int index = 0; index < recoveryActions.size(); index += 1) {
            if (index > 0) result.append(", ");
            result.append(recoveryActions.get(index).label);
        }
        if (recoveryInteraction == null) {
            result.append(
                ". Hold the companion to speak an option. "
                    + "The card itself does not run actions."
            );
        } else {
            result.append(
                ". Safe server recovery actions are available. "
                    + "Double tap an enabled option, or hold the "
                    + "companion to speak."
            );
        }
        return result.toString();
    }

    private static CompanionIssueV2 issue(
        String code,
        String treatment,
        String queueBehavior,
        String title,
        String detail,
        RecoveryAction... actions
    ) {
        return new CompanionIssueV2(
            code,
            treatment,
            queueBehavior,
            title,
            detail,
            null,
            actions
        );
    }

    private static RecoveryAction action(
        String actionId,
        String label,
        String safety
    ) {
        return new RecoveryAction(2, actionId, label, safety);
    }
}
