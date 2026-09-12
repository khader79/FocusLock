/// How FocusLock re-locks the device after a reboot.
///
/// This library is documentation-only: boot handling lives on the Android
/// side (`BootReceiver` + `FocusVpnService`), because receiving a
/// `BOOT_COMPLETED` broadcast and starting a service must happen in the native
/// (Kotlin) layer — Dart cannot run until the Flutter engine starts.
///
/// ## Flow
///
/// 1. The device finishes booting. Android broadcasts
///    `android.intent.action.BOOT_COMPLETED` to every app that declared the
///    `RECEIVE_BOOT_COMPLETED` permission.
///
/// 2. `BootReceiver` (declared in `AndroidManifest.xml`) receives it even
///    while FocusLock is not running — manifest receivers are started by the
///    system on boot.
///
/// 3. `BootReceiver` starts `FocusVpnService`:
///    - Android 8+  -> `startForegroundService()` (a background `startService`
///      is banned by the platform), so the service must call
///      `startForeground()` within a few seconds.
///    - Older        -> `startService()`.
///
/// 4. `FocusVpnService` calls `Builder.establish()` with the same tun
///    parameters the user approved earlier (10.0.0.2/32, route 0.0.0.0/0,
///    DNS 10.0.0.1) and starts the packet thread.
///
/// ## What is required for this to actually re-block at boot
///
/// - The VPN consent must already be granted. `establish()` returns null
///   (and the service stops) if the user never approved FocusLock as a VPN.
/// - To be started from the background on Android 12+, the app must be a
///   recognised active VPN. Set it in _Settings > Network > VPN > Always-on_,
///   or let Android auto-start the always-on VPN on boot itself.
/// - The device owner (`AdminReceiver`, see `admin.dart`) is NOT required for
///   boot restart — it is only needed for `lockNow()` / `setUninstallBlocked`.
///
/// ## Lifecycle note
///
/// `FocusVpnService.ACTION_START` is the explicit action used by the receiver;
/// the service keeps running as a foreground service (ongoing notification)
/// while the tunnel is up, and closes the tun fd to tear the network down
/// when stopped.
library;