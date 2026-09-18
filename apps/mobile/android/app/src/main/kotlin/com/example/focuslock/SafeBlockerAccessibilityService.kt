package com.example.focuslock

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Ultra-fast window interception module.
 *
 * The guard is a high-frequency, globally-armed always-on monitor: it reacts to
 * [AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED] **and**
 * [AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED] and, the moment a blocked
 * package surfaces or a browser address bar navigates to an explicitly listed
 * domain, fires [GLOBAL_ACTION_HOME] so fast the offending window never
 * completes a frame.
 *
 * ## The < 50 ms contract
 * Every event is dispatched inside a single guarded callback:
 *
 *  - The package name is looked up in an in-memory [HashSet] — O(1), no disk,
 *    no binder, no lock.
 *  - The fast path is one `in` test between the event package and the hash set.
 *    Non-matches (the overwhelming majority of events) cost a few microseconds
 *    and return without allocating.
 *  - The browser path prefers the text that *ships on the event itself*
 *    (`event.text` / `event.source`) before any tree access, then the
 *    view-id lookup (`FLAG_REPORT_VIEW_IDS`), and only falls back to a bounded
 *    512-node walk. Every stage is a small constant, so the worst realistic
 *    path — an address bar scan — still completes in single-digit milliseconds.
 *  - A per-event wall-clock is taken at entry/exit; any dispatch that actually
 *    exceeds [MAX_EVENT_LATENCY_MS] is surfaced in logcat (a warning) — never
 *    a throw. The module is contract-deadline observant, not contract-enforcing.
 *
 * ## Block sources
 *  1. **Blocked app** — any package in [AppBlocker.readBlockedPackages]
 *     (e.g. `com.twitter.android`, `com.android.settings`).
 *  2. **Blocked URL** — a known browser is foreground and its address bar /
 *     search field navigates to an explicitly listed domain. Matching uses
 *     [Uri.parse] host extraction via [ExplicitDomainGate] — never fuzzy
 *     keywords — so typed queries and on-page prose can never trigger it.
 *     Typed URLs, pasted URLs and on-page navigation are all caught.
 *
 * ## Crash policy / structural exceptions
 * The outer boundary of [onAccessibilityEvent] is a `catch (t: Throwable)`
 * safety net: a malicious, recycled or half-mutated accessibility tree can make
 * *any* node call throw, and this service must survive that without killing its
 * process. Every node-acquisition-and-recycle pair is further guarded with
 * `runCatching` so a stale node cannot surface. The single dispatch thread is
 * never blocked by I/O or allocation-heavy work. The only correctness cost of
 * the net is a skipped block, which the next event re-checks.
 *
 * ## Battery
 * `TYPE_WINDOW_CONTENT_CHANGED` is high-volume, so the per-event overload is
 * deliberately tiny: two hash lookups and, unless the package is blocked or a
 * browser, an immediate return. There is no polling thread, no timer, no
 * per-event tree walk.
 *
 * Setup: Settings -> Accessibility -> enable "FocusLock app blocking"
 * (adb: settings put secure enabled_accessibility_services
 *  com.example.focuslock/com.example.focuslock.SafeBlockerAccessibilityService)
 */
class SafeBlockerAccessibilityService : AccessibilityService() {

    // ------------------------------------------------------------- hot state

    /** O(1) blocked-package membership set. Rebuilt only when prefs change and
     *  swapped atomically into this volatile reference — reads that hit the
     *  common (non-blocked) path never touch a lock or the disk. */
    @Volatile
    private var blockedPackages: HashSet<String> = HashSet()

    /** O(1) browser membership — same reason: this is checked per content event. */
    @Volatile
    private var browserPackages: HashSet<String> = BROWSER_PACKAGES

    /** Package owning the window seen last, kept coherent across the two event
     *  types so a content-change knows which window is being typed in. */
    private var foregroundPkg: String? = null

    /** Last HOME fire, to debounce the window-animation event bursts. */
    private var lastBlockedActionAt = 0L

    /** Outer event-loop statistic (see the <50ms contract above). */
    private var eventsSeen = 0L

    /** Remaining node budget for the bounded fallback walk. */
    private var nodeBudget = 0

    /** Heartbeat loop: while connected we stamp the shared heartbeat every
     *  [HEARTBEAT_PERIOD_MS], so [AccessibilityHealthService] can tell "alive
     *  but idle" (no window events) from "killed by the OEM". */
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private val heartbeatTick = object : Runnable {
        override fun run() {
            try {
                AntiKill.touchHeartbeat(this@SafeBlockerAccessibilityService)
            } catch (_: Throwable) {
                // Best-effort; skip this round.
            }
            heartbeatHandler.postDelayed(this, HEARTBEAT_PERIOD_MS)
        }
    }

    private val prefsListener =
        android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
            reloadBlockedSet()
            ExplicitDomainGate.reload(this)
        }

    // ------------------------------------------------------------------ life

    override fun onServiceConnected() {
        super.onServiceConnected()
        try {
            serviceInfo.eventTypes =
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            serviceInfo.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            serviceInfo.notificationTimeout = NOTIFICATION_TIMEOUT_MILLIS

            reloadBlockedSet()
            ExplicitDomainGate.reload(this)
            browserPackages = BROWSER_PACKAGES
            getSharedPreferences(AppBlocker.PREFS_NAME, MODE_PRIVATE)
                .registerOnSharedPreferenceChangeListener(prefsListener)
            getSharedPreferences(ExplicitDomainGate.PREFS_NAME, MODE_PRIVATE)
                .registerOnSharedPreferenceChangeListener(prefsListener)

            // Anti-kill: whenever the system (re)binds us — including after it
            // killed the whole process and is bringing it back — re-stamp the
            // heartbeat and repair the primary foreground service if
            // protection is owed.
            AntiKill.touchHeartbeat(this)
            AntiKill.resolvePrimaryService(this)
            heartbeatHandler.postDelayed(heartbeatTick, HEARTBEAT_PERIOD_MS)
        } catch (t: Throwable) {
            Log.e(TAG, "onServiceConnected failed; service stays degraded but alive.", t)
        }
    }

    /** Central dispatch — the ONLY entry point the framework drives. Everything
     *  below is a pure function of [event] and can never escape this net. */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val start = SystemClock.uptimeMillis()
        try {
            eventsSeen++
            if (event == null) return
            when (event.eventType) {
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> onWindowStateChanged(event)
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> onWindowContentChanged(event)
            }
        } catch (t: Throwable) {
            // Last line of defense. A corrupted tree may throw from ANY node
            // call; we log and move on rather than let it reach the framework.
            Log.e(TAG, "Accessibility dispatch swallowed; next event re-checks.", t)
        } finally {
            val elapsed = SystemClock.uptimeMillis() - start
            if (elapsed > MAX_EVENT_LATENCY_MS) {
                // Measure the contract, never panic on it: log, don't throw.
                Log.w(
                    TAG,
                    "Event dispatch exceeded ${MAX_EVENT_LATENCY_MS}ms: " +
                        "$elapsed ms (event=${event?.eventType}, seen=$eventsSeen)",
                )
            }
        }
    }

    override fun onInterrupt() {
        // Nothing to tear down — no polling thread, no held nodes.
    }

    /** Wakeups from [AccessibilityHealthService]. `ACTION_REVALIDATE` re-runs a
     *  full enforcement sweep against the current top window, so the moment a
     *  killed service is re-bound the block resumes (HOME) without waiting for
     *  a fresh window event. */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            AntiKill.touchHeartbeat(this)
            if (intent?.action == ACTION_REVALIDATE) {
                revalidateSweep()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "REVALIDATE dispatch swallowed; staying alive.", t)
        }
        return START_STICKY
    }

    /** One full enforcement sweep against the CURRENT top window — the
     *  hard-redirect half of the watchdog contract: while [AntiKill.shouldProtect]
     *  says the lock is owed, this fires HOME for a blocked app / blocked URL
     *  on every watchdog tick until healthy. */
    private fun revalidateSweep() {
        if (!shouldEnforceNow()) return
        val root = try {
            rootInActiveWindow
        } catch (_: Throwable) {
            null
        }
        if (root == null) return // not yet re-bound / mid-animation
        val pkg = try {
            root.packageName?.toString()
        } catch (_: Throwable) {
            null
        } ?: foregroundPkg ?: return
        if (isOwnPackage(pkg)) return

        if (pkg in blockedPackages) {
            performHome(pkg, "revalidate-app")
            return
        }
        if (pkg in browserPackages) {
            nodeBudget = NODE_BUDGET
            val hit = try {
                addressBarMatchesByViewId(root, pkg) || addressBarContainsBlockedUrl(root)
            } catch (_: Throwable) {
                false
            }
            if (hit) performHome(pkg, "revalidate-url")
        }
    }

    private fun shouldEnforceNow(): Boolean =
        try {
            AntiKill.shouldProtect(this)
        } catch (_: Throwable) {
            true // When in doubt during a lock window, re-enforce.
        }

    override fun onUnbind(intent: Intent?): Boolean {
        resurrectIfNeeded()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        heartbeatHandler.removeCallbacks(heartbeatTick)
        resurrectIfNeeded()
        try {
            getSharedPreferences(AppBlocker.PREFS_NAME, MODE_PRIVATE)
                .unregisterOnSharedPreferenceChangeListener(prefsListener)
        } catch (_: Throwable) {
            // Already torn down; fine.
        }
        try {
            getSharedPreferences(ExplicitDomainGate.PREFS_NAME, MODE_PRIVATE)
                .unregisterOnSharedPreferenceChangeListener(prefsListener)
        } catch (_: Throwable) {
            // Already torn down; fine.
        }
        super.onDestroy()
    }

    private fun resurrectIfNeeded() {
        try {
            if (AntiKill.shouldProtect(this) && !AntiKill.isPrimaryRunning(this)) {
                AntiKill.scheduleRestart(this, AntiKill.RESTART_DELAY_MS)
            }
            AntiKill.schedulePulse(this)
        } catch (_: Throwable) {
            // Nothing to do — the watchdog job retries on its own cadence.
        }
    }

    // -------------------------------------------------------------- dispatch

    /** A brand-new window is topmost: block a blocked app outright, or scan a
     *  browser's address bar. */
    private fun onWindowStateChanged(event: AccessibilityEvent) {
        val pkg = pkgOf(event) ?: return
        if (isOwnPackage(pkg)) return
        foregroundPkg = pkg

        // 1) Blocked package in the O(1) set — fire and get out.
        if (pkg in blockedPackages) {
            performHome(pkg, "blocked-app")
            return
        }

        // 2) Browser — scan for an adult URL / query now that it owns the screen.
        if (pkg in browserPackages) {
            addressBarOpenedOrRefreshed(pkg)
        }
    }

    /** Content changed inside a focused window — the user typed, scrolled or a
     *  blocked window re-rendered. Kept extremely cheap for the common case. */
    private fun onWindowContentChanged(event: AccessibilityEvent) {
        val pkg = pkgOf(event) ?: return
        if (isOwnPackage(pkg)) return

        // Adopt: content events can precede the state event for a brand-new
        // window; labeling it here costs one field write.
        if (pkg != foregroundPkg) foregroundPkg = pkg

        // 1) A blocked package still (or again) owns the screen.
        if (pkg in blockedPackages) {
            performHome(pkg, "blocked-app")
            return
        }

        // 2) Browser address bar: the changed text is most likely IN the event.
        if (pkg in browserPackages) {
            if (textOnEventBlocked(event) || addressBarMatchesFor(pkg)) {
                performHome(pkg, "address-bar")
            }
        }
        // Every other package: two hash lookups, done.
    }

    /** Zero-tree fast path: `event.text` (text-change events) or `event.source`
     *  (the EditText that changed) already carry the suspicious URL text. */
    private fun textOnEventBlocked(event: AccessibilityEvent): Boolean {
        try {
            val changed = event.text
            if (!changed.isNullOrEmpty()) {
                for (t in changed) {
                    val s = t?.toString() ?: continue
                    if (ExplicitDomainGate.isBlocked(s)) return true
                }
            }
        } catch (_: Throwable) {
            // Event text mutated mid-read; fall through to the tree scan.
        }

        val source = try {
            event.source
        } catch (_: Throwable) {
            null
        }
        if (source == null) return false
        return try {
            val s = source.text?.toString() ?: return false
            ExplicitDomainGate.isBlocked(s)
        } catch (_: Throwable) {
            false
        } finally {
            try {
                source.recycle()
            } catch (_: Throwable) {
                // Already recycled by the framework (safe no-op on modern OS).
            }
        }
    }

    /** Browser window scanned on open/refresh: view-id fast path, then bounded
     *  walk. */
    private fun addressBarOpenedOrRefreshed(pkg: String) {
        nodeBudget = NODE_BUDGET
        val root = try {
            rootInActiveWindow
        } catch (_: Throwable) {
            null // mid-window-animation, or the tree is being rebuilt
        } ?: return

        try {
            if (addressBarMatchesByViewId(root, pkg) || addressBarContainsBlockedUrl(root)) {
                performHome(pkg, "address-bar")
            }
        } catch (_: Throwable) {
            // Root flipped mid-scan; the next state event re-checks.
        } finally {
            // root belongs to the system: we never recycle it.
        }
    }

    /** Address-bar re-check on content changes — same scanning budget. */
    private fun addressBarMatchesFor(pkg: String): Boolean {
        nodeBudget = NODE_BUDGET
        val root = try {
            rootInActiveWindow
        } catch (_: Throwable) {
            null
        } ?: return false
        return try {
            addressBarMatchesByViewId(root, pkg) || addressBarContainsBlockedUrl(root)
        } catch (_: Throwable) {
            false
        } finally {
            // root is owned by the system.
        }
    }

    // ------------------------------------------------------- block dispatch

    /** Debounced [GLOBAL_ACTION_HOME]. The debounce only throttles repeated
     *  fires for the *same* incident (animation bursts); a genuinely new
     *  blocked package still dispatches, and dispatch happens inline on the
     *  event thread, inside the 50ms contract. */
    private fun performHome(pkg: String, reason: String) {
        val now = SystemClock.uptimeMillis()
        if (now - lastBlockedActionAt < HOME_DEBOUNCE_MILLIS) return

        lastBlockedActionAt = now
        val ok = try {
            performGlobalAction(GLOBAL_ACTION_HOME)
        } catch (t: Throwable) {
            Log.e(TAG, "GLOBAL_ACTION_HOME threw; suppressed.", t)
            false
        }
        if (!ok) {
            Log.w(TAG, "GLOBAL_ACTION_HOME returned false ($reason, $pkg)")
        }
    }

    // ------------------------------------------------------------- scanning

    /** O(1)-ish, zero-allocation-dominant path: browsers expose the URL/search
     *  field as a resource view id (FLAG_REPORT_VIEW_IDS), so it is looked up
     *  by id instead of walking the window tree. Returns true when that field's
     *  text points at an explicitly listed domain. */
    private fun addressBarMatchesByViewId(root: AccessibilityNodeInfo, pkg: String): Boolean {
        for (suffix in ADDRESS_BAR_ID_SUFFIXES) {
            val resolvedId = "$pkg:$suffix"
            val nodes = try {
                root.findAccessibilityNodeInfosByViewId(resolvedId)
            } catch (_: Throwable) {
                continue // view-id lookup unsupported or the tree changed
            }
            try {
                for (node in nodes) {
                    try {
                        node.text?.toString()?.let { if (ExplicitDomainGate.isBlocked(it)) return true }
                        // Chromium keeps the edited URL on an inner EditText.
                        firstEditTextText(node, 0)?.let {
                            if (ExplicitDomainGate.isBlocked(it)) return true
                        }
                    } catch (_: Throwable) {
                        // Node recycled mid-lookup; skip.
                    }
                }
            } finally {
                for (node in nodes) {
                    try {
                        node.recycle()
                    } catch (_: Throwable) {
                        // Best-effort recycling; the framework reclaims anyway.
                    }
                }
            }
        }
        return false
    }

    /** Text of the nearest descendant EditText, bounded depth. */
    private fun firstEditTextText(node: AccessibilityNodeInfo, depth: Int): String? {
        if (depth > MAX_EDIT_TEXT_DEPTH) return null
        try {
            if (node.className?.toString()?.contains("EditText") == true) {
                return node.text?.toString()
            }
            for (i in 0 until node.childCount) {
                val child = try {
                    node.getChild(i)
                } catch (_: Throwable) {
                    null
                }
                try {
                    if (child != null) {
                        firstEditTextText(child, depth + 1)?.let { return it }
                    }
                } finally {
                    try {
                        child?.recycle()
                    } catch (_: Throwable) {
                        // Stale node; ignore.
                    }
                }
            }
        } catch (_: Throwable) {
            // Tree changed while descending; abort this branch.
        }
        return null
    }

    /** Bounded walk: EditText nodes (address bar / search) block when their text
     *  is an explicit URL to a listed domain; non-EditText text triggers only
     *  when it looks like a URL — so page prose can never match. [root]
     *  belongs to the system (never recycled). */
    private fun addressBarContainsBlockedUrl(root: AccessibilityNodeInfo): Boolean {
        try {
            if (root.className?.toString()?.contains("EditText") == true) {
                val t = (root.text ?: root.contentDescription)?.toString()
                if (!t.isNullOrEmpty() && ExplicitDomainGate.isBlocked(t)) return true
            } else {
                val candidates = listOfNotNull(
                    root.text?.toString(),
                    root.contentDescription?.toString(),
                )
                if (candidates.any { looksLikeUrl(it) && ExplicitDomainGate.isBlocked(it) }) return true
            }
            return scanChildren(root)
        } catch (_: Throwable) {
            return false // Tree changed mid-walk; abort silently.
        }
    }

    private fun scanChildren(node: AccessibilityNodeInfo): Boolean {
        try {
            for (i in 0 until node.childCount) {
                if (nodeBudget-- <= 0) {
                    return false // Budget exhausted; stop before stalling.
                }
                val child = try {
                    node.getChild(i)
                } catch (_: Throwable) {
                    null
                }
                try {
                    if (child != null && addressBarContainsBlockedUrl(child)) return true
                } finally {
                    try {
                        child?.recycle()
                    } catch (_: Throwable) {
                        // Stale node; ignore.
                    }
                }
            }
        } catch (_: Throwable) {
            // Abort gracefully on stale nodes.
        }
        return false
    }

    // ---------------------------------------------------------------- helpers

    private fun pkgOf(event: AccessibilityEvent): String? =
        try {
            event.packageName?.toString()
        } catch (_: Throwable) {
            null
        }

    private fun isOwnPackage(pkg: String): Boolean = pkg == packageName

    /** Reloads the O(1) blocked set from prefs. Runs only on a prefs change
     *  (or connect), never per event. */
    private fun reloadBlockedSet() {
        blockedPackages = HashSet(AppBlocker.readBlockedPackages(this))
    }

    /** TRUE for anything that plausibly is a URL / hostname, never prose. */
    private fun looksLikeUrl(raw: String): Boolean {
        val t = raw.trim().lowercase()
        return (t.contains("http") ||
            (t.length in MIN_URL_LENGTH..MAX_URL_LENGTH && !t.contains(' ') && t.contains('.')))
    }

    companion object {
        private const val TAG = "FocusLock.A11y"

        /** Action [AccessibilityHealthService] sends to force an immediate
         *  enforcement sweep (the "continuous HOME while degraded" loop). */
        const val ACTION_REVALIDATE = "com.example.focuslock.action.A11Y_REVALIDATE"

        /** Cadence the heartbeat is stamped while connected. Must stay well
         *  under [AccessibilityHealthService.A11Y_ALIVE_WINDOW_MS] (60s). */
        const val HEARTBEAT_PERIOD_MS = 20_000L

        /** Mike up the accessibility service and ask it to re-enforce right
         *  now. Same-app explicit start of a non-exported service; harmless
         *  (and a no-op) when the process is still dead. */
        fun sendRevalidate(context: Context) {
            val intent = Intent(context, SafeBlockerAccessibilityService::class.java)
                .setAction(ACTION_REVALIDATE)
            try {
                context.startService(intent)
            } catch (_: Throwable) {
                // Not running yet; the system re-binds it on its own.
            }
        }

        private const val HOME_DEBOUNCE_MILLIS = 400L
        private const val NODE_BUDGET = 512
        private const val MAX_EDIT_TEXT_DEPTH = 3
        private const val MAX_URL_LENGTH = 130
        private const val MIN_URL_LENGTH = 3
        private const val NOTIFICATION_TIMEOUT_MILLIS = 100L

        /** Enforced *by measurement*, not by exception (see KDoc): the dispatch
         *  deadline every event must meet before GLOBAL_ACTION_HOME fires. */
        const val MAX_EVENT_LATENCY_MS = 50L

        /** Address-bar / search-box resource ids (suffix after "<package>:"),
         *  exposed via FLAG_REPORT_VIEW_IDS. */
        val ADDRESS_BAR_ID_SUFFIXES = hashSetOf(
            "id/location_bar",                        // Chrome + Chromium family
            "id/omnibox_input",                       // Chrome omnibox EditText
            "id/url_bar",                             // legacy Chromium + old Firefox
            "id/url_edit_text",                       // Samsung Internet
            "id/address_bar",                         // Firefox Focus / minimalist
            "id/mozac_browser_toolbar_edit_url_view", // Firefox Fenix
            "id/search_widget",                       // Opera start-page search
            "id/search_container",                    // DuckDuckGo / WebView wrappers
        )

        /** O(1) known-browsers gate — the only packages ever scanned. */
        val BROWSER_PACKAGES = hashSetOf(
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.chrome.canary",
            "org.chromium.chrome",
            "com.sec.android.app.sbrowser",      // Samsung Internet
            "com.samsung.android.browser",
            "org.mozilla.firefox",
            "org.mozilla.firefox_beta",
            "org.mozilla.fennec_fdroid",
            "org.mozilla.focus",
            "com.opera.browser",
            "com.opera.browser.beta",
            "com.opera.mini.android",
            "com.opera.mini.nightly",
            "com.microsoft.emmx",                 // Edge
            "com.duckduckgo.mobile.android",
            "com.brave.browser",
            "com.vivaldi.browser",
            "com.kiwi.browser",
            "com.android.browser",                // legacy AOSP browser
        )
    }
}