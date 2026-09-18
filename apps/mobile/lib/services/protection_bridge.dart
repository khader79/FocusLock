/// MethodChannel bridges to the Android-native FocusLock layers.
library;

import 'package:flutter/services.dart';

import '../challenge.dart';
import '../models.dart';

/// Bridge to the persistent foreground service + challenge gating
/// ('focuslock/protection').
class ProtectionBridge {
  ProtectionBridge._();

  static const MethodChannel _channel = MethodChannel('focuslock/protection');

  static Future<FocusState> getState() async {
    final map = await _channel.invokeMapMethod<Object?, Object?>('getState');
    return FocusState.fromMap(map ?? const <Object?, Object?>{});
  }

  static Future<bool> startSession() async =>
      await _channel.invokeMethod<bool>('startSession') ?? false;

  static Future<bool> stopSession() async =>
      await _channel.invokeMethod<bool>('stopSession') ?? false;

  /// Requests a native-generated challenge used to gate pause/resume.
  /// The native side registers it as the pending challenge.
  static Future<Challenge> generateChallenge({int? difficulty}) async {
    final map = await _channel.invokeMapMethod<Object?, Object?>(
      'generateChallenge',
      {'difficulty': ?difficulty},
    );
    if (map == null) {
      throw PlatformException(code: 'NO_CHALLENGE', message: 'No challenge returned.');
    }
    final text = map['text'] as String? ?? '';
    final minutes = map['minutes'] as int? ?? 0;
    final now = DateTime.now();
    return Challenge(
      id: map['id'] as String? ?? '',
      text: text,
      wordCount: map['wordCount'] as int? ?? text.split(' ').length,
      createdAt: now,
      expiresAt: now.add(Duration(minutes: minutes)),
      difficulty: map['difficulty'] as int? ?? 3,
    );
  }

  /// Verifies a completed challenge natively. Returns true and the resulting
  /// paused state when the session toggled.
  static Future<({bool ok, bool paused})> verifyChallenge(
    String id,
    String typed,
  ) async {
    final map = await _channel.invokeMapMethod<Object?, Object?>(
      'verifyChallenge',
      <String, Object?>{'id': id, 'typed': typed},
    );
    return (ok: map?['ok'] as bool? ?? false, paused: map?['paused'] as bool? ?? false);
  }

  static Future<void> rejectChallenge() async {
    await _channel.invokeMethod<void>('rejectChallenge');
  }

  /// Verifies [typed] against a pending challenge without touching the session
  /// state (no pause toggle). Used to gate non-session changes like unblocking
  /// an app. Returns true when the challenge was completed correctly.
  static Future<bool> verifyChallengeOnly(String id, String typed) async {
    final map = await _channel.invokeMapMethod<Object?, Object?>(
      'verifyChallengeOnly',
      <String, Object?>{'id': id, 'typed': typed},
    );
    return map?['ok'] as bool? ?? false;
  }

  static Future<void> setDifficulty(int difficulty) async {
    await _channel.invokeMethod<void>(
      'setDifficulty',
      <String, Object?>{'difficulty': difficulty},
    );
  }

  /// Arms the one-way strict mode (cannot be disabled from the device).
  /// Returns the applied DPM flags: uninstallBlocked / lockdownVpn / guard.
  static Future<Map<Object?, Object?>> enableGuard() async {
    return await _channel.invokeMapMethod<Object?, Object?>('setGuard') ??
        const <Object?, Object?>{};
  }

  /// Whether the strict mode is currently armed.
  static Future<bool> isGuarded() async {
    final map = await _channel.invokeMapMethod<Object?, Object?>('guardState') ??
        const <Object?, Object?>{};
    return map['guard'] as bool? ?? false;
  }
}

/// Bridge for the notification-launch action ('focuslock/launch').
///
/// Tapping "Pause"/"Resume" on the persistent notification reopens the app
/// with a launch action; this exposes and consumes it so the UI can open the
/// challenge modal.
class LaunchBridge {
  LaunchBridge._();

  static const MethodChannel _channel = MethodChannel('focuslock/launch');

  static Future<String?> getLaunchAction() async =>
      await _channel.invokeMethod<String>('getLaunchAction');

  static Future<String?> consumeLaunchAction() async =>
      await _channel.invokeMethod<String>('consumeLaunchAction');
}

/// Rules storage bridge ('focuslock/rules').
///
/// Custom sites/categories are persisted natively so the VPN blocklist merges
/// them through the exact same matcher as the shipped asset blocklist.
class RulesBridge {
  RulesBridge._();

  static const MethodChannel _channel = MethodChannel('focuslock/rules');

  static Future<List<String>> getSites() async {
    final raw = await _channel.invokeListMethod<String>('getSites');
    return raw ?? <String>[];
  }

  static Future<bool> addSite(String site) async {
    return await _channel.invokeMethod<bool>('addSite', <String, Object?>{'site': site}) ?? false;
  }

  static Future<void> removeSite(String site) async {
    await _channel.invokeMethod<void>('removeSite', <String, Object?>{'site': site});
  }

  static Future<void> setSites(List<String> sites) async {
    await _channel.invokeMethod<void>('setSites', <String, Object?>{'sites': sites});
  }

  static Future<List<Category>> getCategories() async {
    final raw = await _channel.invokeListMethod<Map<Object?, Object?>>('getCategories');
    return (raw ?? <Map<Object?, Object?>>[])
        .map(Category.fromMap)
        .toList();
  }

  static Future<void> setCategories(List<Category> categories) async {
    await _channel.invokeMethod<void>(
      'setCategories',
      <String, Object?>{'categories': categories.map((c) => c.toJson().toString()).toList()},
    );
  }
}

/// A blocked/app-managed app as exposed by the native layer.
class FocusApp {
  const FocusApp({required this.name, required this.packageName, this.icon});

  final String name;
  final String packageName;
  final Uint8List? icon;
}

/// Apps blocking bridge, layered DPM -> VPN quarantine -> accessibility
/// ('focuslock/apps').
class AppsBridge {
  AppsBridge._();

  static const MethodChannel _channel = MethodChannel('focuslock/apps');

  static Future<bool> isDeviceOwner() async =>
      await _channel.invokeMethod<bool>('isDeviceOwner') ?? false;

  /// Package names of all installed apps that are currently blocked.
  static Future<List<String>> getBlocked() async {
    final raw = await _channel.invokeListMethod<String>('getBlocked');
    return raw ?? <String>[];
  }

  static Future<List<FocusApp>> listInstalledApps() async {
    final raw = await _channel.invokeListMethod<Map<Object?, Object?>>('listInstalledApps');
    return (raw ?? <Map<Object?, Object?>>[]).map((entry) {
      final Object? icon = entry['icon'];
      return FocusApp(
        name: entry['name']?.toString() ?? '',
        packageName: entry['packageName']?.toString() ?? '',
        icon: icon is Uint8List && icon.isNotEmpty ? icon : null,
      );
    }).toList();
  }

  /// Returns the enforcement mechanism name ("dpm" | "vpn" | "accessibility").
  static Future<String> suspendApp(String packageName) async {
    final name = await _channel.invokeMethod<String?>(
      'suspendApp',
      <String, Object?>{'packageName': packageName},
    );
    return name ?? 'none';
  }

  static Future<void> resumeApp(String packageName) async {
    await _channel.invokeMethod<void>('resumeApp', <String, Object?>{'packageName': packageName});
  }
}

/// Protection-health bridge ('focuslock/watchdog'). Feeds the live dashboard
/// with the state of every protective layer (VPN, a11y guard, notifications,
/// battery exemption, primary service) and opens the matching settings screen
/// when a layer needs a manual fix.
class HealthBridge {
  HealthBridge._();

  static const MethodChannel _channel = MethodChannel('focuslock/watchdog');

  static Future<HealthStatus> getHealth() async {
    final map = await _channel.invokeMapMethod<Object?, Object?>('status');
    return HealthStatus.fromMap(map ?? const <Object?, Object?>{});
  }

  static Future<void> openAccessibilitySettings() async {
    await _channel.invokeMethod<void>('openAccessibilitySettings');
  }

  static Future<void> openNotificationSettings() async {
    await _channel.invokeMethod<void>('openNotificationSettings');
  }

  static Future<void> openBatterySettings() async {
    await _channel.invokeMethod<void>('openBatterySettings');
  }

  /// Forces the watchdog to re-resolve / revive the primary protection service.
  static Future<bool> revivePrimary() async {
    return await _channel.invokeMethod<bool>('reviveNow') ?? false;
  }
}