# FocusLock — Mobile

FocusLock companion app for Android: a Flutter (Dart) UI driving a Kotlin
native layer that reimplements the desktop core's challenge-gated focus
protection on-device.

## What's here

```
lib/                         Dart app + UI (RTL, Arabic, dark)
  main.dart                  app entry: provider wiring, RTL, launch-action handling
  theme.dart                 shared dark/violet tokens
  models.dart                FocusState / Category models
  state/app_state.dart       ChangeNotifier bridging native services + sync
  services/protection_bridge.dart  protection/launch/rules/apps MethodChannels
  services/crypt.dart        AES-256-GCM payload encryption (byte-compatible
                             with Kotlin SyncClient and the shared desktop key)
  services/sync_service.dart Supabase REST push/pull + realtime websocket
  screens/                   dashboard, websites, categories, apps, settings, shell
  challenge.dart / words.dart / challenge_screen.dart  typing challenge (Dart core port)

android/app/src/main/kotlin/com/example/focuslock/   Kotlin native layer
  Core.kt                  challenge engine (bit-for-bit port of packages/core)
  ProtectionStore.kt       session state (SharedPreferences)
  FocusLockService.kt      foreground service + persistent notification
  FocusVpnService.kt       DNS-filtering VPN with pause passthrough
  Blocklist.kt / RuleStore.kt  asset + custom sites/categories merge
  AppBlocker.kt / AdminReceiver.kt / BootReceiver.kt / FocusAccessibilityService.kt
  SyncClient.kt            Kotlin mirror of the encrypted Supabase sync
  MainActivity.kt          MethodChannel host (protection, launch, rules, apps, sync)
```

## Prerequisites

- Flutter SDK (3.27+) with a Gradle-configured Android toolchain.
- Android SDK; create `android/local.properties` with `flutter.sdk` and SDK
  paths (generated automatically by `flutter pub get` / `flutter run`).

```powershell
cd apps/mobile
flutter pub get
flutter analyze
flutter test          # widget tests for the challenge screen
flutter build apk --debug
```

## Running on a device

```powershell
flutter run            # debug on the first attached device
```

### Enabling the protections

1. **VPN consent** — the first time a session starts, allow the "FocusLock"
   VPN connection (it filters DNS locally; traffic does not leave the device).
2. **Persistent notification** — a foreground notification stays visible while
   the session is active. Tapping it reopens the app into the challenge lock.
3. **Device Owner** (optional, enables direct app suspension + uninstall
   blocking):

   ```bash
   adb shell dpm set-device-owner com.example.focuslock/.AdminReceiver
   ```

   The app is built with `android:testOnly="true"` for this provisioning flow;
   a production build should drop that flag.
4. **Accessibility fallback** (optional) — if neither DPM nor VPN is
   available, "FocusLock app blocking" under accessibility sends blocked apps
   home.

## Supabase sync (desktop companion)

Creates the shared table:

```sql
create table public.focuslock_sync (
  id         text primary key,
  payload    text not null,          -- base64(iv[12] || aes-256-gcm ct)
  updated_at timestamptz default now()
);
```

Then configure **Settings → المزامنة** in the app with the Supabase URL, anon
key, row id, and a shared passphrase. The same passphrase keyed by SHA-256 lets
the desktop app read the payload. Push now / realtime mirrors updates from any
FocusLock endpoint publishing to that row.

## Architecture notes

- **Challenge gating** — Pausing while a session is active (app button or
  notification Pause action) always opens the typing challenge. `ChallengeScreen`
  calls `verifyChallenge` on the native channel (`focuslock/protection`); the
  native layer validates against `ProtectionStore.pendingChallenge` and toggles
  pause only on success.
- **Blocklist** — `Blocklist.kt` loads `assets/blocklist.txt` plus custom sites
  and enabled category patterns from `RuleStore`, so user edits flow through the
  exact same DNS matcher.
- **Sync** — encrypted payloads are byte-compatible across Dart (`crypt.dart`),
  Kotlin (`SyncClient.kt`) and the desktop port.