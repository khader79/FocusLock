/// Central application state: focuses on the native session, rules and sync.
library;

import 'package:flutter/foundation.dart' hide Category;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../challenge.dart';
import '../models.dart';
import '../services/protection_bridge.dart';
import '../services/sync_service.dart';

class AppState extends ChangeNotifier {
  AppState({SyncService? sync}) : _sync = sync ?? SyncService();

  static const FlutterSecureStorage _secureStorage = FlutterSecureStorage();
  static const String _prefUrl = 'sync_url';
  static const String _prefAnon = 'sync_anon';
  static const String _prefRow = 'sync_row';
  static const String _prefSecretKey = 'sync_secret';

  final SyncService _sync;

  bool _initialized = false;
  bool get initialized => _initialized;

  FocusState? _focus;
  FocusState? get focus => _focus;

  List<String> _sites = <String>[];
  List<String> get sites => List<String>.unmodifiable(_sites);

  List<Category> _categories = <Category>[];
  List<Category> get categories => List<Category>.unmodifiable(_categories);

  List<String> _blockedApps = <String>[];
  List<String> get blockedApps => List<String>.unmodifiable(_blockedApps);

  final bool _busy = false;
  bool get busy => _busy;

  bool _deviceOwner = false;
  bool get deviceOwner => _deviceOwner;

  String? _lastError;
  String? get lastError => _lastError;

  List<FocusApp> installedApps = <FocusApp>[];

  SyncService get sync => _sync;

  // ------------------------------------------------------------ lifecycle

  /// Loads the session snapshot + rules from the native layer once.
  Future<void> init() async {
    if (_initialized) {
      return;
    }
    _initialized = true;
    await refresh();
    await _loadSyncConfig();

    _sync.remoteState.listen((remote) {
      _focus = remote;
      notifyListeners();
    });
  }

  /// Restores a persisted Supabase sync config and starts real-time listening.
  Future<void> _loadSyncConfig() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final url = prefs.getString(_prefUrl) ?? '';
      final anonKey = prefs.getString(_prefAnon) ?? '';
      final rowId = prefs.getString(_prefRow) ?? '';
      final secret = await _secureStorage.read(key: _prefSecretKey) ?? '';
      if (url.isNotEmpty && anonKey.isNotEmpty && rowId.isNotEmpty && secret.isNotEmpty) {
        _sync
          ..config = SyncConfig(url: url, anonKey: anonKey, rowId: rowId)
          ..sharedSecret = secret;
        _sync.start();
      }
    } catch (_) {
      // Corrupt/inaccessible prefs; treat as unconfigured.
    }
    notifyListeners();
  }

  /// Persists + wires a new sync config and opens the real-time socket.
  Future<bool> saveSyncConfig({
    required String url,
    required String anonKey,
    required String rowId,
    required String secret,
  }) async {
    if (url.isEmpty || anonKey.isEmpty || rowId.isEmpty || secret.isEmpty) {
      return false;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_prefUrl, url);
      await prefs.setString(_prefAnon, anonKey);
      await prefs.setString(_prefRow, rowId);
      await _secureStorage.write(key: _prefSecretKey, value: secret);
      _sync
        ..config = SyncConfig(url: url, anonKey: anonKey, rowId: rowId)
        ..sharedSecret = secret
        ..stop()
        ..start();
      notifyListeners();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> clearSyncConfig() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_prefUrl);
    await prefs.remove(_prefAnon);
    await prefs.remove(_prefRow);
    await _secureStorage.delete(key: _prefSecretKey);
    _sync
      ..stop()
      ..config = null
      ..sharedSecret = '';
    notifyListeners();
  }

  Future<void> refresh() async {
    try {
      final results = await Future.wait<Object>(<Future<Object>>[
        ProtectionBridge.getState(),
        RulesBridge.getSites(),
        RulesBridge.getCategories(),
        AppsBridge.getBlocked(),
      ]);
      _focus = results[0] as FocusState;
      _sites = (results[1] as List<String>);
      _categories = (results[2] as List<Category>);
      _blockedApps = (results[3] as List<String>);
    } catch (e) {
      _lastError = e.toString();
    }
    try {
      _deviceOwner = await AppsBridge.isDeviceOwner();
    } catch (_) {
      _deviceOwner = false;
    }
    notifyListeners();
  }

  // ------------------------------------------------------------ session

  Future<bool> startSession() async {
    final started = await ProtectionBridge.startSession();
    await refresh();
    return started;
  }

  Future<bool> stopSession() async {
    final stopped = await ProtectionBridge.stopSession();
    await refresh();
    return stopped;
  }

  /// Native-generated challenge that gates pause/resume.
  Future<Challenge> beginToggle() async {
    return ProtectionBridge.generateChallenge();
  }

  /// Verifies the completed challenge and applies the toggle if accepted.
  Future<bool> finishToggle(Challenge challenge, String typed) async {
    final result = await ProtectionBridge.verifyChallenge(
      challenge.id,
      typed,
    );
    await refresh();
    return result.ok;
  }

  Future<void> abandonToggle() async {
    await ProtectionBridge.rejectChallenge();
  }

  Future<void> setDifficulty(int difficulty) async {
    await ProtectionBridge.setDifficulty(difficulty);
    await refresh();
  }

  // -------------------------------------------------------------- website

  Future<bool> addSite(String site) async {
    final added = await RulesBridge.addSite(site);
    await refresh();
    return added;
  }

  Future<void> removeSite(String site) async {
    await RulesBridge.removeSite(site);
    await refresh();
  }

  // -------------------------------------------------------------- category

  Future<void> toggleCategory(String id) async {
    final updated = _categories
        .map((c) =>
            c.id == id ? Category(id: c.id, name: c.name, pattern: c.pattern, enabled: !c.enabled, custom: c.custom) : c)
        .toList();
    _categories = updated;
    await RulesBridge.setCategories(updated);
    notifyListeners();
  }

  Future<void> addCategory(String name, String pattern) async {
    final updated = List<Category>.from(_categories)
      ..add(Category(
        id: 'custom-${DateTime.now().millisecondsSinceEpoch}',
        name: name,
        pattern: pattern,
        enabled: true,
        custom: true,
      ));
    _categories = updated;
    await RulesBridge.setCategories(updated);
    notifyListeners();
  }

  Future<void> removeCategory(String id) async {
    final updated = _categories.where((c) => c.id != id).toList();
    _categories = updated;
    await RulesBridge.setCategories(updated);
    notifyListeners();
  }

  // ------------------------------------------------------------------ apps

  Future<void> reloadInstalledApps() async {
    try {
      installedApps = await AppsBridge.listInstalledApps();
    } catch (_) {
      // Package listing can be unavailable until launch; keep last snapshot.
    }
    notifyListeners();
  }

  Future<String> suspendApp(FocusApp app) async {
    final mechanism = await AppsBridge.suspendApp(app.packageName);
    if (!_blockedApps.contains(app.packageName)) {
      _blockedApps = List<String>.from(_blockedApps)..add(app.packageName);
    }
    await refresh();
    return mechanism;
  }

  Future<void> resumeApp(FocusApp app) async {
    await AppsBridge.resumeApp(app.packageName);
    _blockedApps = _blockedApps.where((p) => p != app.packageName).toList();
    await refresh();
  }

  bool isAppBlocked(String packageName) => _blockedApps.contains(packageName);

  // ------------------------------------------------------------------- sync

  Future<FocusState?> pushSync() => _sync.push(_focus ?? const FocusState(
        status: 'active',
        blockedToday: 0,
        unlockAttempts: 0,
        customSites: 0,
        customApps: 0,
        syncConfigured: false,
        difficulty: 3,
      ))
      .then((ok) => ok ? _focus : null);

  Future<FocusState?> pullSync() => _sync.pull();
}