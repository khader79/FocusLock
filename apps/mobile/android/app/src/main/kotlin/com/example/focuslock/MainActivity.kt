package com.example.focuslock

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

class MainActivity : FlutterActivity() {

    private val adminComponent by lazy { ComponentName(this, AdminReceiver::class.java) }

    private val policyManager: DevicePolicyManager
        get() = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    /** Latest launch action (e.g. "pause") delivered via notification tap. */
    @Volatile
    private var launchAction: String? = null

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        launchAction = intent?.takeStringExtra(FocusLockService.EXTRA_LAUNCH_ACTION)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(FocusLockService.EXTRA_LAUNCH_ACTION)?.let {
            launchAction = it
        }
    }

    private fun Intent.takeStringExtra(name: String): String? =
        getStringExtra(name)?.also { _ -> }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val messenger = flutterEngine.dartExecutor.binaryMessenger

        registerAdminChannel(messenger)
        registerAppsChannel(messenger)
        registerProtectionChannel(messenger)
        registerLaunchChannel(messenger)
        registerSyncChannel(messenger)
        registerRulesChannel(messenger)
    }

    // ------------------------------------------------------------------ admin

    private fun registerAdminChannel(messenger: io.flutter.plugin.common.BinaryMessenger) {
        MethodChannel(messenger, "focuslock/admin").setMethodCallHandler { call, result ->
            when (call.method) {
                "isDeviceOwner" -> result.success(policyManager.isDeviceOwnerApp(packageName))

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
                    val intent = Intent(this, FocusLockService::class.java)
                        .setAction(FocusLockService.ACTION_START)
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            startForegroundService(intent)
                        } else {
                            startService(intent)
                        }
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("START_FAILED", e.message, null)
                    }
                }

                "stopSession" -> {
                    startService(
                        Intent(this, FocusLockService::class.java)
                            .setAction(FocusLockService.ACTION_STOP),
                    )
                    result.success(true)
                }

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
                        val paused = !ProtectionStore.isPaused(this)
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

                "setDifficulty" -> {
                    ProtectionStore.setDifficulty(this, call.argument<Int>("difficulty") ?: 3)
                    result.success(true)
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
                    } else {
                        val added = RuleStore.addCustomSite(this, site)
                        reconfigureVpn()
                        result.success(added)
                    }
                }

                "removeSite" -> {
                    val site = call.argument<String>("site")
                    if (site != null) {
                        RuleStore.removeCustomSite(this, site)
                        reconfigureVpn()
                    }
                    result.success(true)
                }

                "setSites" -> {
                    val sites = call.argument<List<String>>("sites") ?: emptyList()
                    RuleStore.setCustomSites(this, sites)
                    reconfigureVpn()
                    result.success(true)
                }

                "getCategories" -> result.success(
                    RuleStore.categories(this).map { category ->
                        val raw = JSONObject()
                        category.keys().forEach { key -> raw.put(key, category.get(key)) }
                        raw
                    },
                )

                "setCategories" -> {
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
}