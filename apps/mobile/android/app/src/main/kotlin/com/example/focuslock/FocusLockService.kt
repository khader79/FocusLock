package com.example.focuslock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * The persistent foreground service that implements the "FocusLock Active"
 * experience on Android.
 *
 *  - Shows an ongoing, persistent notification while the focus session runs.
 *  - The notification carries a **Pause** action. Tapping Pause launches the
 *    Flutter app into the challenge modal; the session is only paused after
 *    the typing challenge is verified natively (see [togglePause]).
 *  - Coordinates with [FocusVpnService]: the VPN keeps blocking DNS until a
 *    verified pause flips `ProtectionStore.isPaused`, at which point the tunnel
 *    passes blocked domains through again.
 *
 * **Anti-kill contract.** [onTaskRemoved] / [onDestroy] arm an exact alarm
 * (`setExactAndAllowWhileIdle` + `PendingIntent.getForegroundService`) through
 * [AntiKill.scheduleRestart], which resurrects the service ~1s after a
 * recents-swipe or an OS kill without relying on `START_STICKY`. A 15-minute
 * [WatchdogJobService] pulse verifies this service is alive and force-launches
 * it otherwise, and the user is prompted to whitelist FocusLock from battery
 * optimizations so every component of the ladder stays exact and Doze-safe.
 *
 * Constants replicate the launch-action contract used by [MainActivity].
 */
class FocusLockService : Service() {

    companion object {
        const val ACTION_START = "com.example.focuslock.action.FOCUS_START"
        const val ACTION_STOP = "com.example.focuslock.action.FOCUS_STOP"
        const val ACTION_PAUSE = "com.example.focuslock.action.FOCUS_PAUSE"
        const val ACTION_RESUME = "com.example.focuslock.action.FOCUS_RESUME"
        const val ACTION_REFRESH = "com.example.focuslock.action.FOCUS_REFRESH"
        const val ACTION_SET_PAUSE = "com.example.focuslock.action.FOCUS_SET_PAUSE"
        const val EXTRA_PAUSED = "focuslock:paused"

        // Delivered by the AntiKill resurrection alarm (setExactAndAllowWhileIdle
        // + PendingIntent.getForegroundService) right after a swipe or an OS kill.
        const val ACTION_REVIVE = "com.example.focuslock.action.FOCUS_REVIVE"

        const val EXTRA_LAUNCH_ACTION = "focuslock:action"
        const val LAUNCH_PAUSE = "pause"
        const val LAUNCH_RESUME = "resume"

        private const val CHANNEL_ID = "focuslock_service"
        private const val NOTIFICATION_ID = 2
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        // We are (re)creating: any pending resurrection alarm is obsolete.
        AntiKill.cancelRestart(this)
        AntiKill.touchHeartbeat(this)
        // Re-arm the 15-minute pulse, idempotent under JobScheduler.
        AntiKill.schedulePulse(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // The sticky strict mode is permanent: it cannot be stopped.
                if (ProtectionStore.isGuard(this)) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForeground(NOTIFICATION_ID, buildNotification())
                    }
                    AntiKill.cancelRestart(this)
                    return START_STICKY
                }
                ProtectionStore.setActive(this, false)
                stopVpn()
                stopForeground(STOP_FOREGROUND_REMOVE)
                AntiKill.cancelRestart(this)
                AccessibilityHealthService.sync(this)
                stopSelf()
                return START_NOT_STICKY
            }

            ACTION_REFRESH -> {
                // Pause/resume flipped somewhere else (e.g. the challenge UI);
                // re-render the notification so its action mirrors state.
                refreshNotification()
                // A refresh means the protection intent flips too; keep the
                // accessibility watchdog in step.
                AccessibilityHealthService.sync(this)
            }

            ACTION_SET_PAUSE -> {
                // Strict mode ignores pause requests: filtering never relaxes.
                if (ProtectionStore.isGuard(this)) {
                    ProtectionStore.setPaused(this, false)
                    refreshNotification()
                    AntiKill.cancelRestart(this)
                    return START_STICKY
                }
                val paused = intent.getBooleanExtra(EXTRA_PAUSED, true)
                ProtectionStore.setPaused(this, paused)
                if (paused) {
                    ProtectionStore.touchLastUpdate(this)
                }
                refreshNotification()
            }

            // ACTION_REVIVE (from the resurrection alarm), ACTION_START and any
            // other action simply promote the service and bring blocking back.
            else -> {
                ProtectionStore.setActive(this, true)
                startAsForeground()
                ensureVpn()
                if (ProtectionStore.isGuard(this)) {
                    // Re-assert the Device Owner hardening on every start so a
                    // failed/revoked lockdown re-arms itself.
                    GuardManager.enforce(this, startProtection = false)
                }
                AccessibilityHealthService.sync(this)
            }
        }

        // Alive again — a successful (re)start invalidates the resurrection
        // alarm, stamps the heartbeat and keeps the periodic pulse armed.
        AntiKill.cancelRestart(this)
        AntiKill.touchHeartbeat(this)
        AntiKill.schedulePulse(this)
        return START_STICKY
    }

    /**
     * Swiping the app away from Recent Apps kills the process; `START_STICKY`
     * only *asks* the system to recreate us (it often does not on modern
     * Android). The definitive path is an exact alarm owned by system_server:
     * it fires ~1s later and its PendingIntent.getForegroundService operation is
     * an allowed background FGS start, so the session snaps straight back up.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (AntiKill.shouldProtect(this)) {
            AntiKill.scheduleRestart(this, AntiKill.RESTART_DELAY_MS)
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (AntiKill.shouldProtect(this)) {
            // START_STICKY may recreate us, but the exact alarm is the
            // deterministic path; always re-arm it on teardown too.
            AntiKill.scheduleRestart(this, AntiKill.RESTART_DELAY_MS)
        }
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "FocusLock session",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps FocusLock blocking while the session runs"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        manager.createNotificationChannel(channel)
    }

    private fun startAsForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun refreshNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun buildNotification(): Notification {
        val guard = ProtectionStore.isGuard(this)
        val paused = ProtectionStore.isPaused(this)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        builder
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle(
                if (guard) "FocusLock — وضع صارم مفعّل"
                else if (paused) "FocusLock Paused"
                else "FocusLock Active",
            )
            .setContentText(
                if (guard) "الحماية الإباحية مفعّلة بشكل دائم — لا يمكن إيقافها"
                else if (paused) "Protection paused. Tap Resume to lock again."
                else "Distractions blocked. Tap Pause to take a break.",
            )
            .setOngoing(true)

        // In strict mode there is no pause/resume/stop: the notification only
        // opens the app.
        if (!guard) {
            // Pause (or Resume) always goes through the typing challenge.
            val launchAction = if (paused) LAUNCH_RESUME else LAUNCH_PAUSE
            val toggleIntent = Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_LAUNCH_ACTION, launchAction)

            val togglePending = PendingIntent.getActivity(
                this,
                0,
                toggleIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                Notification.Action.Builder(null, launchAction, togglePending).build(),
            )

            // Stop ends the session outright.
            val stopIntent = Intent(this, FocusLockService::class.java)
                .setAction(ACTION_STOP)
            val stopPending = PendingIntent.getService(
                this,
                1,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                Notification.Action.Builder(null, "Stop", stopPending).build(),
            )
        }

        val contentIntent = PendingIntent.getActivity(
            this,
            2,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        builder.setContentIntent(contentIntent)
        return builder.build()
    }

    private fun ensureVpn() {
        val intent = Intent(this, FocusVpnService::class.java)
            .setAction(FocusVpnService.ACTION_START)
        try {
            startForegroundService(intent)
        } catch (_: Exception) {
            // VPN start may be blocked in background; the always-on VPN or the
            // user starting it from the app covers this case.
        }
    }

    private fun stopVpn() {
        try {
            startService(Intent(this, FocusVpnService::class.java)
                .setAction(FocusVpnService.ACTION_STOP))
        } catch (_: Exception) {
            // The VPN service wasn't running; nothing to stop.
        }
    }
}