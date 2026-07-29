package ai.errandos.overlay;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

public final class TaskProjectionDurabilityTest {
    public static void main(String[] args) throws Exception {
        terminalCrashWindowRestoresEveryAuthoritativeField();
        terminalResetUsesProductionParserAndRestoresCart(args[0]);
    }

    private static void terminalResetUsesProductionParserAndRestoresCart(
        String fixturePath
    ) throws Exception {
        JSONObject envelope = new JSONObject(new String(
            Files.readAllBytes(Paths.get(fixturePath)),
            StandardCharsets.UTF_8
        ));
        JSONObject projection = envelope.getJSONObject("snapshot");
        JSONObject latest = projection.getJSONObject("latestEvent");
        latest.put("kind", "completed");
        latest.put("title", "Cart verified");
        latest.put("detail", "3 verified items · Subtotal ₹119");
        latest.getJSONObject("progress").put("completed", 3);
        projection.getJSONObject("progress").put("completed", 3);
        projection.put("terminal", true);
        projection.put(
            "finalCartSummary",
            new JSONObject(
                "{\"status\":\"ready\","
                    + "\"inspectedAt\":1785202001300,"
                    + "\"lines\":["
                    + "{\"productId\":\"product_milk\","
                    + "\"title\":\"Amul Milk\",\"quantity\":1,"
                    + "\"price\":\"₹29\"},"
                    + "{\"productId\":\"product_bread\","
                    + "\"title\":\"Bread\",\"quantity\":2,"
                    + "\"price\":\"₹45\"}],"
                    + "\"subtotal\":\"₹119\"}"
            )
        );

        RetainedTaskEventParser parser = new RetainedTaskEventParser(
            new OverlayPresentationParser()
        );
        RetainedTaskEventParser.Snapshot snapshot =
            parser.parseSnapshot(envelope);
        require(snapshot.resetRequired, "fixture must be a reset");
        require(
            snapshot.resetFinalCartPresentation != null,
            "reset parser must canonically hydrate final cart"
        );

        TaskEventSubscriptionState cursor =
            new TaskEventSubscriptionState();
        cursor.restore(
            snapshot.taskId,
            snapshot.resetSnapshot.latestSequence,
            snapshot.resetSnapshot.taskRevision,
            "operation_reset-recovery-12345678",
            snapshot.resetSnapshot.terminal
        );
        TaskChecklistState checklist = new TaskChecklistState();
        require(
            checklist.applyResetSnapshot(snapshot.resetSnapshot),
            "reset checklist projection"
        );
        TaskProjectionDurability.Prepared committed =
            TaskProjectionDurability.prepare(
                cursor,
                checklist,
                snapshot.resetPresentation,
                snapshot.resetFinalCartPresentation,
                false,
                1785202001400L
            );
        require(committed != null, "terminal reset projection must prepare");

        // Crash immediately after the one durable transaction and before any
        // reset rendering. Both records must be independently recoverable.
        OverlayRecoverySnapshot.Restored restartedLatest =
            OverlayRecoverySnapshot.decode(
                committed.recoveryPresentation,
                1785202001500L
            );
        OverlayRecoverySnapshot.Restored restartedCart =
            OverlayRecoverySnapshot.decode(
                committed.verifiedCartPresentation,
                1785202001500L
            );
        require(committed.terminal, "terminal reset cursor survives");
        require(
            restartedLatest != null
                && restartedLatest.presentation.card.cartSummary != null,
            "terminal reset latest presentation survives"
        );
        require(
            restartedCart != null
                && restartedCart.presentation.card.cartSummary
                    .isVerifiedNotOrdered()
                && "₹119".equals(
                    restartedCart.presentation.card.cartSummary.subtotal
                ),
            "terminal reset verified cart survives"
        );
    }

    private static void terminalCrashWindowRestoresEveryAuthoritativeField() {
        String taskId = "task_terminal-crash-12345678";
        String operationId = "operation_terminal-crash-12345678";
        OverlayPresentation.CartSummary cart =
            new OverlayPresentation.CartSummary(
                Arrays.asList(new OverlayPresentation.CartLine(
                    "product_milk",
                    "Amul Taaza Toned Milk",
                    1,
                    "₹29",
                    "₹29"
                )),
                "₹29",
                "Review delivery address",
                true,
                false
            );
        RetainedTaskEvent event = new RetainedTaskEvent(
            "event_terminal-crash",
            taskId,
            9,
            operationId,
            "step_milk",
            12,
            "completed",
            "Your cart is ready",
            "1 verified line · Subtotal ₹29",
            1,
            1,
            1785205000000L,
            "visual_only",
            "Your cart is ready",
            null,
            cart,
            null,
            true
        );
        TaskEventSubscriptionState cursor =
            new TaskEventSubscriptionState();
        cursor.restore(taskId, 12, 9, operationId, true);
        TaskChecklistState checklist = new TaskChecklistState();
        require(checklist.apply(event), "terminal checklist projection");
        OverlayPresentation cartPresentation =
            TaskEventPresentationFactory.createFinalCartPresentation(
                event,
                operationId
            );
        OverlayPresentation latest =
            TaskEventPresentationFactory.create(event, operationId);

        TaskProjectionDurability.Prepared committed =
            TaskProjectionDurability.prepare(
                cursor,
                checklist,
                latest,
                cartPresentation,
                false,
                1785205000100L
            );
        require(committed != null, "terminal projection must prepare");

        // This map is the single committed preference transaction. Simulate a
        // process crash immediately after it, before render/TalkBack/TTS.
        Map<String, Object> disk = new HashMap<String, Object>();
        disk.put("taskId", committed.taskId);
        disk.put("sequence", committed.sequence);
        disk.put("revision", committed.revision);
        disk.put("terminal", committed.terminal);
        disk.put("operationId", committed.operationId);
        disk.put("checklist", committed.checklist);
        disk.put("recovery", committed.recoveryPresentation);
        disk.put("cart", committed.verifiedCartPresentation);

        TaskEventSubscriptionState restartedCursor =
            new TaskEventSubscriptionState();
        restartedCursor.restore(
            (String) disk.get("taskId"),
            ((Integer) disk.get("sequence")).intValue(),
            ((Integer) disk.get("revision")).intValue(),
            (String) disk.get("operationId"),
            ((Boolean) disk.get("terminal")).booleanValue()
        );
        TaskChecklistState restartedChecklist = TaskChecklistState.decode(
            (String) disk.get("checklist")
        );
        OverlayRecoverySnapshot.Restored restartedLatest =
            OverlayRecoverySnapshot.decode(
                (String) disk.get("recovery"),
                1785205000200L
            );
        OverlayRecoverySnapshot.Restored restartedCart =
            OverlayRecoverySnapshot.decode(
                (String) disk.get("cart"),
                1785205000200L
            );

        require(restartedCursor.terminal(), "terminal cursor survives crash");
        require(
            restartedChecklist.snapshot().terminal(),
            "terminal checklist survives crash"
        );
        require(restartedLatest != null, "latest presentation survives crash");
        require(
            restartedCart != null
                && restartedCart.presentation.card.cartSummary != null
                && restartedCart.presentation.card.cartSummary
                    .isVerifiedNotOrdered()
                && "₹29".equals(
                    restartedCart.presentation.card.cartSummary.subtotal
                ),
            "verified final cart survives the terminal crash window"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
