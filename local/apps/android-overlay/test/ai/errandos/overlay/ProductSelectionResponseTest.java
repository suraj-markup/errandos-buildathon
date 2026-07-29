package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public final class ProductSelectionResponseTest {
    public static void main(String[] args) throws Exception {
        JSONObject fixture = new JSONObject(new String(
            Files.readAllBytes(Paths.get(args[0])),
            StandardCharsets.UTF_8
        ));
        JSONObject rawBinding = fixture.getJSONObject("binding");
        OverlayPresentation.ProductSelectionBinding binding =
            new OverlayPresentation.ProductSelectionBinding(
                rawBinding.getInt("version"),
                rawBinding.getString("clientId"),
                rawBinding.getString("taskId"),
                rawBinding.getInt("taskRevision"),
                rawBinding.getString("interactionId"),
                rawBinding.getString("selectionId"),
                rawBinding.getLong("expiresAt")
            );
        JSONArray cases = fixture.getJSONArray("cases");
        ProductSelectionState state = new ProductSelectionState();
        state.attach(binding, 1L);
        require(
            state.begin("offer_losing_choice", 1L) == binding,
            "fixture starts with one local contender"
        );
        for (int index = 0; index < cases.length(); index += 1) {
            JSONObject test = cases.getJSONObject(index);
            ProductSelectionResponse parsed =
                ProductSelectionResponse.parse(
                    test.getJSONObject("response"),
                    binding
                );
            require(parsed != null, test.getString("name") + " must parse");
            require(
                test.getString("expected").equals(
                    parsed.disposition.name()
                ),
                test.getString("name") + " disposition"
            );
            require(
                parsed.acceptedOnce(),
                test.getString("name") + " must not become generic failure"
            );
            require(
                parsed.winnerOfferId != null
                    && parsed.winnerTitle != null,
                test.getString("name") + " surfaces winner identity"
            );
            require(
                parsed.taskRevision == 8,
                test.getString("name") + " binds authoritative revision"
            );
            if (test.getString("name").contains("without legacy ok")) {
                require(
                    !test.getJSONObject("response").has("ok"),
                    "voice accepted fixture must exercise missing legacy ok"
                );
            }
        }

        ProductSelectionResponse conflict =
            ProductSelectionResponse.parse(
                cases.getJSONObject(1).getJSONObject("response"),
                binding
            );
        state.resolveWinner(
            conflict.winnerOfferId,
            ProductSelectionState.Status.DUPLICATE,
            conflict.winnerTitle + " already won."
        );
        String winner = state.selectedOfferId();
        state.resolveWinner(
            "offer_late_second_winner",
            ProductSelectionState.Status.ACCEPTED,
            "late"
        );
        require(
            winner.equals(state.selectedOfferId()),
            "late response cannot replace the authoritative winner"
        );

        JSONObject spoof = new JSONObject(
            cases.getJSONObject(0).getJSONObject("response").toString()
        );
        spoof.put("taskId", "task_other-12345678");
        require(
            ProductSelectionResponse.parse(spoof, binding) == null,
            "wrong-task winner must fail closed"
        );
        JSONObject staleSelection = new JSONObject(
            cases.getJSONObject(0).getJSONObject("response").toString()
        );
        staleSelection.put(
            "selectionId",
            "selection_stale-selection-12345678"
        );
        require(
            ProductSelectionResponse.parse(staleSelection, binding) == null,
            "wrong selection identity must fail closed"
        );
        JSONObject stale = new JSONObject(
            cases.getJSONObject(0).getJSONObject("response").toString()
        );
        stale.put("taskRevision", binding.taskRevision - 1);
        require(
            ProductSelectionResponse.parse(stale, binding) == null,
            "stale winner revision must fail closed"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
