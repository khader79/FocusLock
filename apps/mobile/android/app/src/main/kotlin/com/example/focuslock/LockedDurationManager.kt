package com.example.focuslock

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * The irreversible "Time Lock" / Cold-Turkey-style lock.
 *
 * The user picks a schedule (ALL_DAY, or a daily WINDOW such as 21:00-06:00), a
 * duration (e.g. 90 days) and optionally Locked Mode (immediate + unchangeable).
 * Once armed, until the duration has elapsed [canModify] is false and every
 * mutating entry point must refuse: the schedule, block list and duration are
 * frozen, and Locked Mode forces the block around the clock.
 *
 * ---------------------------------------------------------------------------
 * Tamper resistance
 * ---------------------------------------------------------------------------
 *
 * 1. Integrity — the record is a JSON payload plus an HMAC-SHA256 tag produced
 *    with a key that lives in the Android Keystore (never leaves it). Editing
 *    the payload in SharedPreferences invalidates the tag.
 *
 * 2. Redundant storage — the identical signed record is written to two
 *    independent SharedPreferences files. If one is edited/truncated the other
 *    is used; only when *both* fail verification is the state treated as
 *    tampered (fail closed).
 *
 * 3. Device-time proof — the countdown never trusts the wall clock. It is
 *    measured with [SystemClock.elapsedRealtime] accumulated across reboots:
 *      trustedNow = accumulatedElapsed + (elapsedRealtime - bootBaseElapsed)
 *    A reboot is detected when elapsedRealtime < bootBaseElapsed; the running
 *    total is preserved and re-based. Moving the system clock forwards or
 *    backwards therefore cannot shorten the lock. A wall-clock high-water mark
 *    is still kept so a rollback can be flagged for the UI.
 *
 * Known residual hole (documented, not fixable without Device Owner): clearing
 * the app's data removes the prefs *and* the Keystore key. See GuardManager for
 * the device-owner hardening that closes it.
 */
object LockedDurationManager {

    private const val PREFS_MAIN = "focuslock_timelock"
    private const val PREFS_MIRROR = "focuslock_timelock_mirror"
    private const val KEY_RECORD = "record"

    private const val KEYSTORE = "AndroidKeyStore"
    private const val HMAC_ALIAS = "focuslock_timelock_hmac"
    private const val FALLBACK_SECRET_KEY = "fallback_hmac_secret"

    private const val SLOT_WINDOW = "window"

    /** How much wall-clock rollback still counts as legitimate (DST / NTP). */
    private const val CLOCK_ROLLBACK_SLACK_MILLIS = 10 * 60_000L

    /** Fail-closed lock applied when both signed copies are corrupt. */
    private const val TAMPER_LOCK_MILLIS = 7L * 24 * 60 * 60 * 1000

    enum class ScheduleMode { ALL_DAY, WINDOW }

    data class LockState(
        val locked: Boolean,
        val lockedMode: Boolean,
        val durationDays: Int,
        val remainingMillis: Long,
        val expiresAtWallMillis: Long,
        val scheduleMode: ScheduleMode,
        val startMinutes: Int,
        val endMinutes: Int,
        val scheduleActiveNow: Boolean,
        val clockTampered: Boolean,
        val integrityTampered: Boolean,
    ) {
        fun toMap(): Map<String, Any?> = mapOf(
            "locked" to locked,
            "lockedMode" to lockedMode,
            "durationDays" to durationDays,
            "remainingMillis" to remainingMillis,
            "expiresAtWallMillis" to expiresAtWallMillis,
            "scheduleMode" to if (scheduleMode == ScheduleMode.WINDOW) "window" else "all_day",
            "startMinutes" to startMinutes,
            "endMinutes" to endMinutes,
            "scheduleActiveNow" to scheduleActiveNow,
            "clockTampered" to clockTampered,
            "integrityTampered" to integrityTampered,
        )
    }

    /** Signed, persisted lock record. */
    private data class Record(
        var startTrusted: Long,
        var durationMillis: Long,
        val durationDays: Int,
        val lockedMode: Boolean,
        var scheduleMode: ScheduleMode,
        var startMinutes: Int,
        var endMinutes: Int,
        val armedAtWall: Long,
        var accumulatedElapsed: Long,
        var bootBaseElapsed: Long,
        var wallHighWater: Long,
        var clockTampered: Boolean,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("v", 1)
            put("startTrusted", startTrusted)
            put("durationMillis", durationMillis)
            put("durationDays", durationDays)
            put("lockedMode", lockedMode)
            put("scheduleMode", if (scheduleMode == ScheduleMode.WINDOW) SLOT_WINDOW else "all_day")
            put("startMinutes", startMinutes)
            put("endMinutes", endMinutes)
            put("armedAtWall", armedAtWall)
            put("accumulatedElapsed", accumulatedElapsed)
            put("bootBaseElapsed", bootBaseElapsed)
            put("wallHighWater", wallHighWater)
            put("clockTampered", clockTampered)
        }

        companion object {
            fun fromJson(json: JSONObject): Record? = try {
                Record(
                    startTrusted = json.getLong("startTrusted"),
                    durationMillis = json.getLong("durationMillis"),
                    durationDays = json.getInt("durationDays"),
                    lockedMode = json.getBoolean("lockedMode"),
                    scheduleMode = if (json.getString("scheduleMode") == SLOT_WINDOW) {
                        ScheduleMode.WINDOW
                    } else {
                        ScheduleMode.ALL_DAY
                    },
                    startMinutes = json.getInt("startMinutes"),
                    endMinutes = json.getInt("endMinutes"),
                    armedAtWall = json.getLong("armedAtWall"),
                    accumulatedElapsed = json.getLong("accumulatedElapsed"),
                    bootBaseElapsed = json.getLong("bootBaseElapsed"),
                    wallHighWater = json.getLong("wallHighWater"),
                    clockTampered = json.optBoolean("clockTampered", false),
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_MAIN, Context.MODE_PRIVATE)

    private fun mirror(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_MIRROR, Context.MODE_PRIVATE)

    // ------------------------------------------------------------- integrity

    private fun hmacKey(context: Context): SecretKey {
        return try {
            val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            val entry = keyStore.getEntry(HMAC_ALIAS, null) as? KeyStore.SecretKeyEntry
            entry?.secretKey ?: KeyGenerator
                .getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, KEYSTORE)
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                            HMAC_ALIAS,
                            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
                        ).build(),
                    )
                }
                .generateKey()
        } catch (_: Exception) {
            // Keystore unavailable: fall back to a random app-local secret.
            val stored = prefs(context).getString(FALLBACK_SECRET_KEY, null)
            val bytes = if (stored != null) {
                Base64.decode(stored, Base64.NO_WRAP)
            } else {
                ByteArray(32).also { SecureRandom().nextBytes(it) }.also {
                    prefs(context).edit()
                        .putString(FALLBACK_SECRET_KEY, Base64.encodeToString(it, Base64.NO_WRAP))
                        .apply()
                }
            }
            SecretKeySpec(bytes, "HmacSHA256")
        }
    }

    private fun sign(context: Context, payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(hmacKey(context))
        return Base64.encodeToString(mac.doFinal(payload.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    /** Writes the signed record to both stores. */
    private fun write(context: Context, record: Record) {
        val payload = record.toJson().toString()
        val stored = JSONObject().apply {
            put("payload", payload)
            put("sig", sign(context, payload))
        }.toString()
        prefs(context).edit().putString(KEY_RECORD, stored).apply()
        mirror(context).edit().putString(KEY_RECORD, stored).apply()
    }

    private fun verify(context: Context, raw: String?): Record? {
        if (raw == null) return null
        return try {
            val obj = JSONObject(raw)
            val payload = obj.getString("payload")
            val sig = obj.getString("sig")
            if (sig != sign(context, payload)) return null
            Record.fromJson(JSONObject(payload))
        } catch (_: Exception) {
            null
        }
    }

    /** @return the best valid record, and whether any copy existed at all. */
    private fun read(context: Context): Pair<Record?, Boolean> {
        val main = verify(context, prefs(context).getString(KEY_RECORD, null))
        val mirrored = verify(context, mirror(context).getString(KEY_RECORD, null))
        val anyPresent = prefs(context).contains(KEY_RECORD) || mirror(context).contains(KEY_RECORD)
        val best = main ?: mirrored
        if (best != null && (main == null || mirrored == null)) {
            // One copy was lost/edited: heal it from the good one.
            write(context, best)
        }
        return best to anyPresent
    }

    // ----------------------------------------------------------- trusted time

    /** Monotonic time that survives reboots and ignores the wall clock. */
    private fun trustedNow(record: Record): Long {
        val elapsed = SystemClock.elapsedRealtime()
        val contribution = if (elapsed >= record.bootBaseElapsed) {
            elapsed - record.bootBaseElapsed
        } else {
            0L // rebooted since the last checkpoint
        }
        return record.accumulatedElapsed + contribution
    }

    /** Re-bases the checkpoint and flags wall-clock rollback. Called by the
     *  service tick so a reboot only ever loses the sub-tick window. */
    fun checkpoint(context: Context) {
        val (record, _) = read(context)
        val current = record ?: return
        val wallNow = System.currentTimeMillis()
        if (wallNow < current.wallHighWater - CLOCK_ROLLBACK_SLACK_MILLIS) {
            current.clockTampered = true
        }
        if (wallNow > current.wallHighWater) {
            current.wallHighWater = wallNow
        }
        current.accumulatedElapsed = trustedNow(current)
        current.bootBaseElapsed = SystemClock.elapsedRealtime()
        if (current.accumulatedElapsed - current.startTrusted >= current.durationMillis) {
            clear(context) // elapsed for real: release the lock
            return
        }
        write(context, current)
    }

    // ------------------------------------------------------------------- API

    /** Arms the lock. Refuses to re-arm (which would reset the timer) unless the
     *  previous lock already elapsed. Returns the resulting state. */
    fun arm(
        context: Context,
        durationDays: Int,
        lockedMode: Boolean,
        scheduleMode: ScheduleMode,
        startMinutes: Int,
        endMinutes: Int,
    ): LockState {
        val (existing, _) = read(context)
        if (existing != null && remainingMillis(existing) > 0) {
            throw IllegalStateException("Time lock already active")
        }
        val wallNow = System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtime()
        val record = Record(
            startTrusted = 0L, // filled below
            durationMillis = durationDays.toLong() * 24 * 60 * 60 * 1000,
            durationDays = durationDays,
            lockedMode = lockedMode,
            scheduleMode = scheduleMode,
            startMinutes = startMinutes.coerceIn(0, 24 * 60 - 1),
            endMinutes = endMinutes.coerceIn(0, 24 * 60 - 1),
            armedAtWall = wallNow,
            accumulatedElapsed = 0L,
            bootBaseElapsed = elapsed,
            wallHighWater = wallNow,
            clockTampered = false,
        )
        record.startTrusted = trustedNow(record)
        write(context, record)
        return state(context)
    }

    /** Only ever increases the remaining time — never shortens it. */
    fun extend(context: Context, extraDays: Int): LockState {
        val (candidate, _) = read(context)
        val record = candidate ?: throw IllegalStateException("No active time lock")
        if (extraDays <= 0) throw IllegalArgumentException("extraDays must be positive")
        record.durationMillis += extraDays.toLong() * 24 * 60 * 60 * 1000
        write(context, record)
        return state(context)
    }

    /** Changes the schedule. Rejected while locked. */
    fun updateSchedule(
        context: Context,
        scheduleMode: ScheduleMode,
        startMinutes: Int,
        endMinutes: Int,
    ): LockState {
        val (candidate, anyPresent) = read(context)
        val record = candidate ?: if (anyPresent) {
            throw IllegalStateException("Tampered lock")
        } else {
            throw IllegalStateException("No active time lock")
        }
        if (remainingMillis(record) > 0) {
            throw IllegalStateException("Time lock active: schedule is frozen")
        }
        record.scheduleMode = scheduleMode
        record.startMinutes = startMinutes.coerceIn(0, 24 * 60 - 1)
        record.endMinutes = endMinutes.coerceIn(0, 24 * 60 - 1)
        write(context, record)
        return state(context)
    }

    private fun remainingMillis(record: Record): Long {
        val elapsed = trustedNow(record) - record.startTrusted
        return (record.durationMillis - elapsed).coerceAtLeast(0L)
    }

    fun state(context: Context): LockState {
        val (record, anyPresent) = read(context)
        if (record == null) {
            val tampered = anyPresent
            return LockState(
                locked = tampered,
                lockedMode = tampered,
                durationDays = 0,
                remainingMillis = if (tampered) TAMPER_LOCK_MILLIS else 0L,
                expiresAtWallMillis = if (tampered) {
                    System.currentTimeMillis() + TAMPER_LOCK_MILLIS
                } else {
                    0L
                },
                scheduleMode = ScheduleMode.ALL_DAY,
                startMinutes = 0,
                endMinutes = 0,
                scheduleActiveNow = tampered,
                clockTampered = tampered,
                integrityTampered = tampered,
            )
        }
        val remaining = remainingMillis(record)
        val locked = remaining > 0
        return LockState(
            locked = locked,
            lockedMode = locked && record.lockedMode,
            durationDays = record.durationDays,
            remainingMillis = remaining,
            expiresAtWallMillis = System.currentTimeMillis() + remaining,
            scheduleMode = record.scheduleMode,
            startMinutes = record.startMinutes,
            endMinutes = record.endMinutes,
            scheduleActiveNow = locked && scheduleActiveNow(record),
            clockTampered = record.clockTampered,
            integrityTampered = false,
        )
    }

    fun isLocked(context: Context): Boolean = state(context).locked

    /** True only when the user may edit the schedule / block list / settings. */
    fun canModify(context: Context): Boolean = !state(context).locked

    /** Clears the lock. Internal/maintenance only — never exposed to the UI. */
    fun clear(context: Context) {
        prefs(context).edit().remove(KEY_RECORD).apply()
        mirror(context).edit().remove(KEY_RECORD).apply()
    }

    /** Whether the block should be enforced right now. */
    private fun scheduleActiveNow(record: Record): Boolean {
        if (record.lockedMode || record.scheduleMode == ScheduleMode.ALL_DAY) {
            return true
        }
        val calendar = java.util.Calendar.getInstance()
        val now = calendar.get(java.util.Calendar.HOUR_OF_DAY) * 60 +
            calendar.get(java.util.Calendar.MINUTE)
        val start = record.startMinutes
        val end = record.endMinutes
        return if (start <= end) {
            now in start until end
        } else {
            // Overnight window, e.g. 21:00 -> 06:00.
            now >= start || now < end
        }
    }

    /** True when the schedule is currently in its blocked window. */
    fun isScheduleActiveNow(context: Context): Boolean {
        val (candidate, _) = read(context)
        val record = candidate ?: return false
        return remainingMillis(record) > 0 && scheduleActiveNow(record)
    }
}