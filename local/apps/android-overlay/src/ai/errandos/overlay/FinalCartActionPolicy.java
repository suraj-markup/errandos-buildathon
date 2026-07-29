package ai.errandos.overlay;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Projects a server interaction into the bounded, non-ordering final-cart
 * actions that the companion is allowed to render.
 */
final class FinalCartActionPolicy {
    enum Kind {
        REVIEW_CART,
        KEEP_SHOPPING,
        REVIEW_CHECKOUT,
        STOP
    }

    static final class Action {
        final Kind kind;
        final String label;
        final String talkBackDescription;
        final OverlayPresentation.CompletionChoice backingChoice;

        Action(
            Kind kind,
            String label,
            String talkBackDescription,
            OverlayPresentation.CompletionChoice backingChoice
        ) {
            this.kind = kind;
            this.label = label;
            this.talkBackDescription = talkBackDescription;
            this.backingChoice = backingChoice;
        }

        boolean enabled() {
            return backingChoice != null && backingChoice.enabled;
        }
    }

    private FinalCartActionPolicy() {}

    static List<Action> safeActions(
        OverlayPresentation.CompletionInteraction interaction
    ) {
        ArrayList<Action> result = new ArrayList<Action>();
        if (
            interaction == null
                || interaction.version != 2
                || !hasRequiredRepositoryBackedActions(interaction)
        ) {
            return Collections.unmodifiableList(result);
        }
        OverlayPresentation.CompletionChoice reviewCart = find(
            interaction,
            "review_cart"
        );
        result.add(new Action(
            Kind.REVIEW_CART,
            "Review cart",
            reviewCart.enabled
                ? "Review cart. Read-only. Does not change your cart."
                : unavailable("Review cart", reviewCart),
            reviewCart
        ));
        OverlayPresentation.CompletionChoice keepShopping = find(
            interaction,
            "keep_shopping"
        );
        result.add(new Action(
            Kind.KEEP_SHOPPING,
            "Keep shopping",
            keepShopping.enabled
                ? "Keep shopping. Returns to adding items."
                : unavailable("Keep shopping", keepShopping),
            keepShopping
        ));
        OverlayPresentation.CompletionChoice reviewCheckout = find(
            interaction,
            "review_checkout"
        );
        if (reviewCheckout != null) {
            result.add(new Action(
                Kind.REVIEW_CHECKOUT,
                "Review checkout",
                reviewCheckout.enabled
                    ? "Review checkout. Review only. No order is placed."
                    : unavailable("Review checkout", reviewCheckout),
                reviewCheckout
            ));
        }
        OverlayPresentation.CompletionChoice stop = find(interaction, "stop");
        result.add(new Action(
            Kind.STOP,
            "Stop here",
            stop.enabled
                ? "Stop here. Stops this companion task. Cart items remain."
                : unavailable("Stop here", stop),
            stop
        ));
        return Collections.unmodifiableList(result);
    }

    static boolean hasRequiredRepositoryBackedActions(
        OverlayPresentation.CompletionInteraction interaction
    ) {
        if (interaction == null || interaction.version != 2) return false;
        return find(interaction, "review_cart") != null
            && find(interaction, "keep_shopping") != null
            && find(interaction, "stop") != null;
    }

    private static OverlayPresentation.CompletionChoice find(
        OverlayPresentation.CompletionInteraction interaction,
        String choiceId
    ) {
        for (
            OverlayPresentation.CompletionChoice choice :
                interaction.choices
        ) {
            if (choiceId.equals(choice.choiceId)) return choice;
        }
        return null;
    }

    private static String unavailable(
        String label,
        OverlayPresentation.CompletionChoice choice
    ) {
        return label + ". Unavailable. "
            + (
                choice.disabledReason == null
                    ? "Use voice if you need help."
                    : choice.disabledReason
            );
    }
}
