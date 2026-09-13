package com.example.focuslock

import android.content.Context
import android.content.SharedPreferences
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Single source of truth for protection state, persisted in SharedPreferences
 * so the VPN service, the foreground service and the Flutter UI stay in sync.
 *
 * Mirrors the `DashboardState` shape used by the desktop app.
 */
object ProtectionStore {

    private const val PREFS = "focuslock_state"

    private const val KEY_ACTIVE = "active"
    private const val KEY_PAUSED = "paused"
    private const val KEY_BLOCKED_TODAY = "blocked_today"
    private const val KEY_STATS_DAY = "stats_day"
    private const val KEY_UNLOCK_ATTEMPTS = "unlock_attempts"
    private const val KEY_LAST_UPDATE = "last_update"
    private const val KEY_CHALLENGE_ID = "challenge_id"
    private const val KEY_CHALLENGE_TARGET = "challenge_target"
    private const val KEY_DIFFICULTY = "difficulty"

    private const val KEY_SYNC_URL = "sync_url"
    private const val KEY_SYNC_ANON_KEY = "sync_anon_key"
    private const val KEY_SYNC_ROW_ID = "sync_row_id"
    private const val KEY_SYNC_SECRET = "sync_secret"

    private fun prefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    // ---------------------------------------------------------------- session

    fun setActive(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_ACTIVE, value).apply()
    }

    fun isActive(context: Context): Boolean {
        return prefs(context).getBoolean(KEY_ACTIVE, false)
    }

    fun setPaused(context: Context, value: Boolean) {
        prefs(context).edit().putBoolean(KEY_PAUSED, value).apply()
    }

    fun isPaused(context: Context): Boolean {
        return prefs(context).getBoolean(KEY_PAUSED, false)
    }

    // ----------------------------------------------------------------- stats

    /** The domain/date key the blocked-today counter is valid for. */
    private fun dayKey(): String {
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
    }

    /** Returns blocked-today, resetting the counter when the day rolled over. */
    fun blockedToday(context: Context): Int {
        val stored = prefs(context)
        val currentDay = dayKey()
        if (stored.getString(KEY_STATS_DAY, null) != currentDay) {
            stored.edit()
                .putString(KEY_STATS_DAY, currentDay)
                .putInt(KEY_BLOCKED_TODAY, 0)
                .putInt(KEY_UNLOCK_ATTEMPTS, 0)
                .apply()
        }
        return stored.getInt(KEY_BLOCKED_TODAY, 0)
    }

    fun incrementBlocked(context: Context) {
        // Touch day rollover first.
        blockedToday(context)
        val stored = prefs(context)
        val next = stored.getInt(KEY_BLOCKED_TODAY, 0) + 1
        stored.edit().putInt(KEY_BLOCKED_TODAY, next).apply()
    }

    fun unlockAttempts(context: Context): Int {
        return prefs(context).getInt(KEY_UNLOCK_ATTEMPTS, 0)
    }

    fun incrementUnlockAttempt(context: Context) {
        blockedToday(context) // ensures day key is current
        val stored = prefs(context)
        val next = stored.getInt(KEY_UNLOCK_ATTEMPTS, 0) + 1
        stored.edit().putInt(KEY_UNLOCK_ATTEMPTS, next).apply()
    }

    fun lastUpdate(context: Context): String? {
        return prefs(context).getString(KEY_LAST_UPDATE, null)
    }

    fun touchLastUpdate(context: Context) {
        prefs(context).edit().putString(KEY_LAST_UPDATE, dayKey()).apply()
    }

    // -------------------------------------------------------------- challenge

    /** Registers the challenge the user must complete to toggle pause. */
    fun setPendingChallenge(context: Context, id: String, target: String) {
        prefs(context).edit()
            .putString(KEY_CHALLENGE_ID, id)
            .putString(KEY_CHALLENGE_TARGET, target)
            .apply()
    }

    /** The currently registered challenge target, if any. */
    fun pendingChallenge(context: Context): Pair<String, String>? {
        val st = prefs(context)
        val id = st.getString(KEY_CHALLENGE_ID, null) ?: return null
        val target = st.getString(KEY_CHALLENGE_TARGET, null) ?: return null
        return id to target
    }

    fun clearPendingChallenge(context: Context) {
        prefs(context).edit().remove(KEY_CHALLENGE_ID).remove(KEY_CHALLENGE_TARGET).apply()
    }

    // ------------------------------------------------------------------ sync

    fun difficulty(context: Context): Int {
        return prefs(context).getInt(KEY_DIFFICULTY, 3)
    }

    fun setDifficulty(context: Context, value: Int) {
        prefs(context).edit().putInt(KEY_DIFFICULTY, value).apply()
    }

    fun syncUrl(context: Context): String? = prefs(context).getString(KEY_SYNC_URL, null)
    fun syncAnonKey(context: Context): String? = prefs(context).getString(KEY_SYNC_ANON_KEY, null)
    fun syncRowId(context: Context): String? = prefs(context).getString(KEY_SYNC_ROW_ID, null)
    fun syncSecret(context: Context): String? = prefs(context).getString(KEY_SYNC_SECRET, null)

    fun setSyncConfig(
        context: Context,
        url: String?,
        anonKey: String?,
        rowId: String?,
        secret: String?,
    ) {
        prefs(context).edit()
            .putString(KEY_SYNC_URL, url)
            .putString(KEY_SYNC_ANON_KEY, anonKey)
            .putString(KEY_SYNC_ROW_ID, rowId)
            .putString(KEY_SYNC_SECRET, secret)
            .apply()
    }

    /** Complete snapshot for the UI / sync payloads. */
    fun toMap(context: Context): MutableMap<String, Any?> {
        return mutableMapOf(
            "status" to if (isPaused(context)) "paused" else "active",
            "blockedToday" to blockedToday(context),
            "lastUpdate" to lastUpdate(context),
            "unlockAttempts" to unlockAttempts(context),
            "customSites" to RuleStore.customSites(context).size,
            "customApps" to AppBlocker.readBlockedPackages(context).size,
            "difficulty" to difficulty(context),
            "syncConfigured" to (syncUrl(context) != null),
        )
    }
}