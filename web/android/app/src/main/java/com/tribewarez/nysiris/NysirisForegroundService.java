package com.tribewarez.nysiris;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the WebView process — and therefore the mixnet
 * tunnel inside it — alive while the app is backgrounded.
 *
 * <p>Android Doze / App Standby freeze background apps, which would suspend the
 * one-shot WASM tunnel running in the WebView. A foreground service with an
 * ongoing notification raises the process priority so the tunnel keeps running.
 * The service holds no networking of its own; JS control is
 * {@code web/src/adapters/driven/foreground.mjs} via {@link NysirisForegroundPlugin}.
 */
public class NysirisForegroundService extends Service {

    public static final String CHANNEL_ID = "nysiris_connection";
    private static final int NOTIFICATION_ID = 0x4e59; // "NY"

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        // Restart with the last intent if the OS reclaims the process.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopForeground(true);
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        "Private connection",
                        NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("Keeps your Nysiris connection running in the background.");
                channel.setShowBadge(false);
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, pendingFlags);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Nysiris")
                .setContentText("Private connection is running")
                .setSmallIcon(R.drawable.ic_stat_shield)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }
}
