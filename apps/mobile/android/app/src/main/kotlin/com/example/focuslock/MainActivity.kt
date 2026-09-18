package com.example.focuslock

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkInfo
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

class MainActivity : FlutterActivity() {

    private val adminComponent by lazy { ComponentName(this, DeviceAdminBlocker::class.java) }

    private val policyManager: DevicePolicyManager
        get() = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private companion object {
        const val ACTION_TIMELOCK_ARM = "com.example.focuslock.action.TIMELOCK_ARM"
    }

    /** Latest launch action (e.g. "pause") delivered via notification tap. */
    @Volatile
    private var launchAction: String? = null

    private val REQ_VPN_PERMISSION = 9001
    private var pendingVpnResult: MethodChannel.Result? = null

    private val REQ_ADMIN_PERMISSION = 9002

    private val REQ_BATTERY_OPTIMIZATION = 9003

    /** Prompted once per app start; never re-fires mid-session. */
    private var adminPromptInitiated = false

    /** Prompted once per app start when protection is active and not exempt. */
    private var batteryPromptInitiated = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launchAction = intent?.takeStringExtra(FocusLockService.EXTRA_LAUNCH_ACTION)
        handleTimeLockIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(FocusLockService.EXTRA_LAUNCH_ACTION)?.let {
            launchAction = it
        }
        handleTimeLockIntent(intent)
    }

    private fun Intent.takeStringExtra(name: String): String? =
        getStringExtra(name)?.also { _ -> }

    /** Deep-link ARM: arms and starts the lock service ("TIMELOCK_ARM"). */
    private fun handleTimeLockIntent(intent: Intent?) {
        if (intent?.action != ACTION_TIMELOCK_ARM) return
        val days = intent.getIntExtra(AppLockService.EXTRA_DURATION_DAYS, 1)
        val locked = intent.getBooleanExtra(AppLockService.EXTRA_LOCKED_MODE, false)
        val mode = scheduleModeFrom(intent.getStringExtra(AppLockService.EXTRA_SCHEDULE_MODE))
        val start = intent.getIntExtra(AppLockService.EXTRA_START_MINUTES, 0)
        val end = intent.getIntExtra(AppLockService.EXTRA_END_MINUTES, 0)
        try {
            LockedDurationManager.arm(this, days, locked, mode, start, end)
            AppLockService.start(this)
        } catch (_: Exception) {
            // Already locked: keep the existing (stricter) lock.
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val messenger = flutterEngine.dartExecutor.binaryMessenger

        registerAdminChannel(messenger)
        registerAppsChannel(messenger)
        registerProtectionChannel(messenger)
        registerLaunchChannel(messenger)
        registerSyncChannel(messenger)
        registerRulesChannel(messenger)
        registerTimeLockChannel(messenger)
        registerWatchdogChannel(messenger)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_VPN_PERMISSION -> {
                val result = pendingVpnResult
                pendingVpnResult = null
                if (resultCode == android.app.Activity.RESULT_OK) {
                    startFocusService()
                    result?.success(true)
                } else {
                    result?.success(false)
                }
            }
            // No action needed on RESULT; [adminPromptInitiated] stays set so
            // the dialog is shown once per app launch (next launch re-prompts).
            REQ_ADMIN_PERMISSION -> Unit

            // Fire-and-forget: the Flutter UI polls `batteryOptimizationStatus`
            // on next resume to mirror the outcome.
            REQ_BATTERY_OPTIMIZATION -> Unit
        }
    }

    override fun onResume() {
        super.onResume()
        maybePromptDeviceAdmin()
        maybePromptBatteryOptimization()
        // Safety belt: if protection is owed and the service was somehow lost
        // while the activity was backgrounded, revive it now.
        AntiKill.schedulePulse(this)
        AntiKill.resolvePrimaryService(this)
    }

    /** Asks the user once per launch to activate the device administrator. */
    private fun maybePromptDeviceAdmin() {
        if (adminPromptInitiated || pendingVpnResult != null) return
        if (policyManager.isAdminActive(adminComponent)) return
        adminPromptInitiated = true
        try {
            val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent)
                .putExtra(
                    DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    getString(R.string.device_admin_prompt_explanation),
                )
            startActivityForResult(intent, REQ_ADMIN_PERMISSION)
        } catch (_: Exception) {
            // No admin picker (rare OEM case); fall back to silent rearm.
            adminPromptInitiated = false
            DeviceAdminBlocker.rearm(this)
        }
    }

    /**
     * Asks the user once per launch to exempt FocusLock from battery
     * optimizations, but only when a protection session/guard/time lock is
     * actually active (never nags before the user starts one). Whitelisting:
     *  - stops Doze from deferring the resurrection alarm, and
     *  - counts as the "power save allowlist" that lets an app call
     *    setExactAndAllowWhileIdle without SCHEDULE_EXACT_ALARM on Android 13+,
     *    keeping the 1s anti-kill restart truly exact.
     */
    private fun maybePromptBatteryOptimization() {
        if (batteryPromptInitiated) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (AntiKill.ignoringBatteryOptimizations(this)) return
        val protecting = ProtectionStore.isActive(this) ||
            ProtectionStore.isGuard(this) ||
            LockedDurationManager.isLocked(this)
        if (!protecting) return
        val intent = AntiKill.ignoreBatteryOptimizationsIntent(this) ?: return
        batteryPromptInitiated = true
        try {
            startActivityForResult(intent, REQ_BATTERY_OPTIMIZATION)
        } catch (_: Exception) {
            // OEM settings UI refused to show a dialog; allow the next resume
            // to retry against the fallback list screen.
            batteryPromptInitiated = false
        }
    }

    private fun startFocusService() {
        val intent = Intent(this, FocusLockService::class.java)
            .setAction(FocusLockService.ACTION_START)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    // ------------------------------------------------------------------ admin

    private fun registerAdminChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/admin").setMethodCallHandler { call, result ->
            when (call.method) {
                "isDeviceOwner" -> result.success(policyManager.isDeviceOwnerApp(packageName))

                "isAdminActive" -> result.success(policyManager.isAdminActive(adminComponent))

                "activateAdmin" -> {
                    DeviceAdminBlocker.rearm(this)
                    result.success(policyManager.isAdminActive(adminComponent))
                }

                "promptAdmin" -> {
                    maybePromptDeviceAdmin()
                    result.success(true)
                }

                "setUninstallBlocked" -> {
                    val blocked = call.argument<Boolean>("blocked") ?: false
                    try {
                        policyManager.setUninstallBlocked(adminComponent, packageName, blocked)
                        result.success(null)
                    } catch (e: SecurityException) {
                        result.error("NOT_DEVICE_OWNER", e.message, null)
                    }
                }

                "lockNow" -> {
                    try {
                        policyManager.lockNow()
                        result.success(null)
                    } catch (e: SecurityException) {
                        result.error("NOT_DEVICE_OWNER", e.message, null)
                    }
                }

                else -> result.notImplemented()
            }
        }
    }

    // ------------------------------------------------------------------- apps

    private fun registerAppsChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/apps").setMethodCallHandler { call, result ->
            when (call.method) {
                "isDeviceOwner" -> result.success(AppBlocker.isDeviceOwner(this))

                "getBlocked" -> result.success(AppBlocker.readBlockedPackages(this).toList())

                "listInstalledApps" -> {
                    val apps = AppBlocker.listInstalledApps(this).map { app ->
                        mapOf(
                            "name" to app.name,
                            "packageName" to app.packageName,
                            "icon" to (app.icon ?: ByteArray(0)),
                        )
                    }
                    result.success(apps)
                }

                "suspendApp" -> {
                    val pkg = call.argument<String>("packageName")
                    if (pkg.isNullOrBlank()) {
                        result.error("INVALID_ARGUMENT", "packageName is required.", null)
                    } else if (!LockedDurationManager.canModify(this)) {
                        result.error("LOCKED", "Time lock active: block list is frozen.", null)
                    } else {
                        try {
                            result.success(AppBlocker.suspendApp(this, pkg).name)
                        } catch (e: Exception) {
                            result.error("SUSPEND_FAILED", e.message, null)
                        }
                    }
                }

                "resumeApp" -> {
                    val pkg = call.argument<String>("packageName")
                    if (pkg.isNullOrBlank()) {
                        result.error("INVALID_ARGUMENT", "packageName is required.", null)
                    } else if (!LockedDurationManager.canModify(this)) {
                        result.error("LOCKED", "Time lock active: block list is frozen.", null)
                    } else {
                        try {
                            AppBlocker.resumeApp(this, pkg)
                            result.success(null)
                        } catch (e: Exception) {
                            result.error("RESUME_FAILED", e.message, null)
                        }
                    }
                }

                else -> result.notImplemented()
            }
        }
    }

    // ------------------------------------------------------------- protection

    private fun registerProtectionChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/protection").setMethodCallHandler { call, result ->
            when (call.method) {
                "getState" -> result.success(ProtectionStore.toMap(this))

                "startSession" -> {
                    try {
                        val prepareIntent = VpnService.prepare(this)
                        if (prepareIntent == null) {
                            // VPN consent already granted: start straight away.
                            startFocusService()
                            result.success(true)
                        } else {
                            // Ask the user once for the "connection request"
                            // dialog, then start the service on approval.
                            pendingVpnResult = result
                            startActivityForResult(prepareIntent, REQ_VPN_PERMISSION)
                        }
                    } catch (e: Exception) {
                        result.error("START_FAILED", e.message, null)
                    }
                }

                "stopSession" -> {
                    // Strict mode cannot be stopped locally, ever; neither can
                    // an armed time lock.
                    if (ProtectionStore.isGuard(this) || LockedDurationManager.isLocked(this)) {
                        result.error("GUARDED", "Strict mode / time lock is locked.", null)
                    } else {
                        startService(
                            Intent(this, FocusLockService::class.java)
                                .setAction(FocusLockService.ACTION_STOP),
                        )
                        result.success(true)
                    }
                }

                // Arms the permanent strict mode (one-way: no local disable).
                "setGuard" -> result.success(GuardManager.enable(this))

                "guardState" -> result.success(
                    mapOf(
                        "guard" to ProtectionStore.isGuard(this),
                        "deviceOwner" to AppBlocker.isDeviceOwner(this),
                    ),
                )

                "generateChallenge" -> {
                    val difficulty = call.argument<Int>("difficulty")
                        ?: ProtectionStore.difficulty(this)
                    val pending = ProtectionStore.pendingChallenge(this)
                    if (pending != null) {
                        // Reuse the in-flight challenge so reloads don't swap
                        // it out from under the typist.
                        result.success(
                            challengePayload(pending.first, pending.second, difficulty),
                        )
                    } else {
                        val challenge = Core.generateChallenge(this, difficulty)
                        ProtectionStore.setPendingChallenge(this, challenge.id, challenge.text)
                        result.success(
                            challengePayload(challenge.id, challenge.text, difficulty),
                        )
                    }
                }

                "verifyChallenge" -> {
                    val id = call.argument<String>("id")
                    val typed = call.argument<String>("typed") ?: ""
                    val pending = ProtectionStore.pendingChallenge(this)
                    if (pending == null || pending.first != id) {
                        result.error("NO_CHALLENGE", "No pending challenge.", null)
                        return@setMethodCallHandler
                    }
                    val ok = Core.isComplete(typed, pending.second)
                    if (ok) {
                        ProtectionStore.clearPendingChallenge(this)
                        // Strict mode and an armed time lock never allow pausing.
                        val guarded = ProtectionStore.isGuard(this) ||
                            LockedDurationManager.isLocked(this)
                        val paused = !guarded && !ProtectionStore.isPaused(this)
                        // The foreground service flips state + refreshes notif.
                        startService(
                            Intent(this, FocusLockService::class.java)
                                .setAction(FocusLockService.ACTION_SET_PAUSE)
                                .putExtra(FocusLockService.EXTRA_PAUSED, paused),
                        )
                        result.success(mapOf("ok" to true, "paused" to paused))
                    } else {
                        ProtectionStore.incrementUnlockAttempt(this)
                        result.success(mapOf("ok" to false))
                    }
                }

                "rejectChallenge" -> {
                    ProtectionStore.incrementUnlockAttempt(this)
                    ProtectionStore.clearPendingChallenge(this)
                    result.success(true)
                }

                // Verifies the pending challenge WITHOUT toggling the session.
                // Used to gate actions like unblocking an app (Cold-Turkey-style
                // "type a long text before you can change anything").
                "verifyChallengeOnly" -> {
                    val id = call.argument<String>("id")
                    val typed = call.argument<String>("typed") ?: ""
                    val pending = ProtectionStore.pendingChallenge(this)
                    if (pending == null || pending.first != id) {
                        result.error("NO_CHALLENGE", "No pending challenge.", null)
                        return@setMethodCallHandler
                    }
                    val ok = Core.isComplete(typed, pending.second)
                    if (ok) {
                        ProtectionStore.clearPendingChallenge(this)
                    } else {
                        ProtectionStore.incrementUnlockAttempt(this)
                    }
                    result.success(mapOf("ok" to ok))
                }

                "setDifficulty" -> {
                    if (!LockedDurationManager.canModify(this)) {
                        result.error("LOCKED", "Time lock active: settings are frozen.", null)
                    } else {
                        ProtectionStore.setDifficulty(
                            this, call.argument<Int>("difficulty") ?: 3,
                        )
                        result.success(true)
                    }
                }

                else -> result.notImplemented()
            }
        }
    }

    private fun challengePayload(id: String, text: String, difficulty: Int): Map<String, Any> {
        return mapOf(
            "id" to id,
            "text" to text,
            "wordCount" to text.split(' ').size,
            "difficulty" to difficulty,
            "minutes" to (Core.DIFFICULTY_CONFIG[difficulty]?.minutes ?: 0),
        )
    }

    // -------------------------------------------------------------- launch

    private fun registerLaunchChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/launch").setMethodCallHandler { call, result ->
            when (call.method) {
                "getLaunchAction" -> result.success(launchAction)
                "consumeLaunchAction" -> {
                    val captured = launchAction
                    launchAction = null
                    result.success(captured)
                }

                else -> result.notImplemented()
            }
        }
    }

    // ------------------------------------------------------------------ sync

    private fun registerSyncChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/sync").setMethodCallHandler { call, result ->
            when (call.method) {
                "setConfig" -> {
                    ProtectionStore.setSyncConfig(
                        this,
                        call.argument("url"),
                        call.argument("anonKey"),
                        call.argument("rowId"),
                        call.argument("secret"),
                    )
                    result.success(true)
                }

                "getConfig" -> result.success(
                    mapOf(
                        "configured" to (ProtectionStore.syncUrl(this) != null),
                        "url" to (ProtectionStore.syncUrl(this) ?: ""),
                        "rowId" to (ProtectionStore.syncRowId(this) ?: ""),
                    ),
                )

                "push" -> {
                    val payload = call.argument<String>("payload")
                    if (payload == null) {
                        result.error("INVALID_ARGUMENT", "payload required.", null)
                    } else {
                        val body = SyncClient.push(this, JSONObject(payload))
                        result.success(body.has("payload"))
                    }
                }

                "pull" -> {
                    val pulled = SyncClient.pull(this)
                    result.success(pulled?.toString() ?: "")
                }

                else -> result.notImplemented()
            }
        }
    }

    // ------------------------------------------------------------------ rules

    private fun registerRulesChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/rules").setMethodCallHandler { call, result ->
            when (call.method) {
                "getSites" -> result.success(RuleStore.customSites(this))

                "addSite" -> {
                    val site = call.argument<String>("site")
                    if (site.isNullOrBlank()) {
                        result.error("INVALID_ARGUMENT", "site required.", null)
                    } else if (!LockedDurationManager.canModify(this)) {
                        result.error("LOCKED", "Time lock active: rules are frozen.", null)
                    } else {
                        val added = RuleStore.addCustomSite(this, site)
                        reconfigureVpn()
                        result.success(added)
                    }
                }

                "removeSite" -> {
                    if (!LockedDurationManager.canModify(this)) {
                        result.error("LOCKED", "Time lock active: rules are frozen.", null)
                    } else {
                        val site = call.argument<String>("site")
                        if (site != null) {
                            RuleStore.removeCustomSite(this, site)
                            reconfigureVpn()
                        }
                        result.success(true)
                    }
                }

                "setSites" -> {
                    if (!LockedDurationManager.canModify(this)) {
                        result.error("LOCKED", "Time lock active: rules are frozen.", null)
                    } else {
                        val sites = call.argument<List<String>>("sites") ?: emptyList()
                        RuleStore.setCustomSites(this, sites)
                        reconfigureVpn()
                        result.success(true)
                    }
                }

                "getCategories" -> result.success(
                    RuleStore.categories(this).map { category ->
                        val raw = JSONObject()
                        category.keys().forEach { key -> raw.put(key, category.get(key)) }
                        raw
                    },
                )

                "setCategories" -> {
                    if (!LockedDurationManager.canModify(this)) {
                        result.error("LOCKED", "Time lock active: rules are frozen.", null)
                    } else {
                        val raw = call.argument<List<String>>("categories") ?: emptyList()
                        val parsed = raw.mapNotNull { text ->
                            try {
                                JSONObject(text)
                            } catch (_: Exception) {
                                null
                            }
                        }
                        RuleStore.setCategories(this, parsed)
                        reconfigureVpn()
                        result.success(true)
                    }
                }

                else -> result.notImplemented()
            }
        }
    }

    private fun reconfigureVpn() {
        try {
            startService(
                Intent(this, FocusVpnService::class.java)
                    .setAction(FocusVpnService.ACTION_RECONFIGURE),
            )
        } catch (_: Exception) {
            // VPN not running; it re-reads RuleStore on its next start/load.
        }
    }

    // ------------------------------------------------------------- time lock

    private fun registerTimeLockChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/timelock").setMethodCallHandler { call, result ->
            when (call.method) {
                "status" -> result.success(LockedDurationManager.state(this).toMap())

                "canModify" -> result.success(LockedDurationManager.canModify(this))

                "arm" -> {
                    val days = call.argument<Int>("durationDays") ?: 90
                    val lockedMode = call.argument<Boolean>("lockedMode") ?: false
                    val mode = scheduleModeFrom(call.argument<String>("scheduleMode"))
                    val start = call.argument<Int>("startMinutes") ?: 0
                    val end = call.argument<Int>("endMinutes") ?: 0
                    try {
                        // Arm synchronously (trusted side), then hand the
                        // countdown to the sticky foreground service.
                        val state = LockedDurationManager.arm(
                            this, days, lockedMode, mode, start, end,
                        )
                        AppLockService.start(this)
                        result.success(state.toMap())
                    } catch (e: IllegalStateException) {
                        // Already locked: return the existing (unchanged) lock.
                        result.success(LockedDurationManager.state(this).toMap())
                    } catch (e: Exception) {
                        result.error("ARM_FAILED", e.message, null)
                    }
                }

                "updateSchedule" -> {
                    val mode = scheduleModeFrom(call.argument<String>("scheduleMode"))
                    val start = call.argument<Int>("startMinutes") ?: 0
                    val end = call.argument<Int>("endMinutes") ?: 0
                    try {
                        result.success(
                            LockedDurationManager.updateSchedule(this, mode, start, end).toMap(),
                        )
                    } catch (e: IllegalStateException) {
                        result.error("LOCKED", e.message, null)
                    }
                }

                "extend" -> {
                    val extra = call.argument<Int>("extraDays") ?: 0
                    try {
                        result.success(LockedDurationManager.extend(this, extra).toMap())
                    } catch (e: Exception) {
                        result.error("EXTEND_FAILED", e.message, null)
                    }
                }

                else -> result.notImplemented()
            }
        }
    }

    private fun scheduleModeFrom(raw: String?): LockedDurationManager.ScheduleMode {
        return if (raw?.lowercase() == "window") {
            LockedDurationManager.ScheduleMode.WINDOW
        } else {
            LockedDurationManager.ScheduleMode.ALL_DAY
        }
    }

    // -------------------------------------------------------------- watchdog

    private fun registerWatchdogChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/watchdog").setMethodCallHandler { call, result ->
            when (call.method) {
                "status" -> result.success(
                    mapOf(
                        "protected" to AntiKill.shouldProtect(this),
                        "primaryRunning" to AntiKill.isPrimaryRunning(this),
                        "accessibilityEnabled" to AntiKill.isAccessibilityEnabled(this),
                        "batteryExempt" to AntiKill.ignoringBatteryOptimizations(this),
                        "canScheduleExactAlarms" to AntiKill.canScheduleExact(this),
                        "vpnActive" to FocusVpnService.vpnUp,
                        "notificationsEnabled" to NotificationManagerCompat.from(this).areNotificationsEnabled(),
                        "networkType" to currentNetworkType(),
                        "heartbeatAgeMs" to AntiKill.heartbeatAgeMs(this),
                    ),
                )

                "openAccessibilitySettings" -> {
                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        startActivity(intent)
                    } catch (_: Exception) {
                        // No settings screen on this OEM; ignore.
                    }
                    result.success(true)
                }

                "openNotificationSettings" -> {
                    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    }
                    try {
                        startActivity(intent)
                    } catch (_: Exception) {
                        // Fall back to the app info screen if the OEM lacks it.
                        try {
                            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                data = android.net.Uri.fromParts("package", packageName, null)
                            })
                        } catch (_: Exception) {
                            // Give up quietly.
                        }
                    }
                    result.success(true)
                }

                "openBatterySettings" -> {
                    try {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (_: Exception) {
                        // Give up quietly.
                    }
                    result.success(true)
                }

                "requestIgnoreBatteryOptimizations" -> {
                    maybePromptBatteryOptimization()
                    result.success(AntiKill.ignoringBatteryOptimizations(this))
                }

                "requestExactAlarmAccess" -> {
                    val intent: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        try {
                            AntiKill.exactAlarmAccessIntent(this)
                        } catch (_: Exception) {
                            null
                        }
                    } else {
                        null
                    }
                    if (intent != null) {
                        try {
                            startActivity(intent)
                        } catch (_: Exception) {
                            // No settings screen for this on the OEM; ignore.
                        }
                    }
                    result.success(AntiKill.canScheduleExact(this))
                }

                "armWatchdog" -> {
                    AntiKill.onAppReconciliation(this)
                    result.success(true)
                }

                "reviveNow" -> {
                    AntiKill.resolvePrimaryService(this)
                    result.success(AntiKill.isPrimaryRunning(this))
                }

                else -> result.notImplemented()
            }
        }
    }

    /** Brief, UI-label-friendly description of the active transport. */
    private fun currentNetworkType(): String {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return "none"
            val active: NetworkInfo? = @Suppress("DEPRECATION") cm.activeNetworkInfo
            return when (active?.type) {
                ConnectivityManager.TYPE_WIFI -> "wifi"
                ConnectivityManager.TYPE_MOBILE -> "mobile"
                else -> if (active == null) "none" else "other"
            }
        } catch (_: Exception) {
            return "none"
        }
    }
}
