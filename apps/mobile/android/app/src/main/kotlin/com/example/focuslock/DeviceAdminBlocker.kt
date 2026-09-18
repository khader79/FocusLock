package com.example.focuslock

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import java.security.SecureRandom

/**
 * Device admin receiver + uninstall/deactivation high-friction blocker.
 *
 * A plain (non-owner) Device Admin can never *hard*-block its own deactivation
 * or uninstall — Android always lets the user remove the admin and then delete
 * the app. What it CAN do, and what this class does, is make that removal so
 * expensive that a weak-moment impulse is effectively impossible:
 *
 *  - [onDisableRequested] fires the moment the user taps "Deactivate" in
 *    Settings. It generates a fresh 200-character typing challenge and launches
 *    [DeactivationChallengeActivity] full-screen over Settings. The challenge
 *    must be typed *perfectly*, character for character, exactly as shown, or
 *    the removal is never permitted. There is no "skip", no back button, no
 *    swipe-away: the only escape is waiting out the two-hour cooldown.
 *  - [onDisableRequested] also feeds its copy into the system confirmation
 *    dialog to warn before the flow even starts.
 *  - [onDisabled] fires at the moment an actual uninstall attempt revokes the
 *    admin. Two things happen immediately: [rearm] re-registers the receiver
 *    (verified via reflection because `setActiveAdmin` was removed from the
 *    public SDK in API 36) so the Settings toggle snaps straight back to "on",
 *    and [DeactivationCooldownService] starts a persistent foreground
 *    notification counting down a mandatory 2-hour waiting period. Every
 *    subsequent attempt hits the same wall again — that loop is the delay.
 *  - While the cooldown is active the watchdog in [DeactivationCooldownService]
 *    re-arms the admin on an interval so even a just-revoked admin is restored
 *    within a minute.
 *
 * The only way past this on an un-rooted device is force-stopping the app
 * first (a stopped process can't receive broadcasts) — an Android platform
 * limitation, not a hole this code can close.
 *
 * Optional Device Owner upgrade (needs a reset / account-free device):
 *   adb shell dpm set-device-owner com.example.focuslock/.DeviceAdminBlocker
 * That unlocks `setUninstallBlocked()`, `lockNow()` and always-on VPN lockdown.
 */
class DeviceAdminBlocker : DeviceAdminReceiver() {

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        // Issue a fresh typing challenge and put it in front of Settings BEFORE
        // the confirmation dialog can be acted on.
        DeactivationGate.newChallenge(context)
        DeactivationChallengeActivity.launch(context)
        return context.getString(R.string.device_admin_disable_warning)
    }

    override fun onDisabled(context: Context, intent: Intent) {
        // A deactivation/uninstall attempt got through: start the 2-hour
        // cooldown's persistent notification and instantly re-arm so the switch
        // snaps back on and the uninstall remains blocked.
        DeactivationGate.startCooldown(context)
        rearm(context)
    }

    override fun onEnabled(context: Context, intent: Intent) {
        // Admin re-activated (via the picker, the re-arm, or after a cooldown).
        // A completed cooldown or a re-enable clears any pending challenge and
        // cancels the cooldown notification.
        DeactivationGate.onReenabled(context)
    }

    override fun onPasswordChanged(context: Context, intent: Intent) {
        // Declared via wipe-data / reset-password policies; no action needed.
    }

    companion object {

        fun component(context: Context): ComponentName =
            ComponentName(context, DeviceAdminBlocker::class.java)

        fun isActive(context: Context): Boolean {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE)
                as DevicePolicyManager
            return dpm.isAdminActive(component(context))
        }

        /**
         * Device Admin is a hard requirement of FocusLock, so it must be
         * requested the moment the app opens. After the first grant the check
         * is a no-op; if it was ever revoked the admin picker re-opens and, on
         * picker failure, the silent re-arm fallback engages.
         */
        fun ensureActive(context: Context) {
            if (isActive(context)) {
                DeactivationGate.clearState(context)
                return
            }
            try {
                val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, component(context))
                    .putExtra(
                        DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                        context.getString(R.string.device_admin_prompt_explanation),
                    )
                context.startActivity(intent)
            } catch (_: Exception) {
                // No admin picker (rare OEM) — fall back to the silent re-arm.
                rearm(context)
            }
        }

        /** Re-registers the admin if it was revoked. Idempotent and silent —
         *  also used by [GuardManager] as a boot/service-start watchdog. */
        fun rearm(context: Context) {
            if (isActive(context)) return
            try {
                val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE)
                    as DevicePolicyManager
                reflectSetActiveAdmin(dpm, component(context))
            } catch (_: Exception) {
                // Not permitted here (e.g. admin slot temporarily locked); the
                // next enforce() call retries.
            }
        }

        /**
         * setActiveAdmin was removed from the public SDK in API 36, but the
         * runtime method still exists on supported devices (and is how a
         * non-owner admin re-registers after [onDisabled]). Tries the two-arg
         * variant first, then the one-arg one.
         */
        private fun reflectSetActiveAdmin(dpm: DevicePolicyManager, comp: ComponentName) {
            try {
                val m = dpm.javaClass.getMethod(
                    "setActiveAdmin",
                    ComponentName::class.java,
                    java.lang.Boolean.TYPE,
                )
                m.invoke(dpm, comp, true)
            } catch (_: Exception) {
                try {
                    val m = dpm.javaClass.getMethod("setActiveAdmin", ComponentName::class.java)
                    m.invoke(dpm, comp)
                } catch (_: Exception) {
                    // No runtime method at all (fully updated framework): nothing
                    // more a non-owner app can do here.
                }
            }
        }
    }
}

/**
 * Persisted state for the deactivation gate: the current 200-character
 * challenge and the 2-hour cooldown window. Stored in a dedicated prefs file so
 * protection does not get mixed up with the session store.
 */
object DeactivationGate {

    private const val PREFS = "focuslock_deactivation"
    private const val KEY_TARGET = "challenge_target"
    private const val KEY_COOLDOWN_END = "cooldown_end_wall"

    /** Readable charset — no O/0, I/1, so transcription mistakes are rarer. */
    private const val CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    const val CHALLENGE_LENGTH = 200
    private const val COOLDOWN_MILLIS = 2L * 60 * 60 * 1000

    private val random = SecureRandom()

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------------ challenge

    fun newChallenge(context: Context) {
        val sb = StringBuilder(CHALLENGE_LENGTH)
        repeat(CHALLENGE_LENGTH) { sb.append(CHARSET[random.nextInt(CHARSET.length)]) }
        prefs(context).edit().putString(KEY_TARGET, sb.toString()).apply()
    }

    fun currentChallenge(context: Context): String? =
        prefs(context).getString(KEY_TARGET, null)

    /**
     * Verifies the typed characters against the challenge. Only a perfect,
     * character-for-character match returns true — any difference (wrong char,
     * missing char, extra char) is a failure and progress resets on render.
     * Whitespace typed for readability is tolerated.
     */
    fun verify(context: Context, typed: String): Boolean {
        val target = currentChallenge(context) ?: return false
        val normalized = typed.filterNot { it.isWhitespace() }
        return normalized == target
    }

    /** Strict prefix match length, for the progress readout. */
    fun progress(context: Context, typed: String): Int {
        val target = currentChallenge(context) ?: return 0
        val normalized = typed.filterNot { it.isWhitespace() }
        var i = 0
        while (i < normalized.length && i < target.length && normalized[i] == target[i]) i++
        return i
    }

    // ------------------------------------------------------------ cooldown

    /** Begins the 2-hour mandatory wait (wall clock, so it survives reboots). */
    fun startCooldown(context: Context) {
        val end = System.currentTimeMillis() + COOLDOWN_MILLIS
        prefs(context).edit()
            .putLong(KEY_COOLDOWN_END, end)
            .apply()
        DeactivationCooldownService.start(context)
    }

    /** Whether we are still inside the 2-hour window. */
    fun cooldownRemainingMillis(context: Context): Long {
        val end = prefs(context).getLong(KEY_COOLDOWN_END, 0L)
        return (end - System.currentTimeMillis()).coerceAtLeast(0L)
    }

    fun isCooldownActive(context: Context): Boolean =
        cooldownRemainingMillis(context) > 0

    /** Re-enable after a challenge or cooldown completed. */
    fun onReenabled(context: Context) {
        clearState(context)
    }

    fun clearState(context: Context) {
        prefs(context).edit().clear().apply()
        DeactivationCooldownService.cancel(context)
    }
}