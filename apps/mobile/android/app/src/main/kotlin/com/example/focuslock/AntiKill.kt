package com.example.focuslock

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings

/**
 * Anti-kill watchdog coordinator.
 *
 * Modern Android (11+) forbids starting a foreground service from the
 * background — the system throws `ForegroundServiceStartNotAllowedException`
 * unless one of a small set of exemptions applies. This object drives every
 * exemption FocusLock can legitimately get and layers deterministic + best
 * effort resurrection on top of `START_STICKY`:
 *
 *  1. **Exact-alarm resurrection hook.** [FocusLockService.onTaskRemoved] and
 *     [SafeBlockerAccessibilityService.onDestroy] call [scheduleRestart], which
 *     arms a `setExactAndAllowWhileIdle` alarm ~1s later whose operation is
 *     [PendingIntent.getForegroundService]. Alarms are owned by `system_server`
 *     and therefore survive our process being killed. Per the AlarmManager
 *     contract, **an alarm scheduled on `setExactAndAllowWhileIdle` is allowed
 *     to start a foreground service from the background** — the restart is
 *     delivered directly to the service (no receiver hop, mirroring the AOSP
 *     DeskClock advice to never round-trip through a receiver under LMK
 *     pressure). This works with `SCHEDULE_EXACT_ALARM` granted **or** when the
 *     app sits on the battery whitelist.
 *
 *  2. **15-minute persistent pulse.** [WatchdogJobService] runs on the
 *     OS-official JobScheduler channel; on every pulse it verifies the primary
 *     service is alive via the only per-app reliable signal
 *     (`ActivityManager.getRunningServices` + a heartbeat timestamp) and force
 *     launches it again if protection is supposed to be active.
 *
 *  3. **Battery whitelist = exact-alarm access.** Apps on the power allowlist
 *     may call the exact-alarm APIs without `SCHEDULE_EXACT_ALARM` (Android
 *     13+ denies that permission by default on fresh installs). The
 *     [ignoreBatteryOptimizationsIntent] prompt therefore not only stops Doze
 *     stalls but keeps the 1s resurrection alarm exact.
 *
 * Honest limits: a hard "Force stop" from Settings tears down every alarm and
 * job; nothing can resurrect from that on an unrooted device, and nothing here
 * claims to. The goal is surviving recents-swipe, battery savers, LMK kills and
 * crash loops — which this stack does.
 */
object AntiKill {

    /** Custom broadcast used by the non-exact alarm fallback path. */
    const val ACTION_RESTART = "com.example.focuslock.action.WATCHDOG_RESTART"

    /** Unique id stamped on each resurrection intent so PendingIntents never
     *  collide and stale alarms are replaced rather than stacked. */
    const val EXTRA_REVIVE_ID = "focuslock:revive_id"

    /** Exact-alarm resurrection window: 1s after teardown, as required. */
    const val RESTART_DELAY_MS = 1_000L

    /** Slower retry used when a background FGS start was refused (no
     *  exemption this round); the 15-minute pulse remains the floor. */
    const val RESTART_RETRY_MS = 5L * 60_000

    /** Watchdog pulse cadence — 15 minutes, the JobScheduler platform floor. */
    const val PULSE_INTERVAL_MS = 15L * 60_000

    /** A heartbeat fresher than this means the process was recently alive. */
    const val ALIVE_WINDOW_MS = PULSE_INTERVAL_MS + 5L * 60_000

    private const val PULSE_JOB_ID = 0x466C4B01 // "FLK" watchdog periodic
    private const val PULSE_NOW_JOB_ID = 0x466C4B02 // "FLK" watchdog retry

    private const val REQ_RESTART = 0x0F0C_0001
    private const val REQ_RESTART_FALLBACK = 0x0F0C_0002

    private const val PREFS = "focuslock_watchdog"
    private const val KEY_HEARTBEAT = "heartbeat_elapsed_realtime"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // --------------------------------------------------------------- heartbeat

    /** Any trusted component (FGS, accessibility service, watchdog job) stamps
     *  "my process is alive right now". Cheap, monotonic, survives reboots. */
    fun touchHeartbeat(context: Context) {
        prefs(context).edit().putLong(KEY_HEARTBEAT, SystemClock.elapsedRealtime()).apply()
    }

    fun heartbeatAgeMs(context: Context): Long {
        val stamped = prefs(context).getLong(KEY_HEARTBEAT, 0L)
        if (stamped == 0L) return Long.MAX_VALUE
        return SystemClock.elapsedRealtime() - stamped
    }

    // -------------------------------------------------------- required state

    /** True when the blocking pipeline is *supposed* to be running right now:
     *  an active session, sticky strict mode, or an in-window time lock. */
    fun shouldProtect(context: Context): Boolean {
        return ProtectionStore.isActive(context) ||
            ProtectionStore.isGuard(context) ||
            LockedDurationManager.isScheduleActiveNow(context)
    }

    /**
     * Is the primary foreground service actually up? `getRunningServices` only
     * reports the caller's own services since Android 10 — exactly what a
     * self-watchdog needs (and it never leaks other apps). Falls back to
     * heartbeat freshness on exotic OEMs that block the call.
     */
    @Suppress("DEPRECATION")
    fun isPrimaryRunning(context: Context): Boolean {
        val app = context.applicationContext
        val target = ComponentName(app, FocusLockService::class.java)
        return try {
            val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            am.getRunningServices(256).any { it.service == target }
        } catch (_: Throwable) {
            heartbeatAgeMs(app) < ALIVE_WINDOW_MS
        }
    }

    /** True when the accessibility guard is enabled in system settings. */
    fun isAccessibilityEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(
            context.applicationContext.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        val needle = "${context.packageName}/${SafeBlockerAccessibilityService::class.java.name}"
        return enabled.split(':').any { it.equals(needle, ignoreCase = true) }
    }

    // ------------------------------------------------------------- resurrection

    /**
     * Force-launches [FocusLockService]; if the background-FGS restriction
     * refuses it, queues an alarm-based restart plus an expedited pulse. The
     * exact alarm itself is the reliable resurrection on supported devices.
     */
    fun launchPrimaryOrQueue(context: Context, fallbackDelayMs: Long = RESTART_DELAY_MS) {
        val app = context.applicationContext
        try {
            val intent = Intent(app, FocusLockService::class.java)
                .setAction(FocusLockService.ACTION_REVIVE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(intent)
            } else {
                app.startService(intent)
            }
            cancelRestart(app)
        } catch (_: Exception) {
            // No FGS-start exemption available this round (e.g. only the pulse
            // fired without an exact alarm). Queue a retry and the job floor.
            scheduleRestart(app, delayMs = fallbackDelayMs)
            schedulePulse(app)
            schedulePulseNow(app)
        }
    }

    /**
     * Arms the ~[RESTART_DELAY_MS] resurrection alarm. Uses
     * `setExactAndAllowWhileIdle` (an explicit FGS-start exemption) when the
     * app may schedule exact alarms, otherwise degrades to the inexact
     * allow-while-idle variant routed through [RestartReceiver].
     *
     * Calling twice replaces the previous alarm (same request code + intent
     * identity), so teardown hooks are always idempotent.
     *
     * @return whether an alarm was actually scheduled.
     */
    fun scheduleRestart(context: Context, delayMs: Long = RESTART_DELAY_MS): Boolean {
        val app = context.applicationContext
        val am = app.getSystemService(AlarmManager::class.java)
            ?: run { schedulePulse(app); return false }
        val at = SystemClock.elapsedRealtime() + delayMs

        if (canScheduleExact(app)) {
            val operation = pendingForegroundRestart(app)
            return try {
                am.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, at, operation,
                )
                true
            } catch (_: Exception) {
                // Permission raced away between the check and the set call.
                scheduleFallback(am = am, app = app, at = at)
            }
        }
        return scheduleFallback(am, app, at)
    }

    private fun scheduleFallback(am: AlarmManager, app: Context, at: Long): Boolean {
        return try {
            am.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pendingRestartBroadcast(app),
            )
            true
        } catch (_: Exception) {
            schedulePulse(app)
            false
        }
    }

    /** Cancels any pending resurrection alarm (public: healthy-state hygiene). */
    fun cancelRestart(context: Context) {
        val app = context.applicationContext
        val am = app.getSystemService(AlarmManager::class.java) ?: return
        try {
            am.cancel(pendingForegroundRestart(app))
            am.cancel(pendingRestartBroadcast(app))
        } catch (_: Exception) {
            // Nothing pending.
        }
    }

    // ---------------------------------------------------------------- battery

    /** True when Doze/battery restrictions already exempt this app. */
    fun ignoringBatteryOptimizations(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(context.packageName)
        } catch (_: Exception) {
            false
        }
    }

    /** True when `setExactAndAllowWhileIdle` may be called without throwing:
     *  pre-S always, S+ only with `SCHEDULE_EXACT_ALARM` or on the power
     *  allowlist (which the battery prompt grants). */
    fun canScheduleExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return try {
            (context.applicationContext.getSystemService(AlarmManager::class.java)
                ?: return false).canScheduleExactAlarms()
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * The explicit `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent for
     * this package advertised in [Settings]. Returns null when the device is
     * pre-M or already whitelisted. Falls back to the per-app list settings
     * screen when an OEM's settings UI drops the direct dialog.
     */
    fun ignoreBatteryOptimizationsIntent(context: Context): Intent? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
        if (ignoringBatteryOptimizations(context)) return null
        val explicit = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.applicationContext.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return if (context.packageManager.resolveActivity(explicit, 0) != null) {
            explicit
        } else {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /** Explicit intent to the "Alarms & reminders" special-access screen. */
    fun exactAlarmAccessIntent(context: Context): Intent? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || canScheduleExact(context)) {
            return null
        }
        return Intent(
            Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
            Uri.parse("package:${context.applicationContext.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    // ----------------------------------------------------------------- pulses

    /** Reconciles after boot / app-upgrade: re-persist the periodic pulse and
     *  revive or queue the primary service when protection is required. */
    fun onAppReconciliation(context: Context) {
        val app = context.applicationContext
        schedulePulse(app)
        if (shouldProtect(app)) {
            resolvePrimaryService(app)
        } else {
            cancelRestart(app)
        }
    }

    /** The single entry point every long-lived component calls when it comes
     *  up: heartbeat, repair the FGS if protection is owed, and keep the
     *  15-minute pulse armed. */
    fun resolvePrimaryService(context: Context) {
        val app = context.applicationContext
        touchHeartbeat(app)
        if (!shouldProtect(app)) return
        if (isPrimaryRunning(app)) {
            // Healthy: make sure no stale resurrection alarm is pending.
            cancelRestart(app)
        } else {
            launchPrimaryOrQueue(app)
        }
        schedulePulse(app)
    }

    /** (Re)persists the periodic [WatchdogJobService] pulse (15 minutes). */
    fun schedulePulse(context: Context): Boolean {
        val app = context.applicationContext
        val scheduler = app.getSystemService(JobScheduler::class.java) ?: return false
        val component = ComponentName(app, WatchdogJobService::class.java)
        val job = JobInfo.Builder(PULSE_JOB_ID, component)
            .setPeriodic(PULSE_INTERVAL_MS, PULSE_INTERVAL_MS / 2)
            .setPersisted(true)
            .setRequiresCharging(false)
            .setRequiresDeviceIdle(false)
            .setRequiresBatteryNotLow(false)
            .build()
        return try {
            scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS
        } catch (_: Exception) {
            false
        }
    }

    /** Expedited one-shot pulse (e.g. right after a refused FGS start). */
    fun schedulePulseNow(context: Context) {
        val app = context.applicationContext
        val scheduler = app.getSystemService(JobScheduler::class.java) ?: return
        val component = ComponentName(app, WatchdogJobService::class.java)
        val job = JobInfo.Builder(PULSE_NOW_JOB_ID, component)
            .setMinimumLatency(30_000)
            .setOverrideDeadline(60_000)
            .setRequiresCharging(false)
            .setRequiresDeviceIdle(false)
            .setRequiresBatteryNotLow(false)
            .build()
        try {
            scheduler.schedule(job)
        } catch (_: Exception) {
            // Periodic pulse remains the floor.
        }
    }

    // ----------------------------------------------------------- pending intents

    private fun pendingForegroundRestart(app: Context): PendingIntent {
        val intent = Intent(app, FocusLockService::class.java)
            .setAction(FocusLockService.ACTION_REVIVE)
            .setPackage(app.packageName)
            .putExtra(EXTRA_REVIVE_ID, System.currentTimeMillis())
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(
                app,
                REQ_RESTART,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        } else {
            @Suppress("DEPRECATION")
            PendingIntent.getService(
                app,
                REQ_RESTART,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
    }

    private fun pendingRestartBroadcast(app: Context): PendingIntent {
        val intent = Intent(app, RestartReceiver::class.java)
            .setAction(ACTION_RESTART)
            .setPackage(app.packageName)
        return PendingIntent.getBroadcast(
            app,
            REQ_RESTART_FALLBACK,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}