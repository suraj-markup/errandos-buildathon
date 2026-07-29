package ai.errandos.overlay;

import android.Manifest;
import android.animation.ValueAnimator;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.media.audiofx.Visualizer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class OverlayService extends Service {
    private static final String TAG = "JaldiAIOverlay";
    public static final String ACTION_STATUS = StatusIngressPolicy.ACTION;
    private static final String CHANNEL_ID = "errandos_overlay";
    private static final int NOTIFICATION_ID = 73;
    private static final long HOLD_DELAY_MS = 260;
    private static final long AUTO_COLLAPSE_MS = 6500;
    private static final String OVERLAY_PREFERENCES = "overlay";
    private static final String RECOVERY_SNAPSHOT_KEY = "recovery_snapshot_v1";
    private static final String TASK_CURSOR_ID_KEY = "task_event_task_id_v2";
    private static final String TASK_CURSOR_SEQUENCE_KEY =
        "task_event_sequence_v2";
    private static final String TASK_CURSOR_REVISION_KEY =
        "task_event_revision_v2";
    private static final String TASK_CURSOR_OPERATION_KEY =
        "task_event_operation_v2";
    private static final String TASK_CURSOR_TERMINAL_KEY =
        "task_event_terminal_v2";
    private static final String LOCAL_SELECTION_KEY =
        "local_product_selection_v1";
    private static final String LOCAL_RECOVERY_ACTION_KEY =
        "local_recovery_action_v2";
    private static final String QUEUE_TASK_PROJECTION_KEY =
        "queue_task_projection_v2";
    private static final String QUEUE_PENDING_COMMAND_KEY =
        "queue_pending_command_v2";
    private static final String TASK_CHECKLIST_KEY =
        "task_checklist_projection_v1";
    private static final String VERIFIED_CART_KEY =
        "verified_cart_summary_v1";
    private static final String DEFERRED_SYNTHESIS_KEY =
        "deferred_synthesis_v1";
    private static final String VOICE_TURN_URL =
        "http://127.0.0.1:3100/api/voice/turn";
    private static final String CANCEL_RESPONSE_URL =
        "http://127.0.0.1:3100/api/voice/cancel-response";
    private static final String SYNTHESIS_URL =
        "http://127.0.0.1:3100/api/voice/synthesis";
    private static final String PRODUCT_SELECTION_URL =
        "http://127.0.0.1:3100/api/device/selection";
    private static final String TASK_EVENTS_URL =
        "http://127.0.0.1:3100/api/device/task/events";
    private static final String COMPLETION_INTERACTION_URL =
        "http://127.0.0.1:3100/api/device/task/interaction";
    private static final String RECOVERY_ACTION_URL =
        "http://127.0.0.1:3100/api/device/task/recovery";
    private static final String QUEUE_ACTION_URL =
        "http://127.0.0.1:3100/api/device/task/queue";

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService interruptExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService synthesisExecutor =
        Executors.newSingleThreadExecutor();
    private final ExecutorService eventExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService interactionExecutor =
        Executors.newSingleThreadExecutor();
    private final ExecutorService queueExecutor =
        Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OverlayPresentationParser presentationParser =
        new OverlayPresentationParser();
    private final SemanticProgressState semanticProgressState =
        new SemanticProgressState();
    private final TaskEventSubscriptionState taskEventState =
        new TaskEventSubscriptionState();
    private final InteractionFeedbackPolicy feedbackPolicy =
        new InteractionFeedbackPolicy();
    private final InteractionLatencyTracker interactionLatencyTracker =
        new InteractionLatencyTracker(
            new InteractionLatencyTracker.Clock() {
                @Override
                public long elapsedRealtime() {
                    return SystemClock.elapsedRealtime();
                }
            }
        );
    private final DeferredSynthesisState deferredSynthesisState =
        new DeferredSynthesisState();
    private TaskChecklistState taskChecklistState = new TaskChecklistState();
    private final RetainedTaskEventParser taskEventParser =
        new RetainedTaskEventParser(presentationParser);
    private WindowManager windowManager;
    private WindowManager.LayoutParams layoutParams;
    private WindowManager.LayoutParams attentionLayoutParams;
    private OverlayCardView statusView;
    private SpatialAttentionView attentionView;
    private BroadcastReceiver receiver;
    private BroadcastReceiver lifecycleReceiver;
    private MediaRecorder recorder;
    private MediaPlayer player;
    private Visualizer playbackVisualizer;
    private TextToSpeech announcementTts;
    private File recordingFile;
    private boolean recording;
    private volatile boolean uploading;
    private volatile boolean selectionSubmitting;
    private volatile boolean completionSubmitting;
    private volatile boolean recoverySubmitting;
    private volatile boolean queueSubmitting;
    private final QueueCommandState queueCommandState =
        new QueueCommandState();
    private QueueTaskProjection queueTaskProjection;
    private volatile InteractionLatencyTracker.Attempt
        activeVoiceChoiceLatency;
    private boolean speaking;
    private boolean announcementSpeaking;
    private boolean announcementTtsReady;
    private boolean destroyed;
    private String pendingAnnouncementText;
    private String pendingAnnouncementLanguageCode;
    private String pendingAnnouncementId;
    private boolean expanded;
    private boolean captureSuppressed;
    private boolean devicePaused;
    private boolean restoredExpanded;
    private int taskEventPollFailures;
    private boolean taskUpdatesDisconnected;
    private final Runnable deferredSynthesisPollRunnable = new Runnable() {
        @Override
        public void run() {
            startDeferredSynthesisPollIfDue();
        }
    };
    private SpatialAttentionCommand exactAttentionCommand;
    private String broadAttentionOverride;
    private ValueAnimator widthAnimator;
    private final Runnable attentionExpiryRunnable = new Runnable() {
        @Override
        public void run() {
            if (
                exactAttentionCommand != null
                    && exactAttentionCommand.expiresAtEpochMs
                        <= System.currentTimeMillis()
            ) {
                clearSpatialAttention();
            }
        }
    };
    private final Runnable audioLevelRunnable = new Runnable() {
        @Override
        public void run() {
            if (!recording || recorder == null || statusView == null) return;
            int maximumAmplitude = 0;
            try {
                maximumAmplitude = recorder.getMaxAmplitude();
            } catch (RuntimeException ignored) {
                // Recorder release races are harmless; the next state clears it.
            }
            float normalizedLevel = Math.min(
                1f,
                (float) Math.sqrt(maximumAmplitude / 32767f)
            );
            statusView.companionGlyph().setAudioLevel(normalizedLevel);
            mainHandler.postDelayed(this, 50L);
        }
    };
    private final Runnable taskEventPollRunnable = new Runnable() {
        @Override
        public void run() {
            if (
                destroyed
                    || taskEventState.taskId() == null
                    || taskEventState.terminal()
            ) {
                return;
            }
            eventExecutor.execute(new Runnable() {
                @Override
                public void run() {
                    pollTaskEvents();
                }
            });
        }
    };
    private String latestMessage = "Hold to speak";
    private OverlayPresentation latestPresentation =
        OverlayPresentation.legacy("Hold to speak", "ready");
    private OverlayPresentation lastAuthoritativePresentation =
        latestPresentation;
    private OverlayPresentation.CartSummary retainedCartSummary;
    private String statusIngressCapability;
    private final Runnable collapseRunnable = new Runnable() {
        @Override
        public void run() {
            if (
                !recording
                    && !uploading
                    && !selectionSubmitting
                    && !completionSubmitting
                    && !queueSubmitting
                    && !speaking
                    && !announcementSpeaking
            ) {
                setExpanded(false, true);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        restoreRecoveryState();
        restoreTaskEventCursor();
        restoreTaskChecklist();
        restoreQueueState();
        restoreDeferredSynthesisState();
        initializeAnnouncementSpeech();
        KeyguardManager keyguardManager =
            (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        devicePaused = keyguardManager != null
            && keyguardManager.isDeviceLocked();
        taskChecklistState.setPaused(
            devicePaused,
            devicePaused ? "Phone locked. Task paused." : null
        );
        Notification notification = createNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    | ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        createOverlay();
        registerStatusReceiver();
        registerLifecycleReceiver();
        scheduleCollapseIfAllowed();
        scheduleTaskEventPoll(0L);
        scheduleDeferredSynthesisPoll();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        persistRecoveryState();
        persistTaskProjection();
        destroyed = true;
        if (receiver != null) unregisterReceiver(receiver);
        if (lifecycleReceiver != null) unregisterReceiver(lifecycleReceiver);
        releaseRecorder();
        releasePlayer();
        networkExecutor.shutdownNow();
        interruptExecutor.shutdownNow();
        synthesisExecutor.shutdownNow();
        eventExecutor.shutdownNow();
        interactionExecutor.shutdownNow();
        queueExecutor.shutdownNow();
        shutdownAnnouncementSpeech();
        mainHandler.removeCallbacks(deferredSynthesisPollRunnable);
        mainHandler.removeCallbacksAndMessages(null);
        if (widthAnimator != null) widthAnimator.cancel();
        if (windowManager != null && statusView != null) {
            statusView.companionGlyph().release();
            windowManager.removeView(statusView);
        }
        if (attentionView != null) {
            attentionView.release();
            if (windowManager != null) windowManager.removeView(attentionView);
        }
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        clearSpatialAttention();
        if (statusView != null) {
            statusView.companionGlyph().refreshMotionPreference();
        }
        if (layoutParams != null && statusView != null) {
            setExpanded(expanded && !devicePaused, false);
        }
    }

    private Notification createNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "JaldiAI overlay",
            NotificationManager.IMPORTANCE_LOW
        );
        manager.createNotificationChannel(channel);

        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("JaldiAI is ready")
            .setContentText("Hold the floating button to speak")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(pending)
            .setOngoing(true)
            .build();
    }

    private void createOverlay() {
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        attentionView = new SpatialAttentionView(this);
        attentionLayoutParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );
        attentionLayoutParams.gravity = Gravity.TOP | Gravity.START;
        windowManager.addView(attentionView, attentionLayoutParams);
        attentionView.hide();

        statusView = new OverlayCardView(this);
        statusView.setOnProductChoiceListener(
            new OverlayCardView.OnProductChoiceListener() {
                @Override
                public void onProductChoice(
                    OverlayPresentation.ProductChoice option
                ) {
                    submitProductChoice(option);
                }
            }
        );
        statusView.setOnCompletionChoiceListener(
            new OverlayCardView.OnCompletionChoiceListener() {
                @Override
                public void onCompletionChoice(
                    OverlayPresentation.CompletionChoice choice
                ) {
                    submitCompletionChoice(choice);
                }
            }
        );
        statusView.setOnRecoveryActionListener(
            new OverlayCardView.OnRecoveryActionListener() {
                @Override
                public void onRecoveryAction(
                    CompanionIssueV2.RecoveryAction action
                ) {
                    submitRecoveryAction(action);
                }
            }
        );
        statusView.setOnQueueActionListener(
            new OverlayCardView.OnQueueActionListener() {
                @Override
                public void onQueueAction(QueueActionPolicy.Action action) {
                    submitQueueAction(action);
                }
            }
        );
        statusView.setTaskChecklist(taskChecklistState.snapshot());
        statusView.setQueueTaskProjection(queueTaskProjection);
        statusView.setRetainedCartSummary(retainedCartSummary);

        layoutParams = new WindowManager.LayoutParams(
            dp(OverlayCardView.COMPANION_SIZE_DP),
            dp(OverlayCardView.COMPANION_SIZE_DP),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );
        layoutParams.gravity = Gravity.TOP | Gravity.START;
        int savedX = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getInt("x", -1);
        int savedY = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getInt("y", dp(76));
        layoutParams.x = savedX >= 0
            ? savedX
            : getResources().getDisplayMetrics().widthPixels - dp(80);
        layoutParams.y = savedY;

        installTouchBehavior();
        statusView.render(
            latestPresentation,
            restoredExpanded && !devicePaused
        );
        if (devicePaused) {
            statusView.companionGlyph().setMode("paused", "attention");
        } else if (taskUpdatesDisconnected) {
            statusView.companionGlyph().setMode(
                "disconnected",
                "attention"
            );
        }
        restoreLocalProductSelection();
        restoreLocalRecoveryAction();
        restorePendingQueueCommand();
        windowManager.addView(statusView, layoutParams);
        if (restoredExpanded && !devicePaused) {
            setExpanded(true, false);
        }
    }

    private void installTouchBehavior() {
        final View handle = statusView.dragHandle();
        handle.setFocusable(true);
        handle.setContentDescription(
            "JaldiAI companion. Tap to open task. Hold to speak. Drag to move."
        );
        handle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                setExpanded(!expanded, true);
            }
        });
        handle.setOnTouchListener(new View.OnTouchListener() {
            private float downRawX;
            private float downRawY;
            private int downWindowX;
            private int downWindowY;
            private boolean dragging;
            private boolean holdStarted;
            private final int touchSlop = ViewConfiguration
                .get(OverlayService.this)
                .getScaledTouchSlop();
            private final Runnable beginHold = new Runnable() {
                @Override
                public void run() {
                    if (dragging) return;
                    holdStarted = true;
                    Log.i(
                        TAG,
                        "hold.begin paused=" + devicePaused
                            + " recording=" + recording
                            + " uploading=" + uploading
                    );
                    if (uploading) {
                        setStatus("Still working on your last request.", "working");
                    } else if (!recording) {
                        startRecording();
                    }
                }
            };

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                if (event.getAction() == MotionEvent.ACTION_DOWN) {
                    Log.i(TAG, "hold.down");
                    downRawX = event.getRawX();
                    downRawY = event.getRawY();
                    downWindowX = layoutParams.x;
                    downWindowY = layoutParams.y;
                    dragging = false;
                    holdStarted = false;
                    view.setPressed(true);
                    mainHandler.postDelayed(beginHold, HOLD_DELAY_MS);
                    return true;
                }
                if (event.getAction() == MotionEvent.ACTION_MOVE) {
                    float deltaX = event.getRawX() - downRawX;
                    float deltaY = event.getRawY() - downRawY;
                    if (
                        !holdStarted
                            && !dragging
                            && Math.hypot(deltaX, deltaY) > touchSlop
                    ) {
                        dragging = true;
                        mainHandler.removeCallbacks(beginHold);
                        if (expanded) setExpanded(false, false);
                        downWindowX = layoutParams.x;
                        downWindowY = layoutParams.y;
                        downRawX = event.getRawX();
                        downRawY = event.getRawY();
                        deltaX = 0;
                        deltaY = 0;
                    }
                    if (dragging) {
                        layoutParams.x = clampX(downWindowX + Math.round(deltaX));
                        layoutParams.y = clampY(downWindowY + Math.round(deltaY));
                        windowManager.updateViewLayout(statusView, layoutParams);
                    }
                    return true;
                }
                if (
                    event.getAction() == MotionEvent.ACTION_UP
                        || event.getAction() == MotionEvent.ACTION_CANCEL
                ) {
                    Log.i(
                        TAG,
                        "hold.end action=" + event.getAction()
                            + " holdStarted=" + holdStarted
                            + " recording=" + recording
                    );
                    mainHandler.removeCallbacks(beginHold);
                    view.setPressed(false);
                    if (recording) stopRecording();
                    else if (dragging) savePosition();
                    else if (
                        event.getAction() == MotionEvent.ACTION_UP
                            && !holdStarted
                    ) {
                        view.performClick();
                    }
                    return true;
                }
                return true;
            }
        });
    }

    private void startRecording() {
        final long choiceStartedAt = SystemClock.elapsedRealtime();
        if (devicePaused) {
            if (canResumeInteractiveDevice()) {
                Log.i(TAG, "lifecycle.self_recovered_on_hold");
                devicePaused = false;
            } else {
                Log.w(TAG, "recording.blocked device_locked_or_not_interactive");
                setStatus(
                    "Unlock the phone, then hold again to speak.",
                    "error"
                );
                return;
            }
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "recording.blocked microphone_permission_missing");
            setStatus("Open JaldiAI once to allow microphone access.", "error");
            Intent permission = new Intent(this, MainActivity.class);
            permission.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(permission);
            return;
        }

        abandonDeferredSynthesisPlayback();
        releasePlayer();
        stopAnnouncementSpeech();
        cancelObsoleteRealtimeResponse();
        recordingFile = new File(getCacheDir(), "voice-command.m4a");
        final InteractionLatencyTracker.Attempt voiceChoiceLatency =
            beginVoiceChoiceLatency(choiceStartedAt);
        try {
            recorder = Build.VERSION.SDK_INT >= 31
                ? new MediaRecorder(this)
                : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(16000);
            recorder.setAudioEncodingBitRate(64000);
            recorder.setOutputFile(recordingFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            recording = true;
            Log.i(TAG, "recording.started");
            performFeedback(feedbackPolicy.forListening(true));
            setStatus("Listening while you hold.", "listening");
            activeVoiceChoiceLatency = voiceChoiceLatency;
            if (voiceChoiceLatency != null) {
                logInteractionLatency(
                    voiceChoiceLatency.localAcknowledged("optimistic_ack")
                );
            }
            mainHandler.removeCallbacks(audioLevelRunnable);
            mainHandler.post(audioLevelRunnable);
        } catch (Exception error) {
            Log.e(TAG, "recording.start_failed", error);
            if (voiceChoiceLatency != null) {
                logInteractionLatency(
                    voiceChoiceLatency.localAcknowledged(
                        "microphone_start_failed"
                    )
                );
                logInteractionLatency(
                    voiceChoiceLatency.serverOutcome("cancelled")
                );
            }
            releaseRecorder();
            setStatus("I couldn't start the microphone.", "error");
        }
    }

    private void cancelObsoleteRealtimeResponse() {
        interruptExecutor.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(
                        CANCEL_RESPONSE_URL
                    ).openConnection();
                    connection.setConnectTimeout(1500);
                    connection.setReadTimeout(1500);
                    connection.setRequestMethod("POST");
                    connection.setDoOutput(true);
                    connection.setRequestProperty(
                        "Content-Type",
                        "application/json"
                    );
                    byte[] body = (
                        "{\"clientId\":\"pixel-overlay\"}"
                    ).getBytes(StandardCharsets.UTF_8);
                    connection.getOutputStream().write(body);
                    int responseCode = connection.getResponseCode();
                    Log.i(
                        TAG,
                        "realtime.response_interrupt code=" + responseCode
                    );
                } catch (Exception error) {
                    Log.w(
                        TAG,
                        "realtime.response_interrupt_failed",
                        error
                    );
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        });
    }

    private void stopRecording() {
        try {
            recorder.stop();
        } catch (RuntimeException error) {
            Log.w(TAG, "recording.stop_failed_or_too_short", error);
            finishActiveVoiceChoiceLatency("cancelled");
            releaseRecorder();
            setStatus("I didn't hear enough audio. Hold and try again.", "error");
            return;
        }
        Log.i(TAG, "recording.stopped upload_starting");
        releaseRecorder();
        uploading = true;
        setStatus("Understanding your request…", "understanding");
        networkExecutor.execute(new Runnable() {
            @Override
            public void run() {
                uploadVoiceTurn();
            }
        });
    }

    private void uploadVoiceTurn() {
        uploadTurn();
    }

    private void submitProductChoice(
        final OverlayPresentation.ProductChoice option
    ) {
        if (option == null) return;
        final long startedAt = SystemClock.elapsedRealtime();
        final OverlayPresentation.ProductSelectionBinding currentBinding =
            statusView.currentProductSelectionBinding();
        final OverlayPresentation.ProductSelectionBinding binding =
            statusView.beginProductChoiceSubmission(option);
        final OverlayPresentation.ProductSelectionBinding metricBinding =
            binding == null ? currentBinding : binding;
        final InteractionLatencyTracker.Attempt latency =
            metricBinding == null
                ? null
                : interactionLatencyTracker.start(
                    InteractionLatencyTracker.Source.TAP,
                    metricBinding.taskId,
                    metricBinding.interactionId,
                    metricBinding.selectionId,
                    startedAt
                );
        if (binding == null) {
            if (latency != null) {
                logInteractionLatency(
                    latency.localAcknowledged(
                        productLocalRejectionOutcome(
                            statusView.currentProductSelectionStatus()
                        )
                    )
                );
            }
            return;
        }
        persistLocalProductSelection(binding, option);
        selectionSubmitting = true;
        performFeedback(feedbackPolicy.forTap(true));
        logInteractionLatency(
            latency == null
                ? null
                : latency.localAcknowledged("optimistic_ack")
        );
        networkExecutor.execute(new Runnable() {
            @Override
            public void run() {
                submitStructuredProductChoice(option, binding, latency);
            }
        });
    }

    private void submitStructuredProductChoice(
        OverlayPresentation.ProductChoice option,
        OverlayPresentation.ProductSelectionBinding binding,
        InteractionLatencyTracker.Attempt latency
    ) {
        HttpURLConnection connection = null;
        try {
            JSONObject request = new JSONObject();
            request.put("version", binding.version);
            request.put("clientId", binding.clientId);
            request.put("taskId", binding.taskId);
            request.put("taskRevision", binding.taskRevision);
            request.put("interactionId", binding.interactionId);
            request.put("selectionId", binding.selectionId);
            request.put("offerId", option.offerId);
            request.put("source", "tap");

            connection = (HttpURLConnection) new URL(
                PRODUCT_SELECTION_URL
            ).openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty(
                "Content-Type",
                "application/json; charset=utf-8"
            );
            byte[] payload = request.toString().getBytes(
                StandardCharsets.UTF_8
            );
            connection.setFixedLengthStreamingMode(payload.length);
            java.io.OutputStream output = connection.getOutputStream();
            output.write(payload);
            output.flush();
            output.close();

            int responseCode = connection.getResponseCode();
            InputStream responseStream = responseCode >= 200
                    && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            JSONObject result = new JSONObject(readAll(responseStream));
            final ProductSelectionResponse outcome =
                ProductSelectionResponse.parse(result, binding);
            final boolean transportAccepted =
                responseCode >= 200 && responseCode < 300;
            if (
                outcome == null
                    || (
                        !transportAccepted
                            && outcome.disposition
                                != ProductSelectionResponse
                                    .Disposition.CONFLICT
                    )
            ) {
                throw new IllegalArgumentException(
                    "invalid selection acknowledgement"
                );
            }
            logInteractionLatency(
                latency == null
                    ? null
                    : latency.serverOutcome(
                        productServerOutcome(outcome)
                    )
            );
            statusView.post(new Runnable() {
                @Override
                public void run() {
                    applyProductSelectionOutcome(outcome);
                }
            });
        } catch (final Exception error) {
            logInteractionLatency(
                latency == null
                    ? null
                    : latency.serverOutcome("network_error")
            );
            statusView.post(new Runnable() {
                @Override
                public void run() {
                    statusView.completeProductChoiceSubmission(
                        ProductSelectionState.Status.REJECTED,
                        "Couldn’t submit. Tap again or speak your choice.",
                        true
                    );
                }
            });
        } finally {
            selectionSubmitting = false;
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    scheduleCollapseIfAllowed();
                }
            });
            if (connection != null) connection.disconnect();
        }
    }

    private boolean applyProductSelectionOutcome(
        ProductSelectionResponse outcome
    ) {
        if (outcome != null && outcome.acceptedOnce()) {
            ProductSelectionState.Status status =
                outcome.disposition
                        == ProductSelectionResponse.Disposition.ACCEPTED
                    ? ProductSelectionState.Status.ACCEPTED
                    : ProductSelectionState.Status.DUPLICATE;
            String message =
                outcome.disposition
                        == ProductSelectionResponse.Disposition.CONFLICT
                    ? "Another response already selected "
                        + outcome.winnerTitle
                        + "."
                    : outcome.disposition
                            == ProductSelectionResponse
                                .Disposition.DUPLICATE
                        ? outcome.winnerTitle
                            + " was already selected."
                        : outcome.winnerTitle + " selected. Adding to cart…";
            if (
                !updateLocalProductSelectionStatus(
                    status,
                    message,
                    outcome.winnerOfferId
                )
            ) {
                Log.e(TAG, "selection.accepted_persist_failed");
                scheduleTaskEventPoll(0L);
                return false;
            }
            statusView.resolveProductChoiceWinner(
                outcome.winnerOfferId,
                status,
                message
            );
            scheduleTaskEventPoll(0L);
            return true;
        }
        String reason = outcome == null ? null : outcome.reason;
        if (
            "expired".equals(reason)
                || "stale_clarification".equals(reason)
                || "stale_task_revision".equals(reason)
                || "unknown_clarification".equals(reason)
                || "unknown_offer".equals(reason)
                || "unknown_task".equals(reason)
                || "already_resolved".equals(reason)
                || "cancelled".equals(reason)
                || "client_task_mismatch".equals(reason)
        ) {
            statusView.completeProductChoiceSubmission(
                ProductSelectionState.Status.EXPIRED,
                "This choice is no longer current. Speak your choice again.",
                false
            );
            clearLocalProductSelection();
            return true;
        }
        statusView.completeProductChoiceSubmission(
            ProductSelectionState.Status.REJECTED,
            "Couldn’t submit. Tap again or speak your choice.",
            true
        );
        updateLocalProductSelectionStatus(
            ProductSelectionState.Status.REJECTED,
            "Couldn’t submit. Tap the same choice again or speak.",
            null
        );
        return true;
    }

    private void submitQueueAction(final QueueActionPolicy.Action action) {
        String pending = queueCommandState.pendingPayload();
        if (pending != null && !queueSubmitting) {
            submitQueuePayload(pending);
            return;
        }
        if (
            action == null
                || queueSubmitting
                || queueTaskProjection == null
                || !QueueActionPolicy.enabled(
                    queueTaskProjection,
                    action,
                    false
                )
        ) {
            return;
        }
        if (action.kind == QueueActionPolicy.Kind.REFINE) {
            showQueueRefinementDialog(action);
            return;
        }
        enqueueQueueAction(action, null);
    }

    private void showQueueRefinementDialog(
        final QueueActionPolicy.Action action
    ) {
        final android.widget.EditText input =
            new android.widget.EditText(this);
        input.setSingleLine(false);
        input.setMaxLines(3);
        input.setHint("Describe the item, size, or quantity");
        android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(
            new android.view.ContextThemeWrapper(
                this,
                android.R.style.Theme_Material_Dialog_Alert
            )
        )
            .setTitle("Refine future item")
            .setView(input)
            .setNegativeButton("Cancel", null)
            .setPositiveButton(
                "Update",
                new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(
                        android.content.DialogInterface dialog,
                        int which
                    ) {
                        enqueueQueueAction(
                            action,
                            input.getText().toString()
                        );
                    }
                }
            )
            .create();
        if (dialog.getWindow() != null) {
            dialog.getWindow().setType(
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            );
        }
        dialog.show();
    }

    private void enqueueQueueAction(
        final QueueActionPolicy.Action action,
        final String refinement
    ) {
        final JSONObject request;
        try {
            request = QueueActionPolicy.request(
                queueTaskProjection,
                action,
                refinement
            );
        } catch (Exception error) {
            if (statusView != null) {
                statusView.setQueueSubmissionState(
                    false,
                    "Enter a clear item refinement."
                );
            }
            return;
        }
        submitQueuePayload(request.toString());
    }

    private void submitQueuePayload(final String payload) {
        if (payload == null || payload.isEmpty() || queueSubmitting) return;
        queueSubmitting = true;
        queueCommandState.begin(payload);
        getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
            .edit()
            .putString(QUEUE_PENDING_COMMAND_KEY, payload)
            .commit();
        if (statusView != null) {
            statusView.setQueueSubmissionState(
                true,
                "Updating task list…"
            );
        }
        queueExecutor.execute(new Runnable() {
            @Override
            public void run() {
                postQueuePayload(payload);
            }
        });
    }

    private void postQueuePayload(String payload) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(
                QUEUE_ACTION_URL
            ).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty(
                "Content-Type",
                "application/json; charset=utf-8"
            );
            byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            java.io.OutputStream output = connection.getOutputStream();
            output.write(bytes);
            output.flush();
            output.close();
            int responseCode = connection.getResponseCode();
            InputStream stream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            JSONObject response = new JSONObject(readAll(stream));
            final String outcomeName = response.optString("outcome", "");
            final QueueCommandState.Outcome outcome =
                queueCommandState.apply(responseCode, response);
            if (!outcome.retryable) {
                getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                    .edit()
                    .remove(QUEUE_PENDING_COMMAND_KEY)
                    .commit();
            }
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    queueSubmitting = false;
                    if (
                        outcome.status == QueueCommandState.Status.ACCEPTED
                            || outcome.status
                                == QueueCommandState.Status.DUPLICATE
                    ) {
                        if (queueTaskProjection != null) {
                            queueTaskProjection =
                                queueTaskProjection
                                    .awaitingAuthoritativeRefresh(
                                        outcome.taskRevision,
                                        outcomeName
                                    );
                            statusView.setQueueTaskProjection(
                                queueTaskProjection
                            );
                        }
                        scheduleTaskEventPoll(0L);
                    } else if (
                        outcome.status == QueueCommandState.Status.STALE
                            || outcome.status
                                == QueueCommandState.Status.CONFLICT
                    ) {
                        if (
                            queueTaskProjection != null
                                && outcome.taskRevision >= 0
                        ) {
                            queueTaskProjection =
                                queueTaskProjection
                                    .awaitingAuthoritativeRefresh(
                                        outcome.taskRevision,
                                        ""
                                    );
                            statusView.setQueueTaskProjection(
                                queueTaskProjection
                            );
                        }
                        scheduleTaskEventPoll(0L);
                    }
                    statusView.setQueueSubmissionState(
                        false,
                        outcome.message
                    );
                    scheduleCollapseIfAllowed();
                }
            });
        } catch (Exception error) {
            final QueueCommandState.Outcome outcome =
                queueCommandState.networkError();
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    queueSubmitting = false;
                    if (statusView != null) {
                        statusView.setQueueSubmissionState(
                            false,
                            outcome.message
                        );
                    }
                    scheduleCollapseIfAllowed();
                }
            });
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void submitCompletionChoice(
        final OverlayPresentation.CompletionChoice choice
    ) {
        if (choice == null || completionSubmitting) return;
        final long startedAt = SystemClock.elapsedRealtime();
        final OverlayPresentation.CompletionInteraction currentInteraction =
            statusView.currentCompletionInteraction();
        final OverlayPresentation.CompletionInteraction interaction =
            statusView.beginCompletionChoiceSubmission(choice);
        final OverlayPresentation.CompletionInteraction metricInteraction =
            interaction == null ? currentInteraction : interaction;
        final InteractionLatencyTracker.Attempt latency =
            metricInteraction == null
                ? null
                : interactionLatencyTracker.start(
                    InteractionLatencyTracker.Source.TAP,
                    metricInteraction.taskId,
                    metricInteraction.interactionId,
                    choice.choiceId,
                    startedAt
                );
        if (interaction == null) {
            if (latency != null) {
                logInteractionLatency(
                    latency.localAcknowledged(
                        completionLocalRejectionOutcome(
                            statusView.currentCompletionChoiceStatus()
                        )
                    )
                );
            }
            return;
        }
        completionSubmitting = true;
        performFeedback(feedbackPolicy.forTap(true));
        logInteractionLatency(
            latency == null
                ? null
                : latency.localAcknowledged("optimistic_ack")
        );
        interactionExecutor.execute(new Runnable() {
            @Override
            public void run() {
                submitStructuredCompletionChoice(
                    choice,
                    interaction,
                    latency
                );
            }
        });
    }

    private void submitStructuredCompletionChoice(
        OverlayPresentation.CompletionChoice choice,
        OverlayPresentation.CompletionInteraction interaction,
        InteractionLatencyTracker.Attempt latency
    ) {
        HttpURLConnection connection = null;
        try {
            JSONObject request = new JSONObject();
            request.put("version", interaction.version);
            request.put("clientId", "pixel-overlay");
            request.put("taskId", interaction.taskId);
            request.put("taskRevision", interaction.taskRevision);
            request.put("interactionId", interaction.interactionId);
            request.put("choiceId", choice.choiceId);
            request.put("source", "tap");
            connection = (HttpURLConnection) new URL(
                COMPLETION_INTERACTION_URL
            ).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty(
                "Content-Type",
                "application/json; charset=utf-8"
            );
            byte[] payload = request.toString().getBytes(
                StandardCharsets.UTF_8
            );
            connection.setFixedLengthStreamingMode(payload.length);
            java.io.OutputStream output = connection.getOutputStream();
            output.write(payload);
            output.flush();
            output.close();

            int responseCode = connection.getResponseCode();
            InputStream stream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            JSONObject response = new JSONObject(readAll(stream));
            final String acknowledgement = response.optString(
                "acknowledgement",
                response.optBoolean("accepted", false)
                    ? "accepted"
                    : "rejected"
            );
            final String reason = response.optString(
                "reason",
                responseCode >= 500 ? "server_unavailable" : "rejected"
            );
            logInteractionLatency(
                latency == null
                    ? null
                    : latency.serverOutcome(
                        completionServerOutcome(
                            acknowledgement,
                            reason
                        )
                    )
            );
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    applyCompletionChoiceOutcome(acknowledgement, reason);
                }
            });
        } catch (final Exception error) {
            logInteractionLatency(
                latency == null
                    ? null
                    : latency.serverOutcome("network_error")
            );
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    statusView.completeCompletionChoiceSubmission(
                        CompletionChoiceState.Status.REJECTED,
                        "Couldn’t submit. Tap again or hold to speak.",
                        true
                    );
                }
            });
        } finally {
            if (connection != null) connection.disconnect();
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    completionSubmitting = false;
                    scheduleCollapseIfAllowed();
                }
            });
        }
    }

    private void applyCompletionChoiceOutcome(
        String acknowledgement,
        String reason
    ) {
        if ("accepted".equals(acknowledgement)) {
            statusView.completeCompletionChoiceSubmission(
                CompletionChoiceState.Status.ACCEPTED,
                "Choice accepted. Progress will update here.",
                false
            );
            scheduleTaskEventPoll(0L);
            return;
        }
        if ("duplicate".equals(acknowledgement)) {
            statusView.completeCompletionChoiceSubmission(
                CompletionChoiceState.Status.DUPLICATE,
                "This interaction was already answered.",
                false
            );
            scheduleTaskEventPoll(0L);
            return;
        }
        if (
            "expired".equals(reason)
                || "stale_revision".equals(reason)
                || "already_resolved".equals(reason)
                || "unknown_interaction".equals(reason)
                || "cancelled".equals(reason)
        ) {
            statusView.completeCompletionChoiceSubmission(
                CompletionChoiceState.Status.EXPIRED,
                "This choice is no longer current. Hold to speak.",
                false
            );
            scheduleTaskEventPoll(0L);
            return;
        }
        statusView.completeCompletionChoiceSubmission(
            CompletionChoiceState.Status.REJECTED,
            "Couldn’t submit. Tap again or hold to speak.",
            true
        );
    }

    private void submitRecoveryAction(
        final CompanionIssueV2.RecoveryAction action
    ) {
        if (action == null || recoverySubmitting) return;
        final RecoveryActionBinding binding =
            statusView.beginRecoveryActionSubmission(action);
        if (binding == null) return;
        recoverySubmitting = true;
        persistLocalRecoveryAction(binding, action);
        performFeedback(feedbackPolicy.forTap(true));
        interactionExecutor.execute(new Runnable() {
            @Override
            public void run() {
                postRecoveryAction(action, binding);
            }
        });
    }

    private void postRecoveryAction(
        CompanionIssueV2.RecoveryAction action,
        RecoveryActionBinding binding
    ) {
        HttpURLConnection connection = null;
        try {
            JSONObject request = new JSONObject();
            request.put("version", binding.version);
            request.put("actionId", action.actionId);
            request.put("clientId", "pixel-overlay");
            request.put("interactionId", binding.interactionId);
            request.put("operationId", binding.operationId);
            request.put("source", "tap");
            request.put("stepId", binding.stepId);
            request.put("taskId", binding.taskId);
            request.put("taskRevision", binding.taskRevision);
            connection = (HttpURLConnection) new URL(
                RECOVERY_ACTION_URL
            ).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty(
                "Content-Type",
                "application/json; charset=utf-8"
            );
            byte[] payload = request.toString().getBytes(
                StandardCharsets.UTF_8
            );
            connection.setFixedLengthStreamingMode(payload.length);
            java.io.OutputStream output = connection.getOutputStream();
            output.write(payload);
            output.flush();
            output.close();
            int responseCode = connection.getResponseCode();
            InputStream stream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            final RecoveryActionResponse response =
                RecoveryActionResponse.parse(
                    new JSONObject(readAll(stream)),
                    responseCode,
                    binding,
                    action.actionId
                );
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    applyRecoveryActionOutcome(response);
                }
            });
        } catch (Exception error) {
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    completeRecoveryAction(
                        RecoveryActionState.Status.REJECTED,
                        "Server not reachable. Tap again when connected.",
                        true
                    );
                }
            });
        } finally {
            if (connection != null) connection.disconnect();
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    recoverySubmitting = false;
                    scheduleCollapseIfAllowed();
                }
            });
        }
    }

    private void applyRecoveryActionOutcome(
        RecoveryActionResponse response
    ) {
        if (response.outcome == RecoveryActionResponse.Outcome.ACCEPTED) {
            completeRecoveryAction(
                RecoveryActionState.Status.ACCEPTED,
                response.guidance == null
                    ? "Recovery accepted. Checking current task state…"
                    : response.guidance,
                false
            );
            scheduleTaskEventPoll(0L);
            return;
        }
        if (response.outcome == RecoveryActionResponse.Outcome.DUPLICATE) {
            completeRecoveryAction(
                RecoveryActionState.Status.DUPLICATE,
                "This recovery action was already accepted.",
                false
            );
            scheduleTaskEventPoll(0L);
            return;
        }
        if (response.outcome == RecoveryActionResponse.Outcome.STALE) {
            completeRecoveryAction(
                RecoveryActionState.Status.EXPIRED,
                "This recovery action is no longer current.",
                false
            );
            scheduleTaskEventPoll(0L);
            return;
        }
        completeRecoveryAction(
            RecoveryActionState.Status.REJECTED,
            "Recovery was not accepted. Refresh task status and try again.",
            true
        );
    }

    private void completeRecoveryAction(
        RecoveryActionState.Status status,
        String message,
        boolean retryable
    ) {
        statusView.completeRecoveryActionSubmission(
            status,
            message,
            retryable
        );
        updateLocalRecoveryAction(status, message);
    }

    private boolean consumeFastOperationIdentity(JSONObject response) {
        if (response == null) return true;
        JSONObject embeddedSnapshot = response.optJSONObject("taskEvents");
        if (embeddedSnapshot != null) {
            final TaskEventSubscriptionState.Checkpoint cursorBefore =
                taskEventState.checkpoint();
            final String checklistBefore = taskChecklistState.encode();
            try {
                RetainedTaskEventParser.Snapshot snapshot =
                    taskEventParser.parseSnapshot(embeddedSnapshot);
                taskEventState.bind(snapshot.taskId, snapshot.afterSequence);
                if (!applyTaskEventSnapshot(snapshot)) {
                    taskEventState.restore(cursorBefore);
                    taskChecklistState = TaskChecklistState.decode(
                        checklistBefore
                    );
                    return false;
                }
                if (taskEventState.terminal()) {
                    // A terminal embedded snapshot is the newest
                    // authoritative state. Do not let a redundant operation
                    // acknowledgement below reopen its cursor.
                    return true;
                }
            } catch (Exception error) {
                taskEventState.restore(cursorBefore);
                taskChecklistState = TaskChecklistState.decode(
                    checklistBefore
                );
                Log.w(TAG, "task_events.embedded_snapshot_rejected", error);
                return false;
            }
        }

        JSONObject accepted = response.optJSONObject("operationAccepted");
        if (accepted == null) accepted = response.optJSONObject(
            "operationAcknowledgement"
        );
        if (
            accepted == null
                && response.optInt("version", -1) == 2
                && "accepted".equals(response.optString("status", ""))
        ) {
            accepted = response;
        }
        if (accepted != null) {
            if (!bindAcceptedOperation(accepted)) return false;
        }

        JSONObject task = response.optJSONObject("taskV2");
        if (task == null) task = response.optJSONObject("task");
        if (task != null) {
            QueueTaskProjection parsedQueue =
                QueueTaskProjection.parse(task);
            queueTaskProjection = parsedQueue;
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                .edit()
                .putString(
                    QUEUE_TASK_PROJECTION_KEY,
                    parsedQueue == null ? null : task.toString()
                )
                .apply();
            if (statusView != null) {
                statusView.setQueueTaskProjection(parsedQueue);
            }
        }
        String taskId = task == null
            ? taskEventState.taskId()
            : validIdentifier(task.optString("taskId", ""), "task");
        int revision = task == null
            ? taskEventState.taskRevision()
            : task.optInt("revision", -1);
        String operationId = null;
        JSONArray toolResults = response.optJSONArray("toolResults");
        if (toolResults != null) {
            for (int index = 0; index < toolResults.length(); index += 1) {
                JSONObject toolResult = toolResults.optJSONObject(index);
                if (toolResult == null) continue;
                JSONObject operation = toolResult.optJSONObject("operation");
                if (operation != null) {
                    operationId = validIdentifier(
                        operation.optString("operationId", ""),
                        "operation"
                    );
                }
                if (operationId == null) {
                    operationId = validIdentifier(
                        toolResult.optString("operationId", ""),
                        "operation"
                    );
                }
                if (operationId != null) break;
            }
        }
        if (taskId != null) {
            final TaskEventSubscriptionState.Checkpoint cursorBefore =
                taskEventState.checkpoint();
            final String checklistBefore = taskChecklistState.encode();
            taskEventState.bindIdentity(
                taskId,
                taskEventState.lastSequence(),
                revision,
                operationId
            );
            if (
                task != null
                    && "cancelled".equals(task.optString("status", ""))
            ) {
                if (
                    !taskChecklistState.markCancelled(
                        taskId,
                        revision,
                        "Task cancelled. No further phone work will run."
                    )
                ) {
                    taskEventState.restore(cursorBefore);
                    return false;
                }
                taskEventState.restore(
                    taskId,
                    taskEventState.lastSequence(),
                    revision,
                    taskEventState.operationId(),
                    true
                );
                if (!persistTaskProjection()) {
                    taskEventState.restore(cursorBefore);
                    taskChecklistState = TaskChecklistState.decode(
                        checklistBefore
                    );
                    Log.e(TAG, "task.cancelled_persist_failed");
                    return false;
                }
                mainHandler.removeCallbacks(taskEventPollRunnable);
                if (statusView != null) {
                    statusView.setTaskChecklist(
                        taskChecklistState.snapshot()
                    );
                }
                Log.i(TAG, "task.cancelled_terminal");
                return true;
            }
            if (!persistTaskProjection()) {
                taskEventState.restore(cursorBefore);
                taskChecklistState = TaskChecklistState.decode(
                    checklistBefore
                );
                Log.e(TAG, "task.fast_identity_persist_failed");
                return false;
            }
            scheduleTaskEventPoll(0L);
        }
        return true;
    }

    private boolean bindAcceptedOperation(JSONObject accepted) {
        if (
            accepted.optInt("version", -1) != 2
                || !"accepted".equals(accepted.optString("status", ""))
        ) {
            return false;
        }
        String taskId = validIdentifier(
            accepted.optString("taskId", ""),
            "task"
        );
        String operationId = validIdentifier(
            accepted.optString("operationId", ""),
            "operation"
        );
        int revision = accepted.optInt("taskRevision", -1);
        JSONObject events = accepted.optJSONObject("events");
        int afterSequence = events == null
            ? -1
            : events.optInt("afterSequence", -1);
        if (
            taskId == null
                || operationId == null
                || revision < 0
                || afterSequence < -1
        ) {
            return false;
        }
        final TaskEventSubscriptionState.Checkpoint cursorBefore =
            taskEventState.checkpoint();
        final String checklistBefore = taskChecklistState.encode();
        TaskChecklistState.Snapshot identity = taskChecklistState.snapshot();
        final boolean taskChanged = identity.taskId() != null
            && !identity.taskId().equals(taskId);
        if (taskChanged) taskChecklistState = new TaskChecklistState();
        taskEventState.bindIdentity(
            taskId,
            afterSequence,
            revision,
            operationId
        );
        Log.i(
            TAG,
            "operation.accepted taskId=" + taskId
                + " operationId=" + operationId
                + " afterSequence=" + afterSequence
        );
        if (!persistTaskProjection(taskChanged)) {
            taskEventState.restore(cursorBefore);
            taskChecklistState = TaskChecklistState.decode(checklistBefore);
            Log.e(TAG, "operation.accepted_persist_failed");
            return false;
        }
        if (taskChanged) {
            retainedCartSummary = null;
            if (statusView != null) {
                statusView.setTaskChecklist(taskChecklistState.snapshot());
                statusView.setRetainedCartSummary(null);
            }
        }
        scheduleTaskEventPoll(0L);
        return true;
    }

    private void pollTaskEvents() {
        HttpURLConnection connection = null;
        try {
            final String taskId = taskEventState.taskId();
            final int afterSequence = taskEventState.lastSequence();
            if (taskId == null || taskEventState.terminal()) return;
            String query = "?taskId=" + URLEncoder.encode(
                taskId,
                StandardCharsets.UTF_8.name()
            ) + "&afterSequence=" + afterSequence;
            connection = (HttpURLConnection) new URL(
                TASK_EVENTS_URL + query
            ).openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(5000);
            connection.setRequestMethod("GET");
            int responseCode = connection.getResponseCode();
            if (responseCode < 200 || responseCode >= 300) {
                throw new IllegalStateException(
                    "task event response " + responseCode
                );
            }
            final RetainedTaskEventParser.Snapshot snapshot =
                taskEventParser.parseSnapshot(
                    new JSONObject(readAll(connection.getInputStream()))
                );
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    recoverTaskEventConnection();
                    applyTaskEventSnapshot(snapshot);
                }
            });
        } catch (Exception error) {
            Log.w(TAG, "task_events.poll_failed", error);
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    markTaskEventConnectionFailure();
                    scheduleTaskEventPoll(1500L);
                }
            });
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean applyTaskEventSnapshot(
        RetainedTaskEventParser.Snapshot snapshot
    ) {
        if (
            snapshot == null
                || taskEventState.taskId() == null
                || !taskEventState.taskId().equals(snapshot.taskId)
        ) {
            return false;
        }
        if (snapshot.resetRequired) {
            if (snapshot.resetSnapshot == null) {
                Log.e(TAG, "task_events.retention_reset_missing_projection");
                scheduleTaskEventPoll(1200L);
                return false;
            }
            final TaskEventSubscriptionState.Checkpoint cursorBefore =
                taskEventState.checkpoint();
            final String checklistBefore = taskChecklistState.encode();
            final String operationBefore = taskEventState.operationId();
            TaskChecklistState.Snapshot resetIdentity =
                taskChecklistState.snapshot();
            final boolean resetTaskChanged =
                resetIdentity.taskId() != null
                    && !resetIdentity.taskId().equals(snapshot.taskId);
            if (!taskChecklistState.applyResetSnapshot(snapshot.resetSnapshot)) {
                Log.e(TAG, "task_events.retention_reset_projection_rejected");
                scheduleTaskEventPoll(1200L);
                return false;
            }
            taskEventState.restore(
                snapshot.taskId,
                snapshot.resetSnapshot.latestSequence,
                snapshot.resetSnapshot.taskRevision,
                operationBefore,
                snapshot.resetSnapshot.terminal
            );
            boolean committed = AtomicPersistenceGate.persistBeforeEffects(
                new AtomicPersistenceGate.Commit() {
                    @Override
                    public boolean run() {
                        return persistTaskProjection(
                            resetTaskChanged,
                            snapshot.resetPresentation,
                            snapshot.resetFinalCartPresentation
                        );
                    }
                },
                new AtomicPersistenceGate.Rollback() {
                    @Override
                    public void run() {
                        taskEventState.restore(cursorBefore);
                        taskChecklistState = TaskChecklistState.decode(
                            checklistBefore
                        );
                    }
                },
                new AtomicPersistenceGate.Effect() {
                    @Override
                    public void run() {
                        if (resetTaskChanged) {
                            retainedCartSummary = null;
                            if (statusView != null) {
                                statusView.setRetainedCartSummary(null);
                            }
                        }
                        if (statusView != null) {
                            statusView.setTaskChecklist(
                                taskChecklistState.snapshot()
                            );
                        }
                        if (snapshot.resetPresentation != null) {
                            renderTaskEventPresentation(
                                snapshot.resetPresentation,
                                true
                            );
                        }
                    }
                }
            );
            if (!committed) {
                Log.e(TAG, "task_events.retention_reset_persist_failed");
                scheduleTaskEventPoll(0L);
                return false;
            }
            Log.i(
                TAG,
                "task_events.retention_reset_hydrated latestSequence="
                    + snapshot.resetSnapshot.latestSequence
            );
            // Reset projections are historical state: render only. Never
            // replay their haptic, TalkBack announcement, or TTS.
            if (!taskEventState.terminal()) scheduleTaskEventPoll(0L);
            return true;
        }
        if (!snapshot.shouldReplayAnnouncements()) return false;
        for (final RetainedTaskEvent event : snapshot.events) {
            final TaskEventSubscriptionState.Checkpoint cursorBefore =
                taskEventState.checkpoint();
            final String checklistBefore = taskChecklistState.encode();
            TaskEventSubscriptionState.Decision decision =
                taskEventState.accept(
                    event.taskId,
                    event.sequence,
                    event.taskRevision,
                    event.operationId,
                    event.isTerminal()
                );
            if (decision == TaskEventSubscriptionState.Decision.GAP) {
                Log.w(
                    TAG,
                    "task_events.sequence_gap after="
                        + taskEventState.lastSequence()
                        + " received=" + event.sequence
                );
                scheduleTaskEventPoll(0L);
                return false;
            }
            if (decision != TaskEventSubscriptionState.Decision.ACCEPTED) {
                continue;
            }
            TaskChecklistState.Snapshot checklistIdentity =
                taskChecklistState.snapshot();
            final boolean taskChanged = checklistIdentity.taskId() != null
                && !checklistIdentity.taskId().equals(event.taskId);
            if (taskChanged) {
                taskChecklistState = new TaskChecklistState();
            }
            if (!taskChecklistState.apply(event)) {
                Log.e(
                    TAG,
                    "task_events.projection_rejected sequence="
                        + event.sequence
                );
                taskEventState.restore(cursorBefore);
                taskChecklistState = TaskChecklistState.decode(
                    checklistBefore
                );
                scheduleTaskEventPoll(0L);
                return false;
            }
            final OverlayPresentation presentation =
                TaskEventPresentationFactory.create(
                    event,
                    taskEventState.operationId()
                );
            final OverlayPresentation finalCartPresentation =
                TaskEventPresentationFactory.createFinalCartPresentation(
                    event,
                    taskEventState.operationId()
                );
            // Commit cursor and checklist together before visible, haptic,
            // accessibility, or audible acknowledgement.
            boolean committed = AtomicPersistenceGate.persistBeforeEffects(
                new AtomicPersistenceGate.Commit() {
                    @Override
                    public boolean run() {
                        return persistTaskProjection(
                            taskChanged,
                            presentation,
                            finalCartPresentation
                        );
                    }
                },
                new AtomicPersistenceGate.Rollback() {
                    @Override
                    public void run() {
                        taskEventState.restore(cursorBefore);
                        taskChecklistState = TaskChecklistState.decode(
                            checklistBefore
                        );
                    }
                },
                new AtomicPersistenceGate.Effect() {
                    @Override
                    public void run() {
                        if (taskChanged) {
                            retainedCartSummary = null;
                            if (statusView != null) {
                                statusView.setRetainedCartSummary(null);
                            }
                        }
                        if (statusView != null) {
                            statusView.setTaskChecklist(
                                taskChecklistState.snapshot()
                            );
                        }
                        if (finalCartPresentation != null) {
                            retainVerifiedCartSummary(
                                finalCartPresentation
                            );
                        }
                        renderTaskEventPresentation(presentation, true);
                        performFeedback(feedbackPolicy.forEvent(event));
                        if (
                            statusView != null
                                && event.announcementText != null
                        ) {
                            statusView.announceForAccessibility(
                                event.announcementText
                            );
                        }
                        if (event.speaks()) {
                            speakTaskAnnouncement(
                                event.announcementText,
                                presentation.languageCode,
                                event.eventId
                            );
                        }
                    }
                }
            );
            if (!committed) {
                Log.e(
                    TAG,
                    "task_events.effects_blocked_persist_failed sequence="
                        + event.sequence
                );
                scheduleTaskEventPoll(0L);
                return false;
            }
            Log.i(
                TAG,
                "task_events.accepted sequence=" + event.sequence
                    + " kind=" + event.kind
            );
        }
        if (!taskEventState.terminal()) {
            scheduleTaskEventPoll(snapshot.events.isEmpty() ? 1200L : 200L);
        }
        return true;
    }

    private void scheduleTaskEventPoll(long delayMs) {
        mainHandler.removeCallbacks(taskEventPollRunnable);
        if (
            destroyed
                || taskEventState.taskId() == null
                || taskEventState.terminal()
        ) {
            return;
        }
        mainHandler.postDelayed(taskEventPollRunnable, Math.max(0L, delayMs));
    }

    private void markTaskEventConnectionFailure() {
        taskEventPollFailures += 1;
        if (
            taskUpdatesDisconnected
                || taskEventPollFailures < 2
                || taskEventState.taskId() == null
                || taskEventState.terminal()
        ) {
            return;
        }
        taskUpdatesDisconnected = true;
        taskChecklistState.setDisconnected(
            true,
            DeterministicCompanionCopy.connectionLost(
                latestPresentation == null
                    ? "en-IN"
                    : latestPresentation.languageCode
            )
        );
        if (statusView != null) {
            statusView.setTaskChecklist(taskChecklistState.snapshot());
        }
        persistTaskChecklist();
        OverlayPresentation.Card card = new OverlayPresentation.Card(
            "compact_status",
            "attention",
            "DISCONNECTED",
            DeterministicCompanionCopy.connectionLost(
                latestPresentation == null
                    ? "en-IN"
                    : latestPresentation.languageCode
            ),
            java.util.Collections
                .<OverlayPresentation.ProductChoice>emptyList(),
            null
        );
        OverlayPresentation disconnected = new OverlayPresentation(
            1,
            "disconnected",
            "overlay_card",
            null,
            null,
            null,
            null,
            card,
            card.detail,
            latestPresentation == null
                ? "en-IN"
                : latestPresentation.languageCode,
            false,
            6500L,
            true,
            true
        );
        applyPresentation(disconnected, true, false);
    }

    private void recoverTaskEventConnection() {
        taskEventPollFailures = 0;
        if (!taskUpdatesDisconnected) return;
        taskUpdatesDisconnected = false;
        taskChecklistState.setDisconnected(false, null);
        if (statusView != null) {
            statusView.setTaskChecklist(taskChecklistState.snapshot());
        }
        persistTaskChecklist();
        if (lastAuthoritativePresentation != null) {
            applyPresentation(lastAuthoritativePresentation, true, false);
        }
    }

    private void uploadTurn() {
        HttpURLConnection connection = null;
        try {
            Log.i(
                TAG,
                "voice.upload_started bytes="
                    + (recordingFile == null ? -1 : recordingFile.length())
            );
            String boundary = "JaldiAI" + System.currentTimeMillis();
            connection = (HttpURLConnection) new URL(VOICE_TURN_URL).openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(90000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty(
                "Content-Type",
                "multipart/form-data; boundary=" + boundary
            );

            DataOutputStream output = new DataOutputStream(connection.getOutputStream());
            writeTextPart(output, boundary, "clientId", "pixel-overlay");
            output.writeBytes("--" + boundary + "\r\n");
            output.writeBytes(
                "Content-Disposition: form-data; name=\"audio\"; filename=\"command.m4a\"\r\n"
            );
            output.writeBytes("Content-Type: audio/mp4\r\n\r\n");
            InputStream audio = new java.io.FileInputStream(recordingFile);
            byte[] buffer = new byte[8192];
            int count;
            while ((count = audio.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            audio.close();
            output.writeBytes("\r\n--" + boundary + "--\r\n");
            output.flush();
            output.close();

            int responseCode = connection.getResponseCode();
            Log.i(TAG, "voice.upload_response code=" + responseCode);
            InputStream responseStream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            String body = readAll(responseStream);
            JSONObject result = new JSONObject(body);
            OverlayPresentation.ProductSelectionBinding selectionBinding =
                statusView.currentProductSelectionBinding();
            final ProductSelectionResponse selectionOutcome =
                ProductSelectionResponse.parse(
                    result,
                    selectionBinding
                );
            boolean explicitSelectionAccepted =
                selectionOutcome != null
                    && selectionOutcome.acceptedOnce();
            boolean httpSuccess =
                responseCode >= 200 && responseCode < 300;
            boolean conflictWithWinner =
                responseCode == 409
                    && selectionOutcome != null
                    && selectionOutcome.disposition
                        == ProductSelectionResponse.Disposition.CONFLICT;
            boolean legacyOk =
                result.has("ok") && result.optBoolean("ok", false);
            if (
                (!httpSuccess && !conflictWithWinner)
                    || (!legacyOk && !explicitSelectionAccepted)
            ) {
                throw new Exception(result.optString("error", "The voice request failed."));
            }
            finishActiveVoiceChoiceLatency(
                explicitSelectionAccepted
                    ? productServerOutcome(selectionOutcome)
                    : "accepted"
            );

            final String reply = result.optString(
                "reply",
                explicitSelectionAccepted
                    ? selectionOutcome.winnerTitle + " selected."
                    : "Done."
            );
            final String state = result.optString("assistantState", "ready");
            final String audioBase64 = result.optString("audioBase64", "");
            final OverlayPresentation presentation = presentationParser.parse(
                result.optJSONObject("presentation"),
                reply,
                state
            );
            final JSONObject responsePayload = result;
            Log.i(
                TAG,
                "voice.upload_completed assistantState=" + state
            );
            statusView.post(new Runnable() {
                @Override
                public void run() {
                    if (!consumeFastOperationIdentity(responsePayload)) {
                        Log.e(
                            TAG,
                            "voice.response_effects_blocked_persist_failed"
                        );
                        return;
                    }
                    if (
                        selectionOutcome != null
                            && !applyProductSelectionOutcome(selectionOutcome)
                    ) {
                        return;
                    }
                    renderPresentation(presentation, true);
                    consumeVoiceSynthesis(
                        responsePayload,
                        audioBase64
                    );
                }
            });
        } catch (final Exception error) {
            Log.e(TAG, "voice.upload_failed", error);
            finishActiveVoiceChoiceLatency("network_error");
            statusView.post(new Runnable() {
                @Override
                public void run() {
                    setStatus(
                        error.getMessage() == null
                            ? "The voice request failed."
                            : error.getMessage(),
                        "error"
                    );
                }
            });
        } finally {
            uploading = false;
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    scheduleCollapseIfAllowed();
                }
            });
            if (connection != null) connection.disconnect();
        }
    }

    private void consumeVoiceSynthesis(
        JSONObject response,
        String legacyAudioBase64
    ) {
        JSONObject synthesis = response == null
            ? null
            : response.optJSONObject("audioSynthesis");
        if (synthesis == null) {
            deferredSynthesisState.clear();
            persistDeferredSynthesisState();
            if (
                legacyAudioBase64 != null
                    && !legacyAudioBase64.trim().isEmpty()
            ) {
                playSarvamAudio(legacyAudioBase64);
            }
            return;
        }
        DeferredSynthesisState.Effect effect = deferredSynthesisState.begin(
            response.optString("requestId", ""),
            synthesis.optString("synthesisId", ""),
            synthesis.optString("status", ""),
            legacyAudioBase64,
            System.currentTimeMillis(),
            synthesis.optLong("pollAfterMs", 150L)
        );
        boolean persisted = persistDeferredSynthesisState();
        if (!persisted && effect.play) {
            Log.e(TAG, "voice.synthesis_playback_blocked_persist_failed");
            return;
        }
        applyDeferredSynthesisEffect(effect);
        scheduleDeferredSynthesisPoll();
    }

    private void scheduleDeferredSynthesisPoll() {
        mainHandler.removeCallbacks(deferredSynthesisPollRunnable);
        if (
            destroyed
                || devicePaused
                || deferredSynthesisState.phase()
                    != DeferredSynthesisState.Phase.POLLING
        ) {
            return;
        }
        long delay = Math.max(
            0L,
            deferredSynthesisState.nextPollAtEpochMs()
                - System.currentTimeMillis()
        );
        mainHandler.postDelayed(deferredSynthesisPollRunnable, delay);
    }

    private void startDeferredSynthesisPollIfDue() {
        if (destroyed || devicePaused) return;
        DeferredSynthesisState.Effect effect =
            deferredSynthesisState.pollIfDue(System.currentTimeMillis());
        if (!effect.poll) {
            persistDeferredSynthesisState();
            scheduleDeferredSynthesisPoll();
            return;
        }
        final String generation = deferredSynthesisState.generation();
        final String synthesisId = deferredSynthesisState.synthesisId();
        if (!persistDeferredSynthesisState()) {
            Log.e(TAG, "voice.synthesis_poll_blocked_persist_failed");
            return;
        }
        synthesisExecutor.execute(new Runnable() {
            @Override
            public void run() {
                pollDeferredSynthesis(generation, synthesisId);
            }
        });
    }

    private void pollDeferredSynthesis(
        final String generation,
        final String synthesisId
    ) {
        HttpURLConnection connection = null;
        try {
            String query = "?clientId=" + URLEncoder.encode(
                "pixel-overlay",
                StandardCharsets.UTF_8.name()
            ) + "&synthesisId=" + URLEncoder.encode(
                synthesisId,
                StandardCharsets.UTF_8.name()
            );
            connection = (HttpURLConnection) new URL(
                SYNTHESIS_URL + query
            ).openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(2500);
            connection.setRequestMethod("GET");
            int responseCode = connection.getResponseCode();
            if (responseCode < 200 || responseCode >= 300) {
                throw new IllegalStateException(
                    "synthesis response " + responseCode
                );
            }
            JSONObject response = new JSONObject(
                readAll(connection.getInputStream())
            );
            if (!response.optBoolean("ok", false)) {
                throw new IllegalStateException("synthesis response rejected");
            }
            JSONObject synthesis = response.optJSONObject("audioSynthesis");
            if (synthesis == null) {
                throw new IllegalStateException("missing synthesis status");
            }
            if (
                !synthesisId.equals(
                    synthesis.optString("synthesisId", "")
                )
            ) {
                throw new IllegalStateException(
                    "synthesis identity mismatch"
                );
            }
            final String status = synthesis.optString("status", "");
            final String audio = response.optString("audioBase64", "");
            final long pollAfterMs = synthesis.optLong(
                "pollAfterMs",
                150L
            );
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    if (destroyed) return;
                    DeferredSynthesisState.Effect effect =
                        deferredSynthesisState.response(
                            generation,
                            synthesisId,
                            status,
                            audio,
                            System.currentTimeMillis(),
                            pollAfterMs
                        );
                    boolean persisted = persistDeferredSynthesisState();
                    if (!persisted && effect.play) {
                        Log.e(
                            TAG,
                            "voice.synthesis_playback_blocked_persist_failed"
                        );
                        return;
                    }
                    applyDeferredSynthesisEffect(effect);
                    scheduleDeferredSynthesisPoll();
                }
            });
        } catch (Exception error) {
            Log.w(TAG, "voice.synthesis_poll_failed", error);
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    if (destroyed) return;
                    deferredSynthesisState.pollFailed(
                        generation,
                        synthesisId,
                        System.currentTimeMillis(),
                        300L
                    );
                    persistDeferredSynthesisState();
                    scheduleDeferredSynthesisPoll();
                }
            });
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void applyDeferredSynthesisEffect(
        DeferredSynthesisState.Effect effect
    ) {
        if (effect == null) return;
        if (effect.cancelPlayback) releasePlayer();
        if (!effect.play || effect.audioBase64 == null) return;
        final String generation = deferredSynthesisState.generation();
        final String synthesisId = deferredSynthesisState.synthesisId();
        if (
            devicePaused
                || !deferredSynthesisState.playbackStarted(
                    generation,
                    synthesisId
                )
        ) {
            return;
        }
        if (!persistDeferredSynthesisState()) {
            Log.e(TAG, "voice.synthesis_playback_blocked_persist_failed");
            return;
        }
        playSarvamAudio(effect.audioBase64, generation, synthesisId);
    }

    private void finishDeferredSynthesisPlayback(
        String generation,
        String synthesisId
    ) {
        if (generation == null || synthesisId == null) return;
        deferredSynthesisState.playbackFinished(generation, synthesisId);
        persistDeferredSynthesisState();
    }

    private void abandonDeferredSynthesisPlayback() {
        mainHandler.removeCallbacks(deferredSynthesisPollRunnable);
        deferredSynthesisState.clear();
        persistDeferredSynthesisState();
    }

    private boolean persistDeferredSynthesisState() {
        android.content.SharedPreferences.Editor editor =
            getSharedPreferences(
                OVERLAY_PREFERENCES,
                MODE_PRIVATE
            ).edit();
        DeferredSynthesisState.Snapshot snapshot =
            deferredSynthesisState.pendingSnapshot();
        try {
            if (snapshot == null) {
                editor.remove(DEFERRED_SYNTHESIS_KEY);
            } else {
                JSONObject encoded = new JSONObject();
                encoded.put("version", 1);
                encoded.put("generation", snapshot.generation);
                encoded.put("synthesisId", snapshot.synthesisId);
                encoded.put("pollsStarted", snapshot.pollsStarted);
                encoded.put("startedAt", snapshot.startedAtEpochMs);
                encoded.put("nextPollAt", snapshot.nextPollAtEpochMs);
                editor.putString(
                    DEFERRED_SYNTHESIS_KEY,
                    encoded.toString()
                );
            }
            boolean committed = editor.commit();
            if (!committed) {
                Log.e(TAG, "voice.synthesis_state_persist_failed");
            }
            return committed;
        } catch (Exception error) {
            Log.w(TAG, "voice.synthesis_state_persist_failed", error);
            return false;
        }
    }

    private void restoreDeferredSynthesisState() {
        String encoded = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getString(DEFERRED_SYNTHESIS_KEY, null);
        if (encoded == null) return;
        try {
            JSONObject snapshot = new JSONObject(encoded);
            if (snapshot.optInt("version", -1) != 1) {
                throw new IllegalArgumentException(
                    "unsupported synthesis snapshot"
                );
            }
            DeferredSynthesisState.Snapshot pending =
                new DeferredSynthesisState.Snapshot(
                    snapshot.getString("generation"),
                    snapshot.getString("synthesisId"),
                    snapshot.getInt("pollsStarted"),
                    snapshot.getLong("startedAt"),
                    snapshot.getLong("nextPollAt")
                );
            if (
                !deferredSynthesisState.restorePending(
                    pending,
                    System.currentTimeMillis()
                )
            ) {
                persistDeferredSynthesisState();
            }
        } catch (Exception error) {
            deferredSynthesisState.clear();
            persistDeferredSynthesisState();
            Log.w(TAG, "voice.synthesis_state_restore_rejected", error);
        }
    }

    private void playSarvamAudio(String audioBase64) {
        playSarvamAudio(audioBase64, null, null);
    }

    private void playSarvamAudio(
        String audioBase64,
        final String synthesisGeneration,
        final String synthesisId
    ) {
        stopAnnouncementSpeech();
        releasePlayer();
        if (!OverlayLifecyclePolicy.audioPlaybackAllowed(devicePaused)) return;
        try {
            byte[] audio = Base64.decode(audioBase64, Base64.DEFAULT);
            File replyFile = new File(getCacheDir(), "sarvam-reply.mp3");
            FileOutputStream output = new FileOutputStream(replyFile);
            output.write(audio);
            output.close();

            player = new MediaPlayer();
            player.setDataSource(replyFile.getAbsolutePath());
            player.prepare();
            attachPlaybackVisualizer(player.getAudioSessionId());
            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mediaPlayer) {
                    if (player != mediaPlayer) {
                        try {
                            mediaPlayer.release();
                        } catch (RuntimeException ignored) {
                            // An obsolete callback may already be released.
                        }
                        return;
                    }
                    finishDeferredSynthesisPlayback(
                        synthesisGeneration,
                        synthesisId
                    );
                    releasePlayer();
                    statusView.companionGlyph().setMode(
                        latestPresentation.mode,
                        latestPresentation.card.tone
                    );
                    scheduleCollapseIfAllowed();
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(
                    MediaPlayer mediaPlayer,
                    int what,
                    int extra
                ) {
                    if (player != mediaPlayer) {
                        try {
                            mediaPlayer.release();
                        } catch (RuntimeException ignored) {
                            // An obsolete callback may already be released.
                        }
                        return true;
                    }
                    finishDeferredSynthesisPlayback(
                        synthesisGeneration,
                        synthesisId
                    );
                    releasePlayer();
                    if (!devicePaused) {
                        statusView.companionGlyph().setMode(
                            latestPresentation.mode,
                            latestPresentation.card.tone
                        );
                        scheduleCollapseIfAllowed();
                    }
                    return true;
                }
            });
            speaking = true;
            statusView.companionGlyph().setMode(
                "responding",
                latestPresentation.card.tone
            );
            mainHandler.removeCallbacks(collapseRunnable);
            player.start();
        } catch (Exception error) {
            finishDeferredSynthesisPlayback(
                synthesisGeneration,
                synthesisId
            );
            speaking = false;
            setStatus("The task replied, but audio playback failed.", "error");
        }
    }

    private void attachPlaybackVisualizer(int audioSessionId) {
        releasePlaybackVisualizer();
        try {
            playbackVisualizer = new Visualizer(audioSessionId);
            int[] captureRange = Visualizer.getCaptureSizeRange();
            int captureSize = Math.max(
                captureRange[0],
                Math.min(256, captureRange[1])
            );
            playbackVisualizer.setCaptureSize(captureSize);
            playbackVisualizer.setDataCaptureListener(
                new Visualizer.OnDataCaptureListener() {
                    @Override
                    public void onWaveFormDataCapture(
                        Visualizer visualizer,
                        final byte[] waveform,
                        int samplingRate
                    ) {
                        final float level = MotionPolicy.waveformLevel(
                            waveform,
                            waveform == null ? 0 : waveform.length
                        );
                        mainHandler.post(new Runnable() {
                            @Override
                            public void run() {
                                if (speaking && statusView != null) {
                                    statusView.companionGlyph()
                                        .setAudioLevel(level);
                                }
                            }
                        });
                    }

                    @Override
                    public void onFftDataCapture(
                        Visualizer visualizer,
                        byte[] fft,
                        int samplingRate
                    ) {
                        // Waveform RMS is sufficient for companion motion.
                    }
                },
                Math.max(
                    Visualizer.getMaxCaptureRate() / 4,
                    1000
                ),
                true,
                false
            );
            playbackVisualizer.setEnabled(true);
        } catch (Exception ignored) {
            releasePlaybackVisualizer();
        }
    }

    private void registerStatusReceiver() {
        try {
            statusIngressCapability = StatusIngressCapability.loadOrCreate(
                getFilesDir()
            );
        } catch (Exception failure) {
            statusIngressCapability = null;
            Log.e(TAG, "status.ingress_capability_unavailable", failure);
            return;
        }
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (
                    intent == null
                        || !StatusIngressPolicy.accepts(
                            intent.getAction(),
                            intent.getPackage(),
                            getPackageName(),
                            intent.getStringExtra(
                                StatusIngressPolicy.EXTRA_CAPABILITY
                            ),
                            statusIngressCapability
                        )
                ) {
                    Log.w(TAG, "status.ingress_rejected");
                    return;
                }
                if (intent.hasExtra("clearSpatialAttention")) {
                    clearSpatialAttention();
                    return;
                }
                String broadSubject = intent.getStringExtra(
                    "broadAttentionSubject"
                );
                if (broadSubject != null) {
                    clearExactAttention();
                    if (isBroadAttentionSubject(broadSubject)) {
                        broadAttentionOverride = broadSubject;
                        updateAttention();
                    } else {
                        clearSpatialAttention();
                    }
                    return;
                }
                String encodedSpatialAttention = intent.getStringExtra(
                    "spatialAttentionBase64"
                );
                if (
                    encodedSpatialAttention != null
                        && !encodedSpatialAttention.trim().isEmpty()
                ) {
                    receiveSpatialAttention(encodedSpatialAttention);
                    return;
                }
                if (intent.hasExtra("captureSuppressed")) {
                    captureSuppressed = intent.getBooleanExtra(
                        "captureSuppressed",
                        false
                    );
                    if (captureSuppressed && attentionView != null) {
                        attentionView.hide();
                    } else {
                        updateAttention();
                    }
                    return;
                }
                clearExactAttention();
                broadAttentionOverride = null;
                if (attentionView != null) attentionView.hide();
                String message = intent.getStringExtra("message");
                String state = intent.getStringExtra("state");
                String rawPresentation = intent.getStringExtra("presentation");
                String encodedPresentation = intent.getStringExtra(
                    "presentationBase64"
                );
                if (
                    encodedPresentation != null
                        && !encodedPresentation.trim().isEmpty()
                ) {
                    try {
                        rawPresentation = new String(
                            Base64.decode(
                                encodedPresentation,
                                Base64.DEFAULT
                            ),
                            StandardCharsets.UTF_8
                        );
                    } catch (Exception ignored) {
                        rawPresentation = null;
                    }
                }
                if (rawPresentation != null && !rawPresentation.trim().isEmpty()) {
                    try {
                        renderPresentation(
                            presentationParser.parse(
                                new JSONObject(rawPresentation),
                                message,
                                state
                            ),
                            true
                        );
                        return;
                    } catch (Exception ignored) {
                        // The legacy status below is the safe preview fallback.
                    }
                }
                if (message == null || message.trim().isEmpty()) return;
                setStatus(message, state);
            }
        };

        IntentFilter filter = new IntentFilter(ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(receiver, filter);
        }
    }

    private void registerLifecycleReceiver() {
        lifecycleReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                    pauseForLockedDevice();
                    return;
                }
                if (PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED.equals(action)) {
                    PowerManager powerManager =
                        (PowerManager) getSystemService(POWER_SERVICE);
                    if (
                        powerManager != null
                            && powerManager.isDeviceIdleMode()
                    ) {
                        pauseForLockedDevice();
                    } else if (canResumeInteractiveDevice()) {
                        resumeAfterUnlock();
                    }
                    return;
                }
                if (Intent.ACTION_USER_PRESENT.equals(action)) {
                    resumeAfterUnlock();
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(
                lifecycleReceiver,
                filter,
                Context.RECEIVER_NOT_EXPORTED
            );
        } else {
            registerReceiver(lifecycleReceiver, filter);
        }
    }

    private void pauseForLockedDevice() {
        Log.i(TAG, "lifecycle.paused_for_lock");
        devicePaused = true;
        taskChecklistState.setPaused(true, "Phone locked. Task paused.");
        boolean interrupted = recording || speaking;
        releaseRecorder();
        abandonDeferredSynthesisPlayback();
        releasePlayer();
        stopAnnouncementSpeech();
        clearSpatialAttention();
        if (interrupted) {
            latestPresentation = OverlayPresentation.legacy(
                "Audio stopped when the phone locked. Unlock and hold to continue.",
                "error"
            );
            latestMessage = latestPresentation.spokenText;
        }
        if (statusView != null) {
            statusView.setTaskChecklist(taskChecklistState.snapshot());
            statusView.companionGlyph().setMode(
                "paused",
                "attention"
            );
            setExpanded(false, false);
        }
        persistRecoveryState();
        persistTaskChecklist();
    }

    private boolean canResumeInteractiveDevice() {
        PowerManager powerManager =
            (PowerManager) getSystemService(POWER_SERVICE);
        KeyguardManager keyguardManager =
            (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        return powerManager != null
            && powerManager.isInteractive()
            && (
                keyguardManager == null
                    || !keyguardManager.isDeviceLocked()
            );
    }

    private void resumeAfterUnlock() {
        Log.i(TAG, "lifecycle.resumed_after_unlock");
        devicePaused = false;
        taskChecklistState.setPaused(false, null);
        if (statusView != null) {
            statusView.setTaskChecklist(taskChecklistState.snapshot());
            statusView.companionGlyph().refreshMotionPreference();
            statusView.companionGlyph().setMode(
                latestPresentation.mode,
                latestPresentation.card.tone
            );
            setExpanded(false, false);
        }
        persistRecoveryState();
        persistTaskChecklist();
    }

    private void restoreRecoveryState() {
        String encoded = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getString(RECOVERY_SNAPSHOT_KEY, null);
        OverlayRecoverySnapshot.Restored restored =
            OverlayRecoverySnapshot.decode(
                encoded,
                System.currentTimeMillis()
            );
        if (restored != null) {
            latestPresentation = restored.presentation;
            lastAuthoritativePresentation = latestPresentation;
            latestMessage = latestPresentation.spokenText;
            restoredExpanded = restored.expanded;
            recording = false;
            uploading = false;
            selectionSubmitting = false;
            completionSubmitting = false;
            speaking = false;
            announcementSpeaking = false;
        }
        restoreVerifiedCartSummary();
    }

    private void restoreTaskEventCursor() {
        android.content.SharedPreferences preferences = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        );
        String taskId = validIdentifier(
            preferences.getString(TASK_CURSOR_ID_KEY, ""),
            "task"
        );
        if (taskId == null) return;
        String operationId = validIdentifier(
            preferences.getString(TASK_CURSOR_OPERATION_KEY, ""),
            "operation"
        );
        taskEventState.restore(
            taskId,
            preferences.getInt(TASK_CURSOR_SEQUENCE_KEY, -1),
            preferences.getInt(TASK_CURSOR_REVISION_KEY, -1),
            operationId,
            preferences.getBoolean(TASK_CURSOR_TERMINAL_KEY, false)
        );
    }

    private void restoreTaskChecklist() {
        String encoded = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getString(TASK_CHECKLIST_KEY, null);
        if (encoded == null) return;
        try {
            TaskChecklistState restored = TaskChecklistState.decode(encoded);
            TaskChecklistState.Snapshot projected = restored.snapshot();
            if (
                taskEventState.taskId() == null
                    || projected.taskId() == null
                    || !taskEventState.taskId().equals(
                        projected.taskId()
                    )
            ) {
                return;
            }
            taskChecklistState = restored;
            taskUpdatesDisconnected =
                projected.activePhase()
                    == TaskChecklistState.Phase.DISCONNECTED;
            if (
                projected.lastSequence()
                    != taskEventState.lastSequence()
            ) {
                Log.w(
                    TAG,
                    "task_events.restore_reconciled cursor="
                        + taskEventState.lastSequence()
                        + " projection=" + projected.lastSequence()
                );
                taskEventState.restore(
                    projected.taskId(),
                    projected.lastSequence(),
                    projected.taskRevision(),
                    taskEventState.operationId(),
                    projected.terminal()
                );
            }
        } catch (Exception error) {
            Log.w(TAG, "task_checklist.restore_rejected", error);
        }
    }

    private void ensureChecklistTask(String taskId) {
        TaskChecklistState.Snapshot snapshot = taskChecklistState.snapshot();
        if (
            snapshot.taskId() != null
                && !snapshot.taskId().equals(taskId)
        ) {
            taskChecklistState = new TaskChecklistState();
            clearLocalProductSelection();
            retainedCartSummary = null;
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                .edit()
                .remove(VERIFIED_CART_KEY)
                .apply();
            if (statusView != null) {
                statusView.setTaskChecklist(taskChecklistState.snapshot());
                statusView.setRetainedCartSummary(null);
            }
        }
    }

    private void persistTaskChecklist() {
        try {
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                .edit()
                .putString(TASK_CHECKLIST_KEY, taskChecklistState.encode())
                .apply();
        } catch (Exception error) {
            Log.w(TAG, "task_checklist.persist_failed", error);
        }
    }

    private boolean persistTaskProjection() {
        return persistTaskProjection(false, null, null);
    }

    private boolean persistTaskProjection(boolean clearPreviousTaskState) {
        return persistTaskProjection(
            clearPreviousTaskState,
            null,
            null
        );
    }

    private boolean persistTaskProjection(
        boolean clearPreviousTaskState,
        OverlayPresentation latestDurablePresentation,
        OverlayPresentation verifiedCartPresentation
    ) {
        TaskProjectionDurability.Prepared prepared =
            TaskProjectionDurability.prepare(
                taskEventState,
                taskChecklistState,
                latestDurablePresentation,
                verifiedCartPresentation,
                clearPreviousTaskState,
                System.currentTimeMillis()
            );
        if (prepared == null) return false;
        try {
            android.content.SharedPreferences.Editor editor =
                getSharedPreferences(
                    OVERLAY_PREFERENCES,
                    MODE_PRIVATE
                ).edit()
                    .putString(
                        TASK_CURSOR_ID_KEY,
                        prepared.taskId
                    )
                    .putInt(
                        TASK_CURSOR_SEQUENCE_KEY,
                        prepared.sequence
                    )
                    .putInt(
                        TASK_CURSOR_REVISION_KEY,
                        prepared.revision
                    )
                    .putBoolean(
                        TASK_CURSOR_TERMINAL_KEY,
                        prepared.terminal
                    )
                    .putString(
                        TASK_CHECKLIST_KEY,
                        prepared.checklist
                    );
            if (prepared.operationId == null) {
                editor.remove(TASK_CURSOR_OPERATION_KEY);
            } else {
                editor.putString(
                    TASK_CURSOR_OPERATION_KEY,
                    prepared.operationId
                );
            }
            if (prepared.recoveryPresentation != null) {
                editor.putString(
                    RECOVERY_SNAPSHOT_KEY,
                    prepared.recoveryPresentation
                );
            } else if (
                prepared.clearPreviousTaskState || prepared.terminal
            ) {
                editor.remove(RECOVERY_SNAPSHOT_KEY);
            }
            if (prepared.verifiedCartPresentation != null) {
                editor.putString(
                    VERIFIED_CART_KEY,
                    prepared.verifiedCartPresentation
                );
            } else if (
                prepared.clearPreviousTaskState || prepared.terminal
            ) {
                editor.remove(VERIFIED_CART_KEY);
            }
            if (prepared.clearPreviousTaskState) {
                editor.remove(LOCAL_SELECTION_KEY);
                editor.remove(LOCAL_RECOVERY_ACTION_KEY);
            }
            if (!editor.commit()) {
                Log.e(TAG, "task_projection.persist_failed");
                return false;
            }
            return true;
        } catch (Exception error) {
            Log.w(TAG, "task_projection.persist_failed", error);
            return false;
        }
    }

    private void persistRecoveryState() {
        String encoded = OverlayRecoverySnapshot.encode(
            latestPresentation,
            expanded && !devicePaused,
            System.currentTimeMillis()
        );
        if (encoded == null) {
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                .edit()
                .remove(RECOVERY_SNAPSHOT_KEY)
                .apply();
            return;
        }
        getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
            .edit()
            .putString(RECOVERY_SNAPSHOT_KEY, encoded)
            .apply();
    }

    private void initializeAnnouncementSpeech() {
        announcementTts = new TextToSpeech(
            getApplicationContext(),
            new TextToSpeech.OnInitListener() {
                @Override
                public void onInit(int status) {
                    announcementTtsReady = status == TextToSpeech.SUCCESS;
                    if (!announcementTtsReady || announcementTts == null) {
                        pendingAnnouncementText = null;
                        pendingAnnouncementLanguageCode = null;
                        pendingAnnouncementId = null;
                        return;
                    }
                    announcementTts.setOnUtteranceProgressListener(
                        new UtteranceProgressListener() {
                            @Override
                            public void onStart(String utteranceId) {
                                mainHandler.post(new Runnable() {
                                    @Override
                                    public void run() {
                                        announcementSpeaking = true;
                                        if (statusView != null) {
                                            statusView.companionGlyph().setMode(
                                                "responding",
                                                latestPresentation.card.tone
                                            );
                                        }
                                        mainHandler.removeCallbacks(
                                            collapseRunnable
                                        );
                                    }
                                });
                            }

                            @Override
                            public void onDone(String utteranceId) {
                                finishAnnouncementSpeech();
                            }

                            @Override
                            public void onError(String utteranceId) {
                                finishAnnouncementSpeech();
                            }
                        }
                    );
                    if (pendingAnnouncementText != null) {
                        speakTaskAnnouncement(
                            pendingAnnouncementText,
                            pendingAnnouncementLanguageCode,
                            pendingAnnouncementId
                        );
                    }
                }
            }
        );
    }

    private void speakTaskAnnouncement(
        String text,
        String languageCode,
        String eventId
    ) {
        if (
            text == null
                || text.trim().isEmpty()
                || recording
                || devicePaused
        ) {
            return;
        }
        if (!announcementTtsReady || announcementTts == null) {
            pendingAnnouncementText = text;
            pendingAnnouncementLanguageCode = languageCode;
            pendingAnnouncementId = eventId;
            return;
        }
        pendingAnnouncementText = null;
        pendingAnnouncementLanguageCode = null;
        pendingAnnouncementId = null;
        releasePlayer();
        Locale language = languageCode == null
            ? Locale.forLanguageTag("en-IN")
            : Locale.forLanguageTag(languageCode);
        announcementTts.setLanguage(language);
        Bundle parameters = new Bundle();
        announcementTts.speak(
            text,
            TextToSpeech.QUEUE_FLUSH,
            parameters,
            "task-event-" + eventId
        );
    }

    private void finishAnnouncementSpeech() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                announcementSpeaking = false;
                if (statusView != null && !recording && !speaking) {
                    statusView.companionGlyph().setMode(
                        latestPresentation.mode,
                        latestPresentation.card.tone
                    );
                }
                scheduleCollapseIfAllowed();
            }
        });
    }

    private void stopAnnouncementSpeech() {
        pendingAnnouncementText = null;
        pendingAnnouncementLanguageCode = null;
        pendingAnnouncementId = null;
        announcementSpeaking = false;
        if (announcementTts != null) announcementTts.stop();
    }

    private void shutdownAnnouncementSpeech() {
        stopAnnouncementSpeech();
        announcementTtsReady = false;
        if (announcementTts != null) {
            announcementTts.shutdown();
            announcementTts = null;
        }
    }

    private static String validIdentifier(String value, String kind) {
        if (value == null) return null;
        String clean = value.trim();
        return clean.matches(
            "^" + java.util.regex.Pattern.quote(kind)
                + "_[A-Za-z0-9-]{8,80}$"
        ) ? clean : null;
    }

    private void setStatus(String message, String state) {
        renderPresentation(
            OverlayPresentation.legacy(message, state),
            true
        );
    }

    private void renderPresentation(
        OverlayPresentation presentation,
        boolean shouldExpand
    ) {
        if (!semanticProgressState.accept(presentation.task)) return;
        applyPresentation(presentation, shouldExpand);
    }

    private void renderTaskEventPresentation(
        OverlayPresentation presentation,
        boolean shouldExpand
    ) {
        // Retained stream sequence is independent from presentation-v1 task
        // sequence. The task-event cursor already enforced task, revision, gap,
        // duplicate, and terminal ordering for this path.
        applyPresentation(presentation, shouldExpand);
    }

    private void applyPresentation(
        OverlayPresentation presentation,
        boolean shouldExpand
    ) {
        applyPresentation(presentation, shouldExpand, true);
    }

    private void applyPresentation(
        OverlayPresentation presentation,
        boolean shouldExpand,
        boolean authoritative
    ) {
        if (authoritative) lastAuthoritativePresentation = presentation;
        if (presentation.card.cartSummary != null) {
            retainVerifiedCartSummary(presentation);
        }
        latestPresentation = presentation;
        latestMessage = presentation.spokenText;
        statusView.companionGlyph().setMode(
            presentation.mode,
            presentation.card.tone
        );
        setExpanded(shouldExpand && !devicePaused, true);
        mainHandler.removeCallbacks(collapseRunnable);
        scheduleCollapseIfAllowed();
        persistRecoveryState();
    }

    private void performFeedback(InteractionFeedbackPolicy.Cue cue) {
        if (statusView == null || cue == null || cue == InteractionFeedbackPolicy.Cue.NONE) {
            return;
        }
        int constant = HapticFeedbackConstants.KEYBOARD_TAP;
        if (
            cue == InteractionFeedbackPolicy.Cue.SELECTION_ACCEPTED
                || cue == InteractionFeedbackPolicy.Cue.ITEM_VERIFIED
        ) {
            constant = Build.VERSION.SDK_INT >= 30
                ? HapticFeedbackConstants.CONFIRM
                : HapticFeedbackConstants.VIRTUAL_KEY;
        } else if (cue == InteractionFeedbackPolicy.Cue.ATTENTION_REQUIRED) {
            constant = HapticFeedbackConstants.CLOCK_TICK;
        }
        statusView.performHapticFeedback(constant);
    }

    private InteractionLatencyTracker.Attempt beginVoiceChoiceLatency(
        long startedAt
    ) {
        if (statusView == null) return null;
        OverlayPresentation.ProductSelectionBinding product =
            statusView.currentProductSelectionBinding();
        if (product != null) {
            return interactionLatencyTracker.start(
                InteractionLatencyTracker.Source.VOICE,
                product.taskId,
                product.interactionId,
                product.selectionId,
                startedAt
            );
        }
        OverlayPresentation.CompletionInteraction completion =
            statusView.currentCompletionInteraction();
        if (completion == null) return null;
        return interactionLatencyTracker.start(
            InteractionLatencyTracker.Source.VOICE,
            completion.taskId,
            completion.interactionId,
            null,
            startedAt
        );
    }

    private synchronized void finishActiveVoiceChoiceLatency(
        String outcome
    ) {
        InteractionLatencyTracker.Attempt latency =
            activeVoiceChoiceLatency;
        activeVoiceChoiceLatency = null;
        if (latency != null) {
            logInteractionLatency(latency.serverOutcome(outcome));
        }
    }

    private static String productLocalRejectionOutcome(
        ProductSelectionState.Status status
    ) {
        if (status == ProductSelectionState.Status.EXPIRED) return "stale";
        if (
            status == ProductSelectionState.Status.SUBMITTING
                || status == ProductSelectionState.Status.ACCEPTED
                || status == ProductSelectionState.Status.DUPLICATE
                || status == ProductSelectionState.Status.WORKING
        ) {
            return "duplicate";
        }
        return "cancelled";
    }

    private static String completionLocalRejectionOutcome(
        CompletionChoiceState.Status status
    ) {
        if (status == CompletionChoiceState.Status.EXPIRED) return "stale";
        if (
            status == CompletionChoiceState.Status.SUBMITTING
                || status == CompletionChoiceState.Status.ACCEPTED
                || status == CompletionChoiceState.Status.DUPLICATE
        ) {
            return "duplicate";
        }
        return "cancelled";
    }

    private static String productServerOutcome(
        ProductSelectionResponse outcome
    ) {
        if (outcome == null) return "invalid_response";
        if (
            outcome.disposition
                == ProductSelectionResponse.Disposition.ACCEPTED
        ) {
            return "accepted";
        }
        if (
            outcome.disposition
                == ProductSelectionResponse.Disposition.DUPLICATE
        ) {
            return "duplicate";
        }
        if (
            outcome.disposition
                == ProductSelectionResponse.Disposition.CONFLICT
        ) {
            return "conflict";
        }
        return interactionRejectionOutcome(outcome.reason);
    }

    private static String completionServerOutcome(
        String acknowledgement,
        String reason
    ) {
        if ("accepted".equals(acknowledgement)) return "accepted";
        if ("duplicate".equals(acknowledgement)) return "duplicate";
        return interactionRejectionOutcome(reason);
    }

    private static String interactionRejectionOutcome(String reason) {
        if ("cancelled".equals(reason)) return "cancelled";
        if (
            "expired".equals(reason)
                || "stale_revision".equals(reason)
                || "stale_clarification".equals(reason)
                || "stale_task_revision".equals(reason)
                || "unknown_interaction".equals(reason)
                || "unknown_clarification".equals(reason)
                || "already_resolved".equals(reason)
        ) {
            return "stale";
        }
        return "rejected";
    }

    private static void logInteractionLatency(
        InteractionLatencyTracker.Event event
    ) {
        if (event != null) Log.i(TAG, event.logLine());
    }

    private void persistLocalProductSelection(
        OverlayPresentation.ProductSelectionBinding binding,
        OverlayPresentation.ProductChoice option
    ) {
        if (binding == null || option == null) return;
        try {
            JSONObject snapshot = new JSONObject();
            snapshot.put("version", 1);
            snapshot.put("taskId", binding.taskId);
            snapshot.put("taskRevision", binding.taskRevision);
            snapshot.put("interactionId", binding.interactionId);
            snapshot.put("selectionId", binding.selectionId);
            snapshot.put("offerId", option.offerId);
            snapshot.put("status", ProductSelectionState.Status.SUBMITTING.name());
            snapshot.put("message", "Selection saved. Sending…");
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                .edit()
                .putString(LOCAL_SELECTION_KEY, snapshot.toString())
                .commit();
        } catch (Exception error) {
            Log.w(TAG, "selection.local_persist_failed", error);
        }
    }

    private boolean updateLocalProductSelectionStatus(
        ProductSelectionState.Status status,
        String message,
        String winnerOfferId
    ) {
        android.content.SharedPreferences preferences = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        );
        String raw = preferences.getString(LOCAL_SELECTION_KEY, null);
        try {
            JSONObject snapshot;
            if (raw == null) {
                OverlayPresentation.ProductSelectionBinding binding =
                    statusView == null
                        ? null
                        : statusView.currentProductSelectionBinding();
                if (binding == null || winnerOfferId == null) return false;
                snapshot = new JSONObject();
                snapshot.put("version", 1);
                snapshot.put("clientId", binding.clientId);
                snapshot.put("taskId", binding.taskId);
                snapshot.put("taskRevision", binding.taskRevision);
                snapshot.put("interactionId", binding.interactionId);
                snapshot.put("selectionId", binding.selectionId);
            } else {
                snapshot = new JSONObject(raw);
            }
            snapshot.put("status", status.name());
            snapshot.put("message", message);
            if (winnerOfferId != null) {
                snapshot.put("offerId", winnerOfferId);
            }
            return preferences.edit()
                .putString(LOCAL_SELECTION_KEY, snapshot.toString())
                .commit();
        } catch (Exception error) {
            clearLocalProductSelection();
            return false;
        }
    }

    private void restoreLocalProductSelection() {
        if (
            statusView == null
                || latestPresentation == null
                || latestPresentation.card.selection == null
        ) {
            return;
        }
        String raw = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getString(LOCAL_SELECTION_KEY, null);
        if (raw == null) return;
        try {
            JSONObject snapshot = new JSONObject(raw);
            if (snapshot.optInt("version", -1) != 1) {
                clearLocalProductSelection();
                return;
            }
            OverlayPresentation.ProductSelectionBinding binding =
                latestPresentation.card.selection;
            if (
                !binding.taskId.equals(snapshot.optString("taskId"))
                    || binding.taskRevision
                        != snapshot.optInt("taskRevision", -1)
                    || !binding.interactionId.equals(
                        snapshot.optString("interactionId")
                    )
                    || !binding.selectionId.equals(
                        snapshot.optString("selectionId")
                    )
            ) {
                clearLocalProductSelection();
                return;
            }
            ProductSelectionState.Status status =
                ProductSelectionState.Status.valueOf(
                    snapshot.optString("status", "WORKING")
                );
            if (status == ProductSelectionState.Status.SUBMITTING) {
                status = ProductSelectionState.Status.WORKING;
            }
            statusView.restoreProductChoiceSubmission(
                binding,
                snapshot.getString("offerId"),
                status,
                snapshot.optString(
                    "message",
                    "Selection saved. Checking acceptance…"
                )
            );
        } catch (Exception error) {
            clearLocalProductSelection();
        }
    }

    private void clearLocalProductSelection() {
        getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
            .edit()
            .remove(LOCAL_SELECTION_KEY)
            .apply();
    }

    private void restoreQueueState() {
        android.content.SharedPreferences preferences =
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE);
        String task = preferences.getString(
            QUEUE_TASK_PROJECTION_KEY,
            null
        );
        if (task != null) {
            try {
                queueTaskProjection = QueueTaskProjection.parse(
                    new JSONObject(task)
                );
            } catch (Exception ignored) {
                queueTaskProjection = null;
            }
            if (queueTaskProjection == null) {
                preferences.edit()
                    .remove(QUEUE_TASK_PROJECTION_KEY)
                    .apply();
            }
        }
        String pending = preferences.getString(
            QUEUE_PENDING_COMMAND_KEY,
            null
        );
        if (pending != null) queueCommandState.restore(pending);
    }

    private void restorePendingQueueCommand() {
        String pending = queueCommandState.pendingPayload();
        if (pending == null || queueTaskProjection == null) return;
        try {
            JSONObject request = new JSONObject(pending);
            if (
                request.optInt("version", -1) != 2
                    || !queueTaskProjection.taskId.equals(
                        request.optString("taskId", "")
                    )
                    || request.optInt("taskRevision", -1)
                        != queueTaskProjection.taskRevision
                    || !request.optString("commandId", "")
                        .matches(
                            "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$"
                        )
                    || request.optJSONObject("command") == null
            ) {
                getSharedPreferences(
                    OVERLAY_PREFERENCES,
                    MODE_PRIVATE
                ).edit()
                    .remove(QUEUE_PENDING_COMMAND_KEY)
                    .apply();
                return;
            }
            statusView.setQueueSubmissionState(
                false,
                "Restored a pending task-list update."
            );
            submitQueuePayload(pending);
        } catch (Exception error) {
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                .edit()
                .remove(QUEUE_PENDING_COMMAND_KEY)
                .apply();
        }
    }

    private void persistLocalRecoveryAction(
        RecoveryActionBinding binding,
        CompanionIssueV2.RecoveryAction action
    ) {
        if (binding == null || action == null) return;
        try {
            JSONObject snapshot = new JSONObject();
            snapshot.put("version", 2);
            snapshot.put("interactionId", binding.interactionId);
            snapshot.put("operationId", binding.operationId);
            snapshot.put("stepId", binding.stepId);
            snapshot.put("taskId", binding.taskId);
            snapshot.put("taskRevision", binding.taskRevision);
            snapshot.put("actionId", action.actionId);
            snapshot.put(
                "status",
                RecoveryActionState.Status.SUBMITTING.name()
            );
            snapshot.put(
                "message",
                "Recovery request received. Checking safely…"
            );
            if (
                !getSharedPreferences(
                    OVERLAY_PREFERENCES,
                    MODE_PRIVATE
                ).edit()
                    .putString(
                        LOCAL_RECOVERY_ACTION_KEY,
                        snapshot.toString()
                    )
                    .commit()
            ) {
                Log.e(TAG, "recovery_action.local_persist_failed");
            }
        } catch (Exception error) {
            Log.w(TAG, "recovery_action.local_persist_failed", error);
        }
    }

    private void updateLocalRecoveryAction(
        RecoveryActionState.Status status,
        String message
    ) {
        android.content.SharedPreferences preferences =
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE);
        String raw = preferences.getString(
            LOCAL_RECOVERY_ACTION_KEY,
            null
        );
        if (raw == null) return;
        try {
            JSONObject snapshot = new JSONObject(raw);
            snapshot.put("status", status.name());
            snapshot.put("message", message);
            if (
                !preferences.edit()
                    .putString(
                        LOCAL_RECOVERY_ACTION_KEY,
                        snapshot.toString()
                    )
                    .commit()
            ) {
                Log.e(TAG, "recovery_action.status_persist_failed");
            }
        } catch (Exception error) {
            clearLocalRecoveryAction();
        }
    }

    private void restoreLocalRecoveryAction() {
        if (statusView == null) return;
        CompanionIssueV2 issue = statusView.currentCompanionIssue();
        RecoveryActionBinding binding =
            issue == null ? null : issue.recoveryInteraction;
        String raw = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getString(LOCAL_RECOVERY_ACTION_KEY, null);
        if (raw == null) return;
        try {
            JSONObject snapshot = new JSONObject(raw);
            if (
                snapshot.optInt("version", -1) != 2
                    || binding == null
                    || !binding.taskId.equals(
                        snapshot.optString("taskId")
                    )
                    || binding.taskRevision
                        != snapshot.optInt("taskRevision", -1)
                    || !binding.interactionId.equals(
                        snapshot.optString("interactionId")
                    )
                    || !binding.operationId.equals(
                        snapshot.optString("operationId")
                    )
                    || !binding.stepId.equals(
                        snapshot.optString("stepId")
                    )
            ) {
                clearLocalRecoveryAction();
                return;
            }
            String actionId = snapshot.getString("actionId");
            boolean actionExists = false;
            for (CompanionIssueV2.RecoveryAction action :
                issue.recoveryActions) {
                if (action.actionId.equals(actionId)) {
                    actionExists = true;
                    break;
                }
            }
            if (!actionExists) {
                clearLocalRecoveryAction();
                return;
            }
            RecoveryActionState.Status status =
                RecoveryActionState.Status.valueOf(
                    snapshot.optString("status", "REJECTED")
                );
            statusView.restoreRecoveryActionSubmission(
                issue,
                actionId,
                status,
                snapshot.optString(
                    "message",
                    "Checking saved recovery request…"
                )
            );
        } catch (Exception error) {
            clearLocalRecoveryAction();
        }
    }

    private void clearLocalRecoveryAction() {
        getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
            .edit()
            .remove(LOCAL_RECOVERY_ACTION_KEY)
            .apply();
    }

    private void retainVerifiedCartSummary(
        OverlayPresentation presentation
    ) {
        if (
            presentation == null
                || presentation.card.cartSummary == null
                || !presentation.card.cartSummary.isVerifiedNotOrdered()
        ) {
            return;
        }
        retainedCartSummary = presentation.card.cartSummary;
        if (statusView != null) {
            statusView.setRetainedCartSummary(retainedCartSummary);
        }
        String encoded = OverlayRecoverySnapshot.encode(
            presentation,
            true,
            System.currentTimeMillis()
        );
        if (encoded != null) {
            getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
                .edit()
                .putString(VERIFIED_CART_KEY, encoded)
                .apply();
        }
    }

    private void restoreVerifiedCartSummary() {
        String encoded = getSharedPreferences(
            OVERLAY_PREFERENCES,
            MODE_PRIVATE
        ).getString(VERIFIED_CART_KEY, null);
        OverlayRecoverySnapshot.Restored restored =
            OverlayRecoverySnapshot.decode(
                encoded,
                System.currentTimeMillis()
            );
        if (
            restored != null
                && restored.presentation.card.cartSummary != null
                && restored.presentation.card.cartSummary
                    .isVerifiedNotOrdered()
        ) {
            retainedCartSummary = restored.presentation.card.cartSummary;
        }
    }

    private void scheduleCollapseIfAllowed() {
        mainHandler.removeCallbacks(collapseRunnable);
        if (
            latestPresentation == null
                || !OverlayLifecyclePolicy.collapseAllowed(
                    latestPresentation.autoCollapse,
                    recording,
                    uploading,
                    selectionSubmitting || completionSubmitting,
                    speaking || announcementSpeaking,
                    latestPresentation.keepVisibleWhileSpeaking,
                    devicePaused
                )
        ) {
            return;
        }
        long delay = latestPresentation.collapseAfterMs > 0
            ? latestPresentation.collapseAfterMs
            : AUTO_COLLAPSE_MS;
        mainHandler.postDelayed(collapseRunnable, delay);
    }

    private void setExpanded(boolean shouldExpand, boolean animate) {
        if (statusView == null || layoutParams == null) return;
        mainHandler.removeCallbacks(collapseRunnable);
        expanded = shouldExpand;
        statusView.render(latestPresentation, shouldExpand);
        if (!shouldExpand && attentionView != null) attentionView.hide();

        Rect safeFrame = safeDisplayFrame();
        int screenWidth = safeFrame.width();
        int screenHeight = safeFrame.height();
        int targetWidth = Math.min(
            dp(statusView.desiredWidthDp(shouldExpand)),
            screenWidth - dp(24)
        );
        int targetHeight = Math.min(
            dp(statusView.desiredHeightDp(shouldExpand)),
            screenHeight - dp(48)
        );
        final int startingWidth = layoutParams.width;
        final int startingHeight = layoutParams.height;
        if (startingWidth == targetWidth && startingHeight == targetHeight) {
            updateAttention();
            persistRecoveryState();
            return;
        }

        if (widthAnimator != null) widthAnimator.cancel();
        final int startingRight = layoutParams.x + startingWidth;
        final boolean anchoredRight =
            startingRight > safeFrame.left + screenWidth / 2;

        if (!animate || !animationsEnabled()) {
            layoutParams.width = targetWidth;
            layoutParams.height = targetHeight;
            if (anchoredRight) layoutParams.x = startingRight - targetWidth;
            layoutParams.x = clampX(layoutParams.x);
            layoutParams.y = clampY(layoutParams.y);
            windowManager.updateViewLayout(statusView, layoutParams);
            updateAttention();
            persistRecoveryState();
            return;
        }

        final int finalTargetWidth = targetWidth;
        final int finalTargetHeight = targetHeight;
        widthAnimator = ValueAnimator.ofFloat(0f, 1f);
        widthAnimator.setDuration(220);
        widthAnimator.setInterpolator(new AccelerateDecelerateInterpolator());
        widthAnimator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(ValueAnimator animation) {
                float progress = (Float) animation.getAnimatedValue();
                layoutParams.width = Math.round(
                    startingWidth + (finalTargetWidth - startingWidth) * progress
                );
                layoutParams.height = Math.round(
                    startingHeight + (finalTargetHeight - startingHeight) * progress
                );
                if (anchoredRight) layoutParams.x = startingRight - layoutParams.width;
                layoutParams.x = clampX(layoutParams.x);
                layoutParams.y = clampY(layoutParams.y);
                windowManager.updateViewLayout(statusView, layoutParams);
                if (progress >= 1f) updateAttention();
            }
        });
        widthAnimator.start();
        persistRecoveryState();
    }

    private boolean animationsEnabled() {
        float animatorScale = Settings.Global.getFloat(
            getContentResolver(),
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f
        );
        PowerManager powerManager =
            (PowerManager) getSystemService(POWER_SERVICE);
        return MotionPolicy.animationsEnabled(
            animatorScale,
            powerManager != null && powerManager.isPowerSaveMode()
        );
    }

    private void updateAttention() {
        if (attentionView == null || latestPresentation == null) return;
        if (captureSuppressed || !expanded) {
            attentionView.hide();
            return;
        }
        if (
            "product_choices".equals(latestPresentation.card.type)
                || "cart_summary".equals(latestPresentation.card.type)
                || "completion_choices".equals(
                    latestPresentation.card.type
                )
        ) {
            attentionView.hide();
            return;
        }
        if (exactAttentionCommand != null) {
            if (
                exactAttentionCommand.expiresAtEpochMs
                        <= System.currentTimeMillis()
                    || !exactAttentionCommand.matchesDisplay(
                        getResources().getDisplayMetrics().widthPixels,
                        getResources().getDisplayMetrics().heightPixels,
                        getResources().getDisplayMetrics().densityDpi,
                        currentRotationDegrees()
                    )
            ) {
                clearExactAttention();
            } else {
                attentionView.showExact(
                    exactAttentionCommand.overlayRectPx,
                    layoutParams.x + layoutParams.width / 2f,
                    layoutParams.y + layoutParams.height / 2f
                );
                return;
            }
        }
        String broadSubject = broadAttentionOverride;
        if (
            broadSubject == null
                && latestPresentation.usesProviderScreen()
        ) {
            broadSubject = latestPresentation.attentionSubject;
        }
        if (broadSubject == null) {
            attentionView.hide();
            return;
        }
        attentionView.showBroad(
            broadSubject,
            layoutParams.x + layoutParams.width / 2f,
            layoutParams.y + layoutParams.height / 2f
        );
    }

    private void receiveSpatialAttention(String encodedPayload) {
        try {
            String rawPayload = new String(
                Base64.decode(encodedPayload, Base64.DEFAULT),
                StandardCharsets.UTF_8
            );
            if (rawPayload.length() > 12000) {
                throw new IllegalArgumentException("attention payload too large");
            }
            SpatialAttentionCommand command = SpatialAttentionCommand.parse(
                new JSONObject(rawPayload),
                System.currentTimeMillis()
            );
            if (
                !command.matchesDisplay(
                    getResources().getDisplayMetrics().widthPixels,
                    getResources().getDisplayMetrics().heightPixels,
                    getResources().getDisplayMetrics().densityDpi,
                    currentRotationDegrees()
                )
            ) {
                throw new IllegalArgumentException("attention display changed");
            }
            clearExactAttention();
            broadAttentionOverride = null;
            exactAttentionCommand = command;
            mainHandler.postDelayed(
                attentionExpiryRunnable,
                Math.max(
                    1L,
                    command.expiresAtEpochMs - System.currentTimeMillis()
                )
            );
            updateAttention();
        } catch (Exception ignored) {
            clearSpatialAttention();
        }
    }

    private void clearExactAttention() {
        exactAttentionCommand = null;
        mainHandler.removeCallbacks(attentionExpiryRunnable);
    }

    private void clearSpatialAttention() {
        clearExactAttention();
        broadAttentionOverride = null;
        if (attentionView != null) attentionView.hide();
    }

    private boolean isBroadAttentionSubject(String value) {
        return "options".equals(value)
            || "product".equals(value)
            || "cart".equals(value)
            || "checkout".equals(value)
            || "payment".equals(value)
            || "address".equals(value)
            || "confirmation".equals(value)
            || "recent_orders".equals(value);
    }

    @SuppressWarnings("deprecation")
    private int currentRotationDegrees() {
        if (windowManager == null) return 0;
        int rotation = windowManager.getDefaultDisplay().getRotation();
        if (rotation == Surface.ROTATION_90) return 90;
        if (rotation == Surface.ROTATION_180) return 180;
        if (rotation == Surface.ROTATION_270) return 270;
        return 0;
    }

    private int clampX(int x) {
        Rect frame = safeDisplayFrame();
        int margin = dp(8);
        int minimum = frame.left + margin;
        int maximum = frame.right
            - layoutParams.width
            - margin;
        return Math.max(
            minimum,
            Math.min(x, Math.max(minimum, maximum))
        );
    }

    private int clampY(int y) {
        Rect frame = safeDisplayFrame();
        int margin = dp(8);
        int minimum = frame.top + margin;
        int maximum = frame.bottom
            - layoutParams.height
            - margin;
        return Math.max(
            minimum,
            Math.min(y, Math.max(minimum, maximum))
        );
    }

    private Rect safeDisplayFrame() {
        Rect frame = new Rect(
            0,
            0,
            getResources().getDisplayMetrics().widthPixels,
            getResources().getDisplayMetrics().heightPixels
        );
        if (statusView != null && statusView.isAttachedToWindow()) {
            Rect visible = new Rect();
            statusView.getWindowVisibleDisplayFrame(visible);
            if (visible.width() >= dp(120) && visible.height() >= dp(120)) {
                frame = visible;
            }
        }
        return frame;
    }

    private void savePosition() {
        getSharedPreferences(OVERLAY_PREFERENCES, MODE_PRIVATE)
            .edit()
            .putInt("x", layoutParams.x)
            .putInt("y", layoutParams.y)
            .apply();
    }

    private void releaseRecorder() {
        recording = false;
        mainHandler.removeCallbacks(audioLevelRunnable);
        if (statusView != null) statusView.companionGlyph().setAudioLevel(0f);
        if (recorder != null) {
            recorder.release();
            recorder = null;
        }
    }

    private void releasePlayer() {
        speaking = false;
        releasePlaybackVisualizer();
        if (statusView != null) {
            statusView.companionGlyph().setAudioLevel(0f);
        }
        if (player != null) {
            player.release();
            player = null;
        }
    }

    private void releasePlaybackVisualizer() {
        if (playbackVisualizer == null) return;
        try {
            playbackVisualizer.setEnabled(false);
        } catch (Exception ignored) {
            // Release remains safe if audio teardown raced the callback.
        }
        try {
            playbackVisualizer.release();
        } catch (Exception ignored) {
            // A released audio session may already own teardown.
        }
        playbackVisualizer = null;
    }

    private static void writeTextPart(
        DataOutputStream output,
        String boundary,
        String name,
        String value
    ) throws Exception {
        output.writeBytes("--" + boundary + "\r\n");
        output.writeBytes(
            "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n"
        );
        output.write(value.getBytes(StandardCharsets.UTF_8));
        output.writeBytes("\r\n");
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        BufferedReader reader = new BufferedReader(
            new InputStreamReader(stream, StandardCharsets.UTF_8)
        );
        StringBuilder result = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) result.append(line);
        reader.close();
        return result.toString();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
