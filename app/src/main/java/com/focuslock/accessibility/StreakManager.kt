package com.focuslock.accessibility

import android.content.Context
import java.util.Calendar

/**
 * Day-based accountability. Not a lock — a scoreboard. The user can always
 * disable protection; this just keeps a visible record so quitting feels like
 * a decision instead of a non-event.
 */
object StreakManager {

    private const val PREFS = "focuslock_prefs"
    private const val KEY_DAYS = "streak_days"
    private const val KEY_LAST = "streak_last_day"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun today(): Int {
        val c = Calendar.getInstance()
        return c.get(Calendar.YEAR) * 1000 + c.get(Calendar.DAY_OF_YEAR)
    }

    /** Call once a day — when protection is confirmed active. */
    fun markActive(context: Context) {
        val store = prefs(context)
        val last = store.getInt(KEY_LAST, 0)
        val current = today()
        if (last == current) return
        val days = if (last == current - 1) {
            store.getInt(KEY_DAYS, 0) + 1
        } else {
            1
        }
        store.edit()
            .putInt(KEY_DAYS, days)
            .putInt(KEY_LAST, current)
            .apply()
    }

    fun currentStreak(context: Context): Int {
        val store = prefs(context)
        val last = store.getInt(KEY_LAST, 0)
        val current = today()
        // Streak is only alive if today or yesterday was active.
        return if (last == current || last == current - 1) {
            store.getInt(KEY_DAYS, 0)
        } else {
            0
        }
    }

    fun reset(context: Context) {
        prefs(context).edit()
            .remove(KEY_DAYS)
            .remove(KEY_LAST)
            .apply()
    }
}