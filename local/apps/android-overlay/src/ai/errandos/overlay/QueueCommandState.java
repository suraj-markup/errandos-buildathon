package ai.errandos.overlay;

import org.json.JSONObject;

final class QueueCommandState {
    enum Status {
        IDLE,
        SUBMITTING,
        ACCEPTED,
        DUPLICATE,
        STALE,
        CONFLICT,
        NETWORK_ERROR,
        REJECTED
    }

    static final class Outcome {
        final Status status;
        final int taskRevision;
        final String message;
        final boolean retryable;

        Outcome(
            Status status,
            int taskRevision,
            String message,
            boolean retryable
        ) {
            this.status = status;
            this.taskRevision = taskRevision;
            this.message = message;
            this.retryable = retryable;
        }
    }

    private Status status = Status.IDLE;
    private String pendingPayload;

    synchronized void begin(String payload) {
        if (payload == null || payload.isEmpty()) {
            throw new IllegalArgumentException("queue payload is required");
        }
        status = Status.SUBMITTING;
        pendingPayload = payload;
    }

    synchronized Outcome apply(int httpStatus, JSONObject response) {
        String acknowledgement = response == null
            ? ""
            : response.optString("acknowledgement", "");
        String error = response == null
            ? ""
            : response.optString("error", "");
        int revision = response == null
            ? -1
            : response.optInt(
                "taskRevision",
                response.optInt("actualRevision", -1)
            );
        if (httpStatus >= 200 && httpStatus < 300) {
            if ("accepted".equals(acknowledgement)) {
                return finish(
                    Status.ACCEPTED,
                    revision,
                    "Task list updated.",
                    false
                );
            }
            if ("duplicate".equals(acknowledgement)) {
                return finish(
                    Status.DUPLICATE,
                    revision,
                    "This queue change was already applied.",
                    false
                );
            }
        }
        if ("stale_task_revision".equals(error)) {
            return finish(
                Status.STALE,
                revision,
                "Task changed. Refreshing the current list.",
                false
            );
        }
        if ("command_id_conflict".equals(error)) {
            return finish(
                Status.CONFLICT,
                revision,
                "That change conflicts with another queue update.",
                false
            );
        }
        return finish(
            Status.REJECTED,
            revision,
            "Couldn’t update the task list.",
            httpStatus >= 500
        );
    }

    synchronized Outcome networkError() {
        status = Status.NETWORK_ERROR;
        return new Outcome(
            status,
            -1,
            "Connection lost. Tap the same action to retry.",
            true
        );
    }

    synchronized void restore(String payload) {
        if (payload == null || payload.isEmpty()) return;
        pendingPayload = payload;
        status = Status.NETWORK_ERROR;
    }

    synchronized boolean submitting() {
        return status == Status.SUBMITTING;
    }

    synchronized Status status() {
        return status;
    }

    synchronized String pendingPayload() {
        return pendingPayload;
    }

    private Outcome finish(
        Status next,
        int revision,
        String message,
        boolean retryable
    ) {
        status = next;
        if (!retryable) pendingPayload = null;
        return new Outcome(next, revision, message, retryable);
    }
}
