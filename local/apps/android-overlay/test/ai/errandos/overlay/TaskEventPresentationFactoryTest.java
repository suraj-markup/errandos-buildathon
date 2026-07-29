package ai.errandos.overlay;

import java.util.Arrays;

public final class TaskEventPresentationFactoryTest {
    public static void main(String[] args) {
        RetainedTaskEvent moving = event(
            4,
            "moving_to_next_step",
            "Next: ice cream",
            "Preparing to search for ice cream.",
            "Milk added. Now searching for ice cream.",
            null
        );
        OverlayPresentation movingPresentation =
            TaskEventPresentationFactory.create(
                moving,
                "operation_12345678"
            );
        require(
            "searching".equals(movingPresentation.task.stage),
            "next search must remain visually detailed"
        );
        require(
            "Milk added. Now searching for ice cream.".equals(
                movingPresentation.spokenText
            ),
            "verified completion announcement must be exact"
        );

        OverlayPresentation.CompletionInteraction interaction =
            new OverlayPresentation.CompletionInteraction(
                2,
                "interaction_12345678",
                "task_12345678",
                8,
                90_000L,
                "saved UPI",
                Arrays.asList(
                    new OverlayPresentation.CompletionChoice(
                        "add_more",
                        "Add more items",
                        true,
                        null
                    ),
                    new OverlayPresentation.CompletionChoice(
                        "review_checkout",
                        "Review checkout",
                        true,
                        null
                    ),
                    new OverlayPresentation.CompletionChoice(
                        "use_current_payment",
                        "Continue with saved UPI",
                        true,
                        null
                    ),
                    new OverlayPresentation.CompletionChoice(
                        "use_cod",
                        "Review with Cash on Delivery",
                        true,
                        null
                    ),
                    new OverlayPresentation.CompletionChoice(
                        "stop",
                        "Stop here",
                        true,
                        null
                    )
                )
            );
        OverlayPresentation choicePresentation =
            TaskEventPresentationFactory.create(
                event(
                    5,
                    "waiting_for_user",
                    "Choose what to do next",
                    null,
                    "What would you like to do next?",
                    interaction
                ),
                "operation_12345678"
            );
        require(
            "completion_choices".equals(choicePresentation.card.type),
            "completion choices need an interactive card"
        );
        require(
            choicePresentation.card.completionInteraction.choices.size() == 5,
            "all five bounded choices must render"
        );
        require(
            !choicePresentation.autoCollapse,
            "pending interaction must remain visible"
        );

        OverlayPresentation ambiguity =
            TaskEventPresentationFactory.create(
                event(
                    6,
                    "ambiguous",
                    "Checking what happened",
                    "Read-only recovery will not repeat the cart change.",
                    "I will not repeat the cart change while I check.",
                    null
                ),
                "operation_12345678"
            );
        require(
            ambiguity.task != null && !ambiguity.task.terminal,
            "ambiguity must remain nonterminal"
        );
        require(
            !ambiguity.autoCollapse,
            "read-only recovery copy must remain visible"
        );
        require(
            ambiguity.card.detail.contains("will not repeat"),
            "ambiguity copy must state no-repeat recovery"
        );

        RetainedTaskEvent cancelled = new RetainedTaskEvent(
            "event_cancelled",
            "task_12345678",
            9,
            "operation_12345678",
            "step_cancelled",
            7,
            "cancelled",
            "Task cancelled",
            "No further phone work will run.",
            1,
            2,
            50_007L,
            "visual_only",
            "Task cancelled",
            null,
            OverlayPresentation.legacy("Task cancelled", "error"),
            true
        );
        OverlayPresentation cancellation =
            TaskEventPresentationFactory.create(
                cancelled,
                "operation_12345678"
            );
        require(
            cancellation.task != null
                && cancellation.task.terminal
                && "cancelled".equals(cancellation.task.stage),
            "explicit cancellation must be terminal"
        );
        require(
            "idle".equals(cancellation.mode)
                && "neutral".equals(cancellation.card.tone)
                && "TASK STOPPED".equals(cancellation.card.headline),
            "cancelled terminal must use neutral stopped styling"
        );
        require(
            cancellation.structured,
            "obsolete error safePresentation must be replaced, not reused"
        );
    }

    private static RetainedTaskEvent event(
        int sequence,
        String kind,
        String title,
        String detail,
        String announcement,
        OverlayPresentation.CompletionInteraction interaction
    ) {
        return new RetainedTaskEvent(
            "event_" + sequence,
            "task_12345678",
            8,
            "operation_12345678",
            "step_" + sequence,
            sequence,
            kind,
            title,
            detail,
            1,
            2,
            50_000L + sequence,
            "speech_and_visual",
            announcement,
            interaction,
            null
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
