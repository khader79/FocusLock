package com.example.focuslock

import android.app.job.JobService
import android.app.job.JobParameters

/**
 * Periodic anti-kill pulse (15 minutes), executed on the OS-official
 * JobScheduler channel so it survives app process death and respects Doze.
 *
 * Every run:
 *  1. Stamps the heartbeat.
 *  2. Asks [AntiKill.resolvePrimaryService] to revive the primary foreground
 *     service when protection is supposed to be active and it is not running.
 *  3. Re-asserts strict-mode hardening and re-arms the persistent pulse.
 *
 * JobScheduler only charges battery for this while it flexibly merges it with
 * other work, and the schedule is `setPersisted(true)` so it outlives reboots.
 */
class WatchdogJobService : JobService() {

    override fun onStartJob(params: JobParameters): Boolean {
        val app = applicationContext
        try {
            AntiKill.touchHeartbeat(app)
            AntiKill.resolvePrimaryService(app)

            // Strict mode re-arms itself on every pulse in case a Device
            // Owner revocation, app update or a blocked uninstall reset it.
            if (ProtectionStore.isGuard(app)) {
                runCatching { GuardManager.enforce(app, startProtection = false) }
            }

            AntiKill.schedulePulse(app)
        } finally {
            // All work is synchronous and short; never hold the job slot.
            jobFinished(params, false)
        }
        return false
    }

    override fun onStopJob(params: JobParameters): Boolean {
        // Let the system deliver us at the next interval instead of hot-looping.
        return false
    }
}