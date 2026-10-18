package com.example.focuslock

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * Cold-Turkey-style explicit domain blocklist for the accessibility layer.
 *
 * Unlike the keyword heuristics of a plain "adult filter", this gate blocks
 * ONLY what the user explicitly listed — the custom sites from the Websites
 * tab, the enabled category patterns, and the shipped distractor
 * [blocklist.txt] — and it does so by parsing the address-bar text as a URL
 * with [Uri.parse], never by matching fuzzy keywords. A search query like
 * "porn" or a page of prose therefore can NEVER trigger it (no false
 * positives, no accidental full-internet blocking); only a real URL whose
 * hostname is on a blocklist does.
 *
 * Matching semantics:
 *  - Text is accepted as a candidate only when it is unambiguously a URL or
 *    hostname: no whitespace, bounded length, and either an explicit scheme
 *    (`https://…`) or a dotted hostname with no spaces (`pornhub.com`).
 *  - The host is extracted with [Uri.parse] (`Uri.host`), lowercased, and
 *    trailing-dot-stripped. IDN hosts arrive as punycode; entries should be
 *    entered in ASCII, matching what the browser shows in its address bar.
 *  - A host matches when it, or any parent suffix of it, is listed
 *    (`www.pornhub.com` triggers a `pornhub.com` entry). Bare TLD labels
 *    never match anything unless explicitly listed.
 *
 * The in-memory set is tiny (user entries only) and is hot-swapped atomically
 * into a [Volatile] reference; lookups are one hash test per label with no
 * disk, no binder and no allocation, so the < 50 ms dispatch contract of
 * [SafeBlockerAccessibilityService] is unaffected.
 */
object ExplicitDomainGate {

    /** Same SharedPreferences file [RuleStore] uses; public here so the
     *  accessibility service can register its reload listener on it. */
    const val PREFS_NAME = "focuslock_rules"

    private const val KEY_CUSTOM_SITES = "custom_sites"
    private const val KEY_CATEGORIES = "categories"

    /** Shipped user-curated distractor list (assets/flutter_assets/assets/…). */
    private const val ASSET_BLOCKLIST = "blocklist.txt"
    private const val ASSET_PREFIX = "flutter_assets/assets/"

    /** Enforced candidate bounds (below the a11y 130-char URL budget, no prose). */
    private const val MAX_CANDIDATE_LENGTH = 130
    private const val MAX_HOST_LENGTH = 253

    /** O(1) membership set of every explicitly-listed hostname. */
    @Volatile
    private var blocked: Set<String> = emptySet()

    /** Rebuilds [blocked] from the user's rules + the shipped distractor list.
     *  Idempotent and cheap (user data only); call on service connect and on
     *  any "focuslock_rules" preference change. */
    fun reload(context: Context) {
        val next = HashSet<String>()
        customSites(context).forEach { site ->
            normalizeEntry(site).takeIf { it.isNotEmpty() }?.let { next.add(it) }
        }
        categories(context).forEach { category ->
            if (category.optBoolean("enabled", true)) {
                normalizeEntry(category.optString("pattern", "")).takeIf { it.isNotEmpty() }
                    ?.let { next.add(it) }
            }
        }
        readDistractorAsset(context).forEach { next.add(it) }
        blocked = next
    }

    /** True when [text] is an explicit URL/hostname pointing at a listed site.
     *  Runs inside the accessibility event thread — a no-op for prose. */
    fun isBlocked(raw: String): Boolean {
        val host = extractHost(raw) ?: return false
        return matchesHost(host)
    }

    // ---------------------------------------------------------------- ext/parse

    /**
     * Resolves [raw] to a hostname, or null when it is not an explicit
     * URL/hostname. Requires an explicit scheme OR a dotted bare hostname;
     * whitespace, oversized strings and scheme-less single words (search
     * queries) are rejected so prose and searches can never false-positive.
     */
    private fun extractHost(raw: String): String? {
        var t = raw.trim()
        if (t.isEmpty() || t.length > MAX_CANDIDATE_LENGTH) return null
        if (t.any { it.isWhitespace() }) return null
        if (!t.contains("://") && !t.contains('.')) return null
        t = if (t.contains("://")) t else "http://$t"

        val uri = try {
            Uri.parse(t)
        } catch (_: Exception) {
            return null
        }
        val host = uri.host ?: return null
        val normalized = host.trimEnd('.').lowercase()
        if (normalized.length > MAX_HOST_LENGTH || normalized == "localhost") return null
        return normalized
    }

    /** Host-or-raw-label normalization for stored list entries (lenient: the
     *  user intentionally listed it, so bare labels are accepted). */
    private fun normalizeEntry(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return ""
        extractHost(trimmed)?.let { return it }
        return trimmed
            .removePrefix("http://")
            .removePrefix("https://")
            .trimEnd('/')
            .lowercase()
    }

    /** Parent-suffix walk: `www.example.com` → `example.com` → `com`. */
    private fun matchesHost(host: String): Boolean {
        var current: String? = host.trimEnd('.')
        while (current != null && current.isNotEmpty()) {
            if (current in blocked) return true
            val dot = current.indexOf('.')
            current = if (dot == -1) null else current.substring(dot + 1)
        }
        return false
    }

    // --------------------------------------------------------------- storages

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun customSites(context: Context): List<String> {
        val raw = prefs(context).getString(KEY_CUSTOM_SITES, null) ?: return emptyList()
        return try {
            JSONArray(raw).let { arr ->
                (0 until arr.length()).map { arr.getString(it) }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun categories(context: Context): List<JSONObject> {
        val raw = prefs(context).getString(KEY_CATEGORIES, null) ?: return emptyList()
        return try {
            JSONArray(raw).let { arr ->
                (0 until arr.length()).mapNotNull { index ->
                    try {
                        arr.getJSONObject(index)
                    } catch (_: Exception) {
                        null
                    }
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Small user-curated distractor set shipped in assets. */
    private fun readDistractorAsset(context: Context): Set<String> {
        return try {
            context.assets.open("$ASSET_PREFIX$ASSET_BLOCKLIST").use { input ->
                input.bufferedReader(Charsets.UTF_8).use { reader ->
                    reader.readText()
                }
            }.lineSequence()
                .map { it.trim().lowercase() }
                .filter { it.isNotEmpty() && !it.startsWith('#') && !it.contains(' ') && !it.contains('\t') }
                .toHashSet()
        } catch (_: Exception) {
            emptySet()
        }
    }
}