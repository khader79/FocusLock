package com.example.focuslock

import android.content.Context

/** Loads the domain blocklist shipped in assets/blocklist.txt into a HashSet. */
class Blocklist {
    private val domains = HashSet<String>()

    /**
     * Reads assets/blocklist.txt and rebuilds the set. One domain per line;
     * lines starting with '#' and blank lines are ignored.
     */
    @Synchronized
    fun load(context: Context) {
        val text = context.assets.open("blocklist.txt").use { input ->
            input.bufferedReader(Charsets.UTF_8).use { reader ->
                reader.readText()
            }
        }

        val next = HashSet<String>()
        for (rawLine in text.lineSequence()) {
            val line = rawLine.trim().lowercase()
            if (line.isEmpty() || line.startsWith('#') || line.contains(' ') || line.contains('\t')) {
                continue
            }
            next.add(line)
        }

        domains.clear()
        domains.addAll(next)
    }

    /**
     * True when [domain] or any of its parent domains is on the blocklist,
     * so a query for "www.instagram.com" also matches "instagram.com".
     */
    fun isBlocked(domain: String): Boolean {
        var current: String? = domain.trimEnd('.')
        while (current != null && current.isNotEmpty()) {
            if (domains.contains(current)) {
                return true
            }
            val dot = current.indexOf('.')
            current = if (dot == -1) null else current.substring(dot + 1)
        }
        return false
    }
}