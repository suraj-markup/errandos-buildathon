package ai.errandos.overlay;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.widget.ImageButton;
import android.util.Base64;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class OverlayService extends Service {
    public static final String ACTION_STATUS = "ai.errandos.overlay.STATUS";
    private static final String CHANNEL_ID = "errandos_overlay";
    private static final int NOTIFICATION_ID = 73;
    private static final String VOICE_TURN_URL =
        "http://127.0.0.1:3100/api/voice/turn";

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private WindowManager windowManager;
    private WindowManager.LayoutParams layoutParams;
    private ImageButton statusView;
    private BroadcastReceiver receiver;
    private MediaRecorder recorder;
    private MediaPlayer player;
    private File recordingFile;
    private boolean recording;
    private volatile boolean uploading;

    @Override
    public void onCreate() {
        super.onCreate();
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
        if (receiver != null) unregisterReceiver(receiver);
        releaseRecorder();
        releasePlayer();
        networkExecutor.shutdownNow();
        if (windowManager != null && statusView != null) {
            windowManager.removeView(statusView);
        }
        super.onDestroy();
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
        statusView = new ImageButton(this);
        statusView.setImageResource(android.R.drawable.ic_btn_speak_now);
        statusView.setColorFilter(Color.WHITE);
        statusView.setContentDescription("JaldiAI. Press and hold to speak.");
        statusView.setPadding(dp(17), dp(17), dp(17), dp(17));
        statusView.setScaleType(ImageButton.ScaleType.FIT_CENTER);
        statusView.setBackground(backgroundFor("ready"));
        statusView.setElevation(dp(10));

        layoutParams = new WindowManager.LayoutParams(
            dp(64),
            dp(64),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );
        layoutParams.gravity = Gravity.TOP | Gravity.START;
        layoutParams.x = getResources().getDisplayMetrics().widthPixels - dp(80);
        layoutParams.y = dp(76);

        installTouchBehavior();
        windowManager.addView(statusView, layoutParams);
    }

    private void installTouchBehavior() {
        statusView.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View view, MotionEvent event) {
                if (event.getAction() == MotionEvent.ACTION_DOWN) {
                    view.setPressed(true);
                    view.setScaleX(0.92f);
                    view.setScaleY(0.92f);
                    view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK);
                    if (uploading) {
                        setStatus("Still working on your last request.", "working");
                    } else if (!recording) {
                        startRecording();
                    }
                    return true;
                }
                if (
                    event.getAction() == MotionEvent.ACTION_UP
                        || event.getAction() == MotionEvent.ACTION_CANCEL
                ) {
                    view.setPressed(false);
                    view.setScaleX(1f);
                    view.setScaleY(1f);
                    if (event.getAction() == MotionEvent.ACTION_UP) view.performClick();
                    if (recording) stopRecording();
                    return true;
                }
                return true;
            }
        });
    }

    private void startRecording() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            setStatus("Open JaldiAI once to allow microphone access.", "error");
            Intent permission = new Intent(this, MainActivity.class);
            permission.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(permission);
            return;
        }

        releasePlayer();
        recordingFile = new File(getCacheDir(), "voice-command.m4a");
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
            setStatus("Listening while you hold.", "listening");
        } catch (Exception error) {
            releaseRecorder();
            setStatus("I couldn't start the microphone.", "error");
        }
    }

    private void stopRecording() {
        try {
            recorder.stop();
        } catch (RuntimeException error) {
            releaseRecorder();
            setStatus("I didn't hear enough audio. Hold and try again.", "error");
            return;
        }
        releaseRecorder();
        uploading = true;
        setStatus("Understanding and doing the task…", "working");
        networkExecutor.execute(new Runnable() {
            @Override
            public void run() {
                uploadVoiceTurn();
            }
        });
    }

    private void uploadVoiceTurn() {
        HttpURLConnection connection = null;
        try {
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
            while ((count = audio.read(buffer)) != -1) output.write(buffer, 0, count);
            audio.close();
            output.writeBytes("\r\n--" + boundary + "--\r\n");
            output.flush();
            output.close();

            int responseCode = connection.getResponseCode();
            InputStream responseStream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            String body = readAll(responseStream);
            JSONObject result = new JSONObject(body);
            if (responseCode < 200 || responseCode >= 300 || !result.optBoolean("ok")) {
                throw new Exception(result.optString("error", "The voice request failed."));
            }

            final String reply = result.optString("reply", "Done.");
            final String state = result.optString("assistantState", "ready");
            final String audioBase64 = result.optString("audioBase64", "");
            statusView.post(new Runnable() {
                @Override
                public void run() {
                    setStatus(reply, state);
                    if (!audioBase64.isEmpty()) playSarvamAudio(audioBase64);
                }
            });
        } catch (final Exception error) {
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
            if (connection != null) connection.disconnect();
        }
    }

    private void playSarvamAudio(String audioBase64) {
        releasePlayer();
        try {
            byte[] audio = Base64.decode(audioBase64, Base64.DEFAULT);
            File replyFile = new File(getCacheDir(), "sarvam-reply.mp3");
            FileOutputStream output = new FileOutputStream(replyFile);
            output.write(audio);
            output.close();

            player = new MediaPlayer();
            player.setDataSource(replyFile.getAbsolutePath());
            player.prepare();
            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mediaPlayer) {
                    releasePlayer();
                }
            });
            player.start();
        } catch (Exception error) {
            setStatus("The task replied, but audio playback failed.", "error");
        }
    }

    private void registerStatusReceiver() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String message = intent.getStringExtra("message");
                String state = intent.getStringExtra("state");
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

    private void setStatus(String message, String state) {
        statusView.setContentDescription("JaldiAI. " + message);
        if (Build.VERSION.SDK_INT >= 26) statusView.setTooltipText(message);
        statusView.setImageResource(iconFor(state));
        statusView.setBackground(backgroundFor(state));
        statusView.animate().cancel();
        if (
            "working".equals(state)
                || "searching".equals(state)
                || "adding".equals(state)
                || "checkout".equals(state)
        ) {
            statusView.animate()
                .rotationBy(360f)
                .setDuration(650)
                .setInterpolator(new AccelerateDecelerateInterpolator())
                .start();
        } else {
            statusView.setRotation(0f);
        }
    }

    private int iconFor(String state) {
        if ("listening".equals(state)) return android.R.drawable.ic_media_pause;
        if ("searching".equals(state)) return android.R.drawable.ic_menu_search;
        if ("adding".equals(state)) return android.R.drawable.ic_input_add;
        if ("checkout".equals(state)) return android.R.drawable.ic_menu_agenda;
        if ("confirmation".equals(state)) return android.R.drawable.ic_lock_lock;
        if ("success".equals(state)) return android.R.drawable.checkbox_on_background;
        if ("clarification".equals(state)) return android.R.drawable.ic_dialog_info;
        if ("error".equals(state)) return android.R.drawable.ic_dialog_alert;
        if ("working".equals(state)) return android.R.drawable.ic_popup_sync;
        return android.R.drawable.ic_btn_speak_now;
    }

    private void releaseRecorder() {
        recording = false;
        if (recorder != null) {
            recorder.release();
            recorder = null;
        }
    }

    private void releasePlayer() {
        if (player != null) {
            player.release();
            player = null;
        }
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

    private GradientDrawable backgroundFor(String state) {
        int color;
        if ("success".equals(state)) color = Color.rgb(35, 84, 55);
        else if ("clarification".equals(state)) color = Color.rgb(117, 75, 22);
        else if ("error".equals(state)) color = Color.rgb(118, 42, 42);
        else if ("listening".equals(state)) color = Color.rgb(188, 45, 58);
        else if ("searching".equals(state)) color = Color.rgb(26, 96, 113);
        else if ("adding".equals(state)) color = Color.rgb(92, 55, 132);
        else if ("checkout".equals(state)) color = Color.rgb(45, 74, 122);
        else if ("confirmation".equals(state)) color = Color.rgb(142, 91, 20);
        else if ("working".equals(state)) color = Color.rgb(42, 62, 99);
        else color = Color.rgb(28, 31, 25);

        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setShape(GradientDrawable.OVAL);
        background.setStroke(dp(1), Color.argb(90, 220, 255, 116));
        return background;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
