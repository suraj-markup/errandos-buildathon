package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

final class QueueActionPolicy {
    enum Kind {
        REFINE,
        REMOVE,
        SKIP,
        MOVE_UP,
        MOVE_DOWN,
        PAUSE,
        RESUME,
        CANCEL
    }

    static final class Action {
        final Kind kind;
        final QueueTaskProjection.Item item;

        Action(Kind kind, QueueTaskProjection.Item item) {
            this.kind = kind;
            this.item = item;
        }
    }

    static boolean enabled(
        QueueTaskProjection task,
        Action action,
        boolean submitting
    ) {
        if (task == null || action == null || submitting || task.terminal()) {
            return false;
        }
        if (action.kind == Kind.CANCEL) return true;
        if (action.kind == Kind.RESUME) {
            return task.paused() && !task.inFlight;
        }
        if (action.kind == Kind.PAUSE) {
            return !task.paused() && !task.inFlight;
        }
        if (
            task.paused()
                || task.inFlight
                || action.item == null
                || !action.item.editable()
        ) {
            return false;
        }
        if (action.kind == Kind.MOVE_UP || action.kind == Kind.MOVE_DOWN) {
            List<QueueTaskProjection.Item> editable = task.editableItems();
            int index = editable.indexOf(action.item);
            return index >= 0
                && (
                    action.kind == Kind.MOVE_UP
                        ? index > 0
                        : index < editable.size() - 1
                );
        }
        return true;
    }

    static JSONObject request(
        QueueTaskProjection task,
        Action action,
        String refinement
    ) throws Exception {
        if (!enabled(task, action, false)) {
            throw new IllegalArgumentException("queue action is not allowed");
        }
        JSONObject command = new JSONObject();
        switch (action.kind) {
            case REFINE:
                String request = refinement == null
                    ? ""
                    : refinement.trim();
                if (request.isEmpty() || request.length() > 160) {
                    throw new IllegalArgumentException(
                        "refinement must contain 1 to 160 characters"
                    );
                }
                command.put("command", "refine");
                command.put("stepId", action.item.stepId);
                command.put("request", request);
                break;
            case REMOVE:
                command.put("command", "remove");
                command.put("stepId", action.item.stepId);
                break;
            case SKIP:
                command.put("command", "skip");
                command.put("stepId", action.item.stepId);
                break;
            case MOVE_UP:
            case MOVE_DOWN:
                command.put("command", "reorder");
                command.put(
                    "orderedStepIds",
                    reordered(task, action)
                );
                break;
            case PAUSE:
                command.put("command", "pause");
                break;
            case RESUME:
                command.put("command", "resume");
                break;
            case CANCEL:
                command.put("command", "cancel");
                break;
            default:
                throw new IllegalArgumentException("unsupported queue action");
        }
        JSONObject payload = new JSONObject();
        payload.put("version", 2);
        payload.put("clientId", "pixel-overlay");
        payload.put("taskId", task.taskId);
        payload.put("taskRevision", task.taskRevision);
        payload.put("commandId", "command_" + UUID.randomUUID().toString());
        payload.put("command", command);
        return payload;
    }

    private static JSONArray reordered(
        QueueTaskProjection task,
        Action action
    ) {
        List<QueueTaskProjection.Item> editable = task.editableItems();
        int index = editable.indexOf(action.item);
        int other = action.kind == Kind.MOVE_UP ? index - 1 : index + 1;
        QueueTaskProjection.Item swap = editable.get(other);
        editable.set(other, action.item);
        editable.set(index, swap);
        JSONArray result = new JSONArray();
        for (QueueTaskProjection.Item item : editable) {
            result.put(item.stepId);
        }
        return result;
    }

    static String label(Kind kind) {
        switch (kind) {
            case REFINE: return "Refine";
            case REMOVE: return "Remove";
            case SKIP: return "Skip";
            case MOVE_UP: return "Move up";
            case MOVE_DOWN: return "Move down";
            case PAUSE: return "Pause";
            case RESUME: return "Resume";
            case CANCEL: return "Cancel";
            default: return "Queue action";
        }
    }
}
