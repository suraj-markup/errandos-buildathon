package ai.errandos.overlay;

import org.json.JSONObject;

/**
 * Strict acknowledgement parser shared by tap and voice selection paths.
 * Accepted-once responses do not depend on the legacy top-level ok field.
 */
final class ProductSelectionResponse {
    enum Disposition {
        ACCEPTED,
        DUPLICATE,
        CONFLICT,
        REJECTED
    }

    final Disposition disposition;
    final String reason;
    final String winnerOfferId;
    final String winnerTitle;
    final int taskRevision;

    private ProductSelectionResponse(
        Disposition disposition,
        String reason,
        String winnerOfferId,
        String winnerTitle,
        int taskRevision
    ) {
        this.disposition = disposition;
        this.reason = reason;
        this.winnerOfferId = winnerOfferId;
        this.winnerTitle = winnerTitle;
        this.taskRevision = taskRevision;
    }

    static ProductSelectionResponse parse(
        JSONObject response,
        OverlayPresentation.ProductSelectionBinding binding
    ) {
        if (response == null || binding == null) return null;
        if (response.optInt("version", -1) != 2) return null;
        if (!binding.taskId.equals(response.optString("taskId", ""))) {
            return null;
        }
        if (
            !binding.interactionId.equals(
                response.optString("interactionId", "")
            )
        ) {
            return null;
        }
        if (
            !binding.selectionId.equals(
                response.optString("selectionId", "")
            )
        ) {
            return null;
        }
        int taskRevision = response.optInt("taskRevision", -1);
        if (taskRevision < binding.taskRevision) return null;
        String acknowledgement = response.optString(
            "acknowledgement",
            ""
        );
        String reason = clean(response.optString("reason", ""), 100);
        Disposition disposition;
        if ("accepted".equals(acknowledgement)) {
            disposition = Disposition.ACCEPTED;
        } else if ("duplicate".equals(acknowledgement)) {
            disposition = Disposition.DUPLICATE;
        } else if (
            "rejected".equals(acknowledgement)
                && "already_resolved".equals(reason)
        ) {
            disposition = Disposition.CONFLICT;
        } else if ("rejected".equals(acknowledgement)) {
            return new ProductSelectionResponse(
                Disposition.REJECTED,
                reason,
                null,
                null,
                taskRevision
            );
        } else {
            return null;
        }

        JSONObject resolution = response.optJSONObject("resolution");
        JSONObject offer = resolution == null
            ? null
            : resolution.optJSONObject("offer");
        if (offer == null) {
            JSONObject winner = response.optJSONObject("winner");
            offer = winner == null ? null : winner.optJSONObject("offer");
        }
        String offerId = offer == null
            ? null
            : clean(offer.optString("offerId", ""), 256);
        String title = offer == null
            ? null
            : clean(offer.optString("title", ""), 300);
        if (offerId == null || title == null) {
            // A successful or conflicting response without authoritative
            // winner identity cannot safely change the one-winner UI state.
            return null;
        }
        return new ProductSelectionResponse(
            disposition,
            reason,
            offerId,
            title,
            taskRevision
        );
    }

    boolean acceptedOnce() {
        return disposition == Disposition.ACCEPTED
            || disposition == Disposition.DUPLICATE
            || disposition == Disposition.CONFLICT;
    }

    private static String clean(String value, int maximum) {
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
