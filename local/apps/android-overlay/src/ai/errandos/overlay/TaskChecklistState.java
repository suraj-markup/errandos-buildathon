package ai.errandos.overlay;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Rendering projection for one retained V2 task-event stream.
 *
 * This class does not decide whether an operation succeeded. In particular,
 * an item becomes checked only after an accepted {@code mutation_verified}
 * event. Paused and disconnected states are local presentation overlays and
 * never alter retained mutation truth.
 */
final class TaskChecklistState {
    private static final String ENCODING_VERSION = "task-checklist-v1";
    private static final int MAX_ITEMS = 256;

    enum Phase {
        PENDING("pending"),
        SEARCHING("searching"),
        WAITING("waiting"),
        SELECTED("selected"),
        ADDING("adding"),
        VERIFYING("verifying"),
        VERIFIED("verified"),
        AMBIGUOUS("ambiguous"),
        BLOCKED("blocked"),
        PAUSED("paused"),
        DISCONNECTED("disconnected"),
        CANCELLED("cancelled"),
        SUCCESS("success");

        private final String value;

        Phase(String value) {
            this.value = value;
        }

        String value() {
            return value;
        }

        static Phase fromValue(String value) {
            for (Phase phase : values()) {
                if (phase.value.equals(value)) return phase;
            }
            throw new IllegalArgumentException("unknown checklist phase");
        }
    }

    static final class Item {
        private final int position;
        private final String stepId;
        private final String label;
        private final String detail;
        private final Phase phase;
        private final boolean verified;

        private Item(
            int position,
            String stepId,
            String label,
            String detail,
            Phase phase,
            boolean verified
        ) {
            this.position = position;
            this.stepId = stepId;
            this.label = label;
            this.detail = detail;
            this.phase = phase;
            this.verified = verified;
        }

        int position() {
            return position;
        }

        String stepId() {
            return stepId;
        }

        String label() {
            return label;
        }

        String detail() {
            return detail;
        }

        Phase phase() {
            return phase;
        }

        boolean verified() {
            return verified;
        }
    }

    static final class Snapshot {
        private final String taskId;
        private final int lastSequence;
        private final int taskRevision;
        private final int completedCount;
        private final int totalItems;
        private final Phase activePhase;
        private final String activeLabel;
        private final boolean terminal;
        private final List<Item> items;

        private Snapshot(
            String taskId,
            int lastSequence,
            int taskRevision,
            int completedCount,
            int totalItems,
            Phase activePhase,
            String activeLabel,
            boolean terminal,
            List<Item> items
        ) {
            this.taskId = taskId;
            this.lastSequence = lastSequence;
            this.taskRevision = taskRevision;
            this.completedCount = completedCount;
            this.totalItems = totalItems;
            this.activePhase = activePhase;
            this.activeLabel = activeLabel;
            this.terminal = terminal;
            this.items = Collections.unmodifiableList(items);
        }

        String taskId() {
            return taskId;
        }

        int lastSequence() {
            return lastSequence;
        }

        int taskRevision() {
            return taskRevision;
        }

        int completedCount() {
            return completedCount;
        }

        int totalItems() {
            return totalItems;
        }

        Phase activePhase() {
            return activePhase;
        }

        String activeLabel() {
            return activeLabel;
        }

        boolean terminal() {
            return terminal;
        }

        List<Item> items() {
            return items;
        }
    }

    /**
     * Fully validated, authoritative projection carried with a retention
     * reset. It is intentionally separate from retained events: hydrating it
     * must never replay the latest event's haptic, accessibility, or speech
     * effects.
     */
    static final class ResetItem {
        final int position;
        final String stepId;
        final String label;
        final String detail;
        final Phase phase;
        final boolean verified;

        ResetItem(
            int position,
            String stepId,
            String label,
            String detail,
            Phase phase,
            boolean verified
        ) {
            this.position = position;
            this.stepId = stepId;
            this.label = label;
            this.detail = detail;
            this.phase = phase;
            this.verified = verified;
        }
    }

    static final class ResetSnapshot {
        final String taskId;
        final int latestSequence;
        final int taskRevision;
        final int totalItems;
        final Phase activePhase;
        final String activeLabel;
        final boolean terminal;
        final List<ResetItem> items;

        ResetSnapshot(
            String taskId,
            int latestSequence,
            int taskRevision,
            int totalItems,
            Phase activePhase,
            String activeLabel,
            boolean terminal,
            List<ResetItem> items
        ) {
            this.taskId = taskId;
            this.latestSequence = latestSequence;
            this.taskRevision = taskRevision;
            this.totalItems = totalItems;
            this.activePhase = activePhase;
            this.activeLabel = activeLabel;
            this.terminal = terminal;
            this.items = items == null
                ? Collections.<ResetItem>emptyList()
                : Collections.unmodifiableList(
                    new ArrayList<ResetItem>(items)
                );
        }
    }

    private static final class MutableItem {
        final int position;
        String stepId;
        String label;
        String detail;
        Phase phase = Phase.PENDING;
        boolean verified;

        MutableItem(int position) {
            this.position = position;
        }
    }

    private String taskId;
    private int lastSequence = -1;
    private int taskRevision = -1;
    private boolean terminal;
    private int totalItems;
    private Phase activePhase = Phase.PENDING;
    private String activeLabel;
    private boolean paused;
    private String pausedLabel;
    private boolean disconnected;
    private String disconnectedLabel;
    private final List<MutableItem> items = new ArrayList<MutableItem>();

    /**
     * Applies a retained event once. Ordering gaps are guarded by the stream
     * subscription; this projection additionally rejects stale, cross-task,
     * stale-revision, and post-terminal events.
     */
    synchronized boolean apply(RetainedTaskEvent event) {
        if (
            event == null
                || event.taskId == null
                || event.sequence < 0
                || event.taskRevision < 0
                || event.totalItems < 0
                || event.totalItems > MAX_ITEMS
                || event.currentItem < 0
                || event.currentItem > event.totalItems
        ) {
            return false;
        }
        if (taskId == null) {
            taskId = event.taskId;
        } else if (!taskId.equals(event.taskId)) {
            return false;
        }
        if (
            event.sequence <= lastSequence
                || event.taskRevision < taskRevision
                || terminal
        ) {
            return false;
        }

        if (event.totalItems > 0) resize(event.totalItems);

        Phase eventPhase = phase(event.kind);
        int itemPosition = itemPosition(event);
        MutableItem item = itemAt(itemPosition);
        if (item != null && isItemEvent(event.kind)) {
            applyToItem(item, event, eventPhase);
        }

        lastSequence = event.sequence;
        taskRevision = event.taskRevision;
        activePhase = eventPhase;
        activeLabel = event.title;
        terminal = event.isTerminal();
        return true;
    }

    /**
     * Projects a task pause without changing the last retained event or any
     * verified state.
     */
    synchronized void setPaused(boolean value, String label) {
        paused = value;
        pausedLabel = value ? exactOrNull(label) : null;
    }

    /**
     * Projects transport loss without claiming a task or mutation outcome.
     */
    synchronized void setDisconnected(boolean value, String label) {
        disconnected = value;
        disconnectedLabel = value ? exactOrNull(label) : null;
    }

    /**
     * Applies an explicit authoritative task cancellation without inventing a
     * retained event sequence. This is used when a voice response carries the
     * terminal task snapshot before (or instead of) a retained cancellation
     * event.
     */
    synchronized boolean markCancelled(
        String cancelledTaskId,
        int revision,
        String label
    ) {
        if (
            !identifier(cancelledTaskId, "task")
                || revision < taskRevision
                || (
                    taskId != null
                        && !taskId.equals(cancelledTaskId)
                )
        ) {
            return false;
        }
        taskId = cancelledTaskId;
        taskRevision = revision;
        terminal = true;
        activePhase = Phase.CANCELLED;
        activeLabel = exactOrNull(label);
        paused = false;
        pausedLabel = null;
        disconnected = false;
        disconnectedLabel = null;
        return true;
    }

    synchronized Snapshot snapshot() {
        int completed = 0;
        List<Item> result = new ArrayList<Item>(items.size());
        boolean visiblyPaused = paused || disconnected;
        for (MutableItem item : items) {
            if (item.verified) completed += 1;
            Phase visiblePhase = visiblyPaused && !item.verified
                ? Phase.PAUSED
                : item.phase;
            result.add(new Item(
                item.position,
                item.stepId,
                item.label,
                item.detail,
                visiblePhase,
                item.verified
            ));
        }
        Phase visiblePhase = disconnected
            ? Phase.DISCONNECTED
            : paused
                ? Phase.PAUSED
                : activePhase;
        String visibleLabel = disconnected
            ? disconnectedLabel
            : paused
                ? pausedLabel
                : activeLabel;
        return new Snapshot(
            taskId,
            lastSequence,
            taskRevision,
            completed,
            totalItems,
            visiblePhase,
            visibleLabel,
            terminal,
            result
        );
    }

    /**
     * Compact dependency-free representation suitable for SharedPreferences.
     */
    synchronized String encode() {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            DataOutputStream output = new DataOutputStream(bytes);
            output.writeUTF(ENCODING_VERSION);
            writeNullable(output, taskId);
            output.writeInt(lastSequence);
            output.writeInt(taskRevision);
            output.writeBoolean(terminal);
            output.writeInt(totalItems);
            output.writeUTF(activePhase.value());
            writeNullable(output, activeLabel);
            output.writeBoolean(paused);
            writeNullable(output, pausedLabel);
            output.writeBoolean(disconnected);
            writeNullable(output, disconnectedLabel);
            output.writeInt(items.size());
            for (MutableItem item : items) {
                output.writeInt(item.position);
                writeNullable(output, item.stepId);
                writeNullable(output, item.label);
                writeNullable(output, item.detail);
                output.writeUTF(item.phase.value());
                output.writeBoolean(item.verified);
            }
            output.flush();
            return Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString(bytes.toByteArray());
        } catch (IOException error) {
            throw new IllegalStateException("could not encode checklist", error);
        }
    }

    /**
     * Reconnects from the retained window without erasing mutation truth that
     * the device already verified. Non-verified in-flight rows are reset
     * because their source events are no longer replayable.
     */
    synchronized void rebaseForRetention(int afterSequence) {
        lastSequence = Math.max(-1, afterSequence);
        taskRevision = -1;
        terminal = false;
        activePhase = Phase.PENDING;
        activeLabel = null;
        for (MutableItem item : items) {
            if (!item.verified) {
                item.stepId = null;
                item.label = null;
                item.detail = null;
                item.phase = Phase.PENDING;
            }
        }
    }

    /**
     * Atomically replaces the local projection from a server reset snapshot.
     *
     * Validation is completed into a detached list before any field changes,
     * so malformed or partial snapshots cannot combine new cursor truth with
     * old rows. The caller may render this state, but must not replay the
     * snapshot's historical latest-event announcement.
     */
    synchronized boolean applyResetSnapshot(ResetSnapshot reset) {
        if (
            reset == null
                || !identifier(reset.taskId, "task")
                || reset.latestSequence < -1
                || reset.taskRevision < 0
                || reset.totalItems < 0
                || reset.totalItems > MAX_ITEMS
                || reset.activePhase == null
                || reset.items.size() != reset.totalItems
                || (
                    reset.terminal
                        && reset.activePhase != Phase.SUCCESS
                        && reset.activePhase != Phase.CANCELLED
                )
                || (
                    !reset.terminal
                        && (
                            reset.activePhase == Phase.SUCCESS
                                || reset.activePhase == Phase.CANCELLED
                        )
                )
        ) {
            return false;
        }

        List<MutableItem> hydrated =
            new ArrayList<MutableItem>(reset.items.size());
        Set<Integer> positions = new HashSet<Integer>();
        int verifiedCount = 0;
        for (ResetItem source : reset.items) {
            if (
                source == null
                    || source.position < 1
                    || source.position > reset.totalItems
                    || !positions.add(source.position)
                    || exactOrNull(source.label) == null
                    || source.phase == null
                    || (
                        source.verified
                            && source.phase != Phase.VERIFIED
                            && source.phase != Phase.SUCCESS
                    )
            ) {
                return false;
            }
            MutableItem item = new MutableItem(source.position);
            item.stepId = exactOrNull(source.stepId);
            item.label = exactOrNull(source.label);
            item.detail = exactOrNull(source.detail);
            item.phase = source.phase;
            item.verified = source.verified;
            if (item.verified) verifiedCount += 1;
            hydrated.add(item);
        }
        Collections.sort(
            hydrated,
            new java.util.Comparator<MutableItem>() {
                @Override
                public int compare(MutableItem left, MutableItem right) {
                    return left.position - right.position;
                }
            }
        );
        // Completed progress is monotonic and contiguous in the V2 stream.
        // Reject holes instead of projecting an invented checked row.
        for (int index = 0; index < verifiedCount; index += 1) {
            if (!hydrated.get(index).verified) return false;
        }

        taskId = reset.taskId;
        lastSequence = reset.latestSequence;
        taskRevision = reset.taskRevision;
        terminal = reset.terminal;
        totalItems = reset.totalItems;
        activePhase = reset.activePhase;
        activeLabel = exactOrNull(reset.activeLabel);
        paused = false;
        pausedLabel = null;
        disconnected = false;
        disconnectedLabel = null;
        items.clear();
        items.addAll(hydrated);
        return true;
    }

    static TaskChecklistState decode(String encoded) {
        if (encoded == null || encoded.trim().isEmpty()) {
            throw new IllegalArgumentException("missing checklist encoding");
        }
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(encoded);
            DataInputStream input =
                new DataInputStream(new ByteArrayInputStream(bytes));
            if (!ENCODING_VERSION.equals(input.readUTF())) {
                throw new IllegalArgumentException(
                    "unsupported checklist encoding"
                );
            }
            TaskChecklistState state = new TaskChecklistState();
            state.taskId = readNullable(input);
            state.lastSequence = input.readInt();
            state.taskRevision = input.readInt();
            state.terminal = input.readBoolean();
            state.totalItems = input.readInt();
            state.activePhase = Phase.fromValue(input.readUTF());
            state.activeLabel = readNullable(input);
            state.paused = input.readBoolean();
            state.pausedLabel = readNullable(input);
            state.disconnected = input.readBoolean();
            state.disconnectedLabel = readNullable(input);
            int count = input.readInt();
            validateDecodedHeader(state, count);
            Set<Integer> positions = new HashSet<Integer>();
            for (int index = 0; index < count; index += 1) {
                MutableItem item = new MutableItem(input.readInt());
                item.stepId = readNullable(input);
                item.label = readNullable(input);
                item.detail = readNullable(input);
                item.phase = Phase.fromValue(input.readUTF());
                item.verified = input.readBoolean();
                if (
                    item.position < 1
                        || item.position > state.totalItems
                        || !positions.add(item.position)
                ) {
                    throw new IllegalArgumentException(
                        "invalid checklist position"
                    );
                }
                state.items.add(item);
            }
            if (input.available() != 0) {
                throw new IllegalArgumentException(
                    "unexpected checklist data"
                );
            }
            return state;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException(
                "invalid checklist encoding",
                error
            );
        }
    }

    private void applyToItem(
        MutableItem item,
        RetainedTaskEvent event,
        Phase eventPhase
    ) {
        if (item.verified && !"mutation_verified".equals(event.kind)) return;
        if (event.stepId != null) item.stepId = event.stepId;
        item.label = event.title;
        item.detail = event.detail;
        if ("mutation_verified".equals(event.kind)) {
            item.verified = true;
            item.phase = Phase.VERIFIED;
        } else {
            item.phase = eventPhase;
        }
    }

    private int itemPosition(RetainedTaskEvent event) {
        if (
            "moving_to_next_step".equals(event.kind)
                && event.currentItem > 0
                && event.currentItem < totalItems
        ) {
            return event.currentItem + 1;
        }
        if (event.currentItem > 0) return event.currentItem;
        if (event.stepId == null) return 0;
        for (MutableItem item : items) {
            if (event.stepId.equals(item.stepId)) return item.position;
        }
        return 0;
    }

    private MutableItem itemAt(int position) {
        return position < 1 || position > items.size()
            ? null
            : items.get(position - 1);
    }

    private void resize(int nextTotal) {
        if (nextTotal < 1 || nextTotal > MAX_ITEMS) return;
        while (items.size() < nextTotal) {
            items.add(new MutableItem(items.size() + 1));
        }
        while (items.size() > nextTotal) {
            items.remove(items.size() - 1);
        }
        totalItems = nextTotal;
    }

    private static Phase phase(String kind) {
        if (
            "step_started".equals(kind)
                || "searching".equals(kind)
                || "moving_to_next_step".equals(kind)
        ) {
            return Phase.SEARCHING;
        }
        if (
            "options_ready".equals(kind)
                || "checkout_ready".equals(kind)
                || "waiting_for_user".equals(kind)
        ) {
            return Phase.WAITING;
        }
        if ("selection_accepted".equals(kind)) return Phase.SELECTED;
        if ("mutation_started".equals(kind)) return Phase.ADDING;
        if ("reviewing_cart".equals(kind)) return Phase.VERIFYING;
        if ("mutation_verified".equals(kind)) return Phase.VERIFIED;
        if ("ambiguous".equals(kind)) return Phase.AMBIGUOUS;
        if ("blocked".equals(kind)) return Phase.BLOCKED;
        if ("cancelled".equals(kind)) return Phase.CANCELLED;
        if ("completed".equals(kind)) return Phase.SUCCESS;
        return Phase.PENDING;
    }

    private static boolean isItemEvent(String kind) {
        return
            "step_started".equals(kind)
                || "searching".equals(kind)
                || "options_ready".equals(kind)
                || "selection_accepted".equals(kind)
                || "mutation_started".equals(kind)
                || "mutation_verified".equals(kind)
                || "moving_to_next_step".equals(kind)
                || "blocked".equals(kind)
                || "ambiguous".equals(kind);
    }

    static Phase phaseForEventKind(String kind) {
        return phase(kind);
    }

    private static String exactOrNull(String value) {
        if (value == null) return null;
        String exact = value.trim();
        return exact.isEmpty() ? null : exact;
    }

    private static boolean identifier(String value, String kind) {
        return value != null
            && value.matches(
                "^" + java.util.regex.Pattern.quote(kind)
                    + "_[A-Za-z0-9-]{8,80}$"
            );
    }

    private static void writeNullable(
        DataOutputStream output,
        String value
    ) throws IOException {
        output.writeBoolean(value != null);
        if (value != null) output.writeUTF(value);
    }

    private static String readNullable(DataInputStream input)
        throws IOException {
        return input.readBoolean() ? input.readUTF() : null;
    }

    private static void validateDecodedHeader(
        TaskChecklistState state,
        int count
    ) {
        if (
            state.lastSequence < -1
                || state.taskRevision < -1
                || state.totalItems < 0
                || state.totalItems > MAX_ITEMS
                || count < 0
                || count > MAX_ITEMS
                || count != state.totalItems
                || (
                    state.taskId == null
                        && (
                            state.lastSequence >= 0
                                || state.taskRevision >= 0
                                || state.totalItems > 0
                        )
                )
        ) {
            throw new IllegalArgumentException("invalid checklist state");
        }
    }
}
