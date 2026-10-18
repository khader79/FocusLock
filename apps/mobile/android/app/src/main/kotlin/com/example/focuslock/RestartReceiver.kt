package com.example.focuslock

import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Wake-up receiver for the anti-kill stack.
 *
 *  - [ACTION_RESTART]: delivered by the *inexact* allow-while-idle alarm used
 *    when the app cannot schedule exact alarms (Android 13+ `SCHEDULE_EXACT_ALARM`
 *    is denied by default). A plain broadcast has no FGS-start exemption, so
 *    the service launch is attempted and, if refused, re-queued on the alarm +
 *    expedited-pulse ladder.
 *  - [AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED]: a
 *    foreground system broadcast sent when the user grants exact-alarm access.
 *    Receiving **this** broadcast is an allowed background FGS start, so the
 *    service is brought straight back up and all alarms are re-armed.
 */
class RestartReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        when (intent.action) {
            AntiKill.ACTION_RESTART -> {
                // No exemption in this delivery: only act when protection is
                // actually owed and the primary service is genuinely down, so
                // the 5-minute retry loop never churns a healthy system.
                if (!AntiKill.shouldProtect(app)) return
                if (AntiKill.isPrimaryRunning(app)) return
                AntiKill.launchPrimaryOrQueue(app, AntiKill.RESTART_RETRY_MS)
            }

            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> {
                // The permission could have been granted then revoked again in
                // the same heartbeat — re-check before any exact-alarm call.
                if (AntiKill.canScheduleExact(app)) {
                    if (AntiKill.shouldProtect(app)) {
                        AntiKill.launchPrimaryOrQueue(app)
                        AntiKill.scheduleRestart(app)
                    }
                }
                AntiKill.schedulePulse(app)
            }
        }
    }
}