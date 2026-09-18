package com.example.focuslock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.util.Locale

/**
 * The 2-hour mandatory wait that is the cooldown path of the deactivation gate.
 *
 * When a deactivation/uninstall attempt actually revokes the admin, [DeviceAdminBlocker]
 * re-arms it instantly and starts this service: a persistent, ongoing
 * foreground notification counts down from 02:00:00. While it runs, a watchdog
 * calls [DeviceAdminBlocker.rearm] every minute, so even an immediately
 * re-revoked admin snaps back before the user can complete a second attempt.
 *
 * When the window expires the service stops itself and the notification is
 * removed; the admin stays active (protection continues). The countdown uses
 * the wall clock so it survives a reboot.
 */
class DeactivationCooldownService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val tickRunnable = object : Runnable {
        override fun run() {
            if (!DeactivationGate.isCooldownActive(this@DeactivationCooldownService)) {
                // Window elapsed: release the notification.
                finishCooldown()
                return
            }
            DeviceAdminBlocker.rearm(this@DeactivationCooldownService)
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, buildNotification())
            handler.postDelayed(this, TICK_MILLIS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!DeactivationGate.isCooldownActive(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
        handler.removeCallbacks(tickRunnable)
        handler.post(tickRunnable)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tickRunnable)
        super.onDestroy()
    }

    private fun finishCooldown() {
        handler.removeCallbacks(tickRunnable)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.deactivation_cooldown_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.deactivation_cooldown_channel_desc)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val remaining = DeactivationGate.cooldownRemainingMillis(this)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return builder
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle(
                getString(R.string.deactivation_cooldown_title, formatRemaining(remaining)),
            )
            .setContentText(getString(R.string.deactivation_cooldown_body))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent)
            .build()
    }

    private fun formatRemaining(millis: Long): String {
        val totalSec = millis / 1000
        val h = totalSec / 3600
        val m = (totalSec % 3600) / 60
        val s = totalSec % 60
        return String.format(Locale.US, "%02d:%02d:%02d", h, m, s)
    }

    companion object {
        private const val CHANNEL_ID = "deactivation_cooldown"
        private const val NOTIFICATION_ID = 3
        private const val TICK_MILLIS = 60_000L

        fun start(context: Context) {
            val intent = Intent(context, DeactivationCooldownService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Stops the service and removes the notification (state stays intact). */
        fun cancel(context: Context) {
            try {
                context.stopService(Intent(context, DeactivationCooldownService::class.java))
            } catch (_: Exception) {
                // Already stopped; nothing to cancel.
            }
        }
    }
}