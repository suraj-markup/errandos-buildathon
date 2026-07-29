package ai.errandos.overlay;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class QueueControlsTest {
    public static void main(String[] args) throws Exception {
        QueueTaskProjection task = QueueTaskProjection.parse(
            new JSONObject(
                "{\"version\":2,\"taskId\":\"task_queue1234\","
                    + "\"revision\":4,\"status\":\"active\","
                    + "\"activeStepId\":\"task_item_active01\","
                    + "\"steps\":["
                    + "{\"stepId\":\"task_item_active01\","
                    + "\"kind\":\"add_cart_item\",\"status\":\"ready\"},"
                    + "{\"stepId\":\"task_item_future01\","
                    + "\"kind\":\"search_products\",\"status\":\"planned\"},"
                    + "{\"stepId\":\"task_item_future02\","
                    + "\"kind\":\"add_cart_item\",\"status\":\"planned\"},"
                    + "{\"stepId\":\"task_item_cart0001\","
                    + "\"kind\":\"inspect_cart\",\"status\":\"planned\"}]}"
            )
        );
        require(task != null, "valid task");
        require(task.items.size() == 3, "only product queue items");
        require(task.editableItems().size() == 2, "future items editable");
        require(!task.items.get(0).editable(), "active item immutable");

        QueueActionPolicy.Action skip = new QueueActionPolicy.Action(
            QueueActionPolicy.Kind.SKIP,
            task.items.get(1)
        );
        JSONObject skipRequest = QueueActionPolicy.request(task, skip, null);
        require(skipRequest.getInt("taskRevision") == 4, "exact revision");
        require(
            skipRequest.getJSONObject("command")
                .getString("stepId")
                .equals("task_item_future01"),
            "exact future step"
        );
        require(
            skipRequest.getString("commandId").startsWith("command_"),
            "stable command prefix"
        );

        QueueActionPolicy.Action down = new QueueActionPolicy.Action(
            QueueActionPolicy.Kind.MOVE_DOWN,
            task.items.get(1)
        );
        JSONObject reorder = QueueActionPolicy.request(task, down, null);
        require(
            reorder.getJSONObject("command")
                .getJSONArray("orderedStepIds")
                .getString(0)
                .equals("task_item_future02"),
            "future-only reorder"
        );

        JSONObject running = new JSONObject(
            "{\"version\":2,\"taskId\":\"task_queue1234\","
                + "\"revision\":5,\"status\":\"active\","
                + "\"activeStepId\":\"task_item_active01\","
                + "\"steps\":["
                + "{\"stepId\":\"task_item_active01\","
                + "\"kind\":\"add_cart_item\",\"status\":\"running\"},"
                + "{\"stepId\":\"task_item_future01\","
                + "\"kind\":\"search_products\",\"status\":\"planned\"}]}"
        );
        QueueTaskProjection inFlight = QueueTaskProjection.parse(running);
        require(inFlight != null && inFlight.inFlight, "in-flight detected");
        require(
            !QueueActionPolicy.enabled(
                inFlight,
                new QueueActionPolicy.Action(
                    QueueActionPolicy.Kind.REMOVE,
                    inFlight.items.get(1)
                ),
                false
            ),
            "future edit disabled in-flight"
        );
        require(
            QueueActionPolicy.enabled(
                inFlight,
                new QueueActionPolicy.Action(
                    QueueActionPolicy.Kind.CANCEL,
                    null
                ),
                false
            ),
            "cancel requests remain possible"
        );

        QueueCommandState state = new QueueCommandState();
        state.begin(skipRequest.toString());
        QueueCommandState.Outcome duplicate = state.apply(
            200,
            new JSONObject(
                "{\"acknowledgement\":\"duplicate\",\"taskRevision\":5}"
            )
        );
        require(
            duplicate.status == QueueCommandState.Status.DUPLICATE,
            "duplicate is success"
        );
        state.begin(skipRequest.toString());
        QueueCommandState.Outcome stale = state.apply(
            409,
            new JSONObject(
                "{\"acknowledgement\":\"rejected\","
                    + "\"error\":\"stale_task_revision\","
                    + "\"actualRevision\":6}"
            )
        );
        require(
            stale.status == QueueCommandState.Status.STALE
                && stale.taskRevision == 6,
            "stale revision refreshes"
        );
        state.begin(skipRequest.toString());
        QueueCommandState.Outcome conflict = state.apply(
            409,
            new JSONObject(
                "{\"acknowledgement\":\"rejected\","
                    + "\"error\":\"command_id_conflict\"}"
            )
        );
        require(
            conflict.status == QueueCommandState.Status.CONFLICT,
            "command conflict"
        );
        state.begin(skipRequest.toString());
        QueueCommandState.Outcome network = state.networkError();
        require(network.retryable, "network is retryable");
        QueueCommandState recreated = new QueueCommandState();
        recreated.restore(state.pendingPayload());
        require(
            recreated.status() == QueueCommandState.Status.NETWORK_ERROR,
            "pending exact request survives recreation"
        );

        require(
            QueueTaskProjection.parse(
                new JSONObject(
                    "{\"version\":2,\"taskId\":\"task_queue1234\","
                        + "\"revision\":1,\"status\":\"active\","
                        + "\"steps\":[{\"stepId\":\"bad space\","
                        + "\"kind\":\"search_products\","
                        + "\"status\":\"planned\"}]}"
                )
            ) == null,
            "invalid IDs fail closed"
        );
        if (args.length > 0) {
            QueueTaskProjection fixture = QueueTaskProjection.parse(
                new JSONObject(
                    Files.readString(
                        Path.of(args[0]),
                        StandardCharsets.UTF_8
                    )
                )
            );
            require(fixture != null, "production-shaped fixture parses");
            require(fixture.inFlight, "fixture in-flight state");
            require(
                fixture.items.size() == 4
                    && fixture.editableItems().isEmpty(),
                "fixture disables every future edit during phone work"
            );
        }
        System.out.println("QueueControlsTest passed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
