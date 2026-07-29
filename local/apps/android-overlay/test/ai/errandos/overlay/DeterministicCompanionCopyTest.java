package ai.errandos.overlay;

public final class DeterministicCompanionCopyTest {
    public static void main(String[] args) {
        require(
            "Searching for Amul Paneer".equals(
                DeterministicCompanionCopy.phase(
                    "searching",
                    "Amul Paneer",
                    "en-IN"
                )
            ),
            "English search copy must preserve the product name"
        );
        require(
            DeterministicCompanionCopy.phase(
                "adding",
                "Amul Paneer",
                "hi-IN"
            ).startsWith("Amul Paneer "),
            "Hindi copy must preserve the provider product name"
        );
        require(
            DeterministicCompanionCopy.phase(
                "waiting_for_choice",
                "Amul Paneer",
                "hi-Latn-IN"
            ).startsWith("Amul Paneer "),
            "Hinglish copy must preserve the provider product name"
        );
        require(
            DeterministicCompanionCopy.selected(
                "Amul Paneer",
                "200 g · ₹105",
                "en-IN"
            ).contains("Adding to cart"),
            "tap acknowledgement must name the next exact phase"
        );
        String ambiguity = DeterministicCompanionCopy.phase(
            "ambiguous",
            "Checking cart",
            "en-IN"
        );
        require(
            ambiguity.contains("Read-only recovery")
                && ambiguity.contains("will not repeat"),
            "ambiguity must expose read-only no-repeat recovery"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
