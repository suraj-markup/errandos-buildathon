package ai.errandos.overlay;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Pure-JDK regression guard for the UX030–UX035 and UX050 fixture matrix.
 *
 * The fixtures deliberately contain only authoritative retained-event or
 * structured-presentation facts. This test does not infer transaction truth.
 */
public final class MultiItemCompanionFixtureContractTest {
    public static void main(String[] args) throws Exception {
        Path fixtures = Paths.get(args[0]);
        String lifecycle = read(
            fixtures,
            "ux-regression-four-item-retained-lifecycle.json"
        );
        String localized = read(
            fixtures,
            "ux-regression-localized-progress-copy.json"
        );
        String choices = read(
            fixtures,
            "ux-regression-rich-product-choices.json"
        );
        String cart = read(
            fixtures,
            "ux-regression-verified-cart-summary.json"
        );
        String ambiguity = read(fixtures, "ambiguous-reconciliation.json");
        String reset = read(fixtures, "retention-reset-recovery.json");
        String negative = read(fixtures, "cart-provenance-negative.json");
        String races = read(fixtures, "reconciliation-race-restart.json");

        retainedLifecycleIsOrderedAndAuthoritative(lifecycle);
        copyCoversEnglishHindiAndHinglish(localized);
        choicesAreRichAndInputAgnostic(choices);
        finalCartIsVerifiedAndSafe(cart);
        ambiguityIsReadOnlyAndNonterminal(ambiguity, races);
        resetHydratesAuthoritativeProjection(reset);
        negativeProvenanceNeverClaimsVerifiedCart(negative);
        raceAndRestartRecoveryIsFailClosed(races);

        String all = (
            lifecycle
                + localized
                + choices
                + cart
                + ambiguity
                + reset
                + races
        ).toLowerCase();
        absent(all, "\"choiceid\": \"place_order\"");
        absent(all, "\"label\": \"place order\"");
        absent(all, "\"ordered\": true");
    }

    private static void retainedLifecycleIsOrderedAndAuthoritative(
        String fixture
    ) {
        contains(fixture, "\"version\": 2");
        contains(fixture, "\"total\": 4");
        contains(fixture, "\"latestSequence\": 15");
        contains(fixture, "\"kind\": \"task_started\"");
        contains(fixture, "\"kind\": \"searching\"");
        contains(fixture, "\"kind\": \"options_ready\"");
        contains(fixture, "\"kind\": \"selection_accepted\"");
        contains(fixture, "\"kind\": \"mutation_started\"");
        contains(fixture, "\"kind\": \"mutation_verified\"");
        contains(fixture, "\"kind\": \"moving_to_next_step\"");
        contains(fixture, "\"kind\": \"reviewing_cart\"");
        contains(fixture, "\"kind\": \"completed\"");
        contains(fixture, "\"channel\": \"visual_only\"");
        contains(fixture, "\"channel\": \"speech_and_visual\"");
        require(
            occurrences(fixture, "\"kind\": \"mutation_verified\"") == 4,
            "four-item lifecycle must verify exactly four item mutations"
        );
        inOrder(
            fixture,
            "\"kind\": \"task_started\"",
            "\"kind\": \"options_ready\"",
            "\"kind\": \"selection_accepted\"",
            "\"kind\": \"reviewing_cart\"",
            "\"kind\": \"completed\""
        );
        inOrder(
            fixture,
            "Potato added. Now looking for paneer.",
            "Paneer added. Now looking for chicken.",
            "Chicken added. Now looking for rice.",
            "Your cart is ready"
        );
    }

    private static void copyCoversEnglishHindiAndHinglish(String fixture) {
        contains(fixture, "\"languageCode\": \"en-IN\"");
        contains(fixture, "\"languageCode\": \"hi-IN\"");
        contains(fixture, "\"languageCode\": \"hi-Latn-IN\"");
        require(
            occurrences(fixture, "Amul Fresh Malai Paneer") == 15,
            "provider product name must remain intact across localized copy"
        );
        contains(fixture, "\"searching\"");
        contains(fixture, "\"adding\"");
        contains(fixture, "\"verifying\"");
        contains(fixture, "\"waiting\"");
        contains(fixture, "\"verified\"");
        contains(fixture, "\"ambiguous\"");
        contains(fixture, "\"paused\"");
        contains(fixture, "\"disconnected\"");
        contains(fixture, "Checking what happened");
        contains(fixture, "Phone connection lost");
        contains(fixture, "दोबारा नहीं जोड़ूँगा");
        contains(fixture, "dobara add nahi karunga");
    }

    private static void choicesAreRichAndInputAgnostic(String fixture) {
        require(
            occurrences(fixture, "\"offerId\"") == 4,
            "choice fixture must expose three offers and one accepted projection"
        );
        require(
            occurrences(fixture, "\"imageUrl\"") == 3,
            "each choice needs an image URL"
        );
        require(
            occurrences(fixture, "https://cdn.blinkit.com/products/") == 3,
            "choice images must use the native HTTPS provider allowlist"
        );
        require(
            occurrences(fixture, "\"unitPrice\"") == 3,
            "each choice needs a structured unit price"
        );
        require(
            occurrences(fixture, "\"availabilityConstraint\"") == 3,
            "each choice needs an availability constraint"
        );
        contains(fixture, "\"code\": \"suggested_exact_pack\"");
        contains(fixture, "\"label\": \"Suggested\"");
        contains(fixture, "\"code\": \"lowest_price_exact_pack\"");
        contains(fixture, "\"label\": \"Lowest price\"");
        contains(fixture, "\"visualState\": \"selected\"");
        contains(fixture, "\"nextPhase\": \"adding\"");
        contains(fixture, "\"equivalentInputSources\": [\"tap\", \"voice\"]");
    }

    private static void finalCartIsVerifiedAndSafe(String fixture) {
        contains(fixture, "\"kind\": \"completed\"");
        contains(fixture, "\"type\": \"cart_summary\"");
        contains(fixture, "\"verified\": true");
        contains(fixture, "\"ordered\": false");
        contains(fixture, "\"name\": \"Potato\"");
        contains(fixture, "\"name\": \"Amul Fresh Malai Paneer, 200 g\"");
        contains(fixture, "\"name\": \"Abis Pro Chicken Curry Cut, 500 g\"");
        contains(fixture, "\"name\": \"Anand Boiled Rice, 10 kg\"");
        require(
            occurrences(fixture, "\"quantity\": 1") == 8,
            "event projection and safe card must each contain four quantities"
        );
        contains(fixture, "\"finalCartSummary\"");
        contains(fixture, "\"status\": \"ready\"");
        contains(fixture, "\"subtotal\": \"₹880\"");
        contains(fixture, "\"subtotal\": {\"currency\": \"INR\", \"amount\": 880}");
        contains(fixture, "\"choiceId\": \"review_cart\"");
        contains(fixture, "\"choiceId\": \"keep_shopping\"");
        contains(fixture, "\"choiceId\": \"review_checkout\"");
        contains(fixture, "\"choiceId\": \"stop\"");
        absent(fixture, "\"choiceId\": \"add_more\"");
        contains(fixture, "NOT ORDERED");
    }

    private static void ambiguityIsReadOnlyAndNonterminal(
        String ambiguity,
        String races
    ) {
        contains(ambiguity, "Read-only recovery");
        contains(ambiguity, "will not repeat");
        contains(races, "\"ambiguityTerminal\": false");
        inOrder(
            races,
            "\"disconnected\"",
            "\"ambiguous\"",
            "\"reviewing_cart\"",
            "\"completed\""
        );
    }

    private static void resetHydratesAuthoritativeProjection(
        String fixture
    ) {
        contains(fixture, "\"resetRequired\": true");
        contains(fixture, "\"events\": []");
        contains(fixture, "\"latestSequence\": 12");
        contains(fixture, "\"taskRevision\": 9");
        contains(fixture, "\"kind\": \"reviewing_cart\"");
        contains(fixture, "\"completed\": 2");
        contains(fixture, "\"nextLabel\": \"Cart review\"");
        contains(fixture, "\"packSize\": \"500 ml\"");
        contains(fixture, "\"price\": \"₹45\"");
        contains(fixture, "\"terminal\": false");
        contains(fixture, "\"channel\": \"visual_only\"");
        absent(fixture, "\"channel\": \"speech_and_visual\"");
    }

    private static void negativeProvenanceNeverClaimsVerifiedCart(
        String fixture
    ) {
        contains(fixture, "\"name\": \"missing verification\"");
        contains(fixture, "\"verified\": false");
        contains(fixture, "\"name\": \"order state missing\"");
        contains(fixture, "\"ordered\": true");
        require(
            occurrences(fixture, "\"expected\": \"downgrade\"") == 4,
            "all negative provenance cases must downgrade"
        );
        require(
            occurrences(
                fixture,
                "\"forbiddenHeadline\": \"VERIFIED CART · NOT ORDERED\""
            ) == 1,
            "verified headline must remain forbidden in negative fixtures"
        );
    }

    private static void raceAndRestartRecoveryIsFailClosed(String fixture) {
        contains(fixture, "\"name\": \"duplicate does not advance\"");
        contains(fixture, "\"name\": \"gap does not advance\"");
        contains(fixture, "\"reconnectAfterSequence\": 8");
        contains(fixture, "\"states\": [\"reviewing_cart\", \"cancelled\"]");
        contains(fixture, "\"cancelledTerminal\": true");
        contains(fixture, "\"pollAfterCancelled\": false");
    }

    private static String read(Path root, String file) throws Exception {
        return new String(
            Files.readAllBytes(root.resolve(file)),
            StandardCharsets.UTF_8
        );
    }

    private static int occurrences(String text, String expected) {
        int count = 0;
        int offset = 0;
        while ((offset = text.indexOf(expected, offset)) >= 0) {
            count += 1;
            offset += expected.length();
        }
        return count;
    }

    private static void inOrder(String source, String... expected) {
        int offset = -1;
        for (String value : expected) {
            int next = source.indexOf(value, offset + 1);
            require(next > offset, "fixture order missing: " + value);
            offset = next;
        }
    }

    private static void contains(String source, String expected) {
        require(source.contains(expected), "missing fixture contract: " + expected);
    }

    private static void absent(String source, String forbidden) {
        require(
            !source.contains(forbidden),
            "unsafe fixture contract present: " + forbidden
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
