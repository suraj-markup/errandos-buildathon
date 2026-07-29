package ai.errandos.overlay;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

final class OverlayRecoverySnapshot {
    static final int VERSION = 6;
    static final int MAX_ENCODED_BYTES = 64 * 1024;
    static final long MAX_AGE_MS = 10 * 60 * 1000L;

    static final class Restored {
        final OverlayPresentation presentation;
        final boolean expanded;

        Restored(OverlayPresentation presentation, boolean expanded) {
            this.presentation = presentation;
            this.expanded = expanded;
        }
    }

    private OverlayRecoverySnapshot() {}

    static String encode(
        OverlayPresentation presentation,
        boolean expanded,
        long savedAtEpochMs
    ) {
        if (presentation == null) return null;
        if (
            "cart_summary".equals(presentation.card.type)
                && (
                    presentation.card.cartSummary == null
                        || !presentation.card.cartSummary
                            .isVerifiedNotOrdered()
                )
        ) {
            return null;
        }
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            DataOutputStream output = new DataOutputStream(bytes);
            output.writeInt(VERSION);
            output.writeLong(savedAtEpochMs);
            write(output, presentation.mode);
            write(output, presentation.card.type);
            write(output, presentation.card.tone);
            write(output, presentation.card.headline);
            write(output, presentation.card.detail);
            output.writeInt(Math.min(10, presentation.card.options.size()));
            for (
                int index = 0;
                index < Math.min(10, presentation.card.options.size());
                index += 1
            ) {
                OverlayPresentation.ProductChoice option =
                    presentation.card.options.get(index);
                write(output, option.offerId);
                write(output, option.title);
                write(output, option.spokenLabel);
                write(output, option.packSize);
                write(output, option.price);
                write(output, option.imageUrl);
                write(output, option.unitPrice);
                write(output, option.availabilityConstraint);
                write(output, option.recommendationLabel);
            }
            OverlayPresentation.ProductSelectionBinding selection =
                presentation.card.selection;
            output.writeBoolean(selection != null);
            if (selection != null) {
                output.writeInt(selection.version);
                write(output, selection.clientId);
                write(output, selection.taskId);
                output.writeInt(selection.taskRevision);
                write(output, selection.interactionId);
                write(output, selection.selectionId);
                output.writeLong(selection.expiresAtEpochMs);
            }
            write(output, presentation.spokenText);
            write(output, presentation.languageCode);
            output.writeBoolean(presentation.autoCollapse);
            output.writeLong(presentation.collapseAfterMs);
            output.writeBoolean(presentation.keepVisibleWhileSpeaking);
            output.writeBoolean(presentation.structured);
            OverlayPresentation.TaskProgress task = presentation.task;
            output.writeBoolean(task != null);
            if (task != null) {
                output.writeInt(task.version);
                write(output, task.taskId);
                write(output, task.itemId);
                write(output, task.operationId);
                write(output, task.title);
                write(output, task.step);
                write(output, task.stage);
                output.writeInt(task.sequence);
                output.writeInt(task.currentItem);
                output.writeInt(task.totalItems);
                output.writeBoolean(task.cancellationAvailable);
                write(output, task.cancellationPolicy);
                output.writeBoolean(task.terminal);
            }
            OverlayPresentation.CompletionInteraction completion =
                presentation.card.completionInteraction;
            output.writeBoolean(completion != null);
            if (completion != null) {
                output.writeInt(completion.version);
                write(output, completion.interactionId);
                write(output, completion.taskId);
                output.writeInt(completion.taskRevision);
                output.writeLong(completion.expiresAtEpochMs);
                write(output, completion.currentPaymentLabel);
                output.writeInt(completion.choices.size());
                for (
                    int index = 0;
                    index < completion.choices.size();
                    index += 1
                ) {
                    OverlayPresentation.CompletionChoice choice =
                        completion.choices.get(index);
                    write(output, choice.choiceId);
                    write(output, choice.label);
                    output.writeBoolean(choice.enabled);
                    write(output, choice.disabledReason);
                }
            }
            OverlayPresentation.CartSummary cartSummary =
                presentation.card.cartSummary;
            output.writeBoolean(cartSummary != null);
            if (cartSummary != null) {
                output.writeInt(cartSummary.lines.size());
                for (OverlayPresentation.CartLine line : cartSummary.lines) {
                    write(output, line.productId);
                    write(output, line.name);
                    output.writeInt(line.quantity);
                    write(output, line.unitPrice);
                    write(output, line.lineTotal);
                }
                write(output, cartSummary.subtotal);
                write(output, cartSummary.addressLabel);
                output.writeBoolean(cartSummary.verified);
                output.writeBoolean(cartSummary.ordered);
            }
            CompanionIssueV2 issue = presentation.card.issue;
            output.writeBoolean(issue != null);
            if (issue != null) {
                write(output, issue.code);
                RecoveryActionBinding recovery =
                    issue.recoveryInteraction;
                output.writeBoolean(recovery != null);
                if (recovery != null) {
                    output.writeInt(recovery.version);
                    write(output, recovery.interactionId);
                    write(output, recovery.operationId);
                    write(output, recovery.stepId);
                    write(output, recovery.taskId);
                    output.writeInt(recovery.taskRevision);
                    output.writeLong(recovery.expiresAtEpochMs);
                }
            }
            output.writeBoolean(expanded);
            output.flush();
            byte[] raw = bytes.toByteArray();
            if (raw.length > MAX_ENCODED_BYTES) return null;
            return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        } catch (Exception ignored) {
            return null;
        }
    }

    static Restored decode(String encoded, long nowEpochMs) {
        if (
            encoded == null
                || encoded.isEmpty()
                || encoded.length() > MAX_ENCODED_BYTES * 2
        ) {
            return null;
        }
        try {
            byte[] raw = Base64.getUrlDecoder().decode(
                encoded.getBytes(StandardCharsets.US_ASCII)
            );
            if (raw.length > MAX_ENCODED_BYTES) return null;
            DataInputStream input = new DataInputStream(
                new ByteArrayInputStream(raw)
            );
            int snapshotVersion = input.readInt();
            if (
                snapshotVersion != 1
                    && snapshotVersion != 2
                    && snapshotVersion != 3
                    && snapshotVersion != 4
                    && snapshotVersion != 5
                    && snapshotVersion != VERSION
            ) {
                return null;
            }
            long savedAt = input.readLong();
            long age = nowEpochMs - savedAt;
            if (age < 0L || age > MAX_AGE_MS) return null;
            String mode = read(input, 100);
            String cardType = read(input, 100);
            String tone = read(input, 100);
            String headline = read(input, 300);
            String detail = read(input, 1000);
            int optionCount = input.readInt();
            if (optionCount < 0 || optionCount > 10) return null;
            List<OverlayPresentation.ProductChoice> options =
                new ArrayList<OverlayPresentation.ProductChoice>();
            for (int index = 0; index < optionCount; index += 1) {
                String offerId = required(read(input, 200));
                String title = required(read(input, 300));
                String spokenLabel = required(read(input, 300));
                String packSize = read(input, 100);
                String price = read(input, 100);
                options.add(
                    snapshotVersion >= 4
                        ? new OverlayPresentation.ProductChoice(
                            offerId,
                            title,
                            spokenLabel,
                            packSize,
                            price,
                            read(input, 2048),
                            read(input, 100),
                            read(input, 160),
                            read(input, 100)
                        )
                        : new OverlayPresentation.ProductChoice(
                            offerId,
                            title,
                            spokenLabel,
                            packSize,
                            price
                        )
                );
            }
            OverlayPresentation.ProductSelectionBinding selection = null;
            if (input.readBoolean()) {
                int version = input.readInt();
                String clientId = required(read(input, 200));
                String taskId = required(read(input, 100));
                int taskRevision = input.readInt();
                String interactionId = required(read(input, 200));
                String selectionId = required(read(input, 100));
                long expiresAt = input.readLong();
                if (
                    (version != 1 && version != 2)
                        || taskRevision < 0
                        || !identifier(taskId, "task")
                        || (
                            version == 1
                                && !identifier(
                                    interactionId,
                                    "clarification"
                                )
                        )
                        || !identifier(selectionId, "selection")
                ) {
                    return null;
                }
                selection = new OverlayPresentation.ProductSelectionBinding(
                    version,
                    clientId,
                    taskId,
                    taskRevision,
                    interactionId,
                    selectionId,
                    expiresAt
                );
            }
            String spokenText = required(read(input, 1000));
            String languageCode = required(read(input, 12));
            boolean autoCollapse = input.readBoolean();
            long collapseAfterMs = input.readLong();
            boolean keepVisibleWhileSpeaking = input.readBoolean();
            boolean structured = input.readBoolean();
            OverlayPresentation.TaskProgress task = null;
            if (snapshotVersion >= 2 && input.readBoolean()) {
                int taskVersion = input.readInt();
                String taskId = required(read(input, 100));
                String itemId = read(input, 100);
                String operationId = required(read(input, 100));
                String title = required(read(input, 120));
                String step = required(read(input, 200));
                String stage = required(read(input, 100));
                int sequence = input.readInt();
                int currentItem = input.readInt();
                int totalItems = input.readInt();
                boolean cancellationAvailable = input.readBoolean();
                String cancellationPolicy = required(read(input, 100));
                boolean terminal = input.readBoolean();
                if (
                    taskVersion != 1
                        || !identifier(taskId, "task")
                        || (itemId != null
                            && !identifier(itemId, "task_item"))
                        || !identifier(operationId, "operation")
                        || !allowedTaskStage(stage)
                        || sequence < 0
                        || currentItem < 0
                        || totalItems < 0
                        || (totalItems > 0 && currentItem > totalItems)
                        || !allowedCancellationPolicy(cancellationPolicy)
                        || cancellationAvailable
                            != (
                                "cancel_now".equals(cancellationPolicy)
                                    || "stop_after_current_step".equals(
                                        cancellationPolicy
                                    )
                            )
                        || terminal != terminalTaskStage(stage)
                ) {
                    return null;
                }
                task = new OverlayPresentation.TaskProgress(
                    taskVersion,
                    taskId,
                    itemId,
                    operationId,
                    title,
                    step,
                    stage,
                    sequence,
                    currentItem,
                    totalItems,
                    cancellationAvailable,
                    cancellationPolicy,
                    terminal
                );
            }
            OverlayPresentation.CompletionInteraction completion = null;
            if (snapshotVersion >= 3 && input.readBoolean()) {
                int completionVersion = input.readInt();
                String interactionId = required(read(input, 160));
                String completionTaskId = required(read(input, 100));
                int completionRevision = input.readInt();
                long expiresAt = input.readLong();
                String currentPaymentLabel = read(input, 80);
                int choiceCount = input.readInt();
                if (
                    completionVersion != 2
                        || !identifier(completionTaskId, "task")
                        || completionRevision < 0
                        || expiresAt < nowEpochMs
                        || choiceCount < 1
                        || choiceCount > 5
                ) {
                    return null;
                }
                List<OverlayPresentation.CompletionChoice> choices =
                    new ArrayList<OverlayPresentation.CompletionChoice>();
                java.util.HashSet<String> choiceIds =
                    new java.util.HashSet<String>();
                for (int index = 0; index < choiceCount; index += 1) {
                    String choiceId = required(read(input, 40));
                    String label = required(read(input, 120));
                    boolean enabled = input.readBoolean();
                    String disabledReason = read(input, 200);
                    if (
                        !allowedCompletionChoice(choiceId)
                            || !choiceIds.add(choiceId)
                    ) {
                        return null;
                    }
                    choices.add(new OverlayPresentation.CompletionChoice(
                        choiceId,
                        label,
                        enabled,
                        disabledReason
                    ));
                }
                completion = new OverlayPresentation.CompletionInteraction(
                    completionVersion,
                    interactionId,
                    completionTaskId,
                    completionRevision,
                    expiresAt,
                    currentPaymentLabel,
                    choices
                );
            }
            OverlayPresentation.CartSummary cartSummary = null;
            if (snapshotVersion >= 4 && input.readBoolean()) {
                int lineCount = input.readInt();
                if (lineCount < 1 || lineCount > 30) return null;
                List<OverlayPresentation.CartLine> lines =
                    new ArrayList<OverlayPresentation.CartLine>();
                for (int index = 0; index < lineCount; index += 1) {
                    String productId = required(read(input, 200));
                    String name = required(read(input, 300));
                    int quantity = input.readInt();
                    String unitPrice = required(read(input, 100));
                    String lineTotal = required(read(input, 100));
                    if (quantity < 1 || quantity > 100) return null;
                    lines.add(new OverlayPresentation.CartLine(
                        productId,
                        name,
                        quantity,
                        unitPrice,
                        lineTotal
                    ));
                }
                String subtotal = required(read(input, 100));
                String addressLabel = required(read(input, 100));
                boolean verified = snapshotVersion >= 5
                    && input.readBoolean();
                boolean ordered = snapshotVersion >= 5
                    ? input.readBoolean()
                    : true;
                cartSummary = new OverlayPresentation.CartSummary(
                    lines,
                    subtotal,
                    addressLabel,
                    verified,
                    ordered
                );
            }
            CompanionIssueV2 issue = null;
            if (snapshotVersion >= 6 && input.readBoolean()) {
                issue = CompanionIssueV2.canonical(
                    required(read(input, 80))
                );
                if (input.readBoolean()) {
                    int recoveryVersion = input.readInt();
                    String interactionId =
                        required(read(input, 160));
                    String operationId =
                        required(read(input, 100));
                    String stepId = required(read(input, 256));
                    String recoveryTaskId =
                        required(read(input, 100));
                    int recoveryTaskRevision = input.readInt();
                    long expiresAt = input.readLong();
                    if (
                        recoveryVersion != 2
                            || !interactionId.matches(
                                "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$"
                            )
                            || !identifier(operationId, "operation")
                            || !stepId.matches(
                                "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
                            )
                            || !identifier(recoveryTaskId, "task")
                            || recoveryTaskRevision < 0
                            || expiresAt < 0L
                            || task == null
                            || !recoveryTaskId.equals(task.taskId)
                            || !operationId.equals(task.operationId)
                    ) {
                        return null;
                    }
                    issue = issue.withRecoveryInteraction(
                        new RecoveryActionBinding(
                            2,
                            interactionId,
                            operationId,
                            stepId,
                            recoveryTaskId,
                            recoveryTaskRevision,
                            expiresAt
                        )
                    );
                }
            }
            boolean expanded = input.readBoolean();
            if (
                !allowedMode(mode)
                    || !allowedCard(cardType)
                    || !allowedTone(tone)
                    || collapseAfterMs < 0L
                    || collapseAfterMs > 60000L
                    || !languageCode.matches("^[a-z]{2,3}-[A-Z]{2}$")
                    || (selection != null
                        && !"product_choices".equals(cardType))
                    || (completion != null
                        && !"completion_choices".equals(cardType))
                    || (issue != null
                        && !"companion_issue".equals(cardType))
                    || ("companion_issue".equals(cardType)
                        && issue == null)
                    || (cartSummary != null
                        && (
                            !"cart_summary".equals(cardType)
                                || !cartSummary.isVerifiedNotOrdered()
                        ))
                    || ("cart_summary".equals(cardType)
                        && cartSummary == null)
            ) {
                return null;
            }
            if (isTransient(mode) && task == null) {
                return new Restored(
                    OverlayPresentation.legacy(
                        "The previous task was interrupted. Hold to continue.",
                        "error"
                    ),
                    false
                );
            }
            OverlayPresentation presentation = new OverlayPresentation(
                1,
                required(mode),
                "overlay_card",
                null,
                null,
                null,
                task,
                issue != null
                    ? new OverlayPresentation.Card(
                        required(cardType),
                        required(tone),
                        required(headline),
                        required(detail),
                        issue
                    )
                : completion == null
                    ? new OverlayPresentation.Card(
                        required(cardType),
                        required(tone),
                        required(headline),
                        required(detail),
                        options,
                        selection,
                        cartSummary
                    )
                    : new OverlayPresentation.Card(
                        required(cardType),
                        required(tone),
                        required(headline),
                        required(detail),
                        completion
                    ),
                spokenText,
                languageCode,
                autoCollapse,
                collapseAfterMs,
                keepVisibleWhileSpeaking,
                structured
            );
            boolean restoreExpanded = expanded
                && (
                    !autoCollapse
                        || collapseAfterMs <= 0L
                        || age < collapseAfterMs
                );
            return new Restored(presentation, restoreExpanded);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean isTransient(String mode) {
        return "listening".equals(mode)
            || "understanding".equals(mode)
            || "reading".equals(mode)
            || "acting".equals(mode)
            || "verifying".equals(mode);
    }

    private static boolean allowedMode(String mode) {
        return "idle".equals(mode)
            || "listening".equals(mode)
            || "understanding".equals(mode)
            || "reading".equals(mode)
            || "acting".equals(mode)
            || "verifying".equals(mode)
            || "waiting_for_user".equals(mode)
            || "success".equals(mode)
            || "error".equals(mode)
            || "ambiguous".equals(mode)
            || "paused".equals(mode)
            || "disconnected".equals(mode);
    }

    private static boolean allowedCard(String cardType) {
        return "compact_status".equals(cardType)
            || "product_choices".equals(cardType)
            || "cart_summary".equals(cardType)
            || "checkout_review".equals(cardType)
            || "changed_terms".equals(cardType)
            || "provider_constraint".equals(cardType)
            || "receipt".equals(cardType)
            || "ambiguous".equals(cardType)
            || "completion_choices".equals(cardType)
            || "companion_issue".equals(cardType);
    }

    private static boolean allowedTone(String tone) {
        return "neutral".equals(tone)
            || "active".equals(tone)
            || "attention".equals(tone)
            || "success".equals(tone)
            || "error".equals(tone)
            || "ambiguous".equals(tone)
            || "confirmation".equals(tone);
    }

    private static boolean allowedTaskStage(String stage) {
        return "queued".equals(stage)
            || "waiting_for_provider".equals(stage)
            || "searching".equals(stage)
            || "waiting_for_choice".equals(stage)
            || "adding".equals(stage)
            || "verifying".equals(stage)
            || "reconciling".equals(stage)
            || "completed".equals(stage)
            || "failed".equals(stage)
            || "cancelled".equals(stage)
            || "ambiguous".equals(stage);
    }

    private static boolean terminalTaskStage(String stage) {
        return "completed".equals(stage)
            || "failed".equals(stage)
            || "cancelled".equals(stage);
    }

    private static boolean allowedCancellationPolicy(String policy) {
        return "cancel_now".equals(policy)
            || "stop_after_current_step".equals(policy)
            || "reconcile_only".equals(policy)
            || "not_cancellable".equals(policy);
    }

    private static boolean allowedCompletionChoice(String choiceId) {
        return "add_more".equals(choiceId)
            || "keep_shopping".equals(choiceId)
            || "review_cart".equals(choiceId)
            || "review_checkout".equals(choiceId)
            || "use_current_payment".equals(choiceId)
            || "use_cod".equals(choiceId)
            || "stop".equals(choiceId);
    }

    private static boolean identifier(String value, String kind) {
        return value.matches(
            "^" + java.util.regex.Pattern.quote(kind)
                + "_[A-Za-z0-9-]{8,80}$"
        );
    }

    private static void write(DataOutputStream output, String value)
        throws Exception {
        if (value == null) {
            output.writeInt(-1);
            return;
        }
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        output.writeInt(bytes.length);
        output.write(bytes);
    }

    private static String read(DataInputStream input, int maximum)
        throws Exception {
        int length = input.readInt();
        if (length == -1) return null;
        if (length < 0 || length > maximum * 4) {
            throw new IllegalArgumentException("invalid snapshot field");
        }
        byte[] bytes = new byte[length];
        input.readFully(bytes);
        String value = new String(bytes, StandardCharsets.UTF_8);
        if (value.length() > maximum) {
            throw new IllegalArgumentException("oversized snapshot field");
        }
        return value;
    }

    private static String required(String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("missing snapshot field");
        }
        return value;
    }
}
