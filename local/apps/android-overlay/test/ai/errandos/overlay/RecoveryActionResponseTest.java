package ai.errandos.overlay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class RecoveryActionResponseTest {
    public static void main(String[] args) throws Exception {
        JSONArray cases = new JSONArray(new String(
            Files.readAllBytes(Paths.get(args[0])),
            StandardCharsets.UTF_8
        ));
        for (int index = 0; index < cases.length(); index += 1) {
            JSONObject fixture = cases.getJSONObject(index);
            RecoveryActionResponse parsed = RecoveryActionResponse.parse(
                fixture.getJSONObject("response"),
                fixture.getInt("statusCode"),
                fixture.optBoolean("strict", false)
                    ? new RecoveryActionBinding(
                        2,
                        "recovery_12345678",
                        "operation_12345678",
                        "step:first",
                        "task_12345678",
                        7,
                        Long.MAX_VALUE
                    )
                    : null,
                fixture.optBoolean("strict", false)
                    ? fixture.getString("expectedActionId")
                    : null
            );
            require(
                fixture.getString("outcome").equals(parsed.outcome.name()),
                "fixture outcome " + index
            );
            if (fixture.has("guidance")) {
                require(
                    fixture.getString("guidance").equals(parsed.guidance),
                    "fixture guidance " + index
                );
            }
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
