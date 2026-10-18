package com.focuslock.accessibility

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The search guard is an accessibility service, so Android restarts it on its
 * own after a reboot. There is nothing for us to relaunch here — and that is
 * deliberate: the app takes no action behind the user's back, and touches no
 * system setting to keep itself alive.
 */
class BootMonitor : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return

        // Only bookkeeping — never a silent re-enable.
        StreakManager.markActive(context)
    }
}