package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Fail-closed Android projection of the authoritative taskV2 response.
 *
 * Queue mutation identifiers deliberately come only from this response. The
 * retained checklist is presentation-only and must never invent step IDs.
 */
final class QueueTaskProjection {
    private static final Set<String> ITEM_KINDS = new HashSet<String>();
    private static final Set<String> EDITABLE_STATUSES = new HashSet<String>();
    private static final Set<String> KNOWN_TASK_STATUSES =
        new HashSet<String>();
    private static final Set<String> KNOWN_STEP_STATUSES =
        new HashSet<String>();

    static {
        Collections.addAll(ITEM_KINDS, "add_cart_item", "search_products");
        Collections.addAll(EDITABLE_STATUSES, "planned", "ready");
        Collections.addAll(
            KNOWN_TASK_STATUSES,
            "active",
            "paused",
            "waiting_for_user",
            "waiting_for_phone",
            "blocked",
            "ambiguous",
            "completed",
            "cancelled"
        );
        Collections.addAll(
            KNOWN_STEP_STATUSES,
            "planned",
            "ready",
            "running",
            "waiting_for_user",
            "verified",
            "failed",
            "blocked",
            "ambiguous",
            "skipped"
        );
    }

    static final class Item {
        final int queuePosition;
        final String stepId;
        final String kind;
        final String status;
        final boolean active;

        Item(
            int queuePosition,
            String stepId,
            String kind,
            String status,
            boolean active
        ) {
            this.queuePosition = queuePosition;
            this.stepId = stepId;
            this.kind = kind;
            this.status = status;
            this.active = active;
        }

        boolean editable() {
            return !active && EDITABLE_STATUSES.contains(status);
        }
    }

    final String taskId;
    final int taskRevision;
    final String status;
    final String activeStepId;
    final boolean inFlight;
    final List<Item> items;

    private QueueTaskProjection(
        String taskId,
        int taskRevision,
        String status,
        String activeStepId,
        boolean inFlight,
        List<Item> items
    ) {
        this.taskId = taskId;
        this.taskRevision = taskRevision;
        this.status = status;
        this.activeStepId = activeStepId;
        this.inFlight = inFlight;
        this.items = Collections.unmodifiableList(items);
    }

    static QueueTaskProjection parse(JSONObject task) {
        if (task == null || task.optInt("version", -1) != 2) return null;
        String taskId = identifier(task.optString("taskId", ""), "task");
        int revision = task.optInt("revision", -1);
        String status = task.optString("status", "");
        if (
            taskId == null
                || revision < 0
                || !KNOWN_TASK_STATUSES.contains(status)
        ) {
            return null;
        }
        String activeStepId = optionalStepId(
            task.optString("activeStepId", "")
        );
        if (
            task.has("activeStepId")
                && !task.isNull("activeStepId")
                && activeStepId == null
        ) {
            return null;
        }
        JSONArray steps = task.optJSONArray("steps");
        if (steps == null || steps.length() > 50) return null;
        List<Item> items = new ArrayList<Item>();
        Set<String> stepIds = new HashSet<String>();
        boolean inFlight = "waiting_for_phone".equals(status);
        int queuePosition = 0;
        for (int index = 0; index < steps.length(); index += 1) {
            JSONObject raw = steps.optJSONObject(index);
            if (raw == null) return null;
            String stepId = optionalStepId(raw.optString("stepId", ""));
            String kind = bounded(raw.optString("kind", ""), 80);
            String stepStatus = raw.optString("status", "");
            if (
                stepId == null
                    || !stepIds.add(stepId)
                    || kind == null
                    || !KNOWN_STEP_STATUSES.contains(stepStatus)
            ) {
                return null;
            }
            if ("running".equals(stepStatus)) inFlight = true;
            if (!ITEM_KINDS.contains(kind)) continue;
            queuePosition += 1;
            items.add(new Item(
                queuePosition,
                stepId,
                kind,
                stepStatus,
                stepId.equals(activeStepId)
            ));
        }
        if (
            activeStepId != null
                && !stepIds.contains(activeStepId)
        ) {
            return null;
        }
        return new QueueTaskProjection(
            taskId,
            revision,
            status,
            activeStepId,
            inFlight,
            items
        );
    }

    Item itemAtQueuePosition(int position) {
        for (Item item : items) {
            if (item.queuePosition == position) return item;
        }
        return null;
    }

    List<Item> editableItems() {
        List<Item> result = new ArrayList<Item>();
        if (inFlight || terminal() || paused()) return result;
        for (Item item : items) {
            if (item.editable()) result.add(item);
        }
        return result;
    }

    QueueTaskProjection awaitingAuthoritativeRefresh(
        int revision,
        String outcome
    ) {
        String nextStatus = status;
        if ("paused".equals(outcome) || "cancellation_requested".equals(outcome)) {
            nextStatus = "paused";
        } else if ("resumed".equals(outcome)) {
            nextStatus = "active";
        } else if ("cancelled".equals(outcome)) {
            nextStatus = "cancelled";
        }
        return new QueueTaskProjection(
            taskId,
            Math.max(taskRevision, revision),
            nextStatus,
            activeStepId,
            !"cancelled".equals(outcome),
            new ArrayList<Item>(items)
        );
    }

    boolean paused() {
        return "paused".equals(status);
    }

    boolean terminal() {
        return "completed".equals(status) || "cancelled".equals(status);
    }

    private static String optionalStepId(String value) {
        String bounded = bounded(value, 160);
        if (
            bounded == null
                || !bounded.matches("^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
        ) {
            return null;
        }
        return bounded;
    }

    private static String identifier(String value, String kind) {
        String bounded = bounded(value, 100);
        if (
            bounded == null
                || !bounded.matches(
                    "^" + java.util.regex.Pattern.quote(kind)
                        + "_[A-Za-z0-9-]{8,80}$"
                )
        ) {
            return null;
        }
        return bounded;
    }

    private static String bounded(String value, int maximum) {
        if (
            value == null
                || value.isEmpty()
                || !value.equals(value.trim())
                || value.length() > maximum
        ) {
            return null;
        }
        return value;
    }
}
