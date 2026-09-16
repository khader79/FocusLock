package com.example.focuslock

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build

/**
 * Arms the sticky "strict mode" (الوضع الصارم).
 *
 * Once armed it can only be lifted with a factory reset or
 *   adb shell dpm remove-active-admin com.example.focuslock/.AdminReceiver
 * so it must NEVER offer a local "disable" path. [enable] persists the flag
 * and immediately applies every Device Owner hardening below:
 *
 *  - setUninstallBlocked  : the app cannot be uninstalled from the system UI.
 *  - always-on VPN + lockdown: Android makes FocusLock the mandatory VPN and
 *    kills ALL network traffic whenever the tunnel is not connected, so no
 *    traffic can slip past the filter.
 *
 * [enforce] re-applies the same hardening (on boot / service restart) and is
 * idempotent.
 */
object GuardManager {

    /** Turns the strict mode on permanently and enforces it. Returns the
     *  post-exercise state; keys: uninstallBlocked, lockdownVpn. */
    fun enable(context: Context): Map<String, Boolean> {
        ProtectionStore.setGuard(context, true)
        return enforce(context)
    }

    /**
     * Applies (or re-applies) the Device Owner hardening for the current guard
     * state. Safe to call repeatedly. VPN lockdown is only set once the user
     * has granted VPN permission, otherwise enabling it would cut ALL
     * connectivity before the tunnel can even start.
     */
    fun enforce(context: Context, startProtection: Boolean = true): Map<String, Boolean> {
        val guard = ProtectionStore.isGuard(context)
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = ComponentName(context, AdminReceiver::class.java)
        val isOwner = dpm.isDeviceOwnerApp(context.packageName)

        var uninstallBlocked = false
        var lockdownVpn = false

        if (guard && isOwner) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                try {
                    dpm.setUninstallBlocked(admin, context.packageName, true)
                    uninstallBlocked = true
                } catch (_: Exception) {
                    // Owner flag may not include uninstall-block authority (or
                    // another DPC holds it); leave flag false so the UI can warn.
                }
            }

            val vpnGranted = try {
                VpnService.prepare(context) == null
            } catch (_: Exception) {
                false
            }
            if (vpnGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                try {
                    dpm.setAlwaysOnVpnPackage(admin, context.packageName, true)
                    lockdownVpn = true
                } catch (_: Exception) {
                    // Always-on config may be held by another VPN (or the owner
                    // has disabled it); report false so the user sees it.
                }
            }
        }

        if (startProtection && guard) {
            startProtection(context)
        }

        return mapOf(
            "guard" to guard,
            "deviceOwner" to isOwner,
            "uninstallBlocked" to uninstallBlocked,
            "lockdownVpn" to lockdownVpn,
        )
    }

    private fun startProtection(context: Context) {
        try {
            val intent = Intent(context, FocusLockService::class.java)
                .setAction(FocusLockService.ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (_: Exception) {
            // Background FGS start blocked on this Android version; the user or
            // the always-on VPN restarts the tunnel.
        }
    }
}