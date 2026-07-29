package ai.errandos.overlay;

final class RetainedTaskEvent {
    final String eventId;
    final String taskId;
    final int taskRevision;
    final String operationId;
    final String stepId;
    final int sequence;
    final String kind;
    final String title;
    final String detail;
    final int currentItem;
    final int totalItems;
    final long occurredAtEpochMs;
    final String announcementChannel;
    final String announcementText;
    final OverlayPresentation.CompletionInteraction interaction;
    final CompanionIssueV2 issue;
    final OverlayPresentation.CartSummary finalCartSummary;
    final OverlayPresentation safePresentation;
    private final boolean terminal;

    RetainedTaskEvent(
        String eventId,
        String taskId,
        int taskRevision,
        String operationId,
        String stepId,
        int sequence,
        String kind,
        String title,
        String detail,
        int currentItem,
        int totalItems,
        long occurredAtEpochMs,
        String announcementChannel,
        String announcementText,
        OverlayPresentation.CompletionInteraction interaction,
        OverlayPresentation safePresentation
    ) {
        this(
            eventId,
            taskId,
            taskRevision,
            operationId,
            stepId,
            sequence,
            kind,
            title,
            detail,
            currentItem,
            totalItems,
            occurredAtEpochMs,
            announcementChannel,
            announcementText,
            interaction,
            null,
            null,
            safePresentation,
            "completed".equals(kind) || "cancelled".equals(kind)
        );
    }

    RetainedTaskEvent(
        String eventId,
        String taskId,
        int taskRevision,
        String operationId,
        String stepId,
        int sequence,
        String kind,
        String title,
        String detail,
        int currentItem,
        int totalItems,
        long occurredAtEpochMs,
        String announcementChannel,
        String announcementText,
        OverlayPresentation.CompletionInteraction interaction,
        OverlayPresentation safePresentation,
        boolean terminal
    ) {
        this(
            eventId,
            taskId,
            taskRevision,
            operationId,
            stepId,
            sequence,
            kind,
            title,
            detail,
            currentItem,
            totalItems,
            occurredAtEpochMs,
            announcementChannel,
            announcementText,
            interaction,
            null,
            null,
            safePresentation,
            terminal
        );
    }

    RetainedTaskEvent(
        String eventId,
        String taskId,
        int taskRevision,
        String operationId,
        String stepId,
        int sequence,
        String kind,
        String title,
        String detail,
        int currentItem,
        int totalItems,
        long occurredAtEpochMs,
        String announcementChannel,
        String announcementText,
        OverlayPresentation.CompletionInteraction interaction,
        OverlayPresentation.CartSummary finalCartSummary,
        OverlayPresentation safePresentation,
        boolean terminal
    ) {
        this(
            eventId,
            taskId,
            taskRevision,
            operationId,
            stepId,
            sequence,
            kind,
            title,
            detail,
            currentItem,
            totalItems,
            occurredAtEpochMs,
            announcementChannel,
            announcementText,
            interaction,
            null,
            finalCartSummary,
            safePresentation,
            terminal
        );
    }

    RetainedTaskEvent(
        String eventId,
        String taskId,
        int taskRevision,
        String operationId,
        String stepId,
        int sequence,
        String kind,
        String title,
        String detail,
        int currentItem,
        int totalItems,
        long occurredAtEpochMs,
        String announcementChannel,
        String announcementText,
        OverlayPresentation.CompletionInteraction interaction,
        CompanionIssueV2 issue,
        OverlayPresentation.CartSummary finalCartSummary,
        OverlayPresentation safePresentation,
        boolean terminal
    ) {
        this.eventId = eventId;
        this.taskId = taskId;
        this.taskRevision = taskRevision;
        this.operationId = operationId;
        this.stepId = stepId;
        this.sequence = sequence;
        this.kind = kind;
        this.title = title;
        this.detail = detail;
        this.currentItem = currentItem;
        this.totalItems = totalItems;
        this.occurredAtEpochMs = occurredAtEpochMs;
        this.announcementChannel = announcementChannel;
        this.announcementText = announcementText;
        this.interaction = interaction;
        this.issue = issue;
        this.finalCartSummary = finalCartSummary;
        this.safePresentation = safePresentation;
        // Ambiguity is a read-only reconciliation phase, not a reason to
        // abandon the retained stream. A later reviewing_cart/completed or
        // cancelled event must still be observable.
        this.terminal = !"ambiguous".equals(kind) && terminal;
    }

    boolean isTerminal() {
        return terminal;
    }

    boolean speaks() {
        return "speech_and_visual".equals(announcementChannel)
            && announcementText != null;
    }
}
