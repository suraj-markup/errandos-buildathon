package ai.errandos.overlay;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class NativeSourceContractTest {
    public static void main(String[] args) throws Exception {
        Path root = Paths.get(args[0]);
        String service = read(root, "OverlayService.java");
        String card = read(root, "OverlayCardView.java");
        String glyph = read(root, "CompanionGlyphView.java");
        String taskEvent = read(root, "RetainedTaskEvent.java");

        contains(card, "ACCESSIBILITY_LIVE_REGION_POLITE");
        contains(card, "setAccessibilityHeading(true)");
        contains(card, "row.setMinimumHeight(dp(48))");
        contains(card, "Tap to select, or speak your choice.");
        contains(card, "Tap once, or hold to answer by voice.");
        contains(card, "completionChoiceState.canTap()");
        contains(card, "public boolean performClick()");
        contains(service, "statusView.dragHandle()");
        contains(service, "handle.setOnClickListener");
        contains(service, "setExpanded(!expanded, true)");
        contains(service, "FLAG_NOT_FOCUSABLE");
        contains(service, "FLAG_NOT_TOUCH_MODAL");
        contains(service, "FLAG_NOT_TOUCHABLE");

        contains(service, "START_STICKY");
        contains(service, "restoreRecoveryState()");
        contains(service, "persistRecoveryState()");
        contains(service, "onConfigurationChanged");
        contains(service, "setExpanded(expanded && !devicePaused, false)");
        contains(service, "Intent.ACTION_SCREEN_OFF");
        contains(service, "Intent.ACTION_USER_PRESENT");
        contains(service, "ACTION_DEVICE_IDLE_MODE_CHANGED");
        contains(service, "pauseForLockedDevice()");
        contains(service, "/api/voice/cancel-response");
        contains(service, "/api/device/task/events");
        contains(service, "afterSequence=");
        contains(service, "task_events.sequence_gap");
        contains(service, "task_events.retention_reset");
        contains(service, "taskChecklistState.applyResetSnapshot(");
        contains(service, "persistTaskProjection()");
        contains(service, "if (!editor.commit())");
        contains(
            service,
            "snapshot.resetFinalCartPresentation"
        );
        contains(
            service,
            "task_events.embedded_snapshot_rejected"
        );
        before(
            service,
            "if (!consumeFastOperationIdentity(responsePayload))",
            "renderPresentation(presentation, true)"
        );
        before(
            service,
            "return persistTaskProjection(\n"
                + "                            taskChanged,\n"
                + "                            presentation,\n"
                + "                            finalCartPresentation",
            "performFeedback(feedbackPolicy.forEvent(event))"
        );
        contains(service, "consumeFastOperationIdentity(responsePayload)");
        contains(service, "/api/device/task/interaction");
        contains(service, "request.put(\"interactionId\"");
        contains(service, "request.put(\"source\", \"tap\")");
        contains(service, "new TextToSpeech(");
        contains(taskEvent, "speech_and_visual");
        contains(service, "stopAnnouncementSpeech();");
        contains(service, "cancelObsoleteRealtimeResponse()");
        contains(service, "realtime.response_interrupt code=");
        before(
            service,
            "releasePlayer();\n        stopAnnouncementSpeech();"
                + "\n        cancelObsoleteRealtimeResponse();",
            "recorder.start();"
        );

        contains(service, "recorder.getMaxAmplitude()");
        contains(service, "new Visualizer(audioSessionId)");
        contains(service, "onWaveFormDataCapture");
        contains(service, "MotionPolicy.waveformLevel");
        contains(service, "latestPresentation.keepVisibleWhileSpeaking");
        contains(glyph, "\"responding\".equals(mode)");
        contains(glyph, "Settings.Global.ANIMATOR_DURATION_SCALE");
        contains(glyph, "powerManager.isPowerSaveMode()");
    }

    private static String read(Path root, String file) throws Exception {
        return new String(
            Files.readAllBytes(root.resolve(file)),
            StandardCharsets.UTF_8
        );
    }

    private static void contains(String source, String expected) {
        if (!source.contains(expected)) {
            throw new AssertionError("Missing native contract: " + expected);
        }
    }

    private static void before(
        String source,
        String first,
        String second
    ) {
        int firstIndex = source.indexOf(first);
        int secondIndex = source.indexOf(second);
        if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
            throw new AssertionError(
                "Expected native contract order: " + first + " before " + second
            );
        }
    }
}
