package ai.errandos.overlay;

import java.util.Arrays;
import java.util.Base64;

public final class OverlayRecoverySnapshotTest {
    public static void main(String[] args) {
        long now = 10_000L;
        OverlayPresentation.ProductSelectionBinding binding =
            new OverlayPresentation.ProductSelectionBinding(
                2,
                "pixel-overlay",
                "task_12345678",
                2,
                "interaction_12345678",
                "selection_12345678",
                now + 60_000L
            );
        OverlayPresentation presentation = new OverlayPresentation(
            1,
            "waiting_for_user",
            "provider_screen",
            "search_results",
            "product_options",
            "options",
            new OverlayPresentation.TaskProgress(
                1,
                "task_12345678",
                "task_item_12345678",
                "operation_12345678",
                "Find grocery item",
                "Waiting for your choice",
                "waiting_for_choice",
                3,
                1,
                3,
                true,
                "cancel_now",
                false
            ),
            new OverlayPresentation.Card(
                "product_choices",
                "attention",
                "ONE MATCH",
                "Tap or speak.",
                Arrays.asList(new OverlayPresentation.ProductChoice(
                    "offer-1",
                    "Amul Milk",
                    "Amul Milk",
                    "500 ml",
                    "₹29",
                    "https://cdn.blinkit.com/products/milk.png",
                    "₹5.80 / 100 ml",
                    "Available",
                    "Suggested"
                )),
                binding
            ),
            "Choose one.",
            "en-IN",
            false,
            6500L,
            true,
            true
        );
        String encoded = OverlayRecoverySnapshot.encode(
            presentation,
            true,
            now
        );
        OverlayRecoverySnapshot.Restored restored =
            OverlayRecoverySnapshot.decode(encoded, now + 100L);
        require(restored != null, "snapshot must restore");
        require(restored.expanded, "persistent card must stay expanded");
        require(
            "overlay_card".equals(restored.presentation.primarySurface),
            "stale provider-screen attention must not restore"
        );
        require(
            restored.presentation.card.selection != null,
            "exact selection binding must restore"
        );
        require(
            "offer-1".equals(
                restored.presentation.card.options.get(0).offerId
            ),
            "product option identity must restore"
        );
        require(
            "Suggested".equals(
                restored.presentation.card.options.get(0)
                    .recommendationLabel
            ),
            "rich product metadata must restore"
        );
        require(
            restored.presentation.task != null
                && "1 of 3".equals(
                    restored.presentation.task.positionLabel()
                ),
            "structured task progress must restore"
        );

        OverlayPresentation.CompletionInteraction completion =
            new OverlayPresentation.CompletionInteraction(
                2,
                "interaction_12345678",
                "task_12345678",
                3,
                now + 60_000L,
                "saved payment",
                Arrays.asList(new OverlayPresentation.CompletionChoice(
                    "stop",
                    "Stop here",
                    true,
                    null
                ))
            );
        OverlayPresentation completionPresentation =
            new OverlayPresentation(
                1,
                "waiting_for_user",
                "overlay_card",
                null,
                null,
                null,
                presentation.task,
                new OverlayPresentation.Card(
                    "completion_choices",
                    "attention",
                    "WHAT NEXT?",
                    "Tap or speak.",
                    completion
                ),
                "What would you like to do next?",
                "en-IN",
                false,
                6500L,
                true,
                true
            );
        OverlayRecoverySnapshot.Restored completionRestored =
            OverlayRecoverySnapshot.decode(
                OverlayRecoverySnapshot.encode(
                    completionPresentation,
                    true,
                    now
                ),
                now + 100L
            );
        require(
            completionRestored != null
                && completionRestored.presentation.card
                    .completionInteraction != null,
            "pending completion interaction must restore"
        );

        RecoveryActionBinding recoveryBinding =
            new RecoveryActionBinding(
                2,
                "recovery_12345678",
                "operation_12345678",
                "step:first",
                "task_12345678",
                4,
                now + 60_000L
            );
        CompanionIssueV2 recoveryIssue = CompanionIssueV2
            .canonical("reconciliation_required")
            .withRecoveryInteraction(recoveryBinding);
        OverlayPresentation recoveryPresentation =
            new OverlayPresentation(
                1,
                "ambiguous",
                "overlay_card",
                null,
                null,
                null,
                presentation.task,
                new OverlayPresentation.Card(
                    "companion_issue",
                    "ambiguous",
                    recoveryIssue.title,
                    recoveryIssue.detail,
                    recoveryIssue
                ),
                recoveryIssue.detail,
                "en-IN",
                false,
                6500L,
                true,
                true
            );
        OverlayRecoverySnapshot.Restored recoveryRestored =
            OverlayRecoverySnapshot.decode(
                OverlayRecoverySnapshot.encode(
                    recoveryPresentation,
                    true,
                    now
                ),
                now + 100L
            );
        require(
            recoveryRestored != null
                && recoveryRestored.presentation.card.issue != null
                && recoveryRestored.presentation.card.issue
                    .recoveryInteraction != null
                && "recovery_12345678".equals(
                    recoveryRestored.presentation.card.issue
                        .recoveryInteraction.interactionId
                ),
            "recovery issue and exact interaction survive recreation"
        );
        String versionThree = asVersionThree(
            OverlayRecoverySnapshot.encode(
                completionPresentation,
                true,
                now
            )
        );
        OverlayRecoverySnapshot.Restored versionThreeRestored =
            OverlayRecoverySnapshot.decode(versionThree, now + 100L);
        require(
            versionThreeRestored != null
                && versionThreeRestored.presentation.card
                    .completionInteraction != null,
            "version 3 completion snapshot must remain upgrade-compatible"
        );

        OverlayPresentation.CartSummary cart =
            new OverlayPresentation.CartSummary(
                Arrays.asList(new OverlayPresentation.CartLine(
                    "potato-1",
                    "Potato",
                    1,
                    "₹27",
                    "₹27"
                )),
                "₹27",
                "Home",
                true,
                false
            );
        OverlayPresentation cartPresentation = new OverlayPresentation(
            1,
            "success",
            "overlay_card",
            null,
            null,
            null,
            null,
            new OverlayPresentation.Card(
                "cart_summary",
                "success",
                "CART SUMMARY",
                "1 item · ₹27",
                java.util.Collections
                    .<OverlayPresentation.ProductChoice>emptyList(),
                null,
                cart
            ),
            "Your verified subtotal is ₹27.",
            "en-IN",
            false,
            6500L,
            true,
            true
        );
        OverlayRecoverySnapshot.Restored cartRestored =
            OverlayRecoverySnapshot.decode(
                OverlayRecoverySnapshot.encode(cartPresentation, true, now),
                now + 100L
            );
        require(
            cartRestored != null
                && cartRestored.presentation.card.cartSummary != null
                && "₹27".equals(
                    cartRestored.presentation.card.cartSummary.subtotal
                ),
            "authoritative cart lines and subtotal must restore"
        );
        require(
            cartRestored.presentation.card.cartSummary
                .isVerifiedNotOrdered(),
            "restored cart provenance must remain authoritative"
        );
        require(
            OverlayRecoverySnapshot.decode(
                asVersionFourWithoutCartProvenance(
                    OverlayRecoverySnapshot.encode(
                        cartPresentation,
                        true,
                        now
                    )
                ),
                now + 100L
            ) == null,
            "pre-provenance cart snapshot must fail closed after restart"
        );
        OverlayPresentation unsafeCartPresentation =
            new OverlayPresentation(
                1,
                "success",
                "overlay_card",
                null,
                null,
                null,
                null,
                new OverlayPresentation.Card(
                    "cart_summary",
                    "success",
                    "CART SUMMARY",
                    "Untrusted",
                    java.util.Collections
                        .<OverlayPresentation.ProductChoice>emptyList(),
                    null,
                    new OverlayPresentation.CartSummary(
                        cart.lines,
                        cart.subtotal,
                        cart.addressLabel
                    )
                ),
                "Untrusted cart",
                "en-IN",
                false,
                6500L,
                true,
                true
            );
        require(
            OverlayRecoverySnapshot.encode(
                unsafeCartPresentation,
                true,
                now
            ) == null,
            "negative cart provenance must never persist"
        );

        OverlayPresentation actingPresentation = new OverlayPresentation(
            1,
            "acting",
            "overlay_card",
            null,
            null,
            null,
            presentation.task,
            new OverlayPresentation.Card(
                "compact_status",
                "active",
                "WORKING",
                "Searching products",
                java.util.Collections
                    .<OverlayPresentation.ProductChoice>emptyList(),
                null
            ),
            "Searching products",
            "en-IN",
            true,
            6500L,
            true,
            true
        );
        OverlayRecoverySnapshot.Restored actingRestored =
            OverlayRecoverySnapshot.decode(
                OverlayRecoverySnapshot.encode(
                    actingPresentation,
                    true,
                    now
                ),
                now + 100L
            );
        require(
            actingRestored != null
                && actingRestored.presentation.task != null
                && "acting".equals(actingRestored.presentation.mode),
            "retained safe task progress must survive recreation"
        );

        OverlayPresentation transientPresentation =
            OverlayPresentation.legacy("Listening.", "listening");
        OverlayRecoverySnapshot.Restored interrupted =
            OverlayRecoverySnapshot.decode(
                OverlayRecoverySnapshot.encode(
                    transientPresentation,
                    true,
                    now
                ),
                now + 100L
            );
        require(interrupted != null, "transient snapshot must become safe");
        require(
            "error".equals(interrupted.presentation.mode),
            "recording must never resume after recreation"
        );
        require(!interrupted.expanded, "interrupted state starts collapsed");

        require(
            OverlayRecoverySnapshot.decode(encoded, now - 1L) == null,
            "future snapshot must fail closed"
        );
        require(
            OverlayRecoverySnapshot.decode(
                encoded,
                now + OverlayRecoverySnapshot.MAX_AGE_MS + 1L
            ) == null,
            "stale snapshot must expire"
        );
        require(
            OverlayRecoverySnapshot.decode("not-base64", now) == null,
            "malformed snapshot must fail closed"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static String asVersionThree(String versionSix) {
        byte[] source = Base64.getUrlDecoder().decode(versionSix);
        // V4/V5 add cart-summary presence and V6 adds issue presence
        // immediately before the existing expanded flag.
        byte[] result = new byte[source.length - 2];
        System.arraycopy(source, 0, result, 0, source.length - 3);
        result[result.length - 1] = source[source.length - 1];
        result[0] = 0;
        result[1] = 0;
        result[2] = 0;
        result[3] = 3;
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(result);
    }

    private static String asVersionFourWithoutCartProvenance(
        String versionSix
    ) {
        byte[] source = Base64.getUrlDecoder().decode(versionSix);
        // V5 appends verified + ordered; V6 appends issue presence before
        // the existing expanded flag.
        byte[] result = new byte[source.length - 3];
        System.arraycopy(source, 0, result, 0, source.length - 4);
        result[result.length - 1] = source[source.length - 1];
        result[0] = 0;
        result[1] = 0;
        result[2] = 0;
        result[3] = 4;
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(result);
    }
}
