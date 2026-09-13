/// Shared models for the FocusLock companion app.
library;

/// Snapshot of the protection session, mirroring the desktop
/// `DashboardState` exposed by the preload bridge.
class FocusState {
  const FocusState({
    required this.status,
    required this.blockedToday,
    required this.unlockAttempts,
    required this.customSites,
    required this.customApps,
    required this.syncConfigured,
    required this.difficulty,
    this.lastUpdate,
  });

  factory FocusState.fromMap(Map<dynamic, dynamic> map) {
    return FocusState(
      status: map['status'] as String? ?? 'active',
      blockedToday: map['blockedToday'] as int? ?? 0,
      lastUpdate: map['lastUpdate'] as String?,
      unlockAttempts: map['unlockAttempts'] as int? ?? 0,
      customSites: map['customSites'] as int? ?? 0,
      customApps: map['customApps'] as int? ?? 0,
      difficulty: map['difficulty'] as int? ?? 3,
      syncConfigured: map['syncConfigured'] as bool? ?? false,
    );
  }

  final String status;
  final int blockedToday;
  final String? lastUpdate;
  final int unlockAttempts;
  final int customSites;
  final int customApps;
  final int difficulty;
  final bool syncConfigured;

  bool get active => status == 'active';

  FocusState copyWith({
    String? status,
    int? blockedToday,
    String? lastUpdate,
    int? unlockAttempts,
    int? customSites,
    int? customApps,
  }) {
    return FocusState(
      status: status ?? this.status,
      blockedToday: blockedToday ?? this.blockedToday,
      lastUpdate: lastUpdate ?? this.lastUpdate,
      unlockAttempts: unlockAttempts ?? this.unlockAttempts,
      customSites: customSites ?? this.customSites,
      customApps: customApps ?? this.customApps,
      syncConfigured: syncConfigured,
      difficulty: difficulty,
    );
  }

  Map<String, Object> toSyncMap() => <String, Object>{
        'status': status,
        'blockedToday': blockedToday,
        'lastUpdate': lastUpdate ?? '',
        'unlockAttempts': unlockAttempts,
        'customSites': customSites,
        'customApps': customApps,
      };
}

/// A selectable category (e.g. social media) that resolves to a block pattern.
class Category {
  const Category({
    required this.id,
    required this.name,
    required this.pattern,
    this.enabled = true,
    this.custom = false,
  });

  factory Category.fromMap(Map<dynamic, dynamic> map) {
    return Category(
      id: map['id'] as String? ?? '',
      name: map['name'] as String? ?? '',
      pattern: map['pattern'] as String? ?? '',
      enabled: map['enabled'] as bool? ?? true,
      custom: map['custom'] as bool? ?? false,
    );
  }

  final String id;
  final String name;

  /// A domain suffix this category blocks (e.g. "instagram.com" or
  /// consistent with the blocklist "same matcher" semantics).
  final String pattern;
  final bool enabled;
  final bool custom;

  Map<String, Object> toJson() => <String, Object>{
        'id': id,
        'name': name,
        'pattern': pattern,
        'enabled': enabled,
        'custom': custom,
      };
}

/// The built-in category set shown on first launch.
const List<Category> builtInCategories = <Category>[
  Category(
    id: 'social',
    name: 'مواقع التواصل',
    pattern: 'instagram.com',
    enabled: true,
  ),
  Category(
    id: 'video',
    name: 'الفيديو',
    pattern: 'youtube.com',
    enabled: true,
  ),
  Category(
    id: 'x',
    name: 'إكس',
    pattern: 'x.com',
    enabled: true,
  ),
  Category(
    id: 'tiktok',
    name: 'تيك توك',
    pattern: 'tiktok.com',
    enabled: true,
  ),
  Category(
    id: 'facebook',
    name: 'فيسبوك',
    pattern: 'facebook.com',
    enabled: true,
  ),
  Category(
    id: 'shopping',
    name: 'التسوق',
    pattern: 'amazon.com',
    enabled: false,
  ),
];