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
import android.util.Log
import android.provider.Settings

/**
 * Watchdog for [SafeBlockerAccessibilityService] on battery-optimising OEM
 * builds (Samsung "App sleeping", Xiaomi "autostart", …) where the system can
 * disable or drop the accessibility service without the user asking.
 *
 * Why a *separate* foreground service? An accessibility service that has been
 * killed or disabled cannot watch itself — its process is gone. This service
 * runs on the ordinary (START_STICKY) process lane, outlives the accessibility
 * one, and is only active while protection is owed:
 *
 *  ```
 *  foreground             guards android.app                  symptom
 *  window change  ───►  [SafeBlockerAccessibilityService]  ──► alive heartbeat
 *   (OEM kill)      │                                          ✗ gone ── stale
 *                    ▼
 *                [AccessibilityHealthService] (FGS, self-alarmed)
 *                    │ every tick:
 *                    ├─ Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES contains us?
 *                    │      ✔  but heartbeat stale  ──► "killed": alert + reanimate
 *                    │      ✗                        ──► "disabled": alert + re-enable
 *                    │      ✔  heartbeat fresh       ──► healthy: alert cleared
 *                    └─ while unhealthy: re-validate sweep on the a11y service
 *                         → continuous GLOBAL_ACTION_HOME for blocked apps until
 *                           the service is healthy again (see revalidateSweep).
 *  ```
 *
 * Alert behaviour (the part the user sees):
 *  - A **high-priority, ongoing** notification whose tap opens
 *    [Settings.ACTION_ACCESSIBILITY_SETTINGS] — the one screen Android exposes
 *    for re-enabling an accessibility service.
 *  - An extra action jumps to the battery-optimization screen (Samsung/Xiaomi
 *    keep app sleeping there) so the *root cause* can be fixed too.
 *  - While protection is owed the alert only clears when the accessibility
 *    service is healthy again — matching "notify until it works".
 *
 * Honest limit (documented because it matters): [GLOBAL_ACTION_HOME] can only
 * be emitted by the accessibility service itself — a dead or disabled one
 * cannot fire it from thin air. The watchdog therefore *continuously re-drives*
 * the accessibility service (ACTION_REVALIDATE every tick); the moment the
 * system re-binds it, a fresh sweep immediately HOME-es any blocked app still in
 * front, and the debounced loop keeps hammering until the guard is healthy.
 */
class AccessibilityHealthService : Service() {

    companion object {
        const val ACTION_START = "com.example.focuslock.action.A11Y_HEALTH_START"
        const val ACTION_STOP = "com.example.focuslock.action.A11Y_HEALTH_STOP"

        const val CHANNEL_FGS = "focuslock_a11y_health"
        const val CHANNEL_ALERT = "focuslock_a11y_alert"
        const val FGS_NOTIFICATION_ID = 40
        const val ALERT_NOTIFICATION_ID = 41

        /** Quiet cadence while the guard is healthy (saves battery). */
        const val TICK_HEALTHY_MS = 45_000L

        /** Aggressive cadence while the guard is down (enforce + alert). */
        const val TICK_DEGRADED_MS = 15_000L

        /** Heartbeats fresher than this mean the a11y service is alive. The
         *  accessibility service stamps every 20s while connected. */
        const val A11Y_ALIVE_WINDOW_MS = 60_000L

        private const val REQ_TICK = 0xA11001

        private const val DISABLED_TITLE = "FocusLock — حارس إمكانية الوصول معطّل"
        private const val DISABLED_TEXT = "متجرّع من النظام. اضغط لفتح إعدادات إمكانية الوصول وإعادة تفعيله."
        private const val ENABLED_CRASHED_TITLE = "FocusLock — حارس إمكانية الوصول توقف"
        private const val ENABLED_CRASHED_TEXT = "أوقف المصنّع الخدمة. اضغط لإعادة الفحص، وسيُعاد ربطه تلقائياً."

        /** True while any lock/guard/session is owed, so the watchdog stops
         *  itself when FocusLock is not being used at all. */
        fun owesProtection(context: Context): Boolean {
            return ProtectionStore.isActive(context) ||
                ProtectionStore.isGuard(context) ||
                LockedDurationManager.isLocked(context) ||
                LockedDurationManager.isScheduleActiveNow(context)
        }

        /** Start or stop the watchdog to match [owesProtection]. Call after a
         *  session/guard/lock transitions (boot, arm, stop, resume). */
        fun sync(context: Context) {
            val app = context.applicationContext
            val intent = Intent(app, AccessibilityHealthService::class.java)
                .setAction(if (owesProtection(app)) ACTION_START else ACTION_STOP)
            try {
                if (intent.action == ACTION_START && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    app.startForegroundService(intent)
                } else {
                    app.startService(intent)
                }
            } catch (_: Exception) {
                // Process restart via START_STICKY / next sync re-evaluates.
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Foreground promotion must happen immediately on a FGS request.
        startAsForeground()

        if (intent?.action == ACTION_STOP || !owesProtection(this)) {
            cancelTick()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        evaluateHealth()
        return START_STICKY
    }

    override fun onDestroy() {
        cancelTick()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ health

    private fun evaluateHealth() {
        val state = accessibilityState()
        Log.d("FocusLock.Health", "state=${state.name} enabled=${AntiKill.isAccessibilityEnabled(this)} heartbeatAge=${AntiKill.heartbeatAgeMs(this)}ms")
        when (state) {
            AccessState.HEALTHY -> clearAlert()
            // Enabled but the process/heartbeat died: the system will re-bind
            // the service; until then keep reanimating + hammering HOME.
            AccessState.ENABLED_CRASHED -> {
                postAlert(ENABLED_CRASHED_TITLE, ENABLED_CRASHED_TEXT)
                SafeBlockerAccessibilityService.sendRevalidate(this)
            }
            // Explicitly disabled by the user/OEM: only they can re-enable it.
            AccessState.DISABLED -> postAlert(DISABLED_TITLE, DISABLED_TEXT)
        }
        scheduleTick(if (state == AccessState.HEALTHY) TICK_HEALTHY_MS else TICK_DEGRADED_MS)
    }

    private enum class AccessState { HEALTHY, ENABLED_CRASHED, DISABLED }

    private fun accessibilityState(): AccessState {
        val app = applicationContext
        val enabled = AntiKill.isAccessibilityEnabled(app)
        if (!enabled) return AccessState.DISABLED
        val alive = AntiKill.heartbeatAgeMs(app) < A11Y_ALIVE_WINDOW_MS
        return if (alive) AccessState.HEALTHY else AccessState.ENABLED_CRASHED
    }

    // ----------------------------------------------------------------- ticking

    private fun scheduleTick(delayMs: Long) {
        val alarm = getSystemService(AlarmManager::class.java) ?: return
        val at = SystemClock.elapsedRealtime() + delayMs
        val pending = PendingIntent.getBroadcast(
            this,
            REQ_TICK,
            Intent(this, HealthTickReceiver::class.java)
                .setAction(HealthTickReceiver.ACTION_TICK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        try {
            // Inexact is fine: a watchdog tick a few seconds late still works.
            alarm.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending)
        } catch (_: SecurityException) {
            // START_STICKY keeps the FGS alive even without alarm access.
        }
    }

    private fun cancelTick() {
        getSystemService(AlarmManager::class.java)?.cancel(
            PendingIntent.getBroadcast(
                this,
                REQ_TICK,
                Intent(this, HealthTickReceiver::class.java)
                    .setAction(HealthTickReceiver.ACTION_TICK),
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
            )
        )
    }

    // ------------------------------------------------------------- foreground

    private fun startAsForeground() {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_FGS)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        startForeground(
            FGS_NOTIFICATION_ID,
            builder
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("FocusLock — مراقب الحماية")
                .setContentText("يحرس خدمة إمكانية الوصول من إيقاف المصنّع")
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build(),
        )
    }

    // ---------------------------------------------------------------- alerts

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_FGS, "FocusLock watchdog", NotificationManager.IMPORTANCE_LOW)
                .apply {
                    description = "Background health service keeping the guard alive"
                    setShowBadge(false)
                },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERT, "FocusLock guard alerts", NotificationManager.IMPORTANCE_HIGH)
                .apply {
                    description = "Warns when the accessibility guard is down"
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
        )
    }

    private fun postAlert(title: String, text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ALERT)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val openSettings = PendingIntent.getActivity(
            this,
            1,
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val recheck = PendingIntent.getBroadcast(
            this,
            2,
            Intent(this, HealthTickReceiver::class.java)
                .setAction(HealthTickReceiver.ACTION_TICK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        builder
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_ALARM)
            .setContentIntent(openSettings)
            .addAction(0, "فحص الآن", recheck)

        // Battery optimisation is the usual OEM killer (Samsung/Xiaomi); offer
        // its settings screen as a second action when not already whitelisted.
        if (!AntiKill.ignoringBatteryOptimizations(this)) {
            val battery = AntiKill.ignoreBatteryOptimizationsIntent(this)
            if (battery != null) {
                builder.addAction(
                    0,
                    "منع إيقاف التطبيق",
                    PendingIntent.getActivity(
                        this,
                        3,
                        battery,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
            }
        }

        manager.notify(ALERT_NOTIFICATION_ID, builder.build())
    }

    private fun clearAlert() {
        getSystemService(NotificationManager::class.java)
            .cancel(ALERT_NOTIFICATION_ID)
    }
}

/** Alarm tick for the accessibility watchdog (kept separate because a
 *  BroadcastReceiver is the most reliable thing to deliver alarms to). */
class HealthTickReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_TICK = "com.example.focuslock.action.A11Y_HEALTH_TICK"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TICK) return
        AccessibilityHealthService.sync(context)
    }
}