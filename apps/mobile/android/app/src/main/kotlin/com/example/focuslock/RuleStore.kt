package com.example.focuslock

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persists the user's custom sites and categories as JSON in SharedPreferences.
 *
 * The VPN blocklist merges [allDomains] into what it filters, so sites and
 * categories added in the UI are blocked through the exact same DNS matcher
 * (`Blocklist.isBlocked`) as the shipped asset blocklist.
 */
object RuleStore {

    private const val PREFS = "focuslock_rules"
    private const val KEY_CUSTOM_SITES = "custom_sites"
    private const val KEY_CATEGORIES = "categories"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ----------------------------------------------------------- custom sites

    fun customSites(context: Context): List<String> {
        val raw = prefs(context).getString(KEY_CUSTOM_SITES, null) ?: return emptyList()
        return try {
            JSONArray(raw).let { arr ->
                (0 until arr.length()).map { arr.getString(it) }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun setCustomSites(context: Context, sites: List<String>) {
        val arr = JSONArray()
        sites.forEach { arr.put(it.trim().lowercase()) }
        prefs(context).edit().putString(KEY_CUSTOM_SITES, arr.toString()).apply()
    }

    /** Adds a single site unless already present. */
    fun addCustomSite(context: Context, site: String): Boolean {
        val current = customSites(context).toMutableList()
        val normalized = site.trim().lowercase()
        if (normalized.isBlank() || normalized in current) return false
        current.add(normalized)
        setCustomSites(context, current)
        return true
    }

    fun removeCustomSite(context: Context, site: String) {
        setCustomSites(context, customSites(context).filter { it != site.lowercase() })
    }

    // ------------------------------------------------------------- categories

    fun categories(context: Context): List<JSONObject> {
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

    fun setCategories(context: Context, categories: List<JSONObject>) {
        val arr = JSONArray()
        categories.forEach { arr.put(it) }
        prefs(context).edit().putString(KEY_CATEGORIES, arr.toString()).apply()
    }

    /** True when [domain] matches an enabled category pattern. */
    fun matchesEnabledCategory(context: Context, domain: String): Boolean {
        return categories(context).any { category ->
            category.optBoolean("enabled", true) &&
                (category.optString("pattern", "").isNotBlank() && domain.endsWith(
                    category.optString("pattern").trim().removePrefix(".")
                ))
        }
    }

    // ------------------------------------------------------------- matching

    /** Every domain enforced by the DNS matcher (custom sites + categories). */
    fun allDomains(context: Context): Set<String> {
        val domains = HashSet<String>()
        domains.addAll(customSites(context))
        categories(context).forEach { category ->
            if (category.optBoolean("enabled", true)) {
                category.optString("pattern", "").trim().removePrefix(".").takeIf { it.isNotBlank() }
                    ?.let { domains.add(it) }
            }
        }
        return domains
    }
}