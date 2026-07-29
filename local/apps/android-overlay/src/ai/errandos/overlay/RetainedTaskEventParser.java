package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class RetainedTaskEventParser {
    private static final Set<String> KINDS = new HashSet<String>(
        Arrays.asList(
            "task_started",
            "step_started",
            "searching",
            "options_ready",
            "selection_accepted",
            "mutation_started",
            "mutation_verified",
            "moving_to_next_step",
            "reviewing_cart",
            "checkout_ready",
            "waiting_for_user",
            "blocked",
            "ambiguous",
            "cancelled",
            "completed"
        )
    );
    private static final Set<String> CHOICE_IDS = new HashSet<String>(
        Arrays.asList(
            "add_more",
            "keep_shopping",
            "review_cart",
            "review_checkout",
            "use_current_payment",
            "use_cod",
            "stop"
        )
    );

    static final class Snapshot {
        final String taskId;
        final int afterSequence;
        final int earliestSequence;
        final int latestSequence;
        final boolean resetRequired;
        final List<RetainedTaskEvent> events;
        final TaskChecklistState.ResetSnapshot resetSnapshot;
        final OverlayPresentation resetPresentation;
        final OverlayPresentation resetFinalCartPresentation;

        Snapshot(
            String taskId,
            int afterSequence,
            int earliestSequence,
            int latestSequence,
            boolean resetRequired,
            List<RetainedTaskEvent> events,
            TaskChecklistState.ResetSnapshot resetSnapshot,
            OverlayPresentation resetPresentation,
            OverlayPresentation resetFinalCartPresentation
        ) {
            this.taskId = taskId;
            this.afterSequence = afterSequence;
            this.earliestSequence = earliestSequence;
            this.latestSequence = latestSequence;
            this.resetRequired = resetRequired;
            this.events = events;
            this.resetSnapshot = resetSnapshot;
            this.resetPresentation = resetPresentation;
            this.resetFinalCartPresentation = resetFinalCartPresentation;
        }

        boolean shouldReplayAnnouncements() {
            return !resetRequired;
        }
    }

    private final OverlayPresentationParser presentationParser;

    RetainedTaskEventParser(OverlayPresentationParser presentationParser) {
        this.presentationParser = presentationParser;
    }

    Snapshot parseSnapshot(JSONObject payload) throws Exception {
        if (payload == null || payload.optInt("version", -1) != 2) {
            throw new IllegalArgumentException("unsupported event snapshot");
        }
        String taskId = identifier(payload, "taskId", "task");
        int afterSequence = integer(payload, "afterSequence", -1);
        int earliestSequence = integer(payload, "earliestSequence", 0);
        int latestSequence = integer(payload, "latestSequence", -1);
        if (
            earliestSequence < 0
                || latestSequence < -1
                || (latestSequence >= 0 && earliestSequence > latestSequence + 1)
        ) {
            throw new IllegalArgumentException("invalid retained bounds");
        }
        JSONArray rawEvents = payload.getJSONArray("events");
        if (rawEvents.length() > 256) {
            throw new IllegalArgumentException("oversized event snapshot");
        }
        List<RetainedTaskEvent> events =
            new ArrayList<RetainedTaskEvent>();
        for (int index = 0; index < rawEvents.length(); index += 1) {
            events.add(parseEvent(rawEvents.getJSONObject(index), taskId));
        }
        boolean resetRequired = payload.getBoolean("resetRequired");
        ParsedReset parsedReset = resetRequired
            ? parseResetSnapshot(
                payload.optJSONObject("snapshot"),
                taskId,
                latestSequence
            )
            : null;
        return new Snapshot(
            taskId,
            afterSequence,
            earliestSequence,
            latestSequence,
            resetRequired,
            events,
            parsedReset == null ? null : parsedReset.checklist,
            parsedReset == null ? null : parsedReset.presentation,
            parsedReset == null
                ? null
                : parsedReset.finalCartPresentation
        );
    }

    private static final class ParsedReset {
        final TaskChecklistState.ResetSnapshot checklist;
        final OverlayPresentation presentation;
        final OverlayPresentation finalCartPresentation;

        ParsedReset(
            TaskChecklistState.ResetSnapshot checklist,
            OverlayPresentation presentation,
            OverlayPresentation finalCartPresentation
        ) {
            this.checklist = checklist;
            this.presentation = presentation;
            this.finalCartPresentation = finalCartPresentation;
        }
    }

    private static final class ResetItemSource {
        final int index;
        final int total;
        final String title;
        final String detail;

        ResetItemSource(int index, int total, String title, String detail) {
            this.index = index;
            this.total = total;
            this.title = title;
            this.detail = detail;
        }
    }

    private ParsedReset parseResetSnapshot(
        JSONObject projection,
        String envelopeTaskId,
        int envelopeLatestSequence
    ) throws Exception {
        if (projection == null || projection.optInt("version", -1) != 2) {
            throw new IllegalArgumentException(
                "retention reset missing authoritative snapshot"
            );
        }
        String taskId = identifier(projection, "taskId", "task");
        if (!envelopeTaskId.equals(taskId)) {
            throw new IllegalArgumentException("reset task mismatch");
        }
        int taskRevision = integer(projection, "taskRevision", 0);
        int latestSequence = integer(projection, "latestSequence", 0);
        if (latestSequence != envelopeLatestSequence) {
            throw new IllegalArgumentException("reset cursor mismatch");
        }
        RetainedTaskEvent latest = parseEvent(
            projection.getJSONObject("latestEvent"),
            taskId
        );
        if (
            latest.sequence != latestSequence
                || latest.taskRevision != taskRevision
        ) {
            throw new IllegalArgumentException("reset latest event mismatch");
        }

        JSONArray rawItems = projection.getJSONArray("items");
        if (rawItems.length() > 256) {
            throw new IllegalArgumentException("oversized reset items");
        }
        List<ResetItemSource> sources = new ArrayList<ResetItemSource>();
        Set<Integer> positions = new HashSet<Integer>();
        int declaredTotal = 0;
        for (int index = 0; index < rawItems.length(); index += 1) {
            JSONObject raw = rawItems.getJSONObject(index);
            int position = integer(raw, "index", 1);
            int total = integer(raw, "total", 1);
            if (
                position > total
                    || !positions.add(position)
                    || (declaredTotal > 0 && declaredTotal != total)
            ) {
                throw new IllegalArgumentException("invalid reset item");
            }
            declaredTotal = total;
            sources.add(new ResetItemSource(
                position,
                total,
                exact(raw, "title", 300),
                resetItemDetail(raw)
            ));
        }

        int completed = 0;
        JSONObject progress = projection.optJSONObject("progress");
        if (progress != null) {
            completed = integer(progress, "completed", 0);
            int progressTotal = integer(progress, "total", 0);
            if (
                completed > progressTotal
                    || (
                        declaredTotal > 0
                            && progressTotal != declaredTotal
                    )
            ) {
                throw new IllegalArgumentException("invalid reset progress");
            }
            declaredTotal = progressTotal;
        }
        if (declaredTotal != sources.size()) {
            throw new IllegalArgumentException(
                "incomplete reset item projection"
            );
        }

        int activePosition = latest.currentItem;
        JSONObject latestItem = projection
            .getJSONObject("latestEvent")
            .optJSONObject("item");
        if (latestItem != null) {
            activePosition = integer(latestItem, "index", 1);
        }
        TaskChecklistState.Phase activePhase =
            TaskChecklistState.phaseForEventKind(latest.kind);
        List<TaskChecklistState.ResetItem> resetItems =
            new ArrayList<TaskChecklistState.ResetItem>();
        java.util.Collections.sort(
            sources,
            new java.util.Comparator<ResetItemSource>() {
                @Override
                public int compare(
                    ResetItemSource left,
                    ResetItemSource right
                ) {
                    return left.index - right.index;
                }
            }
        );
        for (ResetItemSource source : sources) {
            boolean verified = source.index <= completed;
            TaskChecklistState.Phase phase = verified
                ? TaskChecklistState.Phase.VERIFIED
                : source.index == activePosition
                    ? activePhase
                    : TaskChecklistState.Phase.PENDING;
            resetItems.add(new TaskChecklistState.ResetItem(
                source.index,
                source.index == activePosition ? latest.stepId : null,
                source.title,
                source.index == activePosition && latest.detail != null
                    ? latest.detail
                    : source.detail,
                phase,
                verified
            ));
        }

        boolean terminal = latest.isTerminal()
            || (
                projection.optBoolean("terminal", false)
                    && !"ambiguous".equals(latest.kind)
            );
        if ("ambiguous".equals(latest.kind)) terminal = false;
        if (
            terminal
                && !"completed".equals(latest.kind)
                && !"cancelled".equals(latest.kind)
        ) {
            throw new IllegalArgumentException(
                "unsupported reset terminal state"
            );
        }

        OverlayPresentation resetPresentation = null;
        JSONObject safe = projection.optJSONObject("safePresentation");
        if (safe != null) {
            OverlayPresentation parsed = presentationParser.parse(
                safe,
                latest.detail == null ? latest.title : latest.detail,
                legacyState(latest.kind)
            );
            if (!parsed.structured) {
                throw new IllegalArgumentException(
                    "invalid reset safe presentation"
                );
            }
            resetPresentation = parsed;
        }
        OverlayPresentation resetFinalCartPresentation = null;
        OverlayPresentation.CartSummary resetFinalCart =
            parseFinalCartSummary(
                projection.optJSONObject("finalCartSummary"),
                taskId
            );
        if (resetFinalCart == null) {
            resetFinalCart = latest.finalCartSummary;
        }
        if (resetFinalCart != null) {
            resetFinalCartPresentation =
                TaskEventPresentationFactory.createFinalCartPresentation(
                    copyForResetPresentation(
                        latest,
                        resetFinalCart,
                        resetPresentation
                    ),
                    latest.operationId
                );
            resetPresentation = resetFinalCartPresentation;
        } else if (latest.issue != null) {
            resetPresentation = TaskEventPresentationFactory.create(
                copyForResetPresentation(latest, null, null),
                latest.operationId
            );
        } else if ("cancelled".equals(latest.kind)) {
            // A retained reset is authoritative historical state. Ignore an
            // obsolete error-styled safePresentation and rebuild cancellation
            // with the neutral terminal treatment.
            resetPresentation = TaskEventPresentationFactory.create(
                copyForResetPresentation(latest, null, null),
                latest.operationId
            );
        }
        return new ParsedReset(
            new TaskChecklistState.ResetSnapshot(
                taskId,
                latestSequence,
                taskRevision,
                declaredTotal,
                activePhase,
                latest.title,
                terminal,
                resetItems
            ),
            resetPresentation,
            resetFinalCartPresentation
        );
    }

    private static RetainedTaskEvent copyForResetPresentation(
        RetainedTaskEvent source,
        OverlayPresentation.CartSummary finalCartSummary,
        OverlayPresentation safePresentation
    ) {
        return new RetainedTaskEvent(
            source.eventId,
            source.taskId,
            source.taskRevision,
            source.operationId,
            source.stepId,
            source.sequence,
            source.kind,
            source.title,
            source.detail,
            source.currentItem,
            source.totalItems,
            source.occurredAtEpochMs,
            source.announcementChannel,
            source.announcementText,
            source.interaction,
            source.issue,
            finalCartSummary,
            safePresentation,
            source.isTerminal()
        );
    }

    private static String resetItemDetail(JSONObject raw) throws Exception {
        List<String> parts = new ArrayList<String>();
        String requested = optional(raw, "requestedLabel", 300);
        String packSize = optional(raw, "packSize", 100);
        String price = optional(raw, "price", 100);
        if (requested != null) parts.add(requested);
        if (packSize != null) parts.add(packSize);
        if (raw.has("quantity") && !raw.isNull("quantity")) {
            parts.add("Qty " + integer(raw, "quantity", 1));
        }
        if (price != null) parts.add(price);
        if (parts.isEmpty()) return null;
        StringBuilder detail = new StringBuilder();
        for (String part : parts) {
            if (detail.length() > 0) detail.append(" · ");
            detail.append(part);
        }
        return detail.toString();
    }

    private RetainedTaskEvent parseEvent(
        JSONObject event,
        String snapshotTaskId
    ) throws Exception {
        if (event.optInt("version", -1) != 2) {
            throw new IllegalArgumentException("unsupported task event");
        }
        String taskId = identifier(event, "taskId", "task");
        if (!snapshotTaskId.equals(taskId)) {
            throw new IllegalArgumentException("event task mismatch");
        }
        String kind = exact(event, "kind", 80);
        if (!KINDS.contains(kind)) {
            throw new IllegalArgumentException("unknown event kind");
        }
        JSONObject position = event.optJSONObject("itemPosition");
        int currentItem = 0;
        int totalItems = 0;
        if (position != null) {
            currentItem = integer(position, "current", 1);
            totalItems = integer(position, "total", currentItem);
            if (currentItem > totalItems) {
                throw new IllegalArgumentException("invalid item position");
            }
        }
        JSONObject announcement = event.optJSONObject("announcement");
        String announcementChannel = null;
        String announcementText = null;
        if (announcement != null) {
            announcementChannel = exact(announcement, "channel", 40);
            if (
                !"speech_and_visual".equals(announcementChannel)
                    && !"visual_only".equals(announcementChannel)
            ) {
                throw new IllegalArgumentException("invalid announcement");
            }
            announcementText = exact(announcement, "text", 500);
        }
        OverlayPresentation.CompletionInteraction interaction =
            parseInteraction(event.optJSONObject("interaction"), taskId);
        OverlayPresentation.CartSummary finalCartSummary =
            parseFinalCartSummary(
                event.optJSONObject("finalCartSummary"),
                taskId
            );
        String title = exact(event, "title", 200);
        String detail = optional(event, "detail", 500);
        CompanionIssueV2 issue = parseIssue(
            event,
            kind,
            interaction,
            finalCartSummary,
            taskId
        );
        JSONObject safe = event.optJSONObject("safePresentation");
        OverlayPresentation safePresentation = safe == null
            ? null
            : presentationParser.parse(
                safe,
                detail == null ? title : detail,
                legacyState(kind)
            );
        boolean terminal = "completed".equals(kind)
            || "cancelled".equals(kind)
            || (
                event.optBoolean("terminal", false)
                    && !"ambiguous".equals(kind)
            );
        return new RetainedTaskEvent(
            exact(event, "eventId", 160),
            taskId,
            integer(event, "taskRevision", 0),
            optionalIdentifier(event, "operationId", "operation"),
            optional(event, "stepId", 160),
            integer(event, "sequence", 0),
            kind,
            title,
            detail,
            currentItem,
            totalItems,
            timestamp(event, "occurredAt"),
            announcementChannel,
            announcementText,
            interaction,
            issue,
            finalCartSummary,
            safePresentation,
            terminal
        );
    }

    private CompanionIssueV2 parseIssue(
        JSONObject event,
        String eventKind,
        OverlayPresentation.CompletionInteraction interaction,
        OverlayPresentation.CartSummary finalCartSummary,
        String eventTaskId
    ) throws Exception {
        if (!event.has("issue") || event.isNull("issue")) {
            if (
                event.has("recoveryInteraction")
                    && !event.isNull("recoveryInteraction")
            ) {
                throw new IllegalArgumentException(
                    "recovery interaction requires issue"
                );
            }
            return null;
        }
        JSONObject issue = event.optJSONObject("issue");
        if (issue == null) {
            throw new IllegalArgumentException("invalid companion issue");
        }
        if (
            interaction != null
                || finalCartSummary != null
                || (
                    event.has("interaction")
                        && !event.isNull("interaction")
                )
                || (
                    event.has("finalCartSummary")
                        && !event.isNull("finalCartSummary")
                )
        ) {
            throw new IllegalArgumentException(
                "issue cannot include interactive or cart truth"
            );
        }
        JSONArray rawActions = issue.getJSONArray("recoveryActions");
        if (rawActions.length() < 1 || rawActions.length() > 3) {
            throw new IllegalArgumentException(
                "invalid recovery action count"
            );
        }
        List<CompanionIssueV2.RecoveryAction> actions =
            new ArrayList<CompanionIssueV2.RecoveryAction>();
        Set<String> seen = new HashSet<String>();
        for (int index = 0; index < rawActions.length(); index += 1) {
            JSONObject raw = rawActions.getJSONObject(index);
            String actionId = exact(raw, "actionId", 80);
            if (!seen.add(actionId)) {
                throw new IllegalArgumentException(
                    "duplicate recovery action"
                );
            }
            actions.add(new CompanionIssueV2.RecoveryAction(
                integer(raw, "version", 2),
                actionId,
                exact(raw, "label", 120),
                exact(raw, "safety", 80)
            ));
        }
        CompanionIssueV2 canonical = CompanionIssueV2.validateCanonical(
            integer(issue, "version", 2),
            exact(issue, "code", 80),
            exact(issue, "treatment", 80),
            exact(issue, "queueBehavior", 80),
            exact(issue, "title", 200),
            exact(issue, "detail", 500),
            actions,
            eventKind
        );
        JSONObject rawBinding = event.optJSONObject("recoveryInteraction");
        if (rawBinding == null) return canonical;
        requireExactKeys(
            rawBinding,
            new HashSet<String>(Arrays.asList(
                "version",
                "interactionId",
                "operationId",
                "stepId",
                "taskId",
                "taskRevision",
                "expiresAt"
            )),
            "recovery interaction"
        );
        if (rawBinding.optInt("version", -1) != 2) {
            throw new IllegalArgumentException(
                "unsupported recovery interaction"
            );
        }
        String taskId = identifier(rawBinding, "taskId", "task");
        int taskRevision = integer(rawBinding, "taskRevision", 0);
        String operationId = identifier(
            rawBinding,
            "operationId",
            "operation"
        );
        String stepId = exact(rawBinding, "stepId", 256);
        String interactionId = exact(
            rawBinding,
            "interactionId",
            160
        );
        if (
            !interactionId.matches(
                "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$"
            )
                || !stepId.matches(
                    "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
                )
                || !eventTaskId.equals(taskId)
                || taskRevision != integer(event, "taskRevision", 0)
                || !operationId.equals(
                    optionalIdentifier(
                        event,
                        "operationId",
                        "operation"
                    )
                )
                || !stepId.equals(optional(event, "stepId", 160))
        ) {
            throw new IllegalArgumentException(
                "recovery interaction identity mismatch"
            );
        }
        return canonical.withRecoveryInteraction(
            new RecoveryActionBinding(
                2,
                interactionId,
                operationId,
                stepId,
                taskId,
                taskRevision,
                timestamp(rawBinding, "expiresAt")
            )
        );
    }

    private OverlayPresentation.CartSummary parseFinalCartSummary(
        JSONObject summary,
        String taskId
    ) throws Exception {
        if (summary == null) return null;
        String status = exact(summary, "status", 20);
        if ("empty".equals(status)) {
            // Empty summaries may be shown as compact text, but they cannot
            // establish VERIFIED CART / NOT ORDERED truth.
            return null;
        }
        if (!"ready".equals(status)) {
            throw new IllegalArgumentException(
                "invalid final cart summary status"
            );
        }
        timestamp(summary, "inspectedAt");
        JSONArray rawLines = summary.getJSONArray("lines");
        if (rawLines.length() < 1 || rawLines.length() > 30) {
            throw new IllegalArgumentException("invalid final cart lines");
        }
        String subtotal = exact(summary, "subtotal", 80);
        List<OverlayPresentation.CartLine> lines =
            new ArrayList<OverlayPresentation.CartLine>();
        for (int index = 0; index < rawLines.length(); index += 1) {
            JSONObject raw = rawLines.getJSONObject(index);
            int quantity = raw.has("quantity") && !raw.isNull("quantity")
                ? integer(raw, "quantity", 1)
                : 1;
            if (quantity > 100) {
                throw new IllegalArgumentException(
                    "invalid final cart quantity"
                );
            }
            String price = exact(raw, "price", 80);
            String productId = optional(raw, "productId", 200);
            if (productId == null) {
                productId = taskId + "-line-" + (index + 1);
            }
            lines.add(new OverlayPresentation.CartLine(
                productId,
                exact(raw, "title", 300),
                quantity,
                price,
                price
            ));
        }
        return new OverlayPresentation.CartSummary(
            lines,
            subtotal,
            "Review delivery address",
            true,
            false
        );
    }

    private OverlayPresentation.CompletionInteraction parseInteraction(
        JSONObject interaction,
        String eventTaskId
    ) throws Exception {
        if (interaction == null) return null;
        if (interaction.optInt("version", -1) != 2) {
            throw new IllegalArgumentException("unsupported interaction");
        }
        String taskId = identifier(interaction, "taskId", "task");
        if (!eventTaskId.equals(taskId)) {
            throw new IllegalArgumentException("interaction task mismatch");
        }
        JSONArray rawChoices = interaction.getJSONArray("choices");
        if (rawChoices.length() < 1 || rawChoices.length() > 5) {
            throw new IllegalArgumentException("invalid completion choices");
        }
        List<OverlayPresentation.CompletionChoice> choices =
            new ArrayList<OverlayPresentation.CompletionChoice>();
        Set<String> seen = new HashSet<String>();
        for (int index = 0; index < rawChoices.length(); index += 1) {
            JSONObject raw = rawChoices.getJSONObject(index);
            String choiceId = exact(raw, "choiceId", 40);
            if (!CHOICE_IDS.contains(choiceId) || !seen.add(choiceId)) {
                throw new IllegalArgumentException("invalid completion choice");
            }
            choices.add(new OverlayPresentation.CompletionChoice(
                choiceId,
                exact(raw, "label", 120),
                raw.getBoolean("enabled"),
                optional(raw, "disabledReason", 200)
            ));
        }
        return new OverlayPresentation.CompletionInteraction(
            2,
            exact(interaction, "interactionId", 160),
            taskId,
            integer(interaction, "taskRevision", 0),
            timestamp(interaction, "expiresAt"),
            optional(interaction, "currentPaymentLabel", 80),
            choices
        );
    }

    private static String legacyState(String kind) {
        if ("completed".equals(kind)) return "success";
        if ("cancelled".equals(kind) || "blocked".equals(kind)) return "error";
        if ("ambiguous".equals(kind)) return "working";
        if (
            "options_ready".equals(kind)
                || "checkout_ready".equals(kind)
                || "waiting_for_user".equals(kind)
        ) {
            return "clarification";
        }
        return "working";
    }

    private static void requireExactKeys(
        JSONObject object,
        Set<String> allowed,
        String label
    ) {
        java.util.Iterator<String> keys = object.keys();
        Set<String> seen = new HashSet<String>();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!allowed.contains(key)) {
                throw new IllegalArgumentException(
                    label + " contains unsupported fields"
                );
            }
            seen.add(key);
        }
        if (!seen.equals(allowed)) {
            throw new IllegalArgumentException(
                label + " is missing required fields"
            );
        }
    }

    private static int integer(
        JSONObject object,
        String field,
        int minimum
    ) throws Exception {
        int value = object.getInt(field);
        if (value < minimum) {
            throw new IllegalArgumentException("invalid " + field);
        }
        return value;
    }

    private static long timestamp(JSONObject object, String field)
        throws Exception {
        long value = object.getLong(field);
        if (value < 0L) {
            throw new IllegalArgumentException("invalid " + field);
        }
        return value;
    }

    private static String exact(
        JSONObject object,
        String field,
        int maximum
    ) throws Exception {
        String value = object.getString(field);
        if (
            value.isEmpty()
                || !value.equals(value.trim())
                || value.length() > maximum
        ) {
            throw new IllegalArgumentException("invalid " + field);
        }
        return value;
    }

    private static String optional(
        JSONObject object,
        String field,
        int maximum
    ) throws Exception {
        if (!object.has(field) || object.isNull(field)) return null;
        return exact(object, field, maximum);
    }

    private static String identifier(
        JSONObject object,
        String field,
        String kind
    ) throws Exception {
        String value = exact(object, field, 100);
        if (
            !value.matches(
                "^" + java.util.regex.Pattern.quote(kind)
                    + "_[A-Za-z0-9-]{8,80}$"
            )
        ) {
            throw new IllegalArgumentException("invalid " + field);
        }
        return value;
    }

    private static String optionalIdentifier(
        JSONObject object,
        String field,
        String kind
    ) throws Exception {
        if (!object.has(field) || object.isNull(field)) return null;
        return identifier(object, field, kind);
    }
}
