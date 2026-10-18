package com.focuslock.accessibility

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * One user-defined block: a set of keywords or domains switched on or off,
 * with an optional lock that demands a challenge before it can be disabled.
 *
 * Mirrors the mental model of desktop blockers — a named list you can toggle,
 * edit and lock independently — so the app feels like a tool rather than a
 * set of scattered switches.
 */
data class Block(
    val id: String,
    var name: String,
    var kind: Kind,
    var terms: List<String>,
    var enabled: Boolean,
    var locked: Boolean,
    var challengeLength: Int
) {
    enum class Kind { KEYWORDS, DOMAINS }

    val charCount: Int get() = terms.sumOf { it.length }

    fun matches(text: String): String? {
        if (!enabled) return null
        val lower = text.lowercase()
        for (term in terms) {
            val t = term.trim().lowercase()
            if (t.isEmpty()) continue
            if (kind == Kind.DOMAINS) {
                val host = lower.trim().removePrefix("www.")
                if (host == t || host.endsWith(".$t")) return term
            } else {
                if (lower.contains(Regex("\\b${Regex.escape(t)}\\b"))) return term
            }
        }
        return null
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("kind", kind.name)
        put("terms", JSONArray(terms))
        put("enabled", enabled)
        put("locked", locked)
        put("challengeLength", challengeLength)
    }

    companion object {
        fun fromJson(o: JSONObject): Block = Block(
            id = o.optString("id", System.currentTimeMillis().toString()),
            name = o.optString("name", "Untitled"),
            kind = runCatching { Kind.valueOf(o.optString("kind", "KEYWORDS")) }
                .getOrDefault(Kind.KEYWORDS),
            terms = o.optJSONArray("terms")?.let { arr ->
                (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotBlank() }
            } ?: emptyList(),
            enabled = o.optBoolean("enabled", true),
            locked = o.optBoolean("locked", false),
            challengeLength = o.optInt("challengeLength", 0)
        )
    }
}

/**
 * Persistence for the block list. One JSON array in SharedPreferences — small,
 * human-inspectable, and removed cleanly on uninstall.
 */
object BlockStore {

    private const val PREFS = "focuslock_prefs"
    private const val KEY_BLOCKS = "blocks_v2"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(context: Context): MutableList<Block> {
        val raw = prefs(context).getString(KEY_BLOCKS, null) ?: return defaultBlocks()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { Block.fromJson(arr.getJSONObject(it)) }.toMutableList()
        }.getOrElse { defaultBlocks() }
    }

    fun save(context: Context, blocks: List<Block>) {
        val arr = JSONArray()
        blocks.forEach { arr.put(it.toJson()) }
        prefs(context).edit().putString(KEY_BLOCKS, arr.toString()).apply()
    }

    fun add(context: Context, block: Block) {
        val list = load(context)
        list.add(block)
        save(context, list)
    }

    fun remove(context: Context, id: String) {
        save(context, load(context).filter { it.id != id })
    }

    fun update(context: Context, block: Block) {
        val list = load(context).map { if (it.id == block.id) block else it }
        save(context, list)
    }

    fun reset(context: Context) = prefs(context).edit().remove(KEY_BLOCKS).apply()

    /**
     * Seeded on first run only. These mirror the curated built-in lists so the
     * app is useful the moment it opens, while remaining fully editable.
     */
    private fun defaultBlocks(): MutableList<Block> = mutableListOf(
        Block(
            id = "default_adult",
            name = "Adult",
            kind = Block.Kind.DOMAINS,
            terms = Blocklist.HOSTS.filter { !it.contains("bet") && !it.contains("casino") },
            enabled = true,
            locked = false,
            challengeLength = 0
        ),
        Block(
            id = "default_gambling",
            name = "Gambling",
            kind = Block.Kind.DOMAINS,
            terms = Blocklist.HOSTS.filter { it.contains("bet") || it.contains("casino") },
            enabled = true,
            locked = false,
            challengeLength = 0
        ),
        Block(
            id = "default_keywords",
            name = "Explicit search words",
            kind = Block.Kind.KEYWORDS,
            terms = Blocklist.PHRASES.toList(),
            enabled = true,
            locked = false,
            challengeLength = 0
        )
    )
}