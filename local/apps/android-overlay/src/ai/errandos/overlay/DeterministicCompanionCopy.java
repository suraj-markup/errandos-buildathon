package ai.errandos.overlay;

import java.util.Locale;

/**
 * Small, deterministic strings owned by the native companion. Provider and
 * product names are always supplied as arguments and are never translated.
 */
final class DeterministicCompanionCopy {
    enum Language {
        ENGLISH,
        HINDI,
        HINGLISH
    }

    private DeterministicCompanionCopy() {}

    static Language language(String languageCode) {
        if (languageCode == null) return Language.ENGLISH;
        String normalized = languageCode.trim().toLowerCase(Locale.US);
        if (
            normalized.startsWith("hi-latn")
                || normalized.startsWith("hinglish")
        ) {
            return Language.HINGLISH;
        }
        if (normalized.startsWith("hi")) return Language.HINDI;
        return Language.ENGLISH;
    }

    static String phase(String stage, String item, String languageCode) {
        Language language = language(languageCode);
        String safeItem = clean(item);
        if ("searching".equals(stage)) {
            if (language == Language.HINDI) {
                return safeItem == null
                    ? "खोज रहे हैं"
                    : safeItem + " खोज रहे हैं";
            }
            if (language == Language.HINGLISH) {
                return safeItem == null
                    ? "Dhoondh rahe hain"
                    : safeItem + " dhoondh rahe hain";
            }
            return safeItem == null ? "Searching" : "Searching for " + safeItem;
        }
        if ("waiting_for_choice".equals(stage)) {
            if (language == Language.HINDI) {
                return safeItem == null
                    ? "आपकी पसंद का इंतज़ार है"
                    : safeItem + " की पसंद का इंतज़ार है";
            }
            if (language == Language.HINGLISH) {
                return safeItem == null
                    ? "Aapki choice ka wait hai"
                    : safeItem + " ki choice ka wait hai";
            }
            return safeItem == null
                ? "Waiting for your choice"
                : "Choose " + safeItem;
        }
        if ("selected".equals(stage) || "adding".equals(stage)) {
            if (language == Language.HINDI) {
                return safeItem == null
                    ? "कार्ट में जोड़ रहे हैं"
                    : safeItem + " कार्ट में जोड़ रहे हैं";
            }
            if (language == Language.HINGLISH) {
                return safeItem == null
                    ? "Cart mein add kar rahe hain"
                    : safeItem + " cart mein add kar rahe hain";
            }
            return safeItem == null ? "Adding to cart" : "Adding " + safeItem;
        }
        if ("verifying".equals(stage)) {
            if (language == Language.HINDI) return "अपडेट किया हुआ कार्ट जाँच रहे हैं";
            if (language == Language.HINGLISH) return "Updated cart check kar rahe hain";
            return "Checking the updated cart";
        }
        if ("ambiguous".equals(stage) || "reconciling".equals(stage)) {
            if (language == Language.HINDI) {
                return "केवल पढ़ने वाली रिकवरी मौजूदा कार्ट जाँच रही है; "
                    + "कार्ट बदलाव दोहराया नहीं जाएगा।";
            }
            if (language == Language.HINGLISH) {
                return "Read-only recovery current cart check kar rahi hai "
                    + "aur cart change repeat nahi karegi.";
            }
            return "Read-only recovery is checking the current cart and "
                + "will not repeat the cart change.";
        }
        if ("paused".equals(stage)) {
            if (language == Language.HINDI) return "कार्य रुका हुआ है";
            if (language == Language.HINGLISH) return "Task paused hai";
            return "Task paused";
        }
        if ("disconnected".equals(stage)) {
            if (language == Language.HINDI) return "JaldiAI का कनेक्शन टूट गया";
            if (language == Language.HINGLISH) return "JaldiAI connection toot gaya";
            return "JaldiAI disconnected";
        }
        if ("verified".equals(stage) || "completed".equals(stage)) {
            if (language == Language.HINDI) {
                return safeItem == null ? "पुष्टि हो गई" : safeItem + " जुड़ गया";
            }
            if (language == Language.HINGLISH) {
                return safeItem == null ? "Verify ho gaya" : safeItem + " add ho gaya";
            }
            return safeItem == null ? "Verified" : safeItem + " added";
        }
        return safeItem == null ? "Pending" : safeItem;
    }

    static String connectionLost(String languageCode) {
        Language language = language(languageCode);
        if (language == Language.HINDI) {
            return "JaldiAI सर्वर से कनेक्शन टूट गया। कार्य के अपडेट रुके हुए हैं।";
        }
        if (language == Language.HINGLISH) {
            return "JaldiAI server disconnected. Task updates pause hain.";
        }
        return "JaldiAI server disconnected. Task updates are paused.";
    }

    static String selected(
        String product,
        String metadata,
        String languageCode
    ) {
        String safeProduct = clean(product);
        if (safeProduct == null) safeProduct = "Product";
        String suffix = metadata == null || metadata.trim().isEmpty()
            ? ""
            : " · " + metadata.trim();
        Language language = language(languageCode);
        if (language == Language.HINDI) {
            return "✓ " + safeProduct + " चुना गया" + suffix
                + "\nकार्ट में जोड़ रहे हैं…";
        }
        if (language == Language.HINGLISH) {
            return "✓ " + safeProduct + " selected" + suffix
                + "\nCart mein add kar rahe hain…";
        }
        return "✓ " + safeProduct + " selected" + suffix
            + "\nAdding to cart…";
    }

    private static String clean(String value) {
        if (value == null) return null;
        String clean = value.trim();
        return clean.isEmpty() ? null : clean;
    }
}
