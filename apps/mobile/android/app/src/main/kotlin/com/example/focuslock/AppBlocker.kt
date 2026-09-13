package com.example.focuslock

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.os.Build
import java.io.ByteArrayOutputStream

/**
 * App-level blocking on Android.
 *
 * Three mechanisms are layered, tried in this order:
 *
 *  1. DPM — the OS natively suspends the app (launching it becomes a no-op).
 *     Requires this app to be the Device Owner; see "Device Owner setup" below.
 *  2. VPN — the FocusLock local VPN quarantines blocked apps. Android's
 *     VpnService does NOT expose the originating UID on tunnel packets, so
 *     instead of "filter by UID" the service restricts the tunnel to exactly
 *     the blocked packages via `addAllowedApplication(...)` and drops their
 *     traffic while every other app bypasses the tunnel untouched.
 *  3. Accessibility — [FocusAccessibilityService] watches window-state changes
 *     and fires GLOBAL_ACTION_HOME whenever a blocked app comes to the
 *     foreground. Works without any privileged setup.
 *
 * Every block lives in a SharedPreferences set (`blocked_packages`), which all
 * three backends re-read on demand / on [notifyBackends].
 *
 * --- Device Owner setup (needed for real DPM suspension) ---------------------
 *
 *   1. Build & install the (testOnly) app on the device.
 *   2. From the host terminal run:
 *
 *        adb shell dpm set-device-owner com.example.focuslock/.AdminReceiver
 *
 *   3. Re-launch the app: isDeviceOwner() now returns true and suspendApp()
 *      performs a real OS-level suspension.
 *
 *   Common failures:
 *    - "has existing accounts" -> use the testOnly build (already declared) or
 *      reset the device before provisioning.
 *    - "already set" -> adb shell dpm remove-active-admin
 *      com.example.focuslock/.AdminReceiver, or factory-reset the device.
 *    - Only ONE Device Owner can exist per device.
 *
 * --- Accessibility fallback setup -------------------------------------------
 *
 *   Settings -> Accessibility -> FocusLock app blocking -> enable.
 *   (Or: adb shell settings put secure enabled_accessibility_services
 *        com.example.focuslock/com.example.focuslock.FocusAccessibilityService)
 *
 * --- VPN fallback setup -------------------------------------------------------
 *
 *   Start the FocusLock VPN from the app (or configure it as always-on VPN in
 *   system settings). Requires Android 11+ (API 30) for addAllowedApplication.
 */
object AppBlocker {

    private const val PREFS = "focuslock_app_blocker"
    private const val KEY_BLOCKED = "blocked_packages"

    /** How a block is currently being enforced. */
    enum class BlockMechanism {
        DPM,
        VPN,
        ACCESSIBILITY,
        NONE,
    }

    data class AppInfo(
        val name: String,
        val packageName: String,
        /** PNG bytes of the launcher icon, or null when not decodable. */
        val icon: ByteArray?,
    )

    private fun prefs(context: Context): android.content.SharedPreferences {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    private fun policyManager(context: Context): DevicePolicyManager {
        return context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    }

    private fun adminComponent(context: Context): ComponentName {
        return ComponentName(context, AdminReceiver::class.java)
    }

    /** Whether this app is the current Device Owner. */
    fun isDeviceOwner(context: Context): Boolean {
        return policyManager(context).isDeviceOwnerApp(context.packageName)
    }

    /** The packages currently marked blocked (shared by DPM/VPN/accessibility). */
    fun readBlockedPackages(context: Context): Set<String> {
        return prefs(context).getStringSet(KEY_BLOCKED, emptySet()) ?: emptySet()
    }

    /**
     * Blocks [pkg]. Prefers a real OS suspension when the app is Device Owner;
     * otherwise records the block for the VPN quarantine / accessibility
     * fallback. Returns the mechanism the block relies on.
     */
    fun suspendApp(context: Context, pkg: String): BlockMechanism {
        val blocked = HashSet(readBlockedPackages(context))
        blocked.add(pkg)
        prefs(context).edit().putStringSet(KEY_BLOCKED, blocked).apply()

        var mechanism = BlockMechanism.NONE
        if (isDeviceOwner(context)) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    policyManager(context)
                        .setPackagesSuspended(adminComponent(context), arrayOf(pkg), true)
                    mechanism = BlockMechanism.DPM
                }
            } catch (_: Exception) {
                mechanism = BlockMechanism.NONE
            }
        }

        if (mechanism == BlockMechanism.NONE) {
            mechanism = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                BlockMechanism.VPN
            } else {
                BlockMechanism.ACCESSIBILITY
            }
        }

        notifyBackends(context)
        return mechanism
    }

    /** Unblocks [pkg] across every backend. */
    fun resumeApp(context: Context, pkg: String) {
        val blocked = HashSet(readBlockedPackages(context))
        blocked.remove(pkg)
        prefs(context).edit().putStringSet(KEY_BLOCKED, blocked).apply()

        if (isDeviceOwner(context)) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    policyManager(context)
                        .setPackagesSuspended(adminComponent(context), arrayOf(pkg), false)
                }
            } catch (_: Exception) {
                // Nothing else to undo: the store (and VPN/accessibility) are
                // already unblocked above.
            }
        }

        notifyBackends(context)
    }

    /**
     * All installed apps that have a launcher intent, minus FocusLock itself.
     * The icon (when decodable) is exported as PNG bytes.
     */
    fun listInstalledApps(context: Context): List<AppInfo> {
        val pm = context.packageManager

        val launcherPackages = HashSet<String>()
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        queryLauncherActivities(pm, launcherIntent).forEach { resolveInfo ->
            resolveInfo?.activityInfo?.packageName?.let { launcherPackages.add(it) }
        }

        val apps = mutableListOf<AppInfo>()
        for (info in getInstalledApplications(pm)) {
            val pkg = info.packageName
            if (pkg == context.packageName || pkg !in launcherPackages) {
                continue
            }
            val name = pm.getApplicationLabel(info).toString()
            val icon = try {
                encodeIcon(pm.getApplicationIcon(pkg))
            } catch (_: Exception) {
                null
            }
            apps.add(AppInfo(name, pkg, icon))
        }
        apps.sortBy { it.name.lowercase() }
        return apps
    }

    /** The UIDs backing the blocked packages (used by the VPN layer). */
    fun blockedUids(context: Context): Set<Int> {
        val pm = context.packageManager
        return buildSet {
            for (pkg in readBlockedPackages(context)) {
                try {
                    val info: ApplicationInfo = pm.getApplicationInfo(pkg, 0)
                    add(info.uid)
                } catch (_: Exception) {
                    // Package uninstalled; ignore.
                }
            }
        }
    }

    /** Asks the VPN service to rebuild with the latest block list. */
    fun notifyBackends(context: Context) {
        val intent = Intent(context, FocusVpnService::class.java)
            .setAction(FocusVpnService.ACTION_RECONFIGURE)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (_: Exception) {
            // VPN not currently startable (not running / background-start
            // blocked). The store change is already persisted; the VPN picks it
            // up the next time it starts or is reconfigured.
        }
    }

    @Suppress("DEPRECATION")
    private fun queryLauncherActivities(
        pm: PackageManager,
        intent: Intent,
    ): List<android.content.pm.ResolveInfo?> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L)) as List<android.content.pm.ResolveInfo?>
        } else {
            pm.queryIntentActivities(intent, 0).map { it }
        }
    }

    @Suppress("DEPRECATION")
    private fun getInstalledApplications(pm: PackageManager): List<ApplicationInfo> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getInstalledApplications(PackageManager.ApplicationInfoFlags.of(0L))
        } else {
            pm.getInstalledApplications(0)
        }
    }

    /** Renders [drawable] into PNG bytes; returns null when it cannot be drawn. */
    private fun encodeIcon(drawable: Drawable): ByteArray? {
        val width = drawable.intrinsicWidth
        val height = drawable.intrinsicHeight
        if (width <= 0 || height <= 0) {
            return null
        }
        return try {
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            drawable.setBounds(0, 0, width, height)
            drawable.draw(canvas)
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            out.toByteArray()
        } catch (_: Exception) {
            null
        }
    }
}