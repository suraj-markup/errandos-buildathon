package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

/**
 * Host-JVM contract test that executes the production JSON parsers and reducer.
 * Test-only org.json support is compiled only into the host test classpath.
 */
public final class ProductionParserFixtureTest {
    public static void main(String[] args) throws Exception {
        Path fixtures = Paths.get(args[0]);
        authoritativeResetParsesAndHydrates(fixtures);
        negativeCartProvenanceIsRejected(fixtures);
        structuredProgressMatrixUsesProductionParser(fixtures);
        fourItemLifecycleUsesProductionParser(fixtures);
        raceRestartAndCancellationUseProductionEvents(fixtures);
    }

    private static void authoritativeResetParsesAndHydrates(Path fixtures)
        throws Exception {
        RetainedTaskEventParser parser = retainedParser();
        RetainedTaskEventParser.Snapshot parsed = parser.parseSnapshot(
            new JSONObject(read(fixtures, "retention-reset-recovery.json"))
        );
        require(parsed.resetRequired, "reset fixture must request reset");
        require(
            parsed.resetSnapshot != null,
            "production parser must expose the reset projection"
        );
        require(
            !parsed.shouldReplayAnnouncements(),
            "reset history must remain render-only"
        );

        TaskChecklistState state = new TaskChecklistState();
        require(
            state.applyResetSnapshot(parsed.resetSnapshot),
            "production-parsed reset must hydrate atomically"
        );
        TaskChecklistState.Snapshot hydrated = state.snapshot();
        require(hydrated.lastSequence() == 12, "reset cursor");
        require(hydrated.taskRevision() == 9, "reset revision");
        require(hydrated.completedCount() == 2, "reset progress");
        require(hydrated.totalItems() == 3, "reset item count");
        require(
            hydrated.activePhase() == TaskChecklistState.Phase.VERIFYING,
            "reviewing_cart reset phase"
        );
        String breadDetail = hydrated.items().get(1).detail();
        require(
            breadDetail != null
                && breadDetail.contains("bread")
                && breadDetail.contains("400 g")
                && breadDetail.contains("Qty 1")
                && breadDetail.contains("₹45"),
            "reset item details must survive the real parser"
        );
        require(
            "step_cart_review".equals(
                hydrated.items().get(2).stepId()
            ),
            "reset active item must survive the real parser"
        );

        String encoded = state.encode();
        TaskChecklistState restarted = TaskChecklistState.decode(encoded);
        require(
            restarted.snapshot().lastSequence() == 12
                && restarted.snapshot().completedCount() == 2,
            "hydrated projection must restart without replay"
        );

        JSONObject completedReset = new JSONObject(
            read(fixtures, "retention-reset-recovery.json")
        );
        JSONObject completedProjection =
            completedReset.getJSONObject("snapshot");
        JSONObject completedEvent =
            completedProjection.getJSONObject("latestEvent");
        completedEvent.put("kind", "completed");
        completedEvent.put("title", "Your cart is ready");
        completedEvent.put("detail", "2 verified items · NOT ORDERED");
        completedProjection.put("terminal", true);
        completedProjection.getJSONObject("progress").put("completed", 3);
        completedProjection.put(
            "finalCartSummary",
            finalCartSummary(1785202001200L)
        );
        RetainedTaskEventParser.Snapshot completed =
            parser.parseSnapshot(completedReset);
        require(
            completed.resetPresentation != null
                && completed.resetPresentation.structured
                && completed.resetFinalCartPresentation
                    == completed.resetPresentation
                && completed.resetPresentation.card.cartSummary != null
                && completed.resetPresentation.card.cartSummary
                    .isVerifiedNotOrdered()
                && completed.resetPresentation.card.cartSummary.lines.size()
                    == 2,
            "reset projection finalCartSummary must hydrate canonical cart UI"
        );

        JSONObject cancelledReset = new JSONObject(
            read(fixtures, "retention-reset-recovery.json")
        );
        JSONObject cancelledProjection =
            cancelledReset.getJSONObject("snapshot");
        JSONObject cancelledEvent =
            cancelledProjection.getJSONObject("latestEvent");
        cancelledEvent.put("kind", "cancelled");
        cancelledEvent.put("title", "Task stopped");
        cancelledEvent.put(
            "detail",
            "Task stopped. No further phone work will run."
        );
        cancelledProjection.put("terminal", true);
        cancelledProjection.put(
            "safePresentation",
            obsoleteCancelledErrorPresentation()
        );
        RetainedTaskEventParser.Snapshot cancelled =
            parser.parseSnapshot(cancelledReset);
        require(
            cancelled.resetSnapshot.terminal
                && cancelled.resetPresentation != null
                && "idle".equals(cancelled.resetPresentation.mode)
                && "neutral".equals(cancelled.resetPresentation.card.tone)
                && "TASK STOPPED".equals(
                    cancelled.resetPresentation.card.headline
                ),
            "cancelled reset must replace obsolete error styling with neutral"
        );
    }

    private static void negativeCartProvenanceIsRejected(Path fixtures)
        throws Exception {
        OverlayPresentationParser parser = new OverlayPresentationParser();
        JSONObject fixture = new JSONObject(
            read(fixtures, "cart-provenance-negative.json")
        );
        JSONArray cases = fixture.getJSONArray("cases");
        for (int index = 0; index < cases.length(); index += 1) {
            JSONObject source = cases.getJSONObject(index);
            JSONObject card = new JSONObject(
                source.getJSONObject("card").toString()
            );
            JSONObject cart = card.getJSONObject("cart");
            cart.put("lines", validCartLines());
            cart.put("addressLabel", "Home");
            OverlayPresentation parsed = parser.parse(
                presentation(card),
                "Cart verification unavailable",
                "error"
            );
            require(
                !parsed.structured,
                "negative provenance must downgrade through production parser: "
                    + source.getString("name")
            );
            require(
                parsed.card.cartSummary == null,
                "negative provenance cannot retain cart truth: "
                    + source.getString("name")
            );
        }

        JSONObject safeCard = new JSONObject();
        safeCard.put("type", "cart_summary");
        safeCard.put("ordered", false);
        JSONObject safeCart = new JSONObject();
        safeCart.put("verified", true);
        safeCart.put("lines", validCartLines());
        safeCart.put("subtotal", money(49));
        safeCart.put("addressLabel", "Home");
        safeCard.put("cart", safeCart);
        OverlayPresentation positive = parser.parse(
            presentation(safeCard),
            "Cart verified",
            "success"
        );
        require(positive.structured, "authoritative cart control must parse");
        require(
            positive.card.cartSummary != null
                && positive.card.cartSummary.isVerifiedNotOrdered(),
            "positive control requires both authoritative provenance flags"
        );
    }

    private static void structuredProgressMatrixUsesProductionParser(
        Path fixtures
    ) throws Exception {
        OverlayPresentationParser parser = new OverlayPresentationParser();
        JSONArray matrix = new JSONArray(
            read(fixtures, "structured-progress-matrix.json")
        );
        for (int index = 0; index < matrix.length(); index += 1) {
            JSONObject entry = matrix.getJSONObject(index);
            OverlayPresentation parsed = parser.parse(
                entry.getJSONObject("presentation"),
                "Fixture fallback",
                "error"
            );
            require(
                parsed.structured,
                "matrix row must survive the production parser: "
                    + entry.getString("name")
            );
            require(
                parsed.task != null,
                "matrix row must retain task progress: "
                    + entry.getString("name")
            );
            if ("cancelled".equals(entry.getString("name"))) {
                require(
                    parsed.task.terminal
                        && "cancelled".equals(parsed.task.stage),
                    "cancelled progress remains explicitly terminal"
                );
                require(
                    "idle".equals(parsed.mode)
                        && "neutral".equals(parsed.card.tone),
                    "cancelled terminal must remain visually neutral"
                );
            }
            if ("ambiguous".equals(entry.getString("name"))) {
                require(
                    !parsed.task.terminal
                        && "ambiguous".equals(parsed.task.stage),
                    "ambiguity must remain a nonterminal reconciliation phase"
                );
                require(
                    parsed.spokenText.contains("Read-only recovery")
                        && parsed.spokenText.contains("will not repeat"),
                    "ambiguity accessibility copy must state read-only no-repeat"
                );
            }
        }
    }

    private static void fourItemLifecycleUsesProductionParser(Path fixtures)
        throws Exception {
        RetainedTaskEventParser.Snapshot snapshot =
            retainedParser().parseSnapshot(new JSONObject(
                read(fixtures, "ux-regression-four-item-retained-lifecycle.json")
            ));
        require(
            snapshot.events.size() == 16,
            "all lifecycle events must survive the production parser"
        );
        TaskChecklistState reducer = new TaskChecklistState();
        for (RetainedTaskEvent event : snapshot.events) {
            require(
                reducer.apply(event),
                "production reducer must accept lifecycle sequence "
                    + event.sequence
            );
        }
        TaskChecklistState.Snapshot reduced = reducer.snapshot();
        require(
            reduced.terminal()
                && reduced.completedCount() == 4
                && reduced.totalItems() == 4,
            "production reducer must retain the exact four-item completion"
        );

        RetainedTaskEvent completed =
            snapshot.events.get(snapshot.events.size() - 1);
        require(
            completed.isTerminal() && "completed".equals(completed.kind),
            "final lifecycle event must be authoritative completion"
        );
        require(
            completed.finalCartSummary != null
                && completed.finalCartSummary.isVerifiedNotOrdered()
                && completed.finalCartSummary.lines.size() == 4
                && "₹880".equals(completed.finalCartSummary.subtotal),
            "event.finalCartSummary must canonically hydrate verified lines"
        );

        List<FinalCartActionPolicy.Action> actions =
            FinalCartActionPolicy.safeActions(completed.interaction);
        require(
            actions.size() == 4
                && actions.get(0).kind
                    == FinalCartActionPolicy.Kind.REVIEW_CART
                && actions.get(1).kind
                    == FinalCartActionPolicy.Kind.KEEP_SHOPPING
                && actions.get(2).kind
                    == FinalCartActionPolicy.Kind.REVIEW_CHECKOUT
                && actions.get(3).kind
                    == FinalCartActionPolicy.Kind.STOP,
            "only the repository-backed final action set may render"
        );
        for (FinalCartActionPolicy.Action action : actions) {
            require(
                action.backingChoice != null
                    && !action.talkBackDescription.isEmpty(),
                "every final action needs persisted identity and TalkBack copy"
            );
        }
        OverlayPresentation finalCart =
            TaskEventPresentationFactory.createFinalCartPresentation(
                completed,
                completed.operationId
            );
        require(
            finalCart != null
                && finalCart.structured
                && "cart_summary".equals(finalCart.card.type)
                && "VERIFIED CART · NOT ORDERED".equals(
                    finalCart.card.headline
                )
                && finalCart.card.cartSummary != null
                && finalCart.card.cartSummary.lines.size() == 4,
            "compact safePresentation must be hydrated from finalCartSummary"
        );

        JSONObject missingProvenance = new JSONObject(
            read(fixtures, "ux-regression-four-item-retained-lifecycle.json")
        );
        JSONArray missingEvents = missingProvenance.getJSONArray("events");
        missingEvents.getJSONObject(missingEvents.length() - 1)
            .put("finalCartSummary", JSONObject.NULL);
        RetainedTaskEvent missingCart = retainedParser()
            .parseSnapshot(missingProvenance)
            .events
            .get(missingEvents.length() - 1);
        require(
            missingCart.finalCartSummary == null
                && TaskEventPresentationFactory.createFinalCartPresentation(
                    missingCart,
                    missingCart.operationId
                ) == null,
            "compact completion without finalCartSummary cannot invent cart truth"
        );

        JSONObject invalidProvenance = new JSONObject(
            read(fixtures, "ux-regression-four-item-retained-lifecycle.json")
        );
        JSONArray invalidEvents = invalidProvenance.getJSONArray("events");
        invalidEvents.getJSONObject(invalidEvents.length() - 1)
            .getJSONObject("finalCartSummary")
            .put("status", "assumed");
        boolean rejected = false;
        try {
            retainedParser().parseSnapshot(invalidProvenance);
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        require(
            rejected,
            "unknown final-cart provenance must fail closed in production parser"
        );
    }

    private static void raceRestartAndCancellationUseProductionEvents(
        Path fixtures
    ) throws Exception {
        JSONObject races = new JSONObject(
            read(fixtures, "reconciliation-race-restart.json")
        );
        JSONArray scenarios = races.getJSONArray("scenarios");
        require(
            scenario(scenarios, "duplicate does not advance") != null,
            "duplicate fixture scenario"
        );
        require(
            scenario(scenarios, "gap does not advance") != null,
            "gap fixture scenario"
        );
        JSONObject reconciliation = scenario(
            scenarios,
            "disconnect ambiguity reconcile"
        );
        require(
            reconciliation != null
                && reconciliation.getJSONArray("states").getString(1)
                    .equals("ambiguous")
                && reconciliation.getJSONArray("states").getString(2)
                    .equals("reviewing_cart"),
            "reconciliation fixture ordering"
        );

        String taskId = races.getString("taskId");
        RetainedTaskEventParser parser = retainedParser();
        JSONArray events = new JSONArray();
        events.put(event(
            taskId,
            8,
            8,
            "ambiguous",
            "Checking what happened",
            reconciliation.getString("copy"),
            true
        ));
        events.put(event(
            taskId,
            9,
            9,
            "reviewing_cart",
            "Reviewing cart",
            "Checking the current cart without repeating the change.",
            false
        ));
        events.put(event(
            taskId,
            10,
            10,
            "cancelled",
            "Task cancelled",
            "No more phone work will run.",
            true
        ));
        RetainedTaskEventParser.Snapshot parsed = parser.parseSnapshot(
            envelope(taskId, 7, 8, 10, events)
        );
        require(parsed.events.size() == 3, "real race events parsed");
        require(
            !parsed.events.get(0).isTerminal(),
            "ambiguity terminal hint must fail closed to nonterminal"
        );
        require(
            parsed.events.get(2).isTerminal(),
            "explicit cancelled event must be terminal"
        );

        TaskEventSubscriptionState cursor =
            new TaskEventSubscriptionState();
        cursor.restore(taskId, 7, 7, "operation_race-12345678", false);
        TaskChecklistState reducer = new TaskChecklistState();
        reducer.setDisconnected(true, "JaldiAI disconnected");
        reducer.setDisconnected(false, null);

        RetainedTaskEvent ambiguity = parsed.events.get(0);
        require(
            cursor.accept(
                ambiguity.taskId,
                ambiguity.sequence,
                ambiguity.taskRevision,
                ambiguity.operationId,
                ambiguity.isTerminal()
            ) == TaskEventSubscriptionState.Decision.ACCEPTED,
            "ambiguity accepted"
        );
        require(reducer.apply(ambiguity), "ambiguity reduced");
        require(!cursor.terminal(), "ambiguity polling continues");

        TaskEventSubscriptionState duplicate =
            new TaskEventSubscriptionState();
        duplicate.restore(taskId, 8, 8, ambiguity.operationId, false);
        require(
            duplicate.accept(
                ambiguity.taskId,
                ambiguity.sequence,
                ambiguity.taskRevision,
                ambiguity.operationId,
                ambiguity.isTerminal()
            ) == TaskEventSubscriptionState.Decision.STALE,
            "duplicate does not advance"
        );
        RetainedTaskEvent cancelled = parsed.events.get(2);
        require(
            duplicate.accept(
                cancelled.taskId,
                cancelled.sequence,
                cancelled.taskRevision,
                cancelled.operationId,
                cancelled.isTerminal()
            ) == TaskEventSubscriptionState.Decision.GAP,
            "gap does not advance"
        );
        require(duplicate.lastSequence() == 8, "gap cursor unchanged");

        RetainedTaskEvent reviewing = parsed.events.get(1);
        require(
            cursor.accept(
                reviewing.taskId,
                reviewing.sequence,
                reviewing.taskRevision,
                reviewing.operationId,
                reviewing.isTerminal()
            ) == TaskEventSubscriptionState.Decision.ACCEPTED,
            "reviewing_cart follows ambiguity"
        );
        require(reducer.apply(reviewing), "reviewing_cart reduced");
        TaskChecklistState restarted =
            TaskChecklistState.decode(reducer.encode());
        require(
            restarted.snapshot().activePhase()
                == TaskChecklistState.Phase.VERIFYING,
            "restart preserves reconciliation"
        );
        require(
            cursor.accept(
                cancelled.taskId,
                cancelled.sequence,
                cancelled.taskRevision,
                cancelled.operationId,
                cancelled.isTerminal()
            ) == TaskEventSubscriptionState.Decision.ACCEPTED,
            "cancelled accepted after reviewing_cart"
        );
        require(restarted.apply(cancelled), "cancelled reduced after restart");
        require(cursor.terminal(), "cancelled stops retained polling");
        require(
            restarted.snapshot().terminal()
                && restarted.snapshot().activePhase()
                    == TaskChecklistState.Phase.CANCELLED,
            "cancelled is the exact terminal projection"
        );
    }

    private static RetainedTaskEventParser retainedParser() {
        return new RetainedTaskEventParser(new OverlayPresentationParser());
    }

    private static JSONObject envelope(
        String taskId,
        int afterSequence,
        int earliestSequence,
        int latestSequence,
        JSONArray events
    ) {
        JSONObject result = new JSONObject();
        result.put("version", 2);
        result.put("taskId", taskId);
        result.put("afterSequence", afterSequence);
        result.put("earliestSequence", earliestSequence);
        result.put("latestSequence", latestSequence);
        result.put("resetRequired", false);
        result.put("events", events);
        return result;
    }

    private static JSONObject event(
        String taskId,
        int sequence,
        int revision,
        String kind,
        String title,
        String detail,
        boolean terminal
    ) {
        JSONObject result = new JSONObject();
        result.put("version", 2);
        result.put("eventId", "event_" + kind + "-" + sequence);
        result.put("taskId", taskId);
        result.put("taskRevision", revision);
        result.put("operationId", "operation_race-12345678");
        result.put("stepId", "step_cart_recovery");
        result.put("sequence", sequence);
        result.put("kind", kind);
        result.put("title", title);
        result.put("detail", detail);
        JSONObject position = new JSONObject();
        position.put("current", 1);
        position.put("total", 2);
        result.put("itemPosition", position);
        result.put("terminal", terminal);
        result.put("occurredAt", 1785203000000L + sequence);
        JSONObject announcement = new JSONObject();
        announcement.put("channel", "visual_only");
        announcement.put("text", title);
        result.put("announcement", announcement);
        return result;
    }

    private static JSONObject presentation(JSONObject card) {
        JSONObject result = new JSONObject();
        result.put("version", 1);
        result.put("mode", "success");
        result.put("primarySurface", "overlay_card");
        result.put("card", card);
        JSONObject spoken = new JSONObject();
        spoken.put("text", "Cart checked.");
        spoken.put("languageCode", "en-IN");
        result.put("spoken", spoken);
        JSONObject behavior = new JSONObject();
        behavior.put("autoCollapse", false);
        behavior.put("keepVisibleWhileSpeaking", true);
        result.put("behavior", behavior);
        return result;
    }

    private static JSONArray validCartLines() {
        JSONObject line = new JSONObject();
        line.put("productId", "product_fixture");
        line.put("name", "Fixture item");
        line.put("quantity", 1);
        line.put("unitPrice", money(49));
        line.put("lineTotal", money(49));
        return new JSONArray().put(line);
    }

    private static JSONObject finalCartSummary(long inspectedAt) {
        JSONArray lines = new JSONArray();
        lines.put(new JSONObject()
            .put("productId", "product_milk")
            .put("title", "Amul Milk, 500 ml")
            .put("quantity", 1)
            .put("price", "₹29"));
        lines.put(new JSONObject()
            .put("productId", "product_bread")
            .put("title", "Bread, 400 g")
            .put("quantity", 1)
            .put("price", "₹45"));
        return new JSONObject()
            .put("status", "ready")
            .put("lines", lines)
            .put("subtotal", "₹74")
            .put("inspectedAt", inspectedAt);
    }

    private static JSONObject obsoleteCancelledErrorPresentation() {
        return new JSONObject()
            .put("version", 1)
            .put("mode", "error")
            .put("primarySurface", "overlay_card")
            .put(
                "card",
                new JSONObject()
                    .put("type", "compact_status")
                    .put("tone", "error")
            )
            .put(
                "spoken",
                new JSONObject()
                    .put("text", "Task cancelled")
                    .put("languageCode", "en-IN")
            )
            .put(
                "behavior",
                new JSONObject()
                    .put("autoCollapse", false)
                    .put("keepVisibleWhileSpeaking", true)
            );
    }

    private static JSONObject money(int amount) {
        return new JSONObject()
            .put("currency", "INR")
            .put("amount", amount);
    }

    private static JSONObject scenario(JSONArray scenarios, String name) {
        for (int index = 0; index < scenarios.length(); index += 1) {
            JSONObject candidate = scenarios.getJSONObject(index);
            if (name.equals(candidate.optString("name"))) return candidate;
        }
        return null;
    }

    private static String read(Path root, String name) throws Exception {
        return new String(
            Files.readAllBytes(root.resolve(name)),
            StandardCharsets.UTF_8
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
