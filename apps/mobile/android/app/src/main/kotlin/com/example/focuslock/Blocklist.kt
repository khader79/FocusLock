package com.example.focuslock

import android.content.Context

/**
 * Loads the domain + keyword blocklists shipped in assets into HashSets.
 *
 * - `blocklist.txt`  : user's curated social / distraction domains.
 * - `adult_domains.txt` : adult-content domains, always enforced.
 * - `adult_keywords.txt`: full-label keywords (never substrings) so mirrors
 *   and unknown hosts with clearly-adult label terms are covered too.
 *
 * Custom sites / enabled category patterns from [RuleStore] are merged on top.
 */
class Blocklist {
    private val domains = HashSet<String>()
    private val keywords = HashSet<String>()

    /** Reads a plain asset file into a set. One entry per line; lines starting
     *  with '#' and blank lines are ignored. */
    private fun readAsset(context: Context, name: String): Set<String> {
        val text = context.assets.open(name).use { input ->
            input.bufferedReader(Charsets.UTF_8).use { reader ->
                reader.readText()
            }
        }
        return buildSet {
            for (rawLine in text.lineSequence()) {
                val line = rawLine.trim().lowercase()
                if (line.isEmpty() || line.startsWith('#') || line.contains(' ') || line.contains('\t')) {
                    continue
                }
                add(line)
            }
        }
    }

    /**
     * Rebuilds the block sets from assets + [RuleStore]. Called by the VPN
     * before its read loop starts.
     */
    @Synchronized
    fun load(context: Context) {
        val next = HashSet<String>()
        next.addAll(readAsset(context, "blocklist.txt"))
        next.addAll(readAsset(context, "adult_domains.txt"))
        next.addAll(RuleStore.allDomains(context))

        val nextKeywords = HashSet(readAsset(context, "adult_keywords.txt"))

        domains.let {
            it.clear()
            it.addAll(next)
        }
        keywords.clear()
        keywords.addAll(nextKeywords)
    }

    private fun matchesKeyword(hostname: String): Boolean {
        // Match against full dot-separated labels only (never substrings) so a
        // keyword like "sex" cannot false-positive on "essex.ac.uk".
        for (label in hostname.split('.')) {
            if (label in keywords) {
                return true
            }
        }
        return false
    }

    /**
     * True when [domain] or any of its parent domains is on the blocklist, or
     * when any full hostname label matches an adult keyword. A query for
     * "www.instagram.com" also matches "instagram.com".
     */
    @Synchronized
    fun isBlocked(domain: String): Boolean {
        val host = domain.trim().lowercase()
        if (matchesKeyword(host)) {
            return true
        }
        var current: String? = host.trimEnd('.')
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