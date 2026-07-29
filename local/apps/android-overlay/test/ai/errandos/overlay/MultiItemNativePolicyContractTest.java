package ai.errandos.overlay;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure source-policy test for native behavior that is otherwise difficult to
 * exercise without instrumentation. It intentionally guards user-visible and
 * safety boundaries, not implementation-specific transaction state.
 */
public final class MultiItemNativePolicyContractTest {
    public static void main(String[] args) throws Exception {
        Path sourceRoot = Paths.get(args[0]);
        String card = read(sourceRoot, "OverlayCardView.java");
        String service = read(sourceRoot, "OverlayService.java");
        String presentation = read(sourceRoot, "OverlayPresentation.java");
        String parser = read(sourceRoot, "OverlayPresentationParser.java");
        String selection = read(sourceRoot, "ProductSelectionState.java");
        String reducer = read(sourceRoot, "TaskChecklistState.java");
        String feedback = read(sourceRoot, "InteractionFeedbackPolicy.java");
        String copy = read(sourceRoot, "DeterministicCompanionCopy.java");
        String factory = read(sourceRoot, "TaskEventPresentationFactory.java");
        String all = (
            card + service + presentation + parser + selection + reducer
                + feedback + copy + factory
        ).toLowerCase();

        immediateTapAcknowledgementIsIdempotent(card, service, selection);
        taskAndSelectionProjectionAreUnified(reducer);
        richChoicesAndVerifiedCartStayStructured(presentation, parser, card);
        verifiedCartSurvivesCompletionActions(service, factory);
        accessibilityTargetsAreLargeEnough(card);
        hapticsAreBoundedToMeaningfulEvents(service, feedback);
        exactRecoveryLabelsExist(card, reducer, copy);

        absent(all, "\"place order\"");
        absent(all, "\"place_order\"");
        absent(all, "retry add");
    }

    private static void immediateTapAcknowledgementIsIdempotent(
        String card,
        String service,
        String selection
    ) {
        before(selection, "selectedOfferId = offerId;", "status = Status.SUBMITTING;");
        contains(selection, "status == Status.SUBMITTING");
        contains(selection, "status == Status.ACCEPTED");
        contains(selection, "status == Status.DUPLICATE");
        String begin = methodBody(
            card,
            "OverlayPresentation.ProductSelectionBinding beginProductChoiceSubmission("
        );
        before(
            begin,
            "productSelectionState.begin(",
            "render(latest, expanded);"
        );
        String submit = methodBody(service, "private void submitProductChoice(");
        before(
            submit,
            "statusView.beginProductChoiceSubmission(option)",
            "networkExecutor.execute("
        );
        before(
            submit,
            "if (binding == null) {",
            "performFeedback(feedbackPolicy.forTap(true))"
        );
        before(
            submit,
            "persistLocalProductSelection(binding, option);",
            "performFeedback(feedbackPolicy.forTap(true))"
        );
        before(
            submit,
            "performFeedback(feedbackPolicy.forTap(true))",
            "networkExecutor.execute("
        );
        before(
            submit,
            "performFeedback(feedbackPolicy.forTap(true))",
            "latency.localAcknowledged(\"optimistic_ack\")"
        );
        contains(service, "request.put(\"source\", \"tap\")");
    }

    private static void taskAndSelectionProjectionAreUnified(String reducer) {
        contains(reducer, "final class TaskChecklistState");
        contains(reducer, "enum Phase");
        contains(reducer, "PENDING");
        contains(reducer, "SEARCHING");
        contains(reducer, "WAITING");
        contains(reducer, "SELECTED");
        contains(reducer, "ADDING");
        contains(reducer, "VERIFYING");
        contains(reducer, "VERIFIED");
        contains(reducer, "AMBIGUOUS");
        contains(reducer, "PAUSED");
        contains(reducer, "DISCONNECTED");
        contains(reducer, "\"selection_accepted\"");
        contains(reducer, "Phase.SELECTED");
        absent(reducer, "\"tap\".equals");
        absent(reducer, "\"voice\".equals");
    }

    private static void richChoicesAndVerifiedCartStayStructured(
        String presentation,
        String parser,
        String card
    ) {
        contains(presentation, "final String imageUrl;");
        contains(presentation, "final String unitPrice;");
        contains(presentation, "final String availabilityConstraint;");
        contains(presentation, "final String recommendationLabel;");
        contains(presentation, "static final class CartLine");
        contains(presentation, "static final class CartSummary");
        contains(presentation, "final CartSummary cartSummary;");
        contains(parser, "parseProductChoice");
        contains(parser, "parseCartSummary");
        contains(parser, "unitPriceText");
        contains(parser, "price + \" / \" + unit");
        contains(parser, "safeImageUrl");
        contains(card, "recommendationLabel");
        contains(card, "availabilityConstraint");
        contains(card, "cartSummary.lines");
        contains(card, "cartSummary.subtotal");
        contains(card, "NOT ORDERED");
        absent(card, "name.setMaxLines(2)");
    }

    private static void verifiedCartSurvivesCompletionActions(
        String service,
        String factory
    ) {
        boolean retainedByService = service.contains(
            "setRetainedCartSummary(event.safePresentation.card.cartSummary)"
        ) || Pattern.compile(
            "retainVerifiedCartSummary\\(\\s*event\\.safePresentation\\s*\\)"
        ).matcher(service).find()
            || service.contains(
                "retainVerifiedCartSummary(\n"
                    + "                                finalCartPresentation"
            );
        boolean preservedByFactory = factory.contains(
            "event.safePresentation.card.cartSummary"
        ) || factory.contains("event.finalCartSummary");
        require(
            retainedByService || preservedByFactory,
            "completed event actions must not discard authoritative cart lines"
        );
    }

    private static void accessibilityTargetsAreLargeEnough(String card) {
        contains(card, "ACCESSIBILITY_LIVE_REGION_POLITE");
        contains(card, "setAccessibilityHeading(true)");
        Matcher matcher = Pattern.compile(
            "setMinimumHeight\\(dp\\((\\d+)\\)\\)"
        ).matcher(card);
        int targets = 0;
        while (matcher.find()) {
            targets += 1;
            int dp = Integer.parseInt(matcher.group(1));
            require(dp >= 48, "interactive minimum height is below 48dp: " + dp);
        }
        require(targets >= 2, "expected choice and action tap targets");
        contains(card, "setContentDescription");
        contains(card, "recommendationLabel");
        contains(card, "selected");
    }

    private static void hapticsAreBoundedToMeaningfulEvents(
        String service,
        String feedback
    ) {
        contains(feedback, "LISTENING");
        contains(feedback, "SELECTION_ACCEPTED");
        contains(feedback, "ITEM_VERIFIED");
        contains(feedback, "ATTENTION_REQUIRED");
        contains(feedback, "lastSemanticKey");
        contains(service, "feedbackPolicy.forListening(true)");
        contains(service, "feedbackPolicy.forTap(true)");
        contains(service, "feedbackPolicy.forEvent(event)");
        contains(service, "HapticFeedbackConstants.CONFIRM");
        absent(service, "HapticFeedbackConstants.CONTEXT_CLICK");
        String poll = methodBody(service, "private void pollTaskEvents()");
        absent(poll, "performHapticFeedback");
    }

    private static void exactRecoveryLabelsExist(
        String card,
        String reducer,
        String copy
    ) {
        String combined = card + reducer + copy;
        contains(combined, "Read-only recovery");
        contains(combined, "will not repeat");
        contains(combined, "JaldiAI server disconnected. Task updates are paused.");
        contains(combined, "Task paused");
    }

    private static String methodBody(String source, String signature) {
        int start = source.indexOf(signature);
        require(start >= 0, "missing method: " + signature);
        int opening = source.indexOf('{', start);
        require(opening >= 0, "missing method body: " + signature);
        int depth = 0;
        for (int index = opening; index < source.length(); index += 1) {
            char value = source.charAt(index);
            if (value == '{') depth += 1;
            if (value == '}') {
                depth -= 1;
                if (depth == 0) {
                    return source.substring(opening, index + 1);
                }
            }
        }
        throw new AssertionError("unterminated method: " + signature);
    }

    private static String read(Path root, String file) throws Exception {
        return new String(
            Files.readAllBytes(root.resolve(file)),
            StandardCharsets.UTF_8
        );
    }

    private static void before(
        String source,
        String first,
        String second
    ) {
        int firstIndex = source.indexOf(first);
        int secondIndex = source.indexOf(second);
        require(
            firstIndex >= 0 && secondIndex > firstIndex,
            "expected native order: " + first + " before " + second
        );
    }

    private static void contains(String source, String expected) {
        require(source.contains(expected), "missing native policy: " + expected);
    }

    private static void absent(String source, String forbidden) {
        require(
            !source.contains(forbidden),
            "forbidden native policy present: " + forbidden
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
