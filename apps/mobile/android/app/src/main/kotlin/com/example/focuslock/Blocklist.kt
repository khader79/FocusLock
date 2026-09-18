package com.example.focuslock

import android.content.Context

/**
 * Loads the domain + keyword blocklists shipped in assets into matchers.
 *
 * - `blocklist.txt`      : user's curated social / distraction domains (small).
 * - `adult_domains.txt`  : the full porn blocklist — ~937k minimal-cover
 *   domains (derived from The Block List Project's porn list). Kept in a
 *   flat sorted byte array with a line-offset table and binary-searched on
 *   every query, so a "set of all porn sites in the world" stays resident in
 *   ~23 MB instead of a >120 MB HashSet. The file is pre-sorted and
 *   ASCII-lowercased at build time; parent-suffix matching still applies
 *   (a query for "cdn.www.site.com" matches "site.com").
 * - `adult_keywords.txt` : full-label keywords (never substrings) so mirrors
 *   and unknown hosts with clearly-adult label terms are covered too.
 *
 * Custom sites / enabled category patterns from [RuleStore] are merged on top.
 */
class Blocklist {

    /**
     * Flutter packages pubspec assets inside the APK under
     * `assets/flutter_assets/assets/…`, which is not reachable through the
     * Android-native asset path root — every open must use this prefix.
     */
    private fun openAsset(context: Context, name: String) =
        context.assets.open("flutter_assets/assets/$name")
    private val domains = HashSet<String>()
    private val keywords = HashSet<String>()

    // Flat sorted ASCII domain table (no per-line String objects).
    private var bigBytes: ByteArray = ByteArray(0)
    private var bigOffsets: IntArray = intArrayOf()
    private var bigLineCount = 0

    /** Reads a plain asset file into a set. One entry per line; lines starting
     *  with '#' and blank lines are ignored. */
    private fun readAsset(context: Context, name: String): Set<String> {
        val text = openAsset(context, name).use { input ->
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
        next.addAll(RuleStore.allDomains(context))

        val nextKeywords = HashSet(readAsset(context, "adult_keywords.txt"))

        domains.let {
            it.clear()
            it.addAll(next)
        }
        keywords.clear()
        keywords.addAll(nextKeywords)

        loadBig(context)
    }

    /** Builds the flat domain table: bytes + one offset per domain line. */
    private fun loadBig(context: Context) {
        val bytes = openAsset(context, "adult_domains.txt").use { it.readBytes() }

        var lineCount = 0
        var start = 0
        for (i in bytes.indices) {
            if (bytes[i] == '\n'.code.toByte()) {
                if (start < i && bytes[start] != '#'.code.toByte()) {
                    lineCount++
                }
                start = i + 1
            }
        }
        if (start < bytes.size && bytes[start] != '#'.code.toByte()) {
            lineCount++
        }

        val offsets = IntArray(lineCount)
        var idx = 0
        start = 0
        for (i in bytes.indices) {
            if (bytes[i] == '\n'.code.toByte()) {
                if (start < i && bytes[start] != '#'.code.toByte()) {
                    offsets[idx++] = start
                }
                start = i + 1
            }
        }
        if (start < bytes.size && bytes[start] != '#'.code.toByte()) {
            offsets[idx++] = start
        }

        bigBytes = bytes
        bigOffsets = offsets
        bigLineCount = idx
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
            if (domains.contains(current) || bigContains(current)) {
                return true
            }
            val dot = current.indexOf('.')
            current = if (dot == -1) null else current.substring(dot + 1)
        }
        return false
    }

    /** Binary search of a domain in the flat table. */
    private fun bigContains(host: String): Boolean {
        var lo = 0
        var hi = bigLineCount - 1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            val s = bigOffsets[mid]
            val e = if (mid + 1 == bigLineCount) bigBytes.size else bigOffsets[mid + 1] - 1
            val cmp = compareSlice(host, s, e)
            when {
                cmp == 0 -> return true
                cmp < 0 -> hi = mid - 1
                else -> lo = mid + 1
            }
        }
        return false
    }

    /** Compares [query] against the byte slice bigBytes[s, e) (ASCII, already
     *  lowercased in the file). The slice may carry a trailing Windows CRLF
     *  byte from generated assets; it is excluded from the comparison. */
    private fun compareSlice(query: String, s: Int, e: Int): Int {
        val slResult = e - s
        val sl = if (slResult > 0 && bigBytes[e - 1] == '\r'.code.toByte()) slResult - 1 else slResult
        val q = query.length
        val n = if (q < sl) q else sl
        for (i in 0 until n) {
            val v1 = query[i].code
            val v2 = bigBytes[s + i].toInt() and 0xFF
            if (v1 != v2) {
                return if (v1 < v2) -1 else 1
            }
        }
        return when {
            q < sl -> -1
            q > sl -> 1
            else -> 0
        }
    }
}