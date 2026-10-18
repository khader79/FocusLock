package com.focuslock.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import java.util.concurrent.ConcurrentHashMap

/**
 * Watches what the user types and sends them home when a search or address bar
 * receives a blocked term.
 *
 * Two rules keep it from being obnoxious:
 *   1. Only genuinely editable fields count, so reading an article or
 *      answering a quiz never triggers anything.
 *   2. A field can only fire if it received input within the last few seconds,
 *      so pre-filled page content can never cause a kick.
 *
 * It deliberately does not touch the Settings app, the uninstall screen, or
 * anything else belonging to the OS. The device stays fully usable; the guard
 * only reacts to typed queries.
 */
class ContentBlockerService : AccessibilityService() {

    private val recentTyping = ConcurrentHashMap<String, Long>()

    private var blocks: List<Block> = emptyList()
    private var blockedApps: Set<String> = defaultBlockedApps()
    private var skipApps: Set<String> = setOf()
    private var scanning = false
    private var lastScanMs = 0L
    private var lastBlockLoadMs = 0L
    private var lastAppKickMs = 0L
    private var watcher: android.os.Handler? = null
    private var lastDnsKickMs = 0L

    /**
     * Apps that must never come to the foreground. Only X is blocked by
     * default — Instagram and TikTok were removed at the user's request, since
     * blocking them was not wanted.
     */
    private fun defaultBlockedApps() = setOf(
        "com.twitter.android",
        "com.x.android"
    )

    override fun onServiceConnected() {
        super.onServiceConnected()
        watcher = android.os.Handler(android.os.Looper.getMainLooper())
        serviceInfo = AccessibilityServiceInfo().apply {
            // TYPE_WINDOWS_CHANGED is what fires the instant a blocked app is
            // launched, before any of its content exists to inspect. Without it
            // the app-blocking branch never runs and the app opens freely.
            eventTypes = AccessibilityEvent.TYPE_WINDOWS_CHANGED or
                    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                    AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED or
                    AccessibilityEvent.TYPE_VIEW_FOCUSED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            notificationTimeout = 50
            flags = AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        reloadLists()
        startForegroundWatch()
    }

    override fun onDestroy() {
        watcher?.removeCallbacksAndMessages(null)
        watcher = null
        super.onDestroy()
    }

    private fun reloadLists() {
        val prefs = getSharedPreferences("focuslock_prefs", MODE_PRIVATE)
        // Always intersect with the allowlist so previously-saved Instagram or
        // TikTok entries can never keep blocking after the user removed them.
        val saved = prefs.getStringSet("blocked_apps", null)
        blockedApps = if (saved == null) defaultBlockedApps() else saved.intersect(defaultBlockedApps())
        skipApps = prefs.getStringSet("skip_apps", emptySet())?.toSet() ?: emptySet()
        prefs.edit().putStringSet("blocked_apps", blockedApps).apply()
        reloadBlocks()
    }

    /** User blocks change rarely; refresh at most once every few seconds. */
    private fun reloadBlocks(force: Boolean = false) {
        val now = SystemClock.uptimeMillis()
        if (!force && blocks.isNotEmpty() && now - lastBlockLoadMs < BLOCK_RELOAD_MS) return
        lastBlockLoadMs = now
        blocks = BlockStore.load(this)
    }

    /**
     * Keeps the Private DNS provider locked to the family resolver.
     *
     * The check is deliberately narrow: it looks for the actual DNS settings
     * controls (the hostname field and the mode radio group) rather than
     * scanning screen text for the word "DNS". An earlier version matched any
     * Settings screen mentioning USB or a hostname, which made the whole
     * settings app unusable — that failure is what this shape prevents.
     *
     * Other Settings pages, including the rest of Network, are left alone.
     */
    private fun guardPrivateDns(event: AccessibilityEvent): Boolean {
        val pkg = event.packageName?.toString()?.lowercase() ?: return false
        val isSettings = pkg == "com.android.settings" || pkg == "com.samsung.android.settings"
        if (!isSettings) return false
        if (!dnsProtectionOn()) return false

        val source = event.source ?: return false
        try {
            if (!touchesDnsControls(source) && !isDnsEntryRow(source)) return false
            val now = SystemClock.uptimeMillis()
            performGlobalAction(GLOBAL_ACTION_HOME)
            if (now - lastDnsKickMs > 2500) {
                lastDnsKickMs = now
                BlockedLog.add(this, "DNS", "private_dns_settings", pkg)
                Toast.makeText(this, R.string.dns_protected, Toast.LENGTH_SHORT).show()
            }
            return true
        } finally {
            runCatching { source.recycle() }
        }
    }

    /**
     * True only when the interacted node belongs to the Private DNS screen —
     * identified by its own resource ids, so a same-named string somewhere else
     * cannot trigger it.
     */
    private fun touchesDnsControls(node: AccessibilityNodeInfo): Boolean {
        if (node.isEditable || node.isClickable || node.isCheckable || node.isFocusable) {
            val id = node.viewIdResourceName?.lowercase()
            if (id != null && DNS_CONTROL_IDS.any { id.contains(it) }) return true
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val hit = touchesDnsControls(child)
            child.recycle()
            if (hit) return true
        }
        return false
    }

    /**
     * The Private DNS row itself lives on the parent Network screen. Tapping it
     * is the one interaction that must not be allowed to reach the page, so the
     * row is caught here as well as the controls inside the page.
     */
    private fun isDnsEntryRow(node: AccessibilityNodeInfo): Boolean {
        if (!node.isClickable) return false
        var hit = false
        if (node.viewIdResourceName?.lowercase()?.contains("private_dns") == true) {
            hit = true
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (isDnsEntryRow(child)) hit = true
            child.recycle()
        }
        return hit
    }

    private fun dnsProtectionOn(): Boolean =
        getSharedPreferences("focuslock_prefs", MODE_PRIVATE)
            .getBoolean("dns_protection", true)

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val e = event ?: return
        val pkg = e.packageName?.toString()?.lowercase() ?: return
        if (pkg == packageName.lowercase()) return

        if (guardPrivateDns(e)) return

        if (pkg in blockedApps) {
            val now = SystemClock.uptimeMillis()
            performGlobalAction(GLOBAL_ACTION_HOME)
            if (now - lastAppKickMs > 2000) {
                lastAppKickMs = now
                BlockedLog.add(this, "APP", pkg, pkg)
                Toast.makeText(this, getString(R.string.app_blocked_toast, pkg), Toast.LENGTH_SHORT).show()
            }
            return
        }
        if (pkg in skipApps) return

        when (e.eventType) {
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> handleTyped(e, pkg)
            AccessibilityEvent.TYPE_VIEW_FOCUSED -> {
                reloadLists()
                throttledScan(pkg)
            }
        }
    }

    /** Fast path: the typed characters live on the event, so no tree walk. */
    private fun handleTyped(event: AccessibilityEvent, pkg: String) {
        val source = event.source ?: return
        try {
            if (!isEditable(source)) return
            markTyped(pkg, source)

            val typed = event.text?.joinToString(" ").orEmpty()
            if (typed.isBlank()) return

            val term = match(typed) ?: return
            BlockedLog.recordSearch(this, term, pkg)
            performGlobalAction(GLOBAL_ACTION_HOME)
        } finally {
            runCatching { source.recycle() }
        }
    }

    /** Slow path: a focused field may hold content the event did not carry. */
    private fun throttledScan(pkg: String) {
        val now = SystemClock.uptimeMillis()
        if (now - lastScanMs < SCAN_COOLDOWN_MS) return
        lastScanMs = now
        if (scanning) return

        scanning = true
        try {
            val root = rootInActiveWindow ?: return
            try {
                walk(root, pkg)
            } finally {
                root.recycle()
            }
        } finally {
            scanning = false
        }
    }

    private fun walk(node: AccessibilityNodeInfo, pkg: String) {
        if (isEditable(node) && wasTypedRecently(pkg, node)) {
            val content = listOfNotNull(
                node.text?.toString(),
                node.contentDescription?.toString(),
                node.hintText?.toString()
            ).joinToString(" ").lowercase()
            val term = match(content)
            if (term != null) {
                BlockedLog.recordSearch(this, term, pkg)
                performGlobalAction(GLOBAL_ACTION_HOME)
                return
            }
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            walk(child, pkg)
            runCatching { child.recycle() }
        }
    }

    /** Checks user blocks first, then the curated built-in lists as a fallback. */
    private fun match(text: String): String? {
        reloadBlocks()
        for (block in blocks) {
            block.matches(text)?.let { return it }
        }
        return Blocklist.matchText(text)
    }

    private fun isEditable(node: AccessibilityNodeInfo): Boolean {
        if (node.isEditable) return true
        val cls = node.className?.toString()?.lowercase() ?: return false
        return cls.contains("edittext") ||
                cls.contains("autocompletetextview") ||
                cls.contains("searchview") ||
                cls.contains("textinput")
    }

    private fun key(pkg: String, node: AccessibilityNodeInfo): String {
        val id = node.viewIdResourceName?.toString()
        val cls = node.className?.toString()
        return "$pkg|${id ?: cls ?: "?"}"
    }

    private fun markTyped(pkg: String, node: AccessibilityNodeInfo) {
        recentTyping[key(pkg, node)] = SystemClock.uptimeMillis()
        if (recentTyping.size > 300) {
            val cutoff = SystemClock.uptimeMillis() - TYPING_WINDOW_MS
            recentTyping.entries.removeIf { it.value < cutoff }
        }
    }

    private fun wasTypedRecently(pkg: String, node: AccessibilityNodeInfo): Boolean {
        val at = recentTyping[key(pkg, node)] ?: return false
        return SystemClock.uptimeMillis() - at <= TYPING_WINDOW_MS
    }

    /**
     * Backstop for apps that launch quietly and emit almost no events: some
     * builds of X, for instance, open straight into a restored session. Polling
     * the focused window costs almost nothing and closes that hole, so a
     * blocked app cannot slip in just by being well-behaved with accessibility.
     */
    private fun startForegroundWatch() {
        watcher = android.os.Handler(android.os.Looper.getMainLooper())
        val task = object : Runnable {
            override fun run() {
                checkForegroundApp()
                watcher?.postDelayed(this, WATCH_INTERVAL_MS)
            }
        }
        watcher?.postDelayed(task, WATCH_INTERVAL_MS)
    }

    private fun checkForegroundApp() {
        if (scanning) return
        val root = runCatching { rootInActiveWindow }.getOrNull() ?: return
        val pkg = runCatching { root.packageName?.toString()?.lowercase() }.getOrNull()
        runCatching { root.recycle() }
        if (pkg.isNullOrBlank() || pkg == packageName.lowercase()) return
        if (pkg !in blockedApps) return

        val now = SystemClock.uptimeMillis()
        performGlobalAction(GLOBAL_ACTION_HOME)
        if (now - lastAppKickMs > 2000) {
            lastAppKickMs = now
            BlockedLog.add(this, "APP", pkg, "watch")
            Toast.makeText(this, getString(R.string.app_blocked_toast, pkg), Toast.LENGTH_SHORT).show()
        }
    }

    override fun onInterrupt() {
        scanning = false
    }

    companion object {
        private const val TYPING_WINDOW_MS = 6_000L
        private const val SCAN_COOLDOWN_MS = 500L
        private const val BLOCK_RELOAD_MS = 4_000L
        private const val WATCH_INTERVAL_MS = 700L

        /**
         * Resource-id fragments that exist only on the Private DNS screen.
         *
         * Ids were dumped from the running device rather than guessed, because
         * OEM builds rename them — Samsung uses private_dns_mode_* where AOSP
         * uses dns_mode. Matching on ids rather than visible words is what
         * keeps every other Settings page usable.
         */
        private val DNS_CONTROL_IDS = listOf(
            "private_dns_mode",
            "dnshostname",
            "private_dns_hostname",
            "dns_mode",
            "private_dns",
            "private_dns_base_summary",
            "opportunistic",
            "dns_autofill"
        )
    }
}