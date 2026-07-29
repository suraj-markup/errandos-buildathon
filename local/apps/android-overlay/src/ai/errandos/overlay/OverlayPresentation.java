package ai.errandos.overlay;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class OverlayPresentation {
    static final int VERSION = 1;

    static final class ProductChoice {
        final String offerId;
        final String title;
        final String spokenLabel;
        final String packSize;
        final String price;
        final String imageUrl;
        final String unitPrice;
        final String availabilityConstraint;
        final String recommendationLabel;

        ProductChoice(
            String offerId,
            String title,
            String spokenLabel,
            String packSize,
            String price
        ) {
            this(
                offerId,
                title,
                spokenLabel,
                packSize,
                price,
                null,
                null,
                null,
                null
            );
        }

        ProductChoice(
            String offerId,
            String title,
            String spokenLabel,
            String packSize,
            String price,
            String imageUrl,
            String unitPrice,
            String availabilityConstraint,
            String recommendationLabel
        ) {
            this.offerId = offerId;
            this.title = title;
            this.spokenLabel = spokenLabel;
            this.packSize = packSize;
            this.price = price;
            this.imageUrl = imageUrl;
            this.unitPrice = unitPrice;
            this.availabilityConstraint = availabilityConstraint;
            this.recommendationLabel = recommendationLabel;
        }
    }

    static final class CartLine {
        final String productId;
        final String name;
        final int quantity;
        final String unitPrice;
        final String lineTotal;

        CartLine(
            String productId,
            String name,
            int quantity,
            String unitPrice,
            String lineTotal
        ) {
            this.productId = productId;
            this.name = name;
            this.quantity = quantity;
            this.unitPrice = unitPrice;
            this.lineTotal = lineTotal;
        }
    }

    static final class CartSummary {
        final List<CartLine> lines;
        final String subtotal;
        final String addressLabel;
        final boolean verified;
        final boolean ordered;

        CartSummary(
            List<CartLine> lines,
            String subtotal,
            String addressLabel
        ) {
            this(lines, subtotal, addressLabel, false, true);
        }

        CartSummary(
            List<CartLine> lines,
            String subtotal,
            String addressLabel,
            boolean verified,
            boolean ordered
        ) {
            this.lines = Collections.unmodifiableList(
                new ArrayList<CartLine>(lines)
            );
            this.subtotal = subtotal;
            this.addressLabel = addressLabel;
            this.verified = verified;
            this.ordered = ordered;
        }

        boolean isVerifiedNotOrdered() {
            return verified && !ordered;
        }
    }

    static final class ProductSelectionBinding {
        final int version;
        final String clientId;
        final String taskId;
        final int taskRevision;
        final String interactionId;
        final String selectionId;
        final long expiresAtEpochMs;

        ProductSelectionBinding(
            int version,
            String clientId,
            String taskId,
            int taskRevision,
            String interactionId,
            String selectionId,
            long expiresAtEpochMs
        ) {
            this.version = version;
            this.clientId = clientId;
            this.taskId = taskId;
            this.taskRevision = taskRevision;
            this.interactionId = interactionId;
            this.selectionId = selectionId;
            this.expiresAtEpochMs = expiresAtEpochMs;
        }

        boolean isExpired(long nowEpochMs) {
            return nowEpochMs >= expiresAtEpochMs;
        }

        boolean sameSelection(ProductSelectionBinding other) {
            return other != null
                && selectionId.equals(other.selectionId)
                && interactionId.equals(other.interactionId)
                && taskId.equals(other.taskId)
                && taskRevision == other.taskRevision;
        }
    }

    static final class CompletionChoice {
        final String choiceId;
        final String label;
        final boolean enabled;
        final String disabledReason;

        CompletionChoice(
            String choiceId,
            String label,
            boolean enabled,
            String disabledReason
        ) {
            this.choiceId = choiceId;
            this.label = label;
            this.enabled = enabled;
            this.disabledReason = disabledReason;
        }
    }

    static final class CompletionInteraction {
        final int version;
        final String interactionId;
        final String taskId;
        final int taskRevision;
        final long expiresAtEpochMs;
        final String currentPaymentLabel;
        final List<CompletionChoice> choices;

        CompletionInteraction(
            int version,
            String interactionId,
            String taskId,
            int taskRevision,
            long expiresAtEpochMs,
            String currentPaymentLabel,
            List<CompletionChoice> choices
        ) {
            this.version = version;
            this.interactionId = interactionId;
            this.taskId = taskId;
            this.taskRevision = taskRevision;
            this.expiresAtEpochMs = expiresAtEpochMs;
            this.currentPaymentLabel = currentPaymentLabel;
            this.choices = Collections.unmodifiableList(
                new ArrayList<CompletionChoice>(choices)
            );
        }

        boolean isExpired(long nowEpochMs) {
            return nowEpochMs >= expiresAtEpochMs;
        }

        boolean sameInteraction(CompletionInteraction other) {
            return other != null
                && interactionId.equals(other.interactionId)
                && taskId.equals(other.taskId)
                && taskRevision == other.taskRevision;
        }
    }

    static final class TaskProgress {
        final int version;
        final String taskId;
        final String itemId;
        final String operationId;
        final String title;
        final String step;
        final String stage;
        final int sequence;
        final int currentItem;
        final int totalItems;
        final boolean cancellationAvailable;
        final String cancellationPolicy;
        final boolean terminal;

        TaskProgress(
            int version,
            String taskId,
            String itemId,
            String operationId,
            String title,
            String step,
            String stage,
            int sequence,
            int currentItem,
            int totalItems,
            boolean cancellationAvailable,
            String cancellationPolicy,
            boolean terminal
        ) {
            this.version = version;
            this.taskId = taskId;
            this.itemId = itemId;
            this.operationId = operationId;
            this.title = title;
            this.step = step;
            this.stage = stage;
            this.sequence = sequence;
            this.currentItem = currentItem;
            this.totalItems = totalItems;
            this.cancellationAvailable = cancellationAvailable;
            this.cancellationPolicy = cancellationPolicy;
            this.terminal = terminal;
        }

        String positionLabel() {
            if (currentItem < 1) return null;
            if (totalItems >= currentItem) {
                return currentItem + " of " + totalItems;
            }
            return "Item " + currentItem;
        }

        boolean hasKnownTotal() {
            return currentItem > 0 && totalItems >= currentItem;
        }

        String cancellationLabel() {
            if ("cancel_now".equals(cancellationPolicy)) {
                return "CANCEL AVAILABLE";
            }
            if ("stop_after_current_step".equals(cancellationPolicy)) {
                return "STOPS AFTER THIS STEP";
            }
            if ("reconcile_only".equals(cancellationPolicy)) {
                return "FINISHING VERIFICATION";
            }
            return terminal ? null : "CANNOT CANCEL";
        }
    }

    static final class Card {
        final String type;
        final String tone;
        final String headline;
        final String detail;
        final List<ProductChoice> options;
        final ProductSelectionBinding selection;
        final CompletionInteraction completionInteraction;
        final CartSummary cartSummary;
        final CompanionIssueV2 issue;

        Card(
            String type,
            String tone,
            String headline,
            String detail,
            List<ProductChoice> options,
            ProductSelectionBinding selection
        ) {
            this(
                type,
                tone,
                headline,
                detail,
                options,
                selection,
                null
            );
        }

        Card(
            String type,
            String tone,
            String headline,
            String detail,
            List<ProductChoice> options,
            ProductSelectionBinding selection,
            CartSummary cartSummary
        ) {
            this.type = type;
            this.tone = tone;
            this.headline = headline;
            this.detail = detail;
            this.options = Collections.unmodifiableList(
                new ArrayList<ProductChoice>(options)
            );
            this.selection = selection;
            this.completionInteraction = null;
            this.cartSummary = cartSummary;
            this.issue = null;
        }

        Card(
            String type,
            String tone,
            String headline,
            String detail,
            CompletionInteraction completionInteraction
        ) {
            this.type = type;
            this.tone = tone;
            this.headline = headline;
            this.detail = detail;
            this.options = Collections.emptyList();
            this.selection = null;
            this.completionInteraction = completionInteraction;
            this.cartSummary = null;
            this.issue = null;
        }

        Card(
            String type,
            String tone,
            String headline,
            String detail,
            CompanionIssueV2 issue
        ) {
            this.type = type;
            this.tone = tone;
            this.headline = headline;
            this.detail = detail;
            this.options = Collections.emptyList();
            this.selection = null;
            this.completionInteraction = null;
            this.cartSummary = null;
            this.issue = issue;
        }
    }

    final int version;
    final String mode;
    final String primarySurface;
    final String screenKind;
    final String screenRelevance;
    final String attentionSubject;
    final TaskProgress task;
    final Card card;
    final String spokenText;
    final String languageCode;
    final boolean autoCollapse;
    final long collapseAfterMs;
    final boolean keepVisibleWhileSpeaking;
    final boolean structured;

    OverlayPresentation(
        int version,
        String mode,
        String primarySurface,
        String screenKind,
        String screenRelevance,
        String attentionSubject,
        TaskProgress task,
        Card card,
        String spokenText,
        String languageCode,
        boolean autoCollapse,
        long collapseAfterMs,
        boolean keepVisibleWhileSpeaking,
        boolean structured
    ) {
        this.version = version;
        this.mode = mode;
        this.primarySurface = primarySurface;
        this.screenKind = screenKind;
        this.screenRelevance = screenRelevance;
        this.attentionSubject = attentionSubject;
        this.task = task;
        this.card = card;
        this.spokenText = spokenText;
        this.languageCode = languageCode;
        this.autoCollapse = autoCollapse;
        this.collapseAfterMs = collapseAfterMs;
        this.keepVisibleWhileSpeaking = keepVisibleWhileSpeaking;
        this.structured = structured;
    }

    static OverlayPresentation legacy(String reply, String state) {
        String safeReply = clean(reply, "Done.", 1000);
        String mode = modeFromLegacyState(state);
        Card card = new Card(
            "compact_status",
            toneFromMode(mode),
            headlineForMode(mode),
            safeReply,
            Collections.<ProductChoice>emptyList(),
            null
        );
        boolean persistent = "waiting_for_user".equals(mode)
            || "error".equals(mode)
            || "ambiguous".equals(mode);
        return new OverlayPresentation(
            VERSION,
            mode,
            "overlay_card",
            null,
            null,
            null,
            null,
            card,
            safeReply,
            "en-IN",
            !persistent,
            6500L,
            true,
            false
        );
    }

    static String clean(String value, String fallback, int maximumLength) {
        if (value == null) return fallback;
        String clean = value.trim();
        if (clean.isEmpty()) return fallback;
        return clean.length() <= maximumLength
            ? clean
            : clean.substring(0, maximumLength);
    }

    static String modeFromLegacyState(String state) {
        if ("listening".equals(state)) return "listening";
        if ("understanding".equals(state)) return "understanding";
        if ("verifying".equals(state)) return "verifying";
        if ("disconnected".equals(state)) return "disconnected";
        if ("paused".equals(state)) return "paused";
        if (
            "working".equals(state)
                || "searching".equals(state)
                || "adding".equals(state)
                || "checkout".equals(state)
        ) {
            return "acting";
        }
        if ("clarification".equals(state) || "confirmation".equals(state)) {
            return "waiting_for_user";
        }
        if ("success".equals(state)) return "success";
        if ("error".equals(state)) return "error";
        return "idle";
    }

    static String toneFromMode(String mode) {
        if ("success".equals(mode)) return "success";
        if ("error".equals(mode)) return "error";
        if ("ambiguous".equals(mode)) return "ambiguous";
        if (
            "disconnected".equals(mode)
                || "paused".equals(mode)
        ) {
            return "attention";
        }
        if ("waiting_for_user".equals(mode)) return "attention";
        if (
            "listening".equals(mode)
                || "understanding".equals(mode)
                || "reading".equals(mode)
                || "acting".equals(mode)
                || "verifying".equals(mode)
        ) {
            return "active";
        }
        return "neutral";
    }

    static String headlineForMode(String mode) {
        if ("listening".equals(mode)) return "LISTENING";
        if ("understanding".equals(mode)) return "UNDERSTANDING";
        if ("reading".equals(mode)) return "READING SCREEN";
        if ("acting".equals(mode)) return "WORKING";
        if ("verifying".equals(mode)) return "VERIFYING";
        if ("waiting_for_user".equals(mode)) return "YOUR TURN";
        if ("success".equals(mode)) return "DONE";
        if ("ambiguous".equals(mode)) return "CHECK NEEDED";
        if ("paused".equals(mode)) return "TASK PAUSED";
        if ("disconnected".equals(mode)) return "DISCONNECTED";
        if ("error".equals(mode)) return "NEEDS ATTENTION";
        return "JALDIAI";
    }

    boolean usesProviderScreen() {
        return "provider_screen".equals(primarySurface)
            && screenKind != null
            && screenRelevance != null
            && attentionSubject != null;
    }

    boolean needsContextCard() {
        if (task != null) return true;
        if (
            "product_choices".equals(card.type)
                || "cart_summary".equals(card.type)
                || "checkout_review".equals(card.type)
                || "changed_terms".equals(card.type)
                || "provider_constraint".equals(card.type)
                || "receipt".equals(card.type)
                || "ambiguous".equals(card.type)
                || "completion_choices".equals(card.type)
                || "companion_issue".equals(card.type)
        ) {
            return true;
        }
        return "waiting_for_user".equals(mode)
            && (
                "checkout_summary".equals(screenRelevance)
                    || "address_choices".equals(screenRelevance)
                    || "payment_selection".equals(screenRelevance)
            );
    }
}
