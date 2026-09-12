package com.example.focuslock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Restarts the FocusLock VPN when the device boots, so blocked domains stay
 * blocked without the user having to open the app.
 *
 * How this is delivered:
 *  - The system fires ACTION_BOOT_COMPLETED after the user unlocks the device
 *    (requires the RECEIVE_BOOT_COMPLETED permission, already declared).
 *  - FocusLock's process does not need to be running: manifest-declared
 *    receivers are still invoked by the system on boot.
 *
 * On Android 8+ a receiver cannot call startService() for a background
 * service directly, so we use startForegroundService(), which lets the
 * service promote itself with startForeground() (FocusVpnService does this in
 * startAsForeground()). If the system refuses (Android 12+ background-start
 * restrictions when the app is not an active VPN), the state is ignored and
 * the service can still be started by the user or by always-on VPN.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) {
            return
        }

        val serviceIntent = Intent(context, FocusVpnService::class.java)
            .setAction(FocusVpnService.ACTION_START)

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (_: IllegalStateException) {
            // Background FGS start blocked on this Android version; the user
            // can start the VPN from the app, or always-on VPN restarts it.
        } catch (_: SecurityException) {
            // Not allowed to start the service in this state; ignore.
        }
    }
}