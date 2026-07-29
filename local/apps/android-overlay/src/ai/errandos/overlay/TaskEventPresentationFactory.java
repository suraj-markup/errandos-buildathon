package ai.errandos.overlay;

final class TaskEventPresentationFactory {
    private TaskEventPresentationFactory() {}

    static OverlayPresentation create(
        RetainedTaskEvent event,
        String operationFallback
    ) {
        OverlayPresentation finalCart = createFinalCartPresentation(
            event,
            operationFallback
        );
        if (finalCart != null && event.interaction == null) {
            return finalCart;
        }
        if (event.issue != null) {
            return createIssuePresentation(event, operationFallback);
        }
        if (
            event.safePresentation != null
                && event.interaction == null
                && !"cancelled".equals(event.kind)
        ) {
            return event.safePresentation;
        }
        String mode = mode(event.kind);
        String tone = OverlayPresentation.toneFromMode(mode);
        String detail = event.detail == null ? event.title : event.detail;
        OverlayPresentation.Card card = event.interaction == null
            ? new OverlayPresentation.Card(
                "compact_status",
                tone,
                "cancelled".equals(event.kind)
                    ? "TASK STOPPED"
                    : OverlayPresentation.headlineForMode(mode),
                detail,
                java.util.Collections
                    .<OverlayPresentation.ProductChoice>emptyList(),
                null
            )
            : new OverlayPresentation.Card(
                "completion_choices",
                "attention",
                "WHAT NEXT?",
                "Tap a choice, or hold to speak.",
                event.interaction
            );
        String operationId = event.operationId == null
            ? operationFallback
            : event.operationId;
        OverlayPresentation.TaskProgress task =
            event.safePresentation != null
                && !"cancelled".equals(event.kind)
                ? event.safePresentation.task
                : operationId == null
                    ? null
            : new OverlayPresentation.TaskProgress(
                1,
                event.taskId,
                null,
                operationId,
                event.title,
                detail,
                stage(event.kind),
                event.sequence,
                event.currentItem,
                event.totalItems,
                false,
                "not_cancellable",
                event.isTerminal()
            );
        boolean persistent = event.interaction != null
            || event.isTerminal()
            || "blocked".equals(event.kind)
            || "ambiguous".equals(event.kind);
        return new OverlayPresentation(
            1,
            mode,
            "overlay_card",
            null,
            null,
            null,
            task,
            card,
            event.announcementText == null
                ? event.title
                : event.announcementText,
            "en-IN",
            !persistent,
            6500L,
            true,
            true
        );
    }

    private static OverlayPresentation createIssuePresentation(
        RetainedTaskEvent event,
        String operationFallback
    ) {
        CompanionIssueV2 issue = event.issue;
        String operationId = event.operationId == null
            ? operationFallback
            : event.operationId;
        String mode =
            "reconciliation".equals(issue.treatment)
                    || "final_dispatch_ambiguous".equals(issue.code)
                ? "ambiguous"
                : "connection_blocked".equals(issue.treatment)
                    ? "disconnected"
                    : "error";
        String tone =
            "reconciliation".equals(issue.treatment)
                    || "final_dispatch_attention".equals(issue.treatment)
                ? "ambiguous"
                : "user_attention".equals(issue.treatment)
                        || "checkout_review".equals(issue.treatment)
                    ? "attention"
                    : "error";
        OverlayPresentation.TaskProgress task =
            event.safePresentation != null
                    && event.safePresentation.task != null
                ? event.safePresentation.task
                : operationId == null
                    ? null
                    : new OverlayPresentation.TaskProgress(
                        1,
                        event.taskId,
                        null,
                        operationId,
                        issue.title,
                        issue.detail,
                        "ambiguous".equals(event.kind)
                            ? "ambiguous"
                            : "waiting_for_choice",
                        event.sequence,
                        event.currentItem,
                        event.totalItems,
                        false,
                        "reconciliation".equals(issue.treatment)
                            ? "reconcile_only"
                            : "not_cancellable",
                        false
                    );
        return new OverlayPresentation(
            1,
            mode,
            "overlay_card",
            null,
            null,
            null,
            task,
            new OverlayPresentation.Card(
                "companion_issue",
                tone,
                issue.title,
                issue.detail,
                issue
            ),
            event.announcementText == null
                ? issue.title + ". " + issue.detail
                : event.announcementText,
            event.safePresentation == null
                ? "en-IN"
                : event.safePresentation.languageCode,
            false,
            6500L,
            true,
            true
        );
    }

    static OverlayPresentation createFinalCartPresentation(
        RetainedTaskEvent event,
        String operationFallback
    ) {
        if (event == null || event.finalCartSummary == null) return null;
        String operationId = event.operationId == null
            ? operationFallback
            : event.operationId;
        OverlayPresentation.TaskProgress task =
            event.safePresentation != null
                    && event.safePresentation.task != null
                ? event.safePresentation.task
                : operationId == null
                    ? null
                    : new OverlayPresentation.TaskProgress(
                        1,
                        event.taskId,
                        null,
                        operationId,
                        event.title,
                        event.detail == null ? event.title : event.detail,
                        stage(event.kind),
                        event.sequence,
                        event.currentItem,
                        event.totalItems,
                        false,
                        "not_cancellable",
                        event.isTerminal()
                    );
        OverlayPresentation.CartSummary cart = event.finalCartSummary;
        String detail = cart.lines.size()
            + (cart.lines.size() == 1
                ? " verified line · "
                : " verified lines · ")
            + "Subtotal "
            + cart.subtotal;
        return new OverlayPresentation(
            1,
            "success",
            "overlay_card",
            null,
            null,
            null,
            task,
            new OverlayPresentation.Card(
                "cart_summary",
                "success",
                "VERIFIED CART · NOT ORDERED",
                detail,
                java.util.Collections
                    .<OverlayPresentation.ProductChoice>emptyList(),
                null,
                cart
            ),
            event.announcementText == null
                ? event.title
                : event.announcementText,
            event.safePresentation == null
                ? "en-IN"
                : event.safePresentation.languageCode,
            false,
            6500L,
            true,
            true
        );
    }

    private static String mode(String kind) {
        if ("completed".equals(kind)) return "success";
        if ("ambiguous".equals(kind)) return "ambiguous";
        if ("cancelled".equals(kind)) return "idle";
        if ("blocked".equals(kind)) return "error";
        if (
            "options_ready".equals(kind)
                || "checkout_ready".equals(kind)
                || "waiting_for_user".equals(kind)
        ) {
            return "waiting_for_user";
        }
        if (
            "mutation_verified".equals(kind)
                || "reviewing_cart".equals(kind)
        ) {
            return "verifying";
        }
        return "acting";
    }

    private static String stage(String kind) {
        if ("searching".equals(kind) || "moving_to_next_step".equals(kind)) {
            return "searching";
        }
        if (
            "options_ready".equals(kind)
                || "checkout_ready".equals(kind)
                || "waiting_for_user".equals(kind)
                || "blocked".equals(kind)
        ) {
            return "waiting_for_choice";
        }
        if (
            "selection_accepted".equals(kind)
                || "mutation_started".equals(kind)
        ) {
            return "adding";
        }
        if (
            "mutation_verified".equals(kind)
                || "reviewing_cart".equals(kind)
        ) {
            return "verifying";
        }
        if ("completed".equals(kind)) return "completed";
        if ("cancelled".equals(kind)) return "cancelled";
        if ("ambiguous".equals(kind)) return "ambiguous";
        return "queued";
    }
}
