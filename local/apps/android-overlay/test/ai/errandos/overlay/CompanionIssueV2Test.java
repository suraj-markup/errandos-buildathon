package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class CompanionIssueV2Test {
    private static final String[][] EXPECTED = new String[][]{
        {"unknown_failure", "Task paused"},
        {"server_unreachable", "JaldiAI server unavailable"},
        {"phone_disconnected", "Phone connection lost"},
        {"phone_unauthorized", "Phone authorization required"},
        {"appium_unavailable", "Phone control unavailable"},
        {
            "appium_session_recovery_failed",
            "Phone session needs recovery"
        },
        {"device_locked", "Unlock your phone"},
        {"blinkit_login_required", "Blinkit sign-in required"},
        {"provider_screen_unavailable", "Blinkit screen unavailable"},
        {"provider_screen_unexpected", "Blinkit needs attention"},
        {"speech_provider_unavailable", "Voice service unavailable"},
        {"search_choice_expired", "Product choices expired"},
        {"search_failed", "Blinkit search did not finish"},
        {"search_no_match", "No matching product found"},
        {
            "mutation_verified_not_applied",
            "Cart change was not applied"
        },
        {"mutation_ambiguous", "Checking what happened"},
        {"reconciliation_required", "Cart verification required"},
        {"checkout_blocked", "Checkout needs attention"},
        {"checkout_changed", "Checkout details changed"},
        {"checkout_expired", "Checkout review expired"},
        {
            "final_dispatch_ambiguous",
            "Order status needs verification"
        },
        {"final_dispatch_blocked", "Order was not placed"}
    };

    public static void main(String[] args) throws Exception {
        canonicalCopyAndSafetyAreComplete();
        productionFixtureParsesAndRenders(Paths.get(args[0]));
        malformedAndUnsafeFixturesAreRejected(Paths.get(args[0]));
    }

    private static void canonicalCopyAndSafetyAreComplete() {
        int mutationRetryOwners = 0;
        for (String[] expected : EXPECTED) {
            CompanionIssueV2 issue =
                CompanionIssueV2.canonical(expected[0]);
            require(issue.version == 2, "issue version");
            require(expected[1].equals(issue.title), "precise issue title");
            require(
                issue.detail != null && !issue.detail.trim().isEmpty(),
                "precise issue detail"
            );
            require(
                issue.recoveryActions.size() >= 1
                    && issue.recoveryActions.size() <= 3,
                "bounded recovery actions"
            );
            require(
                issue.talkBackDescription().contains(issue.title)
                    && issue.talkBackDescription().contains(
                        "does not run actions"
                    ),
                "TalkBack must state issue and display-only behavior"
            );
            if (issue.hasMutationRetry()) {
                mutationRetryOwners += 1;
                require(
                    "mutation_verified_not_applied".equals(issue.code),
                    "only verified-not-applied owns mutation retry"
                );
            }
        }
        require(EXPECTED.length == 22, "all stable issue codes covered");
        require(
            mutationRetryOwners == 1,
            "exactly one verified mutation retry owner"
        );
        for (String code : new String[]{
            "mutation_ambiguous",
            "reconciliation_required",
            "final_dispatch_ambiguous"
        }) {
            CompanionIssueV2 issue = CompanionIssueV2.canonical(code);
            require(
                !issue.hasMutationRetry(),
                "ambiguous/reconciliation cannot render mutation retry"
            );
            if (!"final_dispatch_ambiguous".equals(code)) {
                require(
                    "check_cart_again".equals(
                        issue.recoveryActions.get(0).actionId
                    )
                        && "stop_task".equals(
                            issue.recoveryActions.get(1).actionId
                        ),
                    "cart ambiguity is check-again or stop only"
                );
            }
        }
    }

    private static void productionFixtureParsesAndRenders(Path fixture)
        throws Exception {
        RetainedTaskEventParser.Snapshot snapshot = parser().parseSnapshot(
            source(fixture)
        );
        require(snapshot.events.size() == 3, "fixture event count");

        RetainedTaskEvent server = snapshot.events.get(0);
        require(
            "server_unreachable".equals(server.issue.code),
            "server issue parsed"
        );
        require(
            server.issue.recoveryInteraction != null
                && "recovery_12345678".equals(
                    server.issue.recoveryInteraction.interactionId
                ),
            "exact recovery interaction parsed"
        );
        OverlayPresentation serverCard =
            TaskEventPresentationFactory.create(
                server,
                "operation_12345678"
            );
        require(
            "companion_issue".equals(serverCard.card.type)
                && serverCard.card.issue == server.issue
                && !serverCard.autoCollapse,
            "server issue renders dedicated persistent recovery card"
        );

        RetainedTaskEvent verifiedNotApplied = snapshot.events.get(1);
        require(
            verifiedNotApplied.issue.hasMutationRetry(),
            "verified-not-applied retains its guarded retry"
        );

        RetainedTaskEvent reconciliation = snapshot.events.get(2);
        OverlayPresentation reconciliationCard =
            TaskEventPresentationFactory.create(
                reconciliation,
                "operation_32345678"
            );
        require(
            "ambiguous".equals(reconciliationCard.mode)
                && "companion_issue".equals(
                    reconciliationCard.card.type
                )
                && !reconciliationCard.task.terminal
                && "reconcile_only".equals(
                    reconciliationCard.task.cancellationPolicy
                ),
            "reconciliation renders a nonterminal no-repeat card"
        );
    }

    private static void malformedAndUnsafeFixturesAreRejected(Path fixture)
        throws Exception {
        JSONObject wrongTreatment = source(fixture);
        issue(wrongTreatment, 0).put("treatment", "safe_failure");
        expectRejected(wrongTreatment, "mismatched treatment");

        JSONObject retryAfterAmbiguity = source(fixture);
        JSONObject action = issue(retryAfterAmbiguity, 2)
            .getJSONArray("recoveryActions")
            .getJSONObject(0);
        action.put("actionId", "retry_verified_not_applied");
        action.put("label", "Try the cart change again");
        action.put("safety", "verified_not_applied_only");
        expectRejected(retryAfterAmbiguity, "ambiguous mutation retry");

        JSONObject duplicate = source(fixture);
        JSONArray actions = issue(duplicate, 0)
            .getJSONArray("recoveryActions");
        actions.put(new JSONObject(actions.getJSONObject(0).toString()));
        expectRejected(duplicate, "duplicate/oversized action policy");

        JSONObject wrongKind = source(fixture);
        wrongKind.getJSONArray("events")
            .getJSONObject(2)
            .put("kind", "blocked");
        expectRejected(wrongKind, "issue kind mismatch");

        JSONObject wrongVersion = source(fixture);
        issue(wrongVersion, 0).put("version", 1);
        expectRejected(wrongVersion, "unsupported issue version");

        JSONObject mixedTruth = source(fixture);
        JSONObject emptySummary = new JSONObject();
        emptySummary.put("status", "empty");
        mixedTruth.getJSONArray("events")
            .getJSONObject(0)
            .put("finalCartSummary", emptySummary);
        expectRejected(mixedTruth, "issue mixed with cart projection");

        JSONObject mismatchedBinding = source(fixture);
        mismatchedBinding.getJSONArray("events")
            .getJSONObject(2)
            .getJSONObject("recoveryInteraction")
            .put("operationId", "operation_99999999");
        expectRejected(
            mismatchedBinding,
            "recovery binding identity mismatch"
        );

        JSONObject extraBindingField = source(fixture);
        extraBindingField.getJSONArray("events")
            .getJSONObject(2)
            .getJSONObject("recoveryInteraction")
            .put("retry", true);
        expectRejected(
            extraBindingField,
            "recovery binding unsupported field"
        );

        JSONObject orphanBinding = source(fixture);
        orphanBinding.getJSONArray("events")
            .getJSONObject(0)
            .put("issue", JSONObject.NULL);
        expectRejected(
            orphanBinding,
            "recovery binding without issue"
        );
    }

    private static RetainedTaskEventParser parser() {
        return new RetainedTaskEventParser(
            new OverlayPresentationParser()
        );
    }

    private static JSONObject source(Path fixture) throws Exception {
        return new JSONObject(new String(
            Files.readAllBytes(fixture),
            StandardCharsets.UTF_8
        ));
    }

    private static JSONObject issue(JSONObject snapshot, int index) {
        return snapshot.getJSONArray("events")
            .getJSONObject(index)
            .getJSONObject("issue");
    }

    private static void expectRejected(
        JSONObject snapshot,
        String message
    ) throws Exception {
        try {
            parser().parseSnapshot(snapshot);
            throw new AssertionError(
                "parser accepted unsafe fixture: " + message
            );
        } catch (IllegalArgumentException expected) {
            // Expected strict fail-closed behavior.
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
