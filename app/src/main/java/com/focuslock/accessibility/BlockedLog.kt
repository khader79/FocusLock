package com.focuslock.accessibility

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Bounded, append-only record of what got stopped and why. Used by both the
 * search scanner and the network filter so the history reads as one timeline.
 */
object BlockedLog {

    private const val PREFS = "focuslock_prefs"
    private const val KEY = "blocked_entries"
    private const val MAX_ENTRIES = 200

    data class Entry(
        val kind: String,
        val value: String,
        val source: String,
        val timestamp: Long
    )

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun encode(e: Entry): String = "${e.timestamp}\t${e.kind}\t${e.value}\t${e.source}"

    private fun decode(line: String): Entry? {
        val parts = line.split('\t')
        if (parts.size < 4) return null
        return Entry(
            kind = parts[1],
            value = parts[2],
            source = parts[3],
            timestamp = parts[0].toLongOrNull() ?: return null
        )
    }

    fun add(context: Context, kind: String, value: String, source: String) {
        val entry = Entry(kind, value, source, System.currentTimeMillis())
        val store = prefs(context)
        val existing = store.getString(KEY, "").orEmpty()
        val lines = existing.lines().filter { it.isNotBlank() }.toMutableList()
        lines.add(encode(entry))
        val trimmed = if (lines.size > MAX_ENTRIES) {
            lines.subList(lines.size - MAX_ENTRIES, lines.size)
        } else {
            lines
        }
        store.edit().putString(KEY, trimmed.joinToString("\n")).apply()
    }

    fun recordSearch(context: Context, term: String, pkg: String) =
        add(context, "SEARCH", term, pkg)

    fun recordNetwork(context: Context, host: String) =
        add(context, "SITE", host, "network")

    fun entries(context: Context): List<Entry> {
        val raw = prefs(context).getString(KEY, "").orEmpty()
        return raw.lines().filter { it.isNotBlank() }
            .mapNotNull { decode(it) }
            .sortedByDescending { it.timestamp }
    }

    fun countToday(context: Context): Int {
        val startOfDay = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.HOUR_OF_DAY, 0)
            set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }.timeInMillis
        return entries(context).count { it.timestamp >= startOfDay }
    }

    fun clear(context: Context) = prefs(context).edit().remove(KEY).apply()

    fun formatTime(timestamp: Long): String =
        SimpleDateFormat("MM/dd HH:mm", Locale.getDefault()).format(Date(timestamp))
}