package com.example.focuslock

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {

    private val adminComponent = ComponentName(this, AdminReceiver::class.java)

    private val policyManager: DevicePolicyManager
        get() = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "focuslock/admin",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "isDeviceOwner" ->
                    result.success(policyManager.isDeviceOwnerApp(packageName))

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
}