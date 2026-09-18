/// Main dashboard: hero status, live protection-layer health, stats, challenge
/// controls and difficulty — a single glanceable "cockpit" for the guard.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models.dart';
import '../services/protection_bridge.dart';
import '../state/app_state.dart';
import '../theme.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key, required this.onPauseRequested});

  final Future<void> Function() onPauseRequested;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  bool _toggling = false;

  Timer? _healthTimer;

  @override
  void initState() {
    super.initState();
    // Live-refresh the protective-layer health and refresh counters.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<AppState>().refreshHealth();
    });
    _healthTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!mounted) return;
      context.read<AppState>().refreshHealth();
    });
  }

  @override
  void dispose() {
    _healthTimer?.cancel();
    super.dispose();
  }

  Future<void> _pauseFlow() async {
    await widget.onPauseRequested();
  }

  Future<void> _stopSession() async {
    setState(() => _toggling = true);
    await context.read<AppState>().stopSession();
    if (mounted) setState(() => _toggling = false);
  }

  Future<void> _startSession() async {
    setState(() => _toggling = true);
    await context.read<AppState>().startSession();
    if (mounted) setState(() => _toggling = false);
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = context.watch<AppState>();
    final FocusState? focus = state.focus;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          focus?.guard ?? false ? 'فوكس لوك — الوضع الصارم' : 'فوكس لوك',
          style: const TextStyle(fontSize: 18),
        ),
        actions: <Widget>[
          if (focus?.guard ?? false)
            const Padding(
              padding: EdgeInsets.only(left: 16),
              child: _ShieldBadge(),
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: <Widget>[
          _HeroStatusCard(
            focus: focus,
            toggling: _toggling,
            onStart: _startSession,
            onPause: _pauseFlow,
            onStop: _stopSession,
          ),
          const SizedBox(height: 14),
          _HealthCard(state: state),
          const SizedBox(height: 14),
          _StatsGrid(focus: focus),
          const SizedBox(height: 14),
          _DifficultySelector(
            difficulty: state.focus?.difficulty ?? 3,
            onChanged: (value) => state.setDifficulty(value),
          ),
          const SizedBox(height: 14),
          _SyncBar(state: state),
          if (focus?.guard ?? false) ...<Widget>[
            const SizedBox(height: 14),
            const _GuardBanner(),
          ],
        ],
      ),
    );
  }
}

class _ShieldBadge extends StatelessWidget {
  const _ShieldBadge();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        gradient: kGradient,
        borderRadius: BorderRadius.circular(20),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.gpp_good, size: 16, color: Colors.white),
          SizedBox(width: 6),
          Text(
            'دائم',
            style: TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

/// Hero status: gradient panel whose pulse, title and inline controls mirror
/// the protection state. The strict mode swaps the controls for a lock note.
class _HeroStatusCard extends StatelessWidget {
  const _HeroStatusCard({
    required this.focus,
    required this.toggling,
    required this.onStart,
    required this.onPause,
    required this.onStop,
  });

  final FocusState? focus;
  final bool toggling;
  final VoidCallback onStart;
  final VoidCallback onPause;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final bool guarded = focus?.guard ?? false;
    final bool active = focus?.active ?? false;
    final bool idle = focus == null;

    final (String title, String subtitle) = guarded
        ? ('الحماية دائمة', 'الوضع الصارم مفعّل — لا إيقاف ولا إنهاء ولا إلغاء تثبيت')
        : active
            ? ('الحماية نشطة', 'كل الاتصالات محمية — DNS + HTTPS/SNI')
            : idle
                ? ('الحماية متوقفة', 'لم نبدأ جلسة بعد. ابدأ للحماية الآن')
                : ('إيقاف مؤقت', 'مراقبة نشطة — ابدأ من جديد متى شئت');

    return Container(
      decoration: BoxDecoration(
        gradient: kGradient,
        borderRadius: BorderRadius.circular(24),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: kAccent.withValues(alpha: 0.35),
            blurRadius: 28,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Stack(
        children: <Widget>[
          if (active && !guarded)
            const Positioned(top: -30, left: -30, child: _GlowOrb(color: kSuccess)),
          if (guarded)
            const Positioned(top: -30, right: -30, child: _GlowOrb(color: kError)),
          Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    _StatusPill(active: active, guarded: guarded, idle: idle),
                    const Spacer(),
                    if (active && !guarded)
                      const _PulseDot()
                    else if (guarded)
                      const Icon(Icons.lock_outline, color: Colors.white70, size: 22),
                  ],
                ),
                const SizedBox(height: 18),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 350),
                  transitionBuilder: (child, anim) => FadeTransition(
                    opacity: anim,
                    child: SlideTransition(
                      position: Tween<Offset>(
                        begin: const Offset(0, 0.12),
                        end: Offset.zero,
                      ).animate(anim),
                      child: child,
                    ),
                  ),
                  child: Column(
                    key: ValueKey<String>(title),
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        title,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 24,
                          fontWeight: FontWeight.w800,
                          height: 1.1,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        subtitle,
                        style: const TextStyle(color: Colors.white70, fontSize: 13.5, height: 1.4),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                if (!guarded)
                  _HeroControls(
                    active: active,
                    idle: idle,
                    toggling: toggling,
                    onStart: onStart,
                    onPause: onPause,
                    onStop: onStop,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _GlowOrb extends StatelessWidget {
  const _GlowOrb({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 110,
      height: 110,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: 0.16),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.active, required this.guarded, required this.idle});

  final bool active;
  final bool guarded;
  final bool idle;

  @override
  Widget build(BuildContext context) {
    final (String label, Color color) = guarded
        ? ('وضع صارم', kError)
        : active
            ? ('نشطة الآن', kSuccess)
            : idle
                ? ('متوقفة', Colors.white54)
                : ('موقوفة مؤقتًا', kWarning);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(30),
        border: Border.all(color: Colors.white.withValues(alpha: 0.25)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(shape: BoxShape.circle, color: color),
          ),
          const SizedBox(width: 8),
          Text(
            label,
            style: const TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

class _PulseDot extends StatefulWidget {
  const _PulseDot();

  @override
  State<_PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<_PulseDot> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ScaleTransition(
      scale: Tween<double>(begin: 1, end: 1.5).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: Container(
        width: 12,
        height: 12,
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
          color: Color(0xFF3BFFA5),
          boxShadow: <BoxShadow>[
            BoxShadow(color: Color(0x993BFFA5), blurRadius: 10, spreadRadius: 2),
          ],
        ),
      ),
    );
  }
}

class _HeroControls extends StatelessWidget {
  const _HeroControls({
    required this.active,
    required this.idle,
    required this.toggling,
    required this.onStart,
    required this.onPause,
    required this.onStop,
  });

  final bool active;
  final bool idle;
  final bool toggling;
  final VoidCallback onStart;
  final VoidCallback onPause;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    if (toggling) {
      return const SizedBox(
        height: 52,
        child: Center(
          child: SizedBox(
            width: 26,
            height: 26,
            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 3),
          ),
        ),
      );
    }
    return Row(
      children: <Widget>[
        if (active)
          Expanded(
            child: _TonalButton(
              icon: Icons.pause,
              label: 'إيقاف',
              onTap: onPause,
            ),
          ),
        if (active) const SizedBox(width: 10),
        Expanded(
          child: _HeroCta(
            icon: active ? Icons.play_arrow : Icons.power_settings_new,
            label: active ? 'استئناف' : 'بدء الحماية',
            filled: !active,
            onTap: onStart,
          ),
        ),
        if (!idle || active) const SizedBox(width: 10),
        if (!idle || active)
          Expanded(
            child: _TonalButton(
              icon: Icons.stop,
              label: 'إنهاء',
              danger: true,
              onTap: onStop,
            ),
          ),
      ],
    );
  }
}

class _TonalButton extends StatelessWidget {
  const _TonalButton({required this.icon, required this.label, required this.onTap, this.danger = false});

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final Color color = danger ? const Color(0xFFFF8A8A) : Colors.white;
    return Material(
      color: danger ? const Color(0x33FF5252) : Colors.white.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            mainAxisSize: MainAxisSize.max,
            children: <Widget>[
              Icon(icon, size: 18, color: color),
              const SizedBox(width: 8),
              Text(
                label,
                style: TextStyle(color: color, fontSize: 14.5, fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HeroCta extends StatelessWidget {
  const _HeroCta({required this.icon, required this.label, required this.filled, required this.onTap});

  final IconData icon;
  final String label;
  final bool filled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color bg = filled ? Colors.white : Colors.white.withValues(alpha: 0.14);
    final Color fg = filled ? kAccent : Colors.white;
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(icon, size: 18, color: fg),
              const SizedBox(width: 8),
              Text(label, style: TextStyle(color: fg, fontSize: 14.5, fontWeight: FontWeight.w800)),
            ],
          ),
        ),
      ),
    );
  }
}

/// Live snapshot of every protective layer; tap a red row to fix it in place.
class _HealthCard extends StatelessWidget {
  const _HealthCard({required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final HealthStatus? h = state.health;
    final bool allOk = h?.allHealthy ?? false;

    final List<_HealthRow> rows = <_HealthRow>[
      _HealthRow(
        icon: Icons.vpn_lock_outlined,
        title: 'نفق الحماية (VPN)',
        detail: h?.vpnActive ?? false ? 'متصّل' : 'غير متصل',
        ok: h?.vpnActive ?? false,
      ),
      _HealthRow(
        icon: Icons.accessible_forward_outlined,
        title: 'حارس إمكانية الوصول',
        detail: _guardDetail(h),
        ok: h?.guardAlive ?? false,
        onTap: h != null && !h.guardAlive
            ? HealthBridge.openAccessibilitySettings
            : null,
      ),
      _HealthRow(
        icon: Icons.notifications_active_outlined,
        title: 'الإشعارات',
        detail: h?.notificationsEnabled ?? false ? 'مفعّلة' : 'مكتومة',
        ok: h?.notificationsEnabled ?? false,
        onTap: h != null && !h.notificationsEnabled
            ? HealthBridge.openNotificationSettings
            : null,
      ),
      _HealthRow(
        icon: Icons.battery_std_outlined,
        title: 'استثناء توفير الطاقة',
        detail: h?.batteryExempt ?? false ? 'معفاة من التحسين' : 'غير معفاة',
        ok: h?.batteryExempt ?? false,
        onTap: h != null && !h.batteryExempt
            ? HealthBridge.openBatterySettings
            : null,
      ),
      _HealthRow(
        icon: Icons.av_timer_outlined,
        title: 'المنبّه الدقيق',
        detail: h?.canScheduleExactAlarms ?? false ? 'مخوّل' : 'مقيّد',
        ok: h?.canScheduleExactAlarms ?? false,
        onTap: h != null && !h.canScheduleExactAlarms
            ? HealthBridge.openBatterySettings
            : null,
      ),
      _HealthRow(
        icon: Icons.home_repair_service_outlined,
        title: 'الخدمة الرئيسية',
        detail: h?.primaryRunning ?? false ? 'تعمل' : 'متوقفة',
        ok: h?.protected ?? false ? (h?.primaryRunning ?? false) : true,
        onTap: h != null && h.protected && !h.primaryRunning
            ? HealthBridge.revivePrimary
            : null,
      ),
      _HealthRow(
        icon: Icons.wifi_outlined,
        title: 'الشبكة',
        detail: h?.networkLabel ?? 'غير معروفة',
        ok: h?.networkType == 'wifi' || h?.networkType == 'mobile',
        onTap: null,
      ),
    ];

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _HealthHeader(allOk: allOk, loading: h == null),
            const SizedBox(height: 12),
            if (h == null)
              const Padding(
                padding: EdgeInsets.only(right: 160, bottom: 12),
                child: LinearProgressIndicator(color: kAccent, minHeight: 3),
              )
            else
              ...rows.map((r) => _HealthRowTile(row: r)),
          ],
        ),
      ),
    );
  }

  static String _guardDetail(HealthStatus? h) {
    if (h == null) return 'غير معروف';
    if (h.guardAlive) return 'فعّال ويتنفّس';
    if (h.accessibilityEnabled) return 'مفعّل لكن متوقف';
    return 'معطّل';
  }
}

class _HealthHeader extends StatelessWidget {
  const _HealthHeader({required this.allOk, required this.loading});

  final bool allOk;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final Color color = loading ? kMuted : allOk ? kSuccess : kError;
    return Row(
      children: <Widget>[
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withValues(alpha: 0.14),
          ),
          child: Icon(
            loading
                ? Icons.health_and_safety_outlined
                : allOk
                    ? Icons.health_and_safety
                    : Icons.healing_outlined,
            size: 20,
            color: color,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            loading
                ? 'حالة الحماية'
                : allOk
                    ? 'كل طبقات الحماية تعمل'
                    : 'تُفتَرش طبقة — المس الطبقة الحمراء لإصلاحها',
            style: TextStyle(
              color: loading ? kMuted : color,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ],
    );
  }
}

class _HealthRow {
  const _HealthRow({
    required this.icon,
    required this.title,
    required this.detail,
    required this.ok,
    this.onTap,
  });

  final IconData icon;
  final String title;
  final String detail;
  final bool ok;
  final Future<void> Function()? onTap;
}

class _HealthRowTile extends StatelessWidget {
  const _HealthRowTile({required this.row});

  final _HealthRow row;

  @override
  Widget build(BuildContext context) {
    final Color dot = row.ok ? kSuccess : kError;
    final bool tappable = row.onTap != null;
    return InkWell(
      onTap: tappable ? row.onTap : null,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Row(
          children: <Widget>[
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(shape: BoxShape.circle, color: dot),
            ),
            const SizedBox(width: 12),
            Icon(row.icon, size: 20, color: tappable ? dot : kAccent),
            const SizedBox(width: 12),
            Expanded(
              child: Text(row.title, style: const TextStyle(color: kText, fontSize: 14)),
            ),
            Text(
              row.detail,
              style: TextStyle(color: dot, fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
            if (tappable) ...<Widget>[
              const SizedBox(width: 4),
              const Icon(Icons.chevron_left, size: 18, color: kMuted),
            ],
          ],
        ),
      ),
    );
  }
}

/// Compact counters: blocked today, unlock attempts, custom sites and apps.
class _StatsGrid extends StatelessWidget {
  const _StatsGrid({required this.focus});

  final FocusState? focus;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: _StatTile(
                icon: Icons.block_outlined,
                value: '${focus?.blockedToday ?? 0}',
                label: 'محجوب اليوم',
                accent: kError,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _StatTile(
                icon: Icons.fingerprint_outlined,
                value: '${focus?.unlockAttempts ?? 0}',
                label: 'محاولات الفتح',
                accent: kWarning,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            Expanded(
              child: _StatTile(
                icon: Icons.language_outlined,
                value: '${focus?.customSites ?? 0}',
                label: 'مواقع مخصصة',
                accent: kAccent,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _StatTile(
                icon: Icons.apps_outlined,
                value: '${focus?.customApps ?? 0}',
                label: 'تطبيقات ممنوعة',
                accent: kSuccess,
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        _LastUpdateStamp(focus: focus),
      ],
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({
    required this.icon,
    required this.value,
    required this.label,
    required this.accent,
  });

  final IconData icon;
  final String value;
  final String label;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        child: Row(
          children: <Widget>[
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: accent.withValues(alpha: 0.12),
              ),
              child: Icon(icon, size: 20, color: accent),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    value,
                    style: TextStyle(
                      color: kText,
                      fontSize: 24,
                      fontWeight: FontWeight.w800,
                      height: 1,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(label, style: const TextStyle(color: kMuted, fontSize: 12)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LastUpdateStamp extends StatelessWidget {
  const _LastUpdateStamp({required this.focus});

  final FocusState? focus;

  String get _stamp {
    final String? raw = focus?.lastUpdate;
    if (raw == null || raw.isEmpty) return '—';
    final DateTime? t = DateTime.tryParse(raw);
    if (t == null) return raw;
    final DateTime now = DateTime.now();
    final Duration d = now.difference(t);
    if (d.inSeconds < 60) return 'الآن';
    if (d.inMinutes < 60) return 'منذ ${d.inMinutes} د';
    if (d.inHours < 24) return 'منذ ${d.inHours} س';
    return 'منذ ${d.inDays} يوم';
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        const Icon(Icons.schedule, size: 12, color: kMuted),
        const SizedBox(width: 6),
        Text(
          'آخر نشاط: $_stamp',
          style: const TextStyle(color: kMuted, fontSize: 12),
        ),
      ],
    );
  }
}

/// Segmented difficulty picker with an animated thumb.
class _DifficultySelector extends StatelessWidget {
  const _DifficultySelector({required this.difficulty, required this.onChanged});

  final int difficulty;
  final ValueChanged<int> onChanged;

  static const List<(String, IconData)> _levels = <(String, IconData)>[
    ('راحة', Icons.sentiment_satisfied_alt_outlined),
    ('سريع', Icons.timer_outlined),
    ('متوسط', Icons.timer),
    ('صعب', Icons.bolt_outlined),
    ('قوي', Icons.local_fire_department_outlined),
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 4),
          child: Text('مستوى تحدّي الإيقاف', style: TextStyle(color: kText, fontSize: 15, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 10),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(6),
            child: Row(
              children: List<Widget>.generate(_levels.length, (int i) {
                final int value = i + 1;
                final bool selected = value == difficulty;
                return Expanded(
                  child: _DifficultyTile(
                    label: _levels[i].$1,
                    icon: _levels[i].$2,
                    selected: selected,
                    onTap: () => onChanged(value),
                  ),
                );
              }),
            ),
          ),
        ),
      ],
    );
  }
}

class _DifficultyTile extends StatefulWidget {
  const _DifficultyTile({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_DifficultyTile> createState() => _DifficultyTileState();
}

class _DifficultyTileState extends State<_DifficultyTile> {
  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(end: widget.selected ? 1 : 0),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      builder: (context, double t, _) {
        final Color background = Color.lerp(Colors.transparent, kAccent, t)!;
        final Color content = Color.lerp(kMuted, Colors.white, t)!;
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(widget.icon, size: 16, color: content),
                const SizedBox(width: 6),
                Text(
                  widget.label,
                  style: TextStyle(
                    color: content,
                    fontSize: 12.5,
                    fontWeight: t > 0.5 ? FontWeight.w700 : FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// Cloud sync status row.
class _SyncBar extends StatelessWidget {
  const _SyncBar({required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final bool configured = state.sync.configured;
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: <Widget>[
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: (configured ? kSuccess : kMuted).withValues(alpha: 0.12),
              ),
              child: Icon(
                configured ? Icons.cloud_done_outlined : Icons.cloud_off_outlined,
                size: 18,
                color: configured ? kSuccess : kMuted,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    configured ? 'متصل بالمزامنة' : 'غير مهيأ للمزامنة',
                    style: const TextStyle(color: kText, fontSize: 14.5, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    configured ? 'قواعدك محفوظة وتُداول حيًّا عبر عدة أجهزة' : 'فعّل المزامنة من الإعدادات لمشاركة قواعدك',
                    style: const TextStyle(color: kMuted, fontSize: 12),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Strict-mode note; replaces the session controls by design.
class _GuardBanner extends StatelessWidget {
  const _GuardBanner();

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          gradient: kSurfaceGradient,
        ),
        child: const Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(Icons.gpp_maybe_outlined, color: kError, size: 26),
            SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    'الوضع الصارم مفعّل',
                    style: TextStyle(color: kError, fontSize: 16, fontWeight: FontWeight.w800),
                  ),
                  SizedBox(height: 6),
                  Text(
                    'الحماية دائمة: لا إيقاف مؤقت، لا إنهاء، ولا إلغاء تثبيت. '
                    'المحتوى الإباحي محجوب بشكل دائم (DNS + HTTPS/SNI).',
                    style: TextStyle(color: kMuted, fontSize: 13, height: 1.5),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}