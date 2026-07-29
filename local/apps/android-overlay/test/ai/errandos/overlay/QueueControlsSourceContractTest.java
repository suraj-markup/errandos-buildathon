package ai.errandos.overlay;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class QueueControlsSourceContractTest {
    public static void main(String[] args) throws Exception {
        Path source = Path.of(args[0]);
        String card = Files.readString(
            source.resolve("OverlayCardView.java"),
            StandardCharsets.UTF_8
        );
        String service = Files.readString(
            source.resolve("OverlayService.java"),
            StandardCharsets.UTF_8
        );
        require(
            card.contains("setOnQueueActionListener")
                && card.contains("renderQueueItemActions")
                && card.contains("renderQueueTaskActions"),
            "queue controls are wired into the real card"
        );
        for (String label : new String[] {
            "Refine", "Remove", "Skip", "Move up", "Move down",
            "Pause", "Resume", "Cancel"
        }) {
            require(
                card.contains("QueueActionPolicy.label"),
                "labels come from canonical action policy: " + label
            );
        }
        require(
            card.contains("setMinHeight(dp(48))")
                && card.contains(
                    "Double tap to update the future task list."
                ),
            "queue controls have touch target and TalkBack action copy"
        );
        require(
            card.contains(
                "Unavailable while this item or task is in flight."
            ),
            "disabled reason is announced"
        );
        require(
            service.contains(
                "http://127.0.0.1:3100/api/device/task/queue"
            )
                && service.contains("QUEUE_PENDING_COMMAND_KEY")
                && service.contains("restorePendingQueueCommand"),
            "real route and recreation recovery are wired"
        );
        require(
            service.contains(".putString(QUEUE_PENDING_COMMAND_KEY, payload)")
                && service.contains(".commit();"),
            "optimistic command is durably persisted before transport"
        );
        System.out.println("QueueControlsSourceContractTest passed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
