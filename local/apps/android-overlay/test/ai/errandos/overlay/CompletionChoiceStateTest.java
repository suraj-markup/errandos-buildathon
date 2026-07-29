package ai.errandos.overlay;

import java.util.Arrays;

public final class CompletionChoiceStateTest {
    public static void main(String[] args) {
        long now = 10_000L;
        OverlayPresentation.CompletionChoice enabled =
            new OverlayPresentation.CompletionChoice(
                "add_more",
                "Add more items",
                true,
                null
            );
        OverlayPresentation.CompletionChoice disabled =
            new OverlayPresentation.CompletionChoice(
                "use_cod",
                "Review with Cash on Delivery",
                false,
                "Cash on Delivery is unavailable."
            );
        OverlayPresentation.CompletionInteraction interaction = interaction(
            "interaction_12345678",
            now + 60_000L,
            enabled,
            disabled
        );
        CompletionChoiceState state = new CompletionChoiceState();
        state.attach(interaction, now);
        require(state.canTap(), "fresh interaction must be tappable");
        require(
            state.begin(disabled, now) == null,
            "disabled server choice must not submit"
        );
        require(
            state.begin(enabled, now) == interaction,
            "enabled choice must preserve exact interaction binding"
        );
        require(!state.canTap(), "repeat taps must be blocked");
        state.attach(interaction, now + 1L);
        require(
            state.status() == CompletionChoiceState.Status.SUBMITTING,
            "same interaction refresh must preserve in-flight tap"
        );
        require(
            "add_more".equals(state.selectedChoiceId()),
            "selected choice identity must remain exact"
        );
        state.complete(
            CompletionChoiceState.Status.ACCEPTED,
            "Accepted",
            false
        );
        require(!state.canTap(), "accepted interaction cannot submit twice");

        OverlayPresentation.CompletionInteraction replacement = interaction(
            "interaction_87654321",
            now + 60_000L,
            enabled
        );
        state.attach(replacement, now);
        require(state.canTap(), "new interaction must reset tap guard");
        state.attach(
            interaction("interaction_99999999", now, enabled),
            now
        );
        require(
            state.status() == CompletionChoiceState.Status.EXPIRED,
            "expired interaction must fail closed"
        );
    }

    private static OverlayPresentation.CompletionInteraction interaction(
        String id,
        long expiresAt,
        OverlayPresentation.CompletionChoice... choices
    ) {
        return new OverlayPresentation.CompletionInteraction(
            2,
            id,
            "task_12345678",
            7,
            expiresAt,
            "saved payment",
            Arrays.asList(choices)
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
