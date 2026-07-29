package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import android.util.Log;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.time.Instant;

final class OverlayPresentationParser {
    private static final Set<String> MODES = setOf(
        "idle",
        "listening",
        "understanding",
        "reading",
        "acting",
        "verifying",
        "waiting_for_user",
        "success",
        "error",
        "ambiguous"
    );
    private static final Set<String> SCREEN_KINDS = setOf(
        "home",
        "search",
        "search_results",
        "product_detail",
        "cart",
        "checkout",
        "payment",
        "address_selection",
        "login",
        "otp",
        "location_prompt",
        "review_prompt",
        "order_confirmation",
        "order_history"
    );
    private static final Set<String> RELEVANCE = setOf(
        "product_options",
        "product_detail",
        "cart_summary",
        "checkout_summary",
        "payment_selection",
        "address_choices",
        "order_confirmation",
        "order_history",
        "authentication"
    );
    private static final Set<String> SUBJECTS = setOf(
        "options",
        "product",
        "cart",
        "checkout",
        "payment",
        "address",
        "confirmation",
        "recent_orders",
        "authentication"
    );
    private static final Set<String> CARD_TYPES = setOf(
        "compact_status",
        "product_choices",
        "cart_summary",
        "checkout_review",
        "changed_terms",
        "provider_constraint",
        "receipt",
        "ambiguous"
    );
    private static final Set<String> TASK_STAGES = setOf(
        "queued",
        "waiting_for_provider",
        "searching",
        "waiting_for_choice",
        "adding",
        "verifying",
        "reconciling",
        "completed",
        "failed",
        "cancelled",
        "ambiguous"
    );
    private static final Set<String> CANCELLATION_POLICIES = setOf(
        "cancel_now",
        "stop_after_current_step",
        "reconcile_only",
        "not_cancellable"
    );

    OverlayPresentation parse(
        JSONObject payload,
        String legacyReply,
        String legacyState
    ) {
        OverlayPresentation fallback = OverlayPresentation.legacy(
            legacyReply,
            legacyState
        );
        if (payload == null || payload.optInt("version", -1) != 1) {
            return fallback;
        }

        try {
            String mode = requiredEnum(payload, "mode", MODES);
            String primarySurface = requiredEnum(
                payload,
                "primarySurface",
                setOf("provider_screen", "overlay_card")
            );
            JSONObject spoken = requiredObject(payload, "spoken");
            String spokenText = requiredText(spoken, "text", 1000);
            String languageCode = requiredText(spoken, "languageCode", 12);
            JSONObject behavior = requiredObject(payload, "behavior");
            boolean autoCollapse = behavior.getBoolean("autoCollapse");
            boolean keepVisibleWhileSpeaking = behavior.getBoolean(
                "keepVisibleWhileSpeaking"
            );
            long collapseAfterMs = behavior.has("collapseAfterMs")
                ? behavior.getLong("collapseAfterMs")
                : 6500L;
            if (collapseAfterMs < 0L || collapseAfterMs > 60000L) {
                throw new IllegalArgumentException("invalid collapse duration");
            }

            String screenKind = null;
            String screenRelevance = null;
            String attentionSubject = null;
            if ("provider_screen".equals(primarySurface)) {
                JSONObject screen = requiredObject(payload, "currentScreen");
                if (!screen.optBoolean("verified", false)) {
                    throw new IllegalArgumentException("unverified screen");
                }
                screenKind = requiredEnum(screen, "kind", SCREEN_KINDS);
                screenRelevance = requiredEnum(
                    screen,
                    "relevance",
                    RELEVANCE
                );
                JSONObject attention = requiredObject(payload, "attentionCue");
                if (
                    !"check_current_screen".equals(
                        attention.optString("instruction", "")
                    )
                ) {
                    throw new IllegalArgumentException("invalid attention cue");
                }
                attentionSubject = requiredEnum(
                    attention,
                    "subject",
                    SUBJECTS
                );
            }

            OverlayPresentation.Card card = parseCard(
                requiredObject(payload, "card"),
                mode,
                spokenText
            );
            OverlayPresentation.TaskProgress task = payload.has("task")
                && !payload.isNull("task")
                    ? parseTask(requiredObject(payload, "task"))
                    : null;
            if (
                "ambiguous".equals(mode)
                    && !"ambiguous".equals(card.type)
            ) {
                throw new IllegalArgumentException("unsafe ambiguous card");
            }
            if (
                "success".equals(mode)
                    && "receipt".equals(card.type)
                    && card.detail == null
            ) {
                throw new IllegalArgumentException("missing receipt");
            }

            return new OverlayPresentation(
                1,
                mode,
                primarySurface,
                screenKind,
                screenRelevance,
                attentionSubject,
                task,
                card,
                spokenText,
                languageCode,
                autoCollapse,
                collapseAfterMs,
                keepVisibleWhileSpeaking,
                true
            );
        } catch (Exception error) {
            Log.w(
                "JaldiPresentation",
                "Structured presentation rejected: " + error.getMessage()
            );
            return fallback;
        }
    }

    private OverlayPresentation.TaskProgress parseTask(JSONObject task)
        throws Exception {
        // Pre-semantic presentation-v1 task objects remain valid on the wire,
        // but are intentionally ignored rather than converted into invented
        // execution progress.
        if (task.optInt("version", -1) != 1) return null;

        String taskId = requiredIdentifier(task, "taskId", "task");
        String itemId = task.has("itemId") && !task.isNull("itemId")
            ? requiredIdentifier(task, "itemId", "task_item")
            : null;
        String operationId = requiredIdentifier(
            task,
            "operationId",
            "operation"
        );
        String title = requiredText(task, "title", 120);
        String step = requiredText(task, "step", 200);
        String stage = requiredEnum(task, "stage", TASK_STAGES);
        int sequence = task.optInt("sequence", -1);
        if (sequence < 0) {
            throw new IllegalArgumentException("invalid task sequence");
        }

        int currentItem = 0;
        int totalItems = 0;
        JSONObject position = task.optJSONObject("position");
        if (position != null) {
            currentItem = position.optInt("current", -1);
            totalItems = position.has("total")
                ? position.optInt("total", -1)
                : 0;
            if (
                currentItem < 1
                    || totalItems < 0
                    || (totalItems > 0 && currentItem > totalItems)
            ) {
                throw new IllegalArgumentException("invalid task position");
            }
        }

        JSONObject cancellation = requiredObject(task, "cancellation");
        boolean cancellationAvailable = cancellation.getBoolean("available");
        String cancellationPolicy = requiredEnum(
            cancellation,
            "policy",
            CANCELLATION_POLICIES
        );
        if (
            cancellationAvailable
                != (
                    "cancel_now".equals(cancellationPolicy)
                        || "stop_after_current_step".equals(
                            cancellationPolicy
                        )
                )
        ) {
            throw new IllegalArgumentException(
                "invalid cancellation availability"
            );
        }
        boolean terminal = task.getBoolean("terminal");
        boolean terminalStage = "completed".equals(stage)
            || "failed".equals(stage)
            || "cancelled".equals(stage);
        if (terminal != terminalStage) {
            throw new IllegalArgumentException("invalid terminal progress");
        }
        return new OverlayPresentation.TaskProgress(
            1,
            taskId,
            itemId,
            operationId,
            title,
            step,
            stage,
            sequence,
            currentItem,
            totalItems,
            cancellationAvailable,
            cancellationPolicy,
            terminal
        );
    }

    private OverlayPresentation.Card parseCard(
        JSONObject card,
        String mode,
        String spokenText
    ) throws Exception {
        String type = requiredEnum(card, "type", CARD_TYPES);
        String tone = "compact_status".equals(type)
            ? card.optString("tone", OverlayPresentation.toneFromMode(mode))
            : OverlayPresentation.toneFromMode(mode);
        String headline = OverlayPresentation.headlineForMode(mode);
        String detail = spokenText;
        List<OverlayPresentation.ProductChoice> options =
            new ArrayList<OverlayPresentation.ProductChoice>();
        OverlayPresentation.ProductSelectionBinding selection = null;
        OverlayPresentation.CartSummary cartSummary = null;

        if ("product_choices".equals(type)) {
            JSONArray rawOptions = card.getJSONArray("options");
            if (rawOptions.length() < 1 || rawOptions.length() > 10) {
                throw new IllegalArgumentException("invalid product choices");
            }
            for (int index = 0; index < rawOptions.length(); index += 1) {
                options.add(parseProductChoice(
                    rawOptions.getJSONObject(index)
                ));
            }
            headline = options.size() == 1
                ? "ONE MATCH"
                : options.size() + " OPTIONS";
            if (card.has("selection") && !card.isNull("selection")) {
                selection = parseProductSelectionBinding(
                    requiredObject(card, "selection")
                );
                detail = "Tap an option, or say the name, size, or number.";
            } else {
                detail = "Say the name, size, or number.";
            }
        } else if ("provider_constraint".equals(type)) {
            detail = requiredText(card, "reason", 300);
        } else if ("receipt".equals(type)) {
            String reference = requiredText(
                card,
                "providerReference",
                200
            );
            headline = "ORDER VERIFIED";
            detail = "Reference " + reference;
        } else if ("ambiguous".equals(type)) {
            headline = "CHECK BLINKIT";
            detail = spokenText;
        } else if ("changed_terms".equals(type)) {
            JSONArray changes = card.getJSONArray("changes");
            if (changes.length() < 1) {
                throw new IllegalArgumentException("missing changes");
            }
            headline = "TERMS CHANGED";
            detail = joinChanges(changes);
        } else if ("checkout_review".equals(type)) {
            if (!card.has("ordered") || requiredBoolean(card, "ordered")) {
                throw new IllegalArgumentException("unsafe checkout state");
            }
            JSONObject checkout = requiredObject(card, "checkout");
            headline = "REVIEW · NOT ORDERED";
            detail = checkoutDetail(checkout);
        } else if ("cart_summary".equals(type)) {
            if (!card.has("ordered") || requiredBoolean(card, "ordered")) {
                throw new IllegalArgumentException(
                    "cart order state is not authoritative"
                );
            }
            JSONObject cart = requiredObject(card, "cart");
            if (
                !cart.has("verified")
                    || !requiredBoolean(cart, "verified")
            ) {
                throw new IllegalArgumentException(
                    "cart verification is not authoritative"
                );
            }
            cartSummary = parseCartSummary(cart);
            headline = "VERIFIED CART · NOT ORDERED";
            detail = cartDetail(cartSummary);
        }

        return new OverlayPresentation.Card(
            type,
            tone,
            headline,
            detail,
            options,
            selection,
            cartSummary
        );
    }

    private OverlayPresentation.ProductChoice parseProductChoice(
        JSONObject option
    ) throws Exception {
        return new OverlayPresentation.ProductChoice(
            requiredText(option, "offerId", 200),
            requiredText(option, "title", 300),
            requiredText(option, "spokenLabel", 300),
            optionalText(option, "packSize", 100),
            moneyText(option.optJSONObject("price")),
            safeImageUrl(optionalText(option, "imageUrl", 2048)),
            unitPriceText(option.optJSONObject("unitPrice")),
            structuredLabel(
                option,
                "availabilityConstraint",
                "availability",
                160
            ),
            structuredLabel(
                option,
                "recommendationLabel",
                "recommendation",
                100
            )
        );
    }

    private OverlayPresentation.ProductSelectionBinding
        parseProductSelectionBinding(JSONObject selection) throws Exception {
        int version = selection.optInt("version", -1);
        if (version != 1 && version != 2) {
            throw new IllegalArgumentException("invalid selection version");
        }
        String clientId = requiredText(selection, "clientId", 200);
        String taskId = requiredIdentifier(selection, "taskId", "task");
        int taskRevision = selection.optInt("taskRevision", -1);
        if (taskRevision < 0) {
            throw new IllegalArgumentException("invalid task revision");
        }
        String interactionId = version == 1
            ? requiredIdentifier(selection, "clarificationId", "clarification")
            : requiredText(selection, "interactionId", 200);
        String selectionId = requiredIdentifier(
            selection,
            "selectionId",
            "selection"
        );
        String expiresAt = requiredText(selection, "expiresAt", 64);
        long expiresAtEpochMs;
        try {
            expiresAtEpochMs = Instant.parse(expiresAt).toEpochMilli();
        } catch (Exception error) {
            throw new IllegalArgumentException("invalid selection expiry");
        }
        return new OverlayPresentation.ProductSelectionBinding(
            version,
            clientId,
            taskId,
            taskRevision,
            interactionId,
            selectionId,
            expiresAtEpochMs
        );
    }

    private OverlayPresentation.CartSummary parseCartSummary(JSONObject cart)
        throws Exception {
        JSONArray rawLines = cart.getJSONArray("lines");
        if (rawLines.length() < 1 || rawLines.length() > 30) {
            throw new IllegalArgumentException("invalid cart lines");
        }
        List<OverlayPresentation.CartLine> lines =
            new ArrayList<OverlayPresentation.CartLine>();
        for (int index = 0; index < rawLines.length(); index += 1) {
            JSONObject line = rawLines.getJSONObject(index);
            int quantity = requiredPositiveInt(line, "quantity", 100);
            lines.add(new OverlayPresentation.CartLine(
                requiredText(line, "productId", 200),
                requiredText(line, "name", 300),
                quantity,
                requiredMoneyText(line, "unitPrice"),
                requiredMoneyText(line, "lineTotal")
            ));
        }
        return new OverlayPresentation.CartSummary(
            lines,
            requiredMoneyText(cart, "subtotal"),
            requiredText(cart, "addressLabel", 100),
            true,
            false
        );
    }

    private static boolean requiredBoolean(
        JSONObject object,
        String field
    ) throws Exception {
        Object value = object.get(field);
        if (!(value instanceof Boolean)) {
            throw new IllegalArgumentException("invalid " + field);
        }
        return ((Boolean) value).booleanValue();
    }

    private String cartDetail(OverlayPresentation.CartSummary cart) {
        int count = cart.lines.size();
        return count
            + (count == 1 ? " item" : " items")
            + " · "
            + cart.subtotal
            + " · "
            + cart.addressLabel;
    }

    private String checkoutDetail(JSONObject checkout) {
        String total = moneyText(checkout.optJSONObject("total"));
        String address = optionalText(checkout, "addressLabel", 100);
        StringBuilder detail = new StringBuilder();
        if (total != null) detail.append(total);
        if (address != null) {
            if (detail.length() > 0) detail.append(" · ");
            detail.append(address);
        }
        if (detail.length() > 0) detail.append(" · ");
        detail.append("Cash on Delivery");
        return detail.toString();
    }

    private String moneyText(JSONObject money) {
        if (money == null || !"INR".equals(money.optString("currency"))) {
            return null;
        }
        Object rawAmount = money.opt("amount");
        if (!(rawAmount instanceof Number)) return null;
        double amount = ((Number) rawAmount).doubleValue();
        if (Double.isNaN(amount) || Double.isInfinite(amount) || amount < 0) {
            return null;
        }
        return amount == Math.rint(amount)
            ? "₹" + Long.toString(Math.round(amount))
            : "₹" + String.format(java.util.Locale.US, "%.2f", amount);
    }

    private String unitPriceText(JSONObject money) {
        String price = moneyText(money);
        if (price == null || money == null) return price;
        String unit = optionalText(money, "unit", 100);
        return unit == null ? price : price + " / " + unit;
    }

    private String requiredMoneyText(JSONObject parent, String name)
        throws Exception {
        String value = moneyText(parent.optJSONObject(name));
        if (value == null) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return value;
    }

    private int requiredPositiveInt(
        JSONObject parent,
        String name,
        int maximum
    ) {
        Object raw = parent.opt(name);
        if (!(raw instanceof Number)) {
            throw new IllegalArgumentException("invalid " + name);
        }
        double value = ((Number) raw).doubleValue();
        if (
            Double.isNaN(value)
                || Double.isInfinite(value)
                || value != Math.rint(value)
                || value < 1
                || value > maximum
        ) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return (int) value;
    }

    private String structuredLabel(
        JSONObject parent,
        String directName,
        String objectName,
        int maximum
    ) {
        Object directValue = parent.opt(directName);
        if (directValue instanceof String) {
            String direct = optionalText(parent, directName, maximum);
            if (direct != null) return direct;
        } else if (directValue instanceof JSONObject) {
            String label = optionalText(
                (JSONObject) directValue,
                "label",
                maximum
            );
            if (label != null) return label;
        }
        JSONObject structured = parent.optJSONObject(objectName);
        return structured == null
            ? null
            : optionalText(structured, "label", maximum);
    }

    private String safeImageUrl(String value) {
        if (value == null) return null;
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            int port = uri.getPort();
            if (
                !"https".equalsIgnoreCase(uri.getScheme())
                    || host == null
                    || uri.getRawUserInfo() != null
                    || (port != -1 && port != 443)
            ) {
                return null;
            }
            String normalizedHost = host.toLowerCase(Locale.US);
            if (
                !"blinkit.com".equals(normalizedHost)
                    && !normalizedHost.endsWith(".blinkit.com")
                    && !"grofers.com".equals(normalizedHost)
                    && !normalizedHost.endsWith(".grofers.com")
            ) {
                return null;
            }
            return uri.toASCIIString();
        } catch (Exception error) {
            return null;
        }
    }

    private String joinChanges(JSONArray changes) {
        StringBuilder text = new StringBuilder("Review ");
        int limit = Math.min(changes.length(), 3);
        for (int index = 0; index < limit; index += 1) {
            if (index > 0) text.append(index == limit - 1 ? " and " : ", ");
            text.append(changes.optString(index, "terms").replace('_', ' '));
        }
        return text.toString();
    }

    private JSONObject requiredObject(JSONObject parent, String name)
        throws Exception {
        JSONObject value = parent.optJSONObject(name);
        if (value == null) throw new IllegalArgumentException("missing " + name);
        return value;
    }

    private String requiredText(JSONObject parent, String name, int maximum)
        throws Exception {
        String value = optionalText(parent, name, maximum);
        if (value == null) throw new IllegalArgumentException("missing " + name);
        return value;
    }

    private String optionalText(JSONObject parent, String name, int maximum) {
        if (!parent.has(name) || parent.isNull(name)) return null;
        String value = parent.optString(name, "").trim();
        if (value.isEmpty() || value.length() > maximum) return null;
        return value;
    }

    private String requiredEnum(
        JSONObject parent,
        String name,
        Set<String> values
    ) throws Exception {
        String value = requiredText(parent, name, 100);
        if (!values.contains(value)) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return value;
    }

    private String requiredIdentifier(
        JSONObject parent,
        String name,
        String kind
    ) throws Exception {
        String value = requiredText(parent, name, 100);
        if (
            !value.matches(
                "^" + java.util.regex.Pattern.quote(kind)
                    + "_[A-Za-z0-9-]{8,80}$"
            )
        ) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return value;
    }

    private static Set<String> setOf(String... values) {
        return new HashSet<String>(Arrays.asList(values));
    }
}
