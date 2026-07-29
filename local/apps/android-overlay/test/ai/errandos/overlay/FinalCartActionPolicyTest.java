package ai.errandos.overlay;

import java.util.Arrays;
import java.util.List;

public final class FinalCartActionPolicyTest {
    public static void main(String[] args) {
        cartProvenanceFailsClosed();
        safeActionsAreExactAndBounded();
        reviewCheckoutIsOptional();
        talkBackCopyStatesReadOnlySafety();
    }

    private static void cartProvenanceFailsClosed() {
        OverlayPresentation.CartSummary legacy =
            new OverlayPresentation.CartSummary(
                java.util.Collections
                    .<OverlayPresentation.CartLine>emptyList(),
                "₹0",
                "Home"
            );
        require(
            !legacy.isVerifiedNotOrdered(),
            "missing provenance must never render verified/not-ordered truth"
        );
        OverlayPresentation.CartSummary ordered =
            new OverlayPresentation.CartSummary(
                java.util.Collections
                    .<OverlayPresentation.CartLine>emptyList(),
                "₹0",
                "Home",
                true,
                true
            );
        require(
            !ordered.isVerifiedNotOrdered(),
            "ordered carts must never render NOT ORDERED"
        );
        OverlayPresentation.CartSummary safe =
            new OverlayPresentation.CartSummary(
                java.util.Collections
                    .<OverlayPresentation.CartLine>emptyList(),
                "₹0",
                "Home",
                true,
                false
            );
        require(
            safe.isVerifiedNotOrdered(),
            "both authoritative flags are required for the final card"
        );
    }

    private static void safeActionsAreExactAndBounded() {
        OverlayPresentation.CompletionInteraction interaction = interaction(
            new OverlayPresentation.CompletionChoice(
                "review_cart",
                "Review cart",
                true,
                null
            ),
            new OverlayPresentation.CompletionChoice(
                "keep_shopping",
                "Keep shopping",
                true,
                null
            ),
            new OverlayPresentation.CompletionChoice(
                "review_checkout",
                "Go to checkout",
                true,
                null
            ),
            new OverlayPresentation.CompletionChoice(
                "stop",
                "Stop here",
                true,
                null
            )
        );
        List<FinalCartActionPolicy.Action> actions =
            FinalCartActionPolicy.safeActions(interaction);
        require(actions.size() == 4, "only four safe actions may render");
        require(
            "Review cart".equals(actions.get(0).label),
            "review-cart label must be exact"
        );
        require(
            "Keep shopping".equals(actions.get(1).label),
            "keep-shopping label must be exact"
        );
        require(
            "Review checkout".equals(actions.get(2).label),
            "review-checkout label must be exact"
        );
        require(
            "Stop here".equals(actions.get(3).label),
            "stop label must be exact"
        );
        for (FinalCartActionPolicy.Action action : actions) {
            require(
                action.backingChoice != null,
                "every action must be backed by the persisted interaction"
            );
        }
    }

    private static void reviewCheckoutIsOptional() {
        List<FinalCartActionPolicy.Action> actions =
            FinalCartActionPolicy.safeActions(interaction(
                new OverlayPresentation.CompletionChoice(
                    "review_cart",
                    "Review cart",
                    true,
                    null
                ),
                new OverlayPresentation.CompletionChoice(
                    "keep_shopping",
                    "Keep shopping",
                    true,
                    null
                ),
                new OverlayPresentation.CompletionChoice(
                    "stop",
                    "Stop",
                    true,
                    null
                )
            ));
        require(actions.size() == 3, "checkout action must be optional");
        require(
            actions.get(0).kind == FinalCartActionPolicy.Kind.REVIEW_CART
                && actions.get(1).kind
                    == FinalCartActionPolicy.Kind.KEEP_SHOPPING
                && actions.get(2).kind == FinalCartActionPolicy.Kind.STOP,
            "safe action order must remain deterministic"
        );
    }

    private static void talkBackCopyStatesReadOnlySafety() {
        List<FinalCartActionPolicy.Action> actions =
            FinalCartActionPolicy.safeActions(interaction(
                new OverlayPresentation.CompletionChoice(
                    "review_cart",
                    "Review cart",
                    true,
                    null
                ),
                new OverlayPresentation.CompletionChoice(
                    "keep_shopping",
                    "Keep shopping",
                    true,
                    null
                ),
                new OverlayPresentation.CompletionChoice(
                    "review_checkout",
                    "Review",
                    true,
                    null
                ),
                new OverlayPresentation.CompletionChoice(
                    "stop",
                    "Stop here",
                    true,
                    null
                )
            ));
        require(
            actions.get(0).talkBackDescription.contains("Read-only"),
            "review cart must announce read-only behavior"
        );
        require(
            actions.get(2).talkBackDescription.contains(
                "No order is placed"
            ),
            "review checkout must announce the non-ordering boundary"
        );

        require(
            FinalCartActionPolicy.safeActions(interaction(
                new OverlayPresentation.CompletionChoice(
                    "review_checkout",
                    "Review checkout",
                    true,
                    null
                )
            )).isEmpty(),
            "partial or synthetic final action sets must fail closed"
        );
    }

    private static OverlayPresentation.CompletionInteraction interaction(
        OverlayPresentation.CompletionChoice... choices
    ) {
        return new OverlayPresentation.CompletionInteraction(
            2,
            "interaction-12345678",
            "task-12345678",
            4,
            Long.MAX_VALUE,
            null,
            Arrays.asList(choices)
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
