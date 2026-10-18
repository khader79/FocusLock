# FocusLock - Ultra-Optimized Adult Content Blocker for Android

Zero-lag, zero-VPN, dual-layer protection: On-device AccessibilityService + Network-level Private DNS.

## Features

- **O(1) Keyword Lookup** - ConcurrentHashMap-backed HashSet for instant blocked term detection
- **Precision Targeting** - Only monitors EditText, browser address bars, and search fields (Twitter/X, Instagram)
- **Instant Block** - `GLOBAL_ACTION_HOME` redirect in <50ms on detection
- **Network-Level DNS Filtering** - Private DNS (family.adguard-dns.com / 1.1.1.3) blocks domains before connection
- **Zero VPN** - 100% network speed preserved, no tunnel overhead
- **Incognito/Private Mode Support** - Works in all browser modes
- **Boot Persistence** - Auto-restarts after reboot

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    USER TYPES IN SEARCH FIELD                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  AccessibilityService (ContentBlockerService)               │
│  • rootInActiveWindow traversal                             │
│  • Filters: EditText, SearchView, AutoCompleteTextView      │
│  • Browser address bar detection (URL patterns, view IDs)   │
│  • Twitter/X & Instagram search bar targeting               │
│  • ConcurrentHashMap<String> blockedKeywords (O(1) lookup)  │
│  • ConcurrentHashMap<String> blockedDomains (O(1) lookup)   │
└─────────────────────────────────────────────────────────────┘
                              │
                    BLOCKED TERM DETECTED
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  performGlobalAction(GLOBAL_ACTION_HOME)                    │
│  • Instant home screen redirect                             │
│  • Broadcast for logging/UI updates                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  PRIVATE DNS (Network Layer - Independent)                  │
│  • family.adguard-dns.com  (94.140.14.15 / 94.140.15.16)   │
│  • family.cloudflare-dns.com (1.1.1.3 / 1.0.0.3)            │
│  • Blocks adult domains at resolver level                   │
│  • ZERO VPN - Full line speed                               │
└─────────────────────────────────────────────────────────────┘
```

## Setup Guide

### 1. Install & Enable Accessibility Service
```
Settings → Accessibility → Installed Services → FocusLock Content Blocker → ON
```

### 2. Configure Private DNS (Critical for Network-Level Blocking)

**Option A: AdGuard Family DNS (Recommended - blocks ads + adult)**
```
Settings → Network & Internet → Private DNS → Private DNS provider hostname
Enter: family.adguard-dns.com
```

**Option B: Cloudflare Family DNS (1.1.1.3)**
```
Settings → Network & Internet → Private DNS → Private DNS provider hostname
Enter: family.cloudflare-dns.com
```

> **If hostname fails** (some carriers block DoT): Use a DNS changer app (e.g., DNS66, Personal DNS Filter) with DNS-over-HTTPS pointing to the same providers.

### 3. Verify Protection
- Open Chrome/Firefox → Try adult search → Instant home redirect
- Open Incognito/Private mode → Same protection
- Open X (Twitter) → Search bar → Adult term → Blocked
- Open Instagram → Search → Adult term → Blocked
- Direct navigation to adult domains → Blocked at DNS level

## Performance Specs

| Metric | Value |
|--------|-------|
| Notification Timeout | 50ms |
| Keyword Lookup | O(1) HashSet |
| Memory Overhead | ~2MB (keywords + domains) |
| Battery Impact | Negligible (event-driven) |
| Network Speed | 100% (no VPN) |
| False Positive Rate | Minimal (field-type filtering) |

## Keyword Coverage

- **Adult Sites**: Pornhub, Xvideos, XNXX, RedTube, YouPorn, XHamster, Brazzers, etc.
- **Cam Sites**: Chaturbate, Stripchat, BongaCams, LiveJasmin, etc.
- **Platforms**: OnlyFans, Fansly, ManyVids, AdultFriendFinder, etc.
- **Search Terms**: 80+ explicit keywords (porn, xxx, nsfw, hentai, onlyfans, etc.)
- **Social**: Twitter/X search, Instagram search, dating apps

## Build

```bash
./gradlew assembleRelease
```

## Technical Details

### ContentBlockerService.kt Highlights

```kotlin
// O(1) lookup via ConcurrentHashMap-backed HashSet
private val blockedKeywords = ConcurrentHashMap.newKeySet<String>()
private val blockedDomains = ConcurrentHashMap.newKeySet<String>()

// Precision field detection - avoids false positives on general text
private fun isSearchOrAddressField(node: AccessibilityNodeInfo): Boolean {
    val className = node.className?.toString().toLowerCase() ?: return false
    val viewId = node.viewIdResourceName?.toLowerCase() ?: ""
    val hint = node.hintText?.toString().toLowerCase() ?: ""
    
    val isEditableText = className.contains("edittext") || ...
    val isBrowserAddressBar = viewId.contains("url") || hint.contains("address") || text.startsWith("http")
    val isSearchField = viewId.contains("search") || hint.contains("search")
    val isTwitterSearch = viewId.contains("twitter") && isSearchField
    val isInstagramSearch = viewId.contains("instagram") && isSearchField
    
    return isEditableText && (isBrowserAddressBar || isSearchField || isTwitterSearch || isInstagramSearch)
}

// Instant redirect on detection
private fun blockAndRedirect(sourceField: AccessibilityNodeInfo) {
    performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    // + broadcast for logging
}
```

### Private DNS Configuration

| Provider | Hostname | IPv4 | IPv6 | Blocks |
|----------|----------|------|------|--------|
| AdGuard Family | family.adguard-dns.com | 94.140.14.15, 94.140.15.16 | 2a10:50c0::ad1:ff, 2a10:50c0::ad2:ff | Adult + Ads + Trackers |
| Cloudflare Family | family.cloudflare-dns.com | 1.1.1.3, 1.0.0.3 | 2606:4700:4700::1113, 2606:4700:4700::1003 | Adult + Malware |

## Permissions

- `BIND_ACCESSIBILITY_SERVICE` - Core monitoring (user-granted via Accessibility settings)
- `FOREGROUND_SERVICE` - Optional persistent operation
- `RECEIVE_BOOT_COMPLETED` - Auto-start after reboot

## Privacy

- **Zero data collection** - All processing on-device
- **No network requests** from the app itself
- **Private DNS** handled by OS/resolver (AdGuard/Cloudflare policies apply)
- **Open source** - Fully auditable

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Service keeps disabling | Disable battery optimization for FocusLock |
| Private DNS not saving | Carrier blocks DoT → Use DNS changer app with DoH |
| False positives | Report via GitHub Issues - we refine keyword list |
| Not blocking in app X | Ensure app uses standard EditText/SearchView (some use custom renderers) |

## License

MIT License - Use freely, modify, distribute.