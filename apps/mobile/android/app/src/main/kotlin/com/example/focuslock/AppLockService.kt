package com.example.focuslock

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.SystemClock

/**
 * Owns the irreversible Time Lock while it is armed.
 *
 * It is a sticky foreground service so the lock survives the user swiping the
 * app away, and it is restarted by [TimeLockReceiver] (a minute tick) and by
 * [BootReceiver] after a reboot. While [LockedDurationManager.state] says the
 * lock is active:
 *
 *  - The notification shows the remaining time and offers **no** stop/reset.
 *  - An ACTION_STOP is ignored (there is no local way to disarm).
 *  - During the schedule window, Locked Mode or a 24/7 schedule it keeps
 *    [FocusLockService] (and therefore the VPN filter) running.
 *  - Every tick checkpoints the monotonic timer so a reboot loses at most one
 *    tick of counted time, and wall-clock tampering is flagged.
 *
 * Mutating the schedule / block list while locked is refused by
 * [LockedDurationManager] and by the `focuslock/timelock` channel gates.
 */
class AppLockService : Service() {

    companion object {
        const val ACTION_ARM = "com.example.focuslock.action.TIMELOCK_ARM"
        const val ACTION_TICK = "com.example.focuslock.action.TIMELOCK_TICK"
        const val ACTION_REFRESH = "com.example.focuslock.action.TIMELOCK_REFRESH"
        const val ACTION_STOP = "com.example.focuslock.action.TIMELOCK_STOP"

        const val EXTRA_DURATION_DAYS = "durationDays"
        const val EXTRA_LOCKED_MODE = "lockedMode"
        const val EXTRA_SCHEDULE_MODE = "scheduleMode"
        const val EXTRA_START_MINUTES = "startMinutes"
        const val EXTRA_END_MINUTES = "endMinutes"

        private const val CHANNEL_ID = "focuslock_app_lock"
        private const val NOTIFICATION_ID = 3
        private const val TICK_MILLIS = 60_000L

        fun start(context: Context) {
            val intent = Intent(context, AppLockService::class.java).setAction(ACTION_REFRESH)
            start(context, intent)
        }

        /** Arms via the service so the FGS starts even from the background. */
        fun arm(
            context: Context,
            durationDays: Int,
            lockedMode: Boolean,
            scheduleMode: LockedDurationManager.ScheduleMode,
            startMinutes: Int,
            endMinutes: Int,
        ) {
            val intent = Intent(context, AppLockService::class.java)
                .setAction(ACTION_ARM)
                .putExtra(EXTRA_DURATION_DAYS, durationDays)
                .putExtra(EXTRA_LOCKED_MODE, lockedMode)
                .putExtra(EXTRA_SCHEDULE_MODE, scheduleMode.name)
                .putExtra(EXTRA_START_MINUTES, startMinutes)
                .putExtra(EXTRA_END_MINUTES, endMinutes)
            start(context, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, AppLockService::class.java).setAction(ACTION_STOP)
            try {
                context.startService(intent)
            } catch (_: Exception) {
                // Nothing to stop.
            }
        }

        private fun start(context: Context, intent: Intent) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (_: Exception) {
                // Background FGS start refused; BootReceiver / next launch retries.
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Promotion must happen immediately on a foreground request even when
        // the lock has just expired, or Android kills the process.
        startForegroundQuietly()

        when (intent?.action) {
            ACTION_ARM -> {
                val mode = runCatching {
                    LockedDurationManager.ScheduleMode.valueOf(
                        intent.getStringExtra(EXTRA_SCHEDULE_MODE) ?: "ALL_DAY",
                    )
                }.getOrDefault(LockedDurationManager.ScheduleMode.ALL_DAY)
                try {
                    LockedDurationManager.arm(
                        this,
                        intent.getIntExtra(EXTRA_DURATION_DAYS, 90),
                        intent.getBooleanExtra(EXTRA_LOCKED_MODE, false),
                        mode,
                        intent.getIntExtra(EXTRA_START_MINUTES, 0),
                        intent.getIntExtra(EXTRA_END_MINUTES, 0),
                    )
                } catch (_: IllegalStateException) {
                    // Already locked: keep the original (stricter) lock.
                }
                enforce()
            }

            ACTION_STOP -> {
                // Ignored while locked: there is no local disarm.
                if (!LockedDurationManager.isLocked(this)) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    cancelTick()
                    stopSelf()
                    return START_NOT_STICKY
                }
                enforce()
            }

            ACTION_TICK, ACTION_REFRESH -> enforce()

            else -> enforce()
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app away must not cancel the lock tick.
        if (LockedDurationManager.isLocked(this)) {
            scheduleTick()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (LockedDurationManager.isLocked(this)) {
            // Best-effort; START_STICKY also asks the system to recreate us.
            scheduleTick()
        }
        super.onDestroy()
    }

    private fun enforce() {
        val state = LockedDurationManager.state(this)
        if (!state.locked) {
            cancelTick()
            stopForeground(STOP_FOREGROUND_REMOVE)
            AccessibilityHealthService.sync(this)
            stopSelf()
            return
        }

        LockedDurationManager.checkpoint(this)
        scheduleTick()

        // Accessibility watchdog: while the lock is armed, keep a second,
        // ordinary-process-lane service that resurrects the a11y guard if the
        // OEM drops it (battery sleep, crash, "autostart" off).
        AccessibilityHealthService.sync(this)

        if (state.scheduleActiveNow) {
            ensureFocusProtection()
        }

        startForeground(NOTIFICATION_ID, buildNotification())
    }

    private fun startForegroundQuietly() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                startForeground(NOTIFICATION_ID, buildNotification())
            } catch (_: Exception) {
                // Channel race on the very first start; retried in enforce().
            }
        }
    }

    private fun ensureFocusProtection() {
        try {
            val intent = Intent(this, FocusLockService::class.java)
                .setAction(FocusLockService.ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } catch (_: Exception) {
            // The VPN / FGS will be restarted by the next tick or boot.
        }
    }

    // --------------------------------------------------------------- ticking

    private fun scheduleTick() {
        val alarm = getSystemService(AlarmManager::class.java) ?: return
        val pending = tickPendingIntent()
        val at = SystemClock.elapsedRealtime() + TICK_MILLIS
        try {
            // ELAPSED_REALTIME is monotonic, matching the trusted clock, and
            // setAndAllowWhileIdle avoids needing the exact-alarm permission.
            alarm.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending)
        } catch (_: SecurityException) {
            // Even if the alarm is refused START_STICKY keeps us alive.
        }
    }

    private fun cancelTick() {
        getSystemService(AlarmManager::class.java)?.cancel(tickPendingIntent())
    }

    private fun tickPendingIntent(): PendingIntent {
        val intent = Intent(this, TimeLockReceiver::class.java)
            .setAction(TimeLockReceiver.ACTION_TICK)
        return PendingIntent.getBroadcast(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    // ---------------------------------------------------------- notification

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "FocusLock time lock",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Counts down the irreversible FocusLock time lock"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val state = LockedDurationManager.state(this)
        val schedule = when {
            state.lockedMode -> "Locked Mode — blocked 24/7"
            state.scheduleMode == LockedDurationManager.ScheduleMode.ALL_DAY -> "Blocked 24/7"
            else -> "Daily %s – %s".format(
                formatClock(state.startMinutes),
                formatClock(state.endMinutes),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("FocusLock — قفل الوقت مفعّل")
            .setContentText("$schedule • remaining ${formatRemaining(state.remainingMillis)}")
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    0,
                    Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .build()
    }

    private fun formatRemaining(millis: Long): String {
        val totalMinutes = millis / 60_000
        val days = totalMinutes / (24 * 60)
        val hours = (totalMinutes % (24 * 60)) / 60
        val minutes = totalMinutes % 60
        return when {
            days > 0 -> "${days}d ${hours}h"
            hours > 0 -> "${hours}h ${minutes}m"
            else -> "${minutes}m"
        }
    }

    private fun formatClock(minutesOfDay: Int): String =
        "%02d:%02d".format(minutesOfDay / 60, minutesOfDay % 60)
}

/** AlarmManager tick: wakes the lock service to checkpoint + re-evaluate. */
class TimeLockReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_TICK = "com.example.focuslock.action.TIMELOCK_ALARM"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TICK) return
        val serviceIntent = Intent(context, AppLockService::class.java)
            .setAction(AppLockService.ACTION_TICK)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (_: Exception) {
            // Retried on the next alarm / boot / app launch.
        }
    }
}