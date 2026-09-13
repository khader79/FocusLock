/// Main dashboard: session status, stats, pause (challenge-gated) and
/// difficulty controls, plus a live sync bar.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models.dart';
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

  /// Pause flow: native challenge modal, then native verify, then refresh.
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
        title: const Text('فوكس لوك'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          _StatusCard(state: state, focus: focus),
          const SizedBox(height: 16),
          _StatsGrid(focus: focus),
          const SizedBox(height: 16),
          _Controls(
            toggling: _toggling,
            onStart: _startSession,
            onPause: _pauseFlow,
            onStop: _stopSession,
          ),
          const SizedBox(height: 16),
          _DifficultySelector(
            difficulty: state.focus?.difficulty ?? 3,
            onChanged: (value) => state.setDifficulty(value),
          ),
          const SizedBox(height: 16),
          _SyncBar(state: state),
        ],
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.state, required this.focus});

  final AppState state;
  final FocusState? focus;

  @override
  Widget build(BuildContext context) {
    final bool active = focus?.active ?? false;
    final String subtitle = active
        ? 'الحماية نشطة الآن'
        : focus == null
            ? 'تلمس شاشة الحماية لبدء الجلسة'
            : 'مؤقتًا${state.sync.configured ? ', جارٍ المزامنة' : ''}';

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: kSurface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: active ? kSuccess.withValues(alpha: 0.5) : kBorder,
        ),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 14,
            height: 14,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: active ? kSuccess : (focus == null ? kMuted : kError),
            ),
          ),
          const SizedBox(width: 12),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                active ? 'نشطة' : (focus == null ? 'متوقفة' : 'موقوفة'),
                style: const TextStyle(
                  color: kText,
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
              Text(subtitle, style: const TextStyle(color: kMuted, fontSize: 13)),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatsGrid extends StatelessWidget {
  const _StatsGrid({required this.focus});

  final FocusState? focus;

  @override
  Widget build(BuildContext context) {
    final int attempts = focus?.unlockAttempts ?? 0;
    return Row(
      children: <Widget>[
        Expanded(
          child: _StatCard(value: '${focus?.blockedToday ?? 0}', label: 'محجوب اليوم'),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: _StatCard(value: '$attempts', label: 'محاولات الفتح'),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: _StatCard(
            value: '${(focus?.customSites ?? 0) + (focus?.customApps ?? 0)}',
            label: 'قواعد مخصصة',
          ),
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 18),
        child: Column(
          children: <Widget>[
            Text(
              value,
              style: const TextStyle(color: kAccent, fontSize: 26, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(label, style: const TextStyle(color: kMuted, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}

class _Controls extends StatelessWidget {
  const _Controls({
    required this.toggling,
    required this.onStart,
    required this.onPause,
    required this.onStop,
  });

  final bool toggling;
  final VoidCallback onStart;
  final VoidCallback onPause;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        if (toggling)
          const Expanded(
            child: Center(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: CircularProgressIndicator(color: kAccent),
              ),
            ),
          )
        else ...<Widget>[
          Expanded(
            child: FilledButton.icon(
              onPressed: onPause,
              icon: const Icon(Icons.pause),
              label: const Text('إيقاف مؤقت'),
              style: FilledButton.styleFrom(
                backgroundColor: kAccent,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: FilledButton.icon(
              onPressed: onStart,
              icon: const Icon(Icons.play_arrow),
              label: const Text('بدء'),
              style: FilledButton.styleFrom(
                backgroundColor: kSuccess,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: OutlinedButton.icon(
              onPressed: onStop,
              icon: const Icon(Icons.stop),
              label: const Text('إنهاء'),
              style: OutlinedButton.styleFrom(
                foregroundColor: kError,
                side: const BorderSide(color: kError),
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _DifficultySelector extends StatelessWidget {
  const _DifficultySelector({
    required this.difficulty,
    required this.onChanged,
  });

  final int difficulty;
  final ValueChanged<int> onChanged;

  static const List<String> _labels = <String>['راحة', 'سريع', 'متوسط', 'صعب', 'قوي'];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Text('مستوى التحدي', style: TextStyle(color: kText, fontSize: 16)),
        const SizedBox(height: 8),
        SizedBox(
          height: 40,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: _labels.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              final int value = index + 1;
              final bool selected = value == difficulty;
              return ChoiceChip(
                label: Text(_labels[index]),
                selected: selected,
                onSelected: (_) => onChanged(value),
                selectedColor: kAccent,
                backgroundColor: kSurface,
                labelStyle: TextStyle(
                  color: selected ? Colors.white : kMuted,
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _SyncBar extends StatelessWidget {
  const _SyncBar({required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final bool configured = state.sync.configured;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: <Widget>[
            Icon(
              configured ? Icons.cloud_done_outlined : Icons.cloud_off_outlined,
              color: configured ? kSuccess : kMuted,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                configured ? 'متصل بالمزامنة' : 'غير مهيأ للمزامنة',
                style: TextStyle(color: configured ? kText : kMuted, fontSize: 15),
              ),
            ),
          ],
        ),
      ),
    );
  }
}