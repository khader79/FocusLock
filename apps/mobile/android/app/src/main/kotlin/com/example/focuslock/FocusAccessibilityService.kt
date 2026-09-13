package com.example.focuslock

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent

/**
 * Accessibility fallback for app blocking: whenever the foreground window
 * belongs to a blocked package, pressing HOME is simulated so the app cannot
 * be used (works without Device Owner or VPN privileges).
 *
 * Setup: Settings -> Accessibility -> "FocusLock app blocking" -> enable.
 * (Or via adb: settings put secure enabled_accessibility_services
 *  com.example.focuslock/com.example.focuslock.FocusAccessibilityService)
 */
class FocusAccessibilityService : AccessibilityService() {

    private var lastBlockedActionAt = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            return
        }
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName || pkg !in AppBlocker.readBlockedPackages(this)) {
            return
        }

        // Debounce: a blocked app can fire a rapid burst of window-state
        // events while HOME is animating in; only act once per window.
        val now = SystemClock.uptimeMillis()
        if (now - lastBlockedActionAt < AUTO_DISMISS_DEBOUNCE_MILLIS) {
            return
        }
        lastBlockedActionAt = now

        performGlobalAction(GLOBAL_ACTION_HOME)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        // The manifest XML already scopes the events; this just makes the
        // runtime configuration explicit and matches the config file.
        serviceInfo.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        serviceInfo.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        serviceInfo.notificationTimeout = 100
    }

    override fun onInterrupt() {
        // Nothing to tear down.
    }

    private companion object {
        const val AUTO_DISMISS_DEBOUNCE_MILLIS = 300L
    }
}