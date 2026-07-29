package ai.errandos.overlay;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class OverlayCardView extends LinearLayout {
    interface OnProductChoiceListener {
        void onProductChoice(OverlayPresentation.ProductChoice option);
    }

    interface OnCompletionChoiceListener {
        void onCompletionChoice(OverlayPresentation.CompletionChoice choice);
    }

    interface OnRecoveryActionListener {
        void onRecoveryAction(CompanionIssueV2.RecoveryAction action);
    }

    interface OnQueueActionListener {
        void onQueueAction(QueueActionPolicy.Action action);
    }

    static final int COMPANION_SIZE_DP = 64;
    static final int CAPSULE_WIDTH_DP = 292;
    static final int CARD_WIDTH_DP = 336;

    private static final int INK = Color.rgb(13, 18, 15);
    private static final int SURFACE = Color.rgb(22, 29, 24);
    private static final int TEXT = Color.rgb(247, 250, 245);
    private static final int MUTED = Color.rgb(167, 179, 170);
    private static final int LIME = Color.rgb(202, 255, 69);
    private static final int BLUE = Color.rgb(112, 214, 255);
    private static final int AMBER = Color.rgb(255, 200, 87);
    private static final int RED = Color.rgb(255, 107, 107);
    private static final int DIVIDER = Color.rgb(48, 59, 51);
    private static final ExecutorService IMAGE_EXECUTOR =
        Executors.newFixedThreadPool(2);

    private final LinearLayout header;
    private final CompanionGlyphView companionGlyph;
    private final TextView eyebrow;
    private final TextView headline;
    private final TextView compactMessage;
    private final ScrollView scroller;
    private final LinearLayout content;
    private final ProductSelectionState productSelectionState =
        new ProductSelectionState();
    private final CompletionChoiceState completionChoiceState =
        new CompletionChoiceState();
    private final RecoveryActionState recoveryActionState =
        new RecoveryActionState();
    private OverlayPresentation latest;
    private OverlayPresentation.CartSummary retainedCartSummary;
    private TaskChecklistState.Snapshot checklist;
    private QueueTaskProjection queueTask;
    private boolean queueSubmitting;
    private String queueMessage;
    private boolean expanded;
    private OnProductChoiceListener productChoiceListener;
    private OnCompletionChoiceListener completionChoiceListener;
    private OnRecoveryActionListener recoveryActionListener;
    private OnQueueActionListener queueActionListener;

    OverlayCardView(Context context) {
        super(context);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER_VERTICAL);
        setElevation(dp(14));
        setClipToOutline(false);
        setPadding(0, 0, 0, 0);
        setFocusable(false);
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);

        header = new LinearLayout(context);
        header.setOrientation(HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        addView(
            header,
            new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
            )
        );
        header.setMinimumHeight(dp(COMPANION_SIZE_DP));

        FrameLayout iconFrame = new FrameLayout(context);
        header.addView(
            iconFrame,
            new LinearLayout.LayoutParams(
                dp(COMPANION_SIZE_DP),
                dp(COMPANION_SIZE_DP)
            )
        );

        View pulse = new View(context);
        pulse.setBackground(circle(Color.argb(35, 202, 255, 69)));
        FrameLayout.LayoutParams pulseParams = new FrameLayout.LayoutParams(
            dp(48),
            dp(48),
            Gravity.CENTER
        );
        iconFrame.addView(pulse, pulseParams);

        companionGlyph = new CompanionGlyphView(context);
        iconFrame.addView(
            companionGlyph,
            new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.MATCH_PARENT
            )
        );

        LinearLayout titleStack = new LinearLayout(context);
        titleStack.setOrientation(VERTICAL);
        titleStack.setGravity(Gravity.CENTER_VERTICAL);
        titleStack.setPadding(0, 0, dp(18), 0);
        titleStack.setMinimumHeight(dp(COMPANION_SIZE_DP));
        header.addView(
            titleStack,
            new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
        );

        eyebrow = new TextView(context);
        eyebrow.setTextColor(LIME);
        eyebrow.setTextSize(10f);
        eyebrow.setLetterSpacing(0.16f);
        eyebrow.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        eyebrow.setMaxLines(1);
        titleStack.addView(
            eyebrow,
            new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
            )
        );

        headline = new TextView(context);
        headline.setTextColor(TEXT);
        headline.setTextSize(14f);
        headline.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        headline.setMaxLines(2);
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            headline.setAccessibilityHeading(true);
        }
        titleStack.addView(
            headline,
            new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
            )
        );

        compactMessage = new TextView(context);
        compactMessage.setTextColor(MUTED);
        compactMessage.setTextSize(13f);
        compactMessage.setLineSpacing(0f, 1.08f);
        compactMessage.setMaxLines(3);
        compactMessage.setPadding(dp(18), 0, dp(18), dp(14));
        addView(
            compactMessage,
            new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
            )
        );

        scroller = new ScrollView(context);
        scroller.setFillViewport(true);
        scroller.setVerticalScrollBarEnabled(true);
        scroller.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        addView(
            scroller,
            new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        );

        content = new LinearLayout(context);
        content.setOrientation(VERTICAL);
        content.setPadding(dp(12), 0, dp(12), dp(14));
        scroller.addView(
            content,
            new ScrollView.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
            )
        );

        render(OverlayPresentation.legacy("Hold to speak", "ready"), false);
    }

    CompanionGlyphView companionGlyph() {
        return companionGlyph;
    }

    View dragHandle() {
        return header;
    }

    void setTaskChecklist(TaskChecklistState.Snapshot next) {
        checklist = next;
        if (latest != null) render(latest, expanded);
    }

    void setQueueTaskProjection(QueueTaskProjection next) {
        queueTask = next;
        if (latest != null) render(latest, expanded);
    }

    void setQueueSubmissionState(boolean submitting, String message) {
        queueSubmitting = submitting;
        queueMessage = message;
        if (latest != null) render(latest, expanded);
    }

    void setRetainedCartSummary(OverlayPresentation.CartSummary cart) {
        retainedCartSummary = isAuthoritativeCart(cart) ? cart : null;
        if (latest != null) render(latest, expanded);
    }

    void setOnProductChoiceListener(OnProductChoiceListener listener) {
        productChoiceListener = listener;
    }

    void setOnCompletionChoiceListener(OnCompletionChoiceListener listener) {
        completionChoiceListener = listener;
    }

    void setOnRecoveryActionListener(OnRecoveryActionListener listener) {
        recoveryActionListener = listener;
    }

    void setOnQueueActionListener(OnQueueActionListener listener) {
        queueActionListener = listener;
    }

    @Override
    public boolean performClick() {
        super.performClick();
        return true;
    }

    void render(OverlayPresentation presentation, boolean shouldExpand) {
        productSelectionState.attach(
            presentation.card.selection,
            System.currentTimeMillis()
        );
        completionChoiceState.attach(
            presentation.card.completionInteraction,
            System.currentTimeMillis()
        );
        recoveryActionState.attach(
            presentation.card.issue,
            System.currentTimeMillis()
        );
        latest = presentation;
        expanded = shouldExpand;
        setContentDescription(accessibilityDescription(presentation));
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            setTooltipText(presentation.spokenText);
        }

        int accent = accentFor(presentation);
        setBackground(shell(accent, shouldExpand));
        eyebrow.setText(eyebrowFor(presentation));
        eyebrow.setTextColor(accent);
        if (isAuthoritativeCart(presentation.card.cartSummary)) {
            retainedCartSummary = presentation.card.cartSummary;
        } else if (presentation.card.cartSummary != null) {
            retainedCartSummary = null;
        }
        boolean hasChecklist = checklist != null
            && checklist.totalItems() > 0;
        boolean contextCard = shouldExpand
            && (presentation.needsContextCard() || hasChecklist);
        headline.setText(
            presentation.card.issue != null
                ? presentation.card.issue.title
                : isAuthoritativeCart(presentation.card.cartSummary)
                ? "Verified cart · " + presentation.card.cartSummary.subtotal
                : presentation.card.cartSummary != null
                    ? "Cart verification unavailable"
                : hasChecklist
                    ? checklist.completedCount() + " of "
                        + checklist.totalItems() + " verified"
                    : presentation.task != null
                ? presentation.task.title
                : contextCard
                    ? presentation.card.headline
                : presentation.card.detail
        );
        compactMessage.setText(presentation.card.detail);

        eyebrow.setVisibility(shouldExpand ? VISIBLE : INVISIBLE);
        headline.setVisibility(shouldExpand ? VISIBLE : INVISIBLE);
        compactMessage.setVisibility(GONE);
        scroller.setVisibility(contextCard ? VISIBLE : GONE);

        content.removeAllViews();
        if (contextCard) {
            if ("companion_issue".equals(presentation.card.type)) {
                renderCompanionIssue(presentation.card.issue);
            } else if ("product_choices".equals(presentation.card.type)) {
                renderChoices(presentation);
            } else if ("completion_choices".equals(presentation.card.type)) {
                renderCompletionChoices(presentation);
            } else if (presentation.card.cartSummary != null) {
                if (isAuthoritativeCart(presentation.card.cartSummary)) {
                    renderCartSummary(presentation.card.cartSummary);
                    renderChecklistFooter(presentation);
                } else {
                    renderUnverifiedCart();
                }
            } else if (hasChecklist) {
                renderTaskChecklist(presentation);
            } else {
                renderContext(presentation, accent);
            }
        }
    }

    OverlayPresentation.ProductSelectionBinding beginProductChoiceSubmission(
        OverlayPresentation.ProductChoice option
    ) {
        if (option == null || latest == null) return null;
        OverlayPresentation.ProductSelectionBinding binding =
            productSelectionState.begin(
                option.offerId,
                System.currentTimeMillis()
            );
        if (binding != null) {
            render(latest, expanded);
        } else if (
            productSelectionState.status()
                == ProductSelectionState.Status.EXPIRED
        ) {
            render(latest, expanded);
        }
        return binding;
    }

    void completeProductChoiceSubmission(
        ProductSelectionState.Status status,
        String message,
        boolean retryable
    ) {
        productSelectionState.complete(status, message, retryable);
        if (latest != null) render(latest, expanded);
    }

    void resolveProductChoiceWinner(
        String winnerOfferId,
        ProductSelectionState.Status status,
        String message
    ) {
        productSelectionState.resolveWinner(
            winnerOfferId,
            status,
            message
        );
        if (latest != null) render(latest, expanded);
    }

    OverlayPresentation.ProductSelectionBinding
        currentProductSelectionBinding() {
        return productSelectionState.binding();
    }

    ProductSelectionState.Status currentProductSelectionStatus() {
        return productSelectionState.status();
    }

    void restoreProductChoiceSubmission(
        OverlayPresentation.ProductSelectionBinding binding,
        String offerId,
        ProductSelectionState.Status status,
        String message
    ) {
        productSelectionState.restore(binding, offerId, status, message);
        if (latest != null) render(latest, expanded);
    }

    OverlayPresentation.CompletionInteraction beginCompletionChoiceSubmission(
        OverlayPresentation.CompletionChoice choice
    ) {
        OverlayPresentation.CompletionInteraction interaction =
            completionChoiceState.begin(choice, System.currentTimeMillis());
        if (latest != null) render(latest, expanded);
        return interaction;
    }

    OverlayPresentation.CompletionInteraction currentCompletionInteraction() {
        return latest == null || latest.card == null
            ? null
            : latest.card.completionInteraction;
    }

    CompletionChoiceState.Status currentCompletionChoiceStatus() {
        return completionChoiceState.status();
    }

    void completeCompletionChoiceSubmission(
        CompletionChoiceState.Status status,
        String message,
        boolean retryable
    ) {
        completionChoiceState.complete(status, message, retryable);
        if (latest != null) render(latest, expanded);
    }

    RecoveryActionBinding beginRecoveryActionSubmission(
        CompanionIssueV2.RecoveryAction action
    ) {
        RecoveryActionBinding binding = recoveryActionState.begin(
            action,
            System.currentTimeMillis()
        );
        if (latest != null) render(latest, expanded);
        return binding;
    }

    CompanionIssueV2 currentCompanionIssue() {
        return latest == null || latest.card == null
            ? null
            : latest.card.issue;
    }

    RecoveryActionState.Status currentRecoveryActionStatus() {
        return recoveryActionState.status();
    }

    void completeRecoveryActionSubmission(
        RecoveryActionState.Status status,
        String message,
        boolean retryable
    ) {
        recoveryActionState.complete(status, message, retryable);
        if (latest != null) render(latest, expanded);
    }

    void restoreRecoveryActionSubmission(
        CompanionIssueV2 issue,
        String actionId,
        RecoveryActionState.Status status,
        String message
    ) {
        recoveryActionState.restore(issue, actionId, status, message);
        if (latest != null) render(latest, expanded);
    }

    int desiredWidthDp(boolean shouldExpand) {
        if (!shouldExpand) return COMPANION_SIZE_DP;
        return latest != null
            && (
                latest.needsContextCard()
                    || (checklist != null && checklist.totalItems() > 0)
            )
            ? CARD_WIDTH_DP
            : CAPSULE_WIDTH_DP;
    }

    int desiredHeightDp(boolean shouldExpand) {
        if (!shouldExpand) return COMPANION_SIZE_DP;
        if (
            latest == null
                || (
                    !latest.needsContextCard()
                        && (checklist == null || checklist.totalItems() == 0)
                )
        ) {
            return COMPANION_SIZE_DP;
        }
        if ("product_choices".equals(latest.card.type)) {
            int visible = Math.min(latest.card.options.size(), 4);
            return Math.min(520, 128 + visible * 86);
        }
        if (
            "companion_issue".equals(latest.card.type)
                && latest.card.issue != null
        ) {
            return Math.min(
                460,
                166 + latest.card.issue.recoveryActions.size() * 58
            );
        }
        if (
            "completion_choices".equals(latest.card.type)
                && latest.card.completionInteraction != null
        ) {
            int visible = Math.min(
                latest.card.completionInteraction.choices.size(),
                5
            );
            int cartHeight = retainedCartSummary == null
                ? 0
                : Math.min(retainedCartSummary.lines.size(), 4) * 48 + 72;
            return Math.min(560, 126 + visible * 52 + cartHeight);
        }
        if (latest.card.cartSummary != null) {
            return Math.min(
                560,
                144 + Math.min(latest.card.cartSummary.lines.size(), 7) * 52
            );
        }
        if (checklist != null && checklist.totalItems() > 0) {
            return Math.min(500, 142 + checklist.totalItems() * 54);
        }
        if (latest.task != null) return 208;
        return 184;
    }

    private void renderChoices(OverlayPresentation presentation) {
        if (checklist != null && checklist.totalItems() > 0) {
            TextView position = text(
                checklist.completedCount() + " verified · "
                    + checklist.totalItems() + " total",
                MUTED,
                11f,
                Typeface.BOLD
            );
            position.setPadding(dp(4), 0, dp(4), dp(8));
            content.addView(position);
        }
        for (
            int index = 0;
            index < presentation.card.options.size();
            index += 1
        ) {
            OverlayPresentation.ProductChoice option =
                presentation.card.options.get(index);
            LinearLayout.LayoutParams rowParams =
                new LinearLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT,
                    LayoutParams.WRAP_CONTENT
                );
            rowParams.setMargins(0, 0, 0, dp(8));
            content.addView(
                choiceRow(index + 1, option),
                rowParams
            );
        }
        TextView instruction = text(
            choiceInstruction(presentation),
            choiceInstructionColor(),
            11f,
            Typeface.NORMAL
        );
        instruction.setPadding(dp(4), dp(8), dp(4), 0);
        content.addView(instruction);
    }

    private View choiceRow(
        int number,
        OverlayPresentation.ProductChoice option
    ) {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        boolean selected = option.offerId.equals(
            productSelectionState.selectedOfferId()
        );
        boolean enabled = productSelectionState.canTap()
            && (
                productSelectionState.selectedOfferId() == null
                    || selected
            );
        row.setClickable(enabled);
        row.setFocusable(true);
        row.setEnabled(enabled);
        row.setMinimumHeight(dp(76));
        row.setPadding(dp(8), dp(8), dp(8), dp(8));
        row.setAlpha(enabled || selected ? 1f : 0.48f);
        row.setBackground(choiceShell(selected, enabled));
        row.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View view, boolean hasFocus) {
                row.setBackground(
                    choiceShell(selected, enabled, hasFocus)
                );
            }
        });
        row.setContentDescription(choiceContentDescription(
            number,
            option,
            enabled
        ));
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                if (productChoiceListener != null && row.isEnabled()) {
                    productChoiceListener.onProductChoice(option);
                }
            }
        });

        FrameLayout visual = new FrameLayout(getContext());
        LinearLayout.LayoutParams visualParams = new LinearLayout.LayoutParams(
            dp(52),
            dp(52)
        );
        visualParams.setMargins(0, 0, dp(10), 0);
        row.addView(visual, visualParams);

        TextView ordinal = text(
            selected ? "✓" : Integer.toString(number),
            selected ? INK : TEXT,
            selected ? 18f : 13f,
            Typeface.BOLD
        );
        ordinal.setGravity(Gravity.CENTER);
        ordinal.setBackground(circle(selected ? LIME : DIVIDER));
        visual.addView(
            ordinal,
            new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.MATCH_PARENT
            )
        );
        if (option.imageUrl != null && !selected) {
            ImageView image = new ImageView(getContext());
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            image.setBackground(circle(DIVIDER));
            visual.addView(
                image,
                new FrameLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT,
                    LayoutParams.MATCH_PARENT
                )
            );
            loadProductImage(image, option.imageUrl);
        }

        LinearLayout labels = new LinearLayout(getContext());
        labels.setOrientation(VERTICAL);
        labels.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(
            labels,
            new LinearLayout.LayoutParams(0, LayoutParams.MATCH_PARENT, 1f)
        );

        TextView name = text(
            option.title,
            TEXT,
            13f,
            Typeface.BOLD
        );
        name.setLineSpacing(0f, 1.05f);
        labels.addView(name);

        String metadata = joinMetadata(
            option.packSize,
            joinMetadata(
                option.price,
                option.unitPrice == null
                    ? null
                    : "Unit " + option.unitPrice
            )
        );
        if (metadata != null) {
            TextView detail = text(metadata, MUTED, 11f, Typeface.NORMAL);
            detail.setMaxLines(2);
            labels.addView(detail);
        }
        if (
            option.recommendationLabel != null
                || option.availabilityConstraint != null
        ) {
            TextView badges = text(
                joinMetadata(
                    option.recommendationLabel,
                    option.availabilityConstraint
                ),
                option.recommendationLabel == null ? AMBER : LIME,
                10f,
                Typeface.BOLD
            );
            badges.setMaxLines(2);
            labels.addView(badges);
        }
        if (selected) {
            ProgressBar progress = new ProgressBar(
                getContext(),
                null,
                android.R.attr.progressBarStyleSmall
            );
            progress.setIndeterminate(true);
            progress.setContentDescription("Adding selected product");
            row.addView(
                progress,
                new LinearLayout.LayoutParams(dp(28), dp(28))
            );
        }
        return row;
    }

    private String choiceInstruction(OverlayPresentation presentation) {
        String stateMessage = productSelectionState.message();
        if (
            productSelectionState.selectedOfferId() != null
                && productSelectionState.status()
                    != ProductSelectionState.Status.REJECTED
                && productSelectionState.status()
                    != ProductSelectionState.Status.EXPIRED
        ) {
            OverlayPresentation.ProductChoice selected =
                findChoice(productSelectionState.selectedOfferId());
            if (selected != null) {
                return DeterministicCompanionCopy.selected(
                    selected.title,
                    joinMetadata(selected.packSize, selected.price),
                    presentation.languageCode
                );
            }
        }
        if (stateMessage != null) return stateMessage;
        if (presentation.card.selection == null) {
            return "Say the name, size, or number.";
        }
        return presentation.card.detail;
    }

    private int choiceInstructionColor() {
        ProductSelectionState.Status state = productSelectionState.status();
        if (state == ProductSelectionState.Status.REJECTED) return RED;
        if (state == ProductSelectionState.Status.EXPIRED) return AMBER;
        if (
            state == ProductSelectionState.Status.SUBMITTING
                || state == ProductSelectionState.Status.WORKING
        ) {
            return BLUE;
        }
        if (
            state == ProductSelectionState.Status.ACCEPTED
                || state == ProductSelectionState.Status.DUPLICATE
        ) {
            return LIME;
        }
        return MUTED;
    }

    private void renderCompletionChoices(OverlayPresentation presentation) {
        OverlayPresentation.CompletionInteraction interaction =
            presentation.card.completionInteraction;
        if (interaction == null) return;
        if (isAuthoritativeCart(retainedCartSummary)) {
            renderCartSummary(retainedCartSummary);
            if (
                FinalCartActionPolicy
                    .hasRequiredRepositoryBackedActions(interaction)
            ) {
                View divider = new View(getContext());
                divider.setBackgroundColor(DIVIDER);
                LinearLayout.LayoutParams dividerParams =
                    new LinearLayout.LayoutParams(
                        LayoutParams.MATCH_PARENT,
                        dp(1)
                );
                dividerParams.setMargins(0, dp(10), 0, dp(10));
                content.addView(divider, dividerParams);
                renderFinalCartActions(interaction);
                renderCompletionInstruction(
                    "Choose a safe next step. Review actions do not order."
                );
            }
            return;
        }
        int visible = Math.min(interaction.choices.size(), 5);
        for (int index = 0; index < visible; index += 1) {
            OverlayPresentation.CompletionChoice choice =
                interaction.choices.get(index);
            content.addView(
                completionChoiceRow(choice),
                new LinearLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT,
                    LayoutParams.WRAP_CONTENT
                )
            );
        }
        renderCompletionInstruction("Tap once, or hold to answer by voice.");
    }

    private void renderFinalCartActions(
        OverlayPresentation.CompletionInteraction interaction
    ) {
        for (
            FinalCartActionPolicy.Action action :
                FinalCartActionPolicy.safeActions(interaction)
        ) {
            content.addView(
                finalCartActionRow(action),
                new LinearLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT,
                    LayoutParams.WRAP_CONTENT
                )
            );
        }
    }

    private View finalCartActionRow(
        FinalCartActionPolicy.Action action
    ) {
        boolean localReview =
            action.kind == FinalCartActionPolicy.Kind.REVIEW_CART;
        boolean enabled = action.enabled()
            && (localReview || completionChoiceState.canTap());
        boolean selected = action.backingChoice != null
            && action.backingChoice.choiceId.equals(
                completionChoiceState.selectedChoiceId()
            );
        TextView row = text(
            selected ? "✓  " + action.label : action.label,
            enabled || selected ? TEXT : MUTED,
            13f,
            enabled ? Typeface.BOLD : Typeface.NORMAL
        );
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(6), dp(12), dp(6));
        row.setMinimumHeight(dp(48));
        row.setClickable(enabled);
        row.setFocusable(true);
        row.setEnabled(enabled);
        row.setAlpha(enabled || selected ? 1f : 0.55f);
        row.setBackground(choiceShell(selected, enabled));
        row.setContentDescription(
            selected
                ? action.talkBackDescription
                    + " Selected. Progress will update here."
                : action.talkBackDescription
        );
        row.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View view, boolean hasFocus) {
                row.setBackground(
                    choiceShell(selected, enabled, hasFocus)
                );
            }
        });
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                if (!row.isEnabled()) return;
                if (localReview) {
                    scroller.smoothScrollTo(0, 0);
                    announceForAccessibility(
                        "Reviewing verified cart. Read-only."
                    );
                    return;
                }
                if (
                    completionChoiceListener != null
                        && action.backingChoice != null
                ) {
                    completionChoiceListener.onCompletionChoice(
                        action.backingChoice
                    );
                }
            }
        });
        return row;
    }

    private void renderCompletionInstruction(String fallback) {
        String stateMessage = completionChoiceState.message();
        TextView instruction = text(
            stateMessage == null ? fallback : stateMessage,
            completionInstructionColor(),
            11f,
            Typeface.NORMAL
        );
        instruction.setPadding(dp(4), dp(8), dp(4), 0);
        instruction.setContentDescription(instruction.getText());
        content.addView(instruction);
    }

    private View completionChoiceRow(
        OverlayPresentation.CompletionChoice choice
    ) {
        TextView row = text(
            choice.label,
            choice.enabled ? TEXT : MUTED,
            13f,
            choice.enabled ? Typeface.BOLD : Typeface.NORMAL
        );
        boolean enabled = choice.enabled && completionChoiceState.canTap();
        boolean selected = choice.choiceId.equals(
            completionChoiceState.selectedChoiceId()
        );
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(6), dp(12), dp(6));
        row.setMinimumHeight(dp(48));
        row.setClickable(enabled);
        row.setFocusable(true);
        row.setEnabled(enabled);
        row.setAlpha(enabled || selected ? 1f : 0.55f);
        row.setCompoundDrawablePadding(dp(8));
        row.setBackground(choiceShell(selected, enabled));
        row.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View view, boolean hasFocus) {
                row.setBackground(
                    choiceShell(selected, enabled, hasFocus)
                );
            }
        });
        if (selected) row.setText("✓  " + choice.label);
        String reason = choice.disabledReason == null
            ? "Hold to speak this choice."
            : choice.disabledReason;
        row.setContentDescription(
            choice.label
                + (enabled
                    ? ". Tap to choose, or hold to speak."
                    : selected
                        ? ". Selected. Progress will update here."
                        : ". Unavailable to tap. " + reason)
        );
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                if (completionChoiceListener != null && row.isEnabled()) {
                    completionChoiceListener.onCompletionChoice(choice);
                }
            }
        });
        return row;
    }

    private int completionInstructionColor() {
        CompletionChoiceState.Status state = completionChoiceState.status();
        if (state == CompletionChoiceState.Status.REJECTED) return RED;
        if (state == CompletionChoiceState.Status.EXPIRED) return AMBER;
        if (state == CompletionChoiceState.Status.SUBMITTING) return BLUE;
        if (
            state == CompletionChoiceState.Status.ACCEPTED
                || state == CompletionChoiceState.Status.DUPLICATE
        ) {
            return LIME;
        }
        return MUTED;
    }

    private void renderTaskChecklist(OverlayPresentation presentation) {
        if (checklist == null) {
            renderContext(presentation, accentFor(presentation));
            return;
        }
        String activeStage = phaseStage(checklist.activePhase());
        TextView active = text(
            DeterministicCompanionCopy.phase(
                activeStage,
                cleanChecklistLabel(checklist.activeLabel()),
                presentation.languageCode
            ),
            phaseColor(checklist.activePhase()),
            12f,
            Typeface.BOLD
        );
        active.setPadding(dp(4), 0, dp(4), dp(10));
        active.setMaxLines(3);
        active.setContentDescription(
            "Current task state. " + active.getText()
        );
        content.addView(active);

        for (TaskChecklistState.Item item : checklist.items()) {
            content.addView(
                checklistRow(item, presentation.languageCode),
                new LinearLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT,
                    LayoutParams.WRAP_CONTENT
                )
            );
        }
        renderQueueTaskActions();
        TextView voiceControls = text(
            checklist.terminal()
                ? "Hold to keep shopping, review checkout, or stop."
                : "Hold to pause, correct, skip, or cancel.",
            MUTED,
            11f,
            Typeface.NORMAL
        );
        voiceControls.setMinHeight(dp(48));
        voiceControls.setGravity(Gravity.CENTER_VERTICAL);
        voiceControls.setPadding(dp(4), dp(8), dp(4), 0);
        voiceControls.setContentDescription(
            checklist.terminal()
                ? "Hold the companion to choose the next safe action."
                : "Hold the companion to pause, correct, skip, or cancel."
        );
        content.addView(voiceControls);
    }

    private View checklistRow(
        TaskChecklistState.Item item,
        String languageCode
    ) {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.TOP);
        row.setMinimumHeight(dp(52));
        row.setPadding(dp(4), dp(6), dp(4), dp(6));

        boolean verified = item.verified();
        TextView state = text(
            verified
                ? "✓"
                : item.phase() == TaskChecklistState.Phase.AMBIGUOUS
                    || item.phase() == TaskChecklistState.Phase.BLOCKED
                    ? "!"
                    : item.phase() == TaskChecklistState.Phase.PENDING
                        ? "○"
                        : "›",
            verified ? INK : phaseColor(item.phase()),
            verified ? 16f : 18f,
            Typeface.BOLD
        );
        state.setGravity(Gravity.CENTER);
        state.setBackground(
            verified ? circle(LIME) : circle(Color.TRANSPARENT)
        );
        LinearLayout.LayoutParams stateParams = new LinearLayout.LayoutParams(
            dp(32),
            dp(32)
        );
        stateParams.setMargins(0, 0, dp(10), 0);
        row.addView(state, stateParams);

        LinearLayout labels = new LinearLayout(getContext());
        labels.setOrientation(VERTICAL);
        String label = cleanChecklistLabel(item.label());
        if (label == null) label = "Item " + item.position();
        TextView title = text(
            label,
            verified ? TEXT : TEXT,
            13f,
            verified ? Typeface.BOLD : Typeface.NORMAL
        );
        title.setMaxLines(2);
        labels.addView(title);

        String stage = phaseStage(item.phase());
        TextView detail = text(
            DeterministicCompanionCopy.phase(
                stage,
                null,
                languageCode
            ),
            verified ? LIME : phaseColor(item.phase()),
            10f,
            Typeface.BOLD
        );
        detail.setMaxLines(2);
        labels.addView(detail);
        renderQueueItemActions(labels, item);
        row.addView(
            labels,
            new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
        );
        row.setContentDescription(
            "Item " + item.position() + ". " + label + ". "
                + detail.getText()
                + (verified ? ". Verified from the cart." : "")
        );
        return row;
    }

    private void renderQueueItemActions(
        LinearLayout labels,
        TaskChecklistState.Item checklistItem
    ) {
        if (queueTask == null || checklistItem == null) return;
        final QueueTaskProjection.Item item =
            queueTask.itemAtQueuePosition(checklistItem.position());
        if (item == null || !item.editable()) return;

        LinearLayout first = queueActionRow();
        first.addView(queueAction(
            new QueueActionPolicy.Action(QueueActionPolicy.Kind.REFINE, item)
        ));
        first.addView(queueAction(
            new QueueActionPolicy.Action(QueueActionPolicy.Kind.SKIP, item)
        ));
        first.addView(queueAction(
            new QueueActionPolicy.Action(QueueActionPolicy.Kind.REMOVE, item)
        ));
        labels.addView(first);

        LinearLayout reorder = queueActionRow();
        reorder.addView(queueAction(
            new QueueActionPolicy.Action(QueueActionPolicy.Kind.MOVE_UP, item)
        ));
        reorder.addView(queueAction(
            new QueueActionPolicy.Action(QueueActionPolicy.Kind.MOVE_DOWN, item)
        ));
        labels.addView(reorder);
    }

    private void renderQueueTaskActions() {
        if (queueTask == null || queueTask.terminal()) return;
        LinearLayout controls = queueActionRow();
        controls.setPadding(dp(4), dp(10), dp(4), dp(2));
        controls.addView(queueAction(
            new QueueActionPolicy.Action(
                queueTask.paused()
                    ? QueueActionPolicy.Kind.RESUME
                    : QueueActionPolicy.Kind.PAUSE,
                null
            )
        ));
        controls.addView(queueAction(
            new QueueActionPolicy.Action(QueueActionPolicy.Kind.CANCEL, null)
        ));
        content.addView(controls);
        if (queueMessage != null) {
            TextView message = text(
                queueMessage,
                queueSubmitting ? BLUE : MUTED,
                10f,
                Typeface.BOLD
            );
            message.setPadding(dp(4), dp(3), dp(4), dp(4));
            message.setContentDescription("Task list update. " + queueMessage);
            content.addView(message);
        }
    }

    private LinearLayout queueActionRow() {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        return row;
    }

    private View queueAction(final QueueActionPolicy.Action action) {
        final boolean enabled = QueueActionPolicy.enabled(
            queueTask,
            action,
            queueSubmitting
        );
        TextView control = text(
            QueueActionPolicy.label(action.kind),
            enabled ? BLUE : MUTED,
            10f,
            Typeface.BOLD
        );
        control.setGravity(Gravity.CENTER);
        control.setMinHeight(dp(48));
        control.setPadding(dp(8), dp(4), dp(8), dp(4));
        control.setEnabled(enabled);
        control.setClickable(enabled);
        control.setFocusable(true);
        control.setAlpha(enabled ? 1f : 0.5f);
        control.setContentDescription(
            QueueActionPolicy.label(action.kind)
                + (
                    enabled
                        ? ". Double tap to update the future task list."
                        : ". Unavailable while this item or task is in flight."
                )
        );
        control.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                if (
                    enabled
                        && queueActionListener != null
                        && view.isEnabled()
                ) {
                    queueActionListener.onQueueAction(action);
                }
            }
        });
        return control;
    }

    private void renderCartSummary(OverlayPresentation.CartSummary cart) {
        if (!isAuthoritativeCart(cart)) {
            renderUnverifiedCart();
            return;
        }
        TextView verified = text(
            "✓ VERIFIED CART",
            LIME,
            10f,
            Typeface.BOLD
        );
        verified.setLetterSpacing(0.12f);
        verified.setPadding(dp(4), 0, dp(4), dp(8));
        content.addView(verified);

        for (OverlayPresentation.CartLine line : cart.lines) {
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(HORIZONTAL);
            row.setGravity(Gravity.TOP);
            row.setMinimumHeight(dp(48));
            row.setPadding(dp(4), dp(5), dp(4), dp(5));

            LinearLayout labelStack = new LinearLayout(getContext());
            labelStack.setOrientation(VERTICAL);
            TextView name = text(
                line.name,
                TEXT,
                12f,
                Typeface.BOLD
            );
            labelStack.addView(name);
            TextView quantity = text(
                "Qty " + line.quantity + " · " + line.unitPrice + " each",
                MUTED,
                10f,
                Typeface.NORMAL
            );
            labelStack.addView(quantity);
            row.addView(
                labelStack,
                new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
            );
            TextView total = text(
                line.lineTotal,
                TEXT,
                12f,
                Typeface.BOLD
            );
            total.setGravity(Gravity.END);
            row.addView(
                total,
                new LinearLayout.LayoutParams(
                    LayoutParams.WRAP_CONTENT,
                    LayoutParams.WRAP_CONTENT
                )
            );
            row.setContentDescription(
                line.name + ". Quantity " + line.quantity + ". "
                    + line.unitPrice + " each. Line total " + line.lineTotal
                    + ". Verified."
            );
            content.addView(row);
        }

        View divider = new View(getContext());
        divider.setBackgroundColor(DIVIDER);
        LinearLayout.LayoutParams dividerParams = new LinearLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            dp(1)
        );
        dividerParams.setMargins(dp(4), dp(4), dp(4), dp(8));
        content.addView(divider, dividerParams);

        LinearLayout subtotalRow = new LinearLayout(getContext());
        subtotalRow.setOrientation(HORIZONTAL);
        subtotalRow.setGravity(Gravity.CENTER_VERTICAL);
        subtotalRow.setMinimumHeight(dp(48));
        TextView subtotalLabel = text(
            "Subtotal",
            TEXT,
            14f,
            Typeface.BOLD
        );
        subtotalRow.addView(
            subtotalLabel,
            new LinearLayout.LayoutParams(
                0,
                LayoutParams.WRAP_CONTENT,
                1f
            )
        );
        TextView subtotal = text(
            cart.subtotal,
            LIME,
            15f,
            Typeface.BOLD
        );
        subtotal.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        subtotalRow.addView(subtotal);
        subtotalRow.setContentDescription(
            "Verified cart subtotal " + cart.subtotal
        );
        content.addView(subtotalRow);

        TextView safety = text(
            "NOT ORDERED · " + cart.addressLabel,
            INK,
            10f,
            Typeface.BOLD
        );
        safety.setGravity(Gravity.CENTER);
        safety.setMinHeight(dp(32));
        safety.setBackground(pill(AMBER));
        safety.setContentDescription(
            "Not ordered. Delivery address " + cart.addressLabel
        );
        content.addView(safety);
    }

    private void renderUnverifiedCart() {
        TextView warning = text(
            "CART DETAILS UNVERIFIED",
            AMBER,
            10f,
            Typeface.BOLD
        );
        warning.setLetterSpacing(0.12f);
        warning.setPadding(dp(4), 0, dp(4), dp(8));
        warning.setContentDescription("Cart details unverified.");
        content.addView(warning);

        TextView guidance = text(
            "Cart contents and ordering status could not be verified. "
                + "Check the current provider screen. No action was taken.",
            TEXT,
            13f,
            Typeface.NORMAL
        );
        guidance.setLineSpacing(dp(2), 1f);
        guidance.setPadding(dp(4), 0, dp(4), dp(8));
        guidance.setContentDescription(
            "Cart contents and ordering status could not be verified. "
                + "Check the current provider screen. No action was taken."
        );
        content.addView(guidance);
    }

    private void renderCompanionIssue(CompanionIssueV2 issue) {
        if (issue == null) return;
        int accent =
            "reconciliation".equals(issue.treatment)
                    || "final_dispatch_attention".equals(issue.treatment)
                ? AMBER
                : "connection_blocked".equals(issue.treatment)
                    ? RED
                    : accentFor(latest);
        TextView state = text(
            issue.eyebrow(),
            accent,
            10f,
            Typeface.BOLD
        );
        state.setLetterSpacing(0.12f);
        state.setPadding(dp(4), 0, dp(4), dp(8));
        state.setContentDescription(issue.eyebrow());
        content.addView(state);

        TextView detail = text(
            issue.detail,
            TEXT,
            13f,
            Typeface.NORMAL
        );
        detail.setLineSpacing(dp(2), 1f);
        detail.setMaxLines(4);
        detail.setPadding(dp(4), 0, dp(4), dp(10));
        detail.setContentDescription(issue.detail);
        content.addView(detail);

        for (CompanionIssueV2.RecoveryAction action :
            issue.recoveryActions) {
            final CompanionIssueV2.RecoveryAction recoveryAction = action;
            boolean enabled = recoveryActionState.canTap(action);
            boolean selected = action.actionId.equals(
                recoveryActionState.selectedActionId()
            );
            String disabledReason = enabled
                ? null
                : RecoveryActionPolicy.disabledReason(issue, action);
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(dp(52));
            row.setPadding(dp(12), dp(6), dp(10), dp(6));
            row.setFocusable(true);
            row.setClickable(enabled);
            row.setEnabled(enabled);
            row.setAlpha(enabled ? 1f : 0.66f);
            row.setBackground(choiceShell(selected, false));
            row.setContentDescription(
                action.talkBackDescription(enabled, disabledReason)
            );
            row.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View view) {
                    if (
                        view.isEnabled()
                            && recoveryActionListener != null
                    ) {
                        recoveryActionListener.onRecoveryAction(
                            recoveryAction
                        );
                    }
                }
            });

            TextView label = text(
                action.label,
                TEXT,
                13f,
                Typeface.BOLD
            );
            label.setMaxLines(2);
            row.addView(
                label,
                new LinearLayout.LayoutParams(
                    0,
                    LayoutParams.WRAP_CONTENT,
                    1f
                )
            );

            TextView safety = text(
                action.safetyLabel(),
                accent,
                9f,
                Typeface.BOLD
            );
            safety.setGravity(Gravity.CENTER);
            safety.setPadding(dp(8), dp(4), dp(8), dp(4));
            safety.setBackground(pill(DIVIDER));
            row.addView(safety);

            LinearLayout.LayoutParams rowParams =
                new LinearLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT,
                    LayoutParams.WRAP_CONTENT
                );
            rowParams.setMargins(0, 0, 0, dp(6));
            content.addView(row, rowParams);
        }

        String recoveryMessage = recoveryActionState.message();
        TextView instruction = text(
            recoveryMessage != null
                ? recoveryMessage
                : issue.recoveryInteraction == null
                    ? "Hold to speak a recovery option. "
                        + "Waiting for current server actions."
                    : "Tap a safe recovery action, or hold to speak it.",
            MUTED,
            11f,
            Typeface.NORMAL
        );
        instruction.setMinHeight(dp(48));
        instruction.setGravity(Gravity.CENTER_VERTICAL);
        instruction.setPadding(dp(4), dp(6), dp(4), 0);
        instruction.setContentDescription(
            recoveryMessage != null
                ? recoveryMessage
                : issue.recoveryInteraction == null
                    ? "Recovery actions are not current yet. "
                        + "Hold the companion to speak an option."
                    : "Recovery actions are available. "
                        + "Double tap one, or hold the companion to speak."
        );
        content.addView(instruction);
    }

    private boolean isAuthoritativeCart(
        OverlayPresentation.CartSummary cart
    ) {
        return cart != null && cart.isVerifiedNotOrdered();
    }

    private void renderChecklistFooter(OverlayPresentation presentation) {
        if (checklist == null || checklist.totalItems() == 0) return;
        TextView status = text(
            checklist.completedCount() + " of " + checklist.totalItems()
                + " requested items verified",
            MUTED,
            11f,
            Typeface.NORMAL
        );
        status.setPadding(dp(4), dp(10), dp(4), 0);
        content.addView(status);
    }

    private String choiceContentDescription(
        int number,
        OverlayPresentation.ProductChoice option,
        boolean enabled
    ) {
        StringBuilder base = new StringBuilder();
        base.append("Option ").append(number).append(". ")
            .append(option.title);
        if (
            option.spokenLabel != null
                && !option.spokenLabel.equals(option.title)
        ) {
            base.append(". Say ").append(option.spokenLabel);
        }
        appendDescription(base, option.packSize);
        appendDescription(base, option.price);
        if (option.unitPrice != null) {
            base.append(". Unit price ").append(option.unitPrice);
        }
        appendDescription(base, option.recommendationLabel);
        appendDescription(base, option.availabilityConstraint);
        if (enabled) return base + ". Tap to select, or speak your choice.";
        ProductSelectionState.Status state = productSelectionState.status();
        if (
            option.offerId.equals(productSelectionState.selectedOfferId())
                && (
                    state == ProductSelectionState.Status.SUBMITTING
                        || state == ProductSelectionState.Status.WORKING
                )
        ) {
            return base + ". Selection submitting. You can still speak.";
        }
        if (
            option.offerId.equals(productSelectionState.selectedOfferId())
                && state == ProductSelectionState.Status.ACCEPTED
        ) {
            return base + ". Selection accepted.";
        }
        if (
            option.offerId.equals(productSelectionState.selectedOfferId())
                && state == ProductSelectionState.Status.DUPLICATE
        ) {
            return base + ". Selection already accepted.";
        }
        if (state == ProductSelectionState.Status.EXPIRED) {
            return base + ". Choice expired. Speak your choice.";
        }
        return base + ". Tap unavailable. You can still speak.";
    }

    private void appendDescription(StringBuilder target, String value) {
        if (value != null && !value.trim().isEmpty()) {
            target.append(". ").append(value.trim());
        }
    }

    private void renderContext(
        OverlayPresentation presentation,
        int accent
    ) {
        if (presentation.task != null) {
            renderTaskProgress(presentation.task, accent);
            if ("compact_status".equals(presentation.card.type)) return;
        }
        // checkout_review is accepted only with literal ordered:false.
        // Screen relevance is observational and cannot establish order truth.
        if ("checkout_review".equals(presentation.card.type)) {
            TextView safety = text(
                "NOT ORDERED",
                INK,
                10f,
                Typeface.BOLD
            );
            safety.setLetterSpacing(0.14f);
            safety.setGravity(Gravity.CENTER);
            safety.setBackground(pill(AMBER));
            LinearLayout.LayoutParams safetyParams = new LinearLayout.LayoutParams(
                dp(108),
                dp(28)
            );
            safetyParams.setMargins(dp(4), 0, 0, dp(10));
            content.addView(safety, safetyParams);
        }

        TextView detail = text(
            presentation.card.detail,
            TEXT,
            14f,
            Typeface.NORMAL
        );
        detail.setLineSpacing(dp(2), 1f);
        detail.setMaxLines(4);
        detail.setPadding(dp(4), 0, dp(4), 0);
        content.addView(detail);

        if (presentation.usesProviderScreen()) {
            TextView cue = text(
                "↗  CHECK CURRENT SCREEN",
                accent,
                10f,
                Typeface.BOLD
            );
            cue.setLetterSpacing(0.12f);
            cue.setPadding(dp(4), dp(12), dp(4), 0);
            content.addView(cue);
        }
    }

    private void renderTaskProgress(
        OverlayPresentation.TaskProgress task,
        int accent
    ) {
        String position = task.positionLabel();
        String stage = task.stage
            .replace('_', ' ')
            .toUpperCase(java.util.Locale.US);
        TextView stageView = text(
            position == null ? stage : position + " · " + stage,
            accent,
            10f,
            Typeface.BOLD
        );
        stageView.setLetterSpacing(0.11f);
        stageView.setPadding(dp(4), 0, dp(4), dp(8));
        content.addView(stageView);

        TextView step = text(task.step, TEXT, 14f, Typeface.NORMAL);
        step.setLineSpacing(dp(2), 1f);
        step.setMaxLines(3);
        step.setPadding(dp(4), 0, dp(4), 0);
        content.addView(step);

        String cancellation = task.cancellationLabel();
        if (cancellation != null) {
            TextView cancellationView = text(
                cancellation,
                task.cancellationAvailable ? MUTED : AMBER,
                10f,
                Typeface.BOLD
            );
            cancellationView.setLetterSpacing(0.08f);
            cancellationView.setPadding(dp(4), dp(10), dp(4), 0);
            content.addView(cancellationView);
        }
    }

    private String accessibilityDescription(
        OverlayPresentation presentation
    ) {
        if (presentation.card.issue != null) {
            return "JaldiAI. "
                + presentation.card.issue.talkBackDescription();
        }
        if (isAuthoritativeCart(presentation.card.cartSummary)) {
            return "JaldiAI. Verified cart. "
                + presentation.card.cartSummary.lines.size()
                + " lines. Subtotal "
                + presentation.card.cartSummary.subtotal
                + ". Not ordered.";
        }
        if (presentation.card.cartSummary != null) {
            return "JaldiAI. Cart details unverified. "
                + "Check the current provider screen. No action was taken.";
        }
        if (checklist != null && checklist.totalItems() > 0) {
            StringBuilder task = new StringBuilder("JaldiAI task. ");
            task.append(checklist.completedCount()).append(" of ")
                .append(checklist.totalItems()).append(" items verified.");
            if (checklist.activeLabel() != null) {
                task.append(" ").append(checklist.activeLabel()).append(".");
            }
            return task.toString();
        }
        if (
            presentation.card.completionInteraction != null
                && presentation.task == null
        ) {
            return "JaldiAI. " + presentation.spokenText
                + ". Tap a choice, or hold to speak.";
        }
        if (presentation.task == null) {
            return "JaldiAI. " + presentation.spokenText;
        }
        StringBuilder description = new StringBuilder("JaldiAI. ");
        description.append(presentation.task.title);
        String position = presentation.task.positionLabel();
        if (position != null) description.append(". ").append(position);
        description.append(". ").append(presentation.task.step);
        String cancellation = presentation.task.cancellationLabel();
        if (cancellation != null) {
            description.append(". ").append(
                cancellation.toLowerCase(java.util.Locale.US)
            );
        }
        return description.toString();
    }

    private String eyebrowFor(OverlayPresentation presentation) {
        if (presentation.card.issue != null) {
            return presentation.card.issue.eyebrow();
        }
        if (presentation.usesProviderScreen()) return "ON BLINKIT";
        if ("ambiguous".equals(presentation.mode)) return "VERIFY MANUALLY";
        if ("disconnected".equals(presentation.mode)) return "UPDATES PAUSED";
        if ("paused".equals(presentation.mode)) return "TASK PAUSED";
        return presentation.structured ? "JALDIAI · LIVE" : "JALDIAI";
    }

    private int accentFor(OverlayPresentation presentation) {
        String tone = presentation.card.tone;
        if ("error".equals(tone)) return RED;
        if ("ambiguous".equals(tone)) return AMBER;
        if ("confirmation".equals(tone)) return AMBER;
        if ("attention".equals(tone)) return AMBER;
        if ("active".equals(tone)) return BLUE;
        return LIME;
    }

    private int phaseColor(TaskChecklistState.Phase phase) {
        if (phase == TaskChecklistState.Phase.BLOCKED) return RED;
        if (
            phase == TaskChecklistState.Phase.AMBIGUOUS
                || phase == TaskChecklistState.Phase.WAITING
                || phase == TaskChecklistState.Phase.PAUSED
                || phase == TaskChecklistState.Phase.DISCONNECTED
        ) {
            return AMBER;
        }
        if (
            phase == TaskChecklistState.Phase.SEARCHING
                || phase == TaskChecklistState.Phase.SELECTED
                || phase == TaskChecklistState.Phase.ADDING
                || phase == TaskChecklistState.Phase.VERIFYING
        ) {
            return BLUE;
        }
        return phase == TaskChecklistState.Phase.VERIFIED
                || phase == TaskChecklistState.Phase.SUCCESS
            ? LIME
            : MUTED;
    }

    private String phaseStage(TaskChecklistState.Phase phase) {
        if (phase == TaskChecklistState.Phase.WAITING) {
            return "waiting_for_choice";
        }
        if (phase == TaskChecklistState.Phase.SELECTED) return "selected";
        return phase.value();
    }

    private String cleanChecklistLabel(String value) {
        if (value == null) return null;
        String label = value.trim();
        if (label.isEmpty()) return null;
        String[] prefixes = new String[]{
            "Searching for ",
            "Choose ",
            "Next: ",
            "Adding ",
            "Checking "
        };
        for (String prefix : prefixes) {
            if (label.startsWith(prefix) && label.length() > prefix.length()) {
                label = label.substring(prefix.length()).trim();
                break;
            }
        }
        String[] suffixes = new String[]{
            " added to cart",
            " added"
        };
        for (String suffix : suffixes) {
            if (label.endsWith(suffix) && label.length() > suffix.length()) {
                label = label.substring(
                    0,
                    label.length() - suffix.length()
                ).trim();
                break;
            }
        }
        return label.isEmpty() ? null : label;
    }

    private GradientDrawable shell(int accent, boolean shouldExpand) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(shouldExpand ? SURFACE : INK);
        drawable.setCornerRadius(dp(shouldExpand ? 22 : 32));
        drawable.setStroke(dp(1), Color.argb(shouldExpand ? 150 : 80, Color.red(accent), Color.green(accent), Color.blue(accent)));
        return drawable;
    }

    private GradientDrawable circle(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(color);
        return drawable;
    }

    private GradientDrawable pill(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(14));
        return drawable;
    }

    private GradientDrawable choiceShell(boolean selected, boolean enabled) {
        return choiceShell(selected, enabled, false);
    }

    private GradientDrawable choiceShell(
        boolean selected,
        boolean enabled,
        boolean focused
    ) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(selected ? Color.rgb(36, 51, 29) : SURFACE);
        drawable.setCornerRadius(dp(14));
        int stroke = selected
            ? LIME
            : focused
                ? BLUE
                : enabled
                    ? DIVIDER
                    : Color.rgb(37, 43, 39);
        drawable.setStroke(dp(focused ? 2 : 1), stroke);
        return drawable;
    }

    private OverlayPresentation.ProductChoice findChoice(String offerId) {
        if (offerId == null || latest == null) return null;
        for (OverlayPresentation.ProductChoice option : latest.card.options) {
            if (offerId.equals(option.offerId)) return option;
        }
        return null;
    }

    private void loadProductImage(ImageView view, String imageUrl) {
        view.setTag(imageUrl);
        view.setClipToOutline(true);
        IMAGE_EXECUTOR.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(
                        imageUrl
                    ).openConnection();
                    connection.setConnectTimeout(3000);
                    connection.setReadTimeout(4000);
                    connection.setInstanceFollowRedirects(false);
                    connection.setRequestMethod("GET");
                    int code = connection.getResponseCode();
                    int length = connection.getContentLength();
                    if (
                        code < 200
                            || code >= 300
                            || length > 2 * 1024 * 1024
                    ) {
                        return;
                    }
                    Bitmap bitmap = decodeProductImage(
                        connection.getInputStream()
                    );
                    if (bitmap == null) return;
                    view.post(new Runnable() {
                        @Override
                        public void run() {
                            if (imageUrl.equals(view.getTag())) {
                                view.setImageBitmap(bitmap);
                            }
                        }
                    });
                } catch (Exception ignored) {
                    // Text remains complete when a product image cannot load.
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        });
    }

    private Bitmap decodeProductImage(InputStream input) throws Exception {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > 2 * 1024 * 1024) return null;
                output.write(buffer, 0, count);
            }
            byte[] encoded = output.toByteArray();
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(
                encoded,
                0,
                encoded.length,
                bounds
            );
            int sample = 1;
            while (
                bounds.outWidth / sample > 256
                    || bounds.outHeight / sample > 256
            ) {
                sample *= 2;
            }
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = Math.max(1, sample);
            return BitmapFactory.decodeByteArray(
                encoded,
                0,
                encoded.length,
                options
            );
        } finally {
            input.close();
        }
    }

    private TextView text(
        String value,
        int color,
        float size,
        int style
    ) {
        TextView view = new TextView(getContext());
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        view.setTypeface(Typeface.create("sans-serif", style));
        return view;
    }

    private String joinMetadata(String first, String second) {
        if (first == null && second == null) return null;
        if (first == null) return second;
        if (second == null) return first;
        return first + " · " + second;
    }

    private int dp(int value) {
        return Math.round(
            value * getResources().getDisplayMetrics().density
        );
    }
}
