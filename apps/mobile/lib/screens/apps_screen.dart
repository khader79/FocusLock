/// App-level blocking: pick installed apps and suspend/resume them. Uses the
/// most capable mechanism available (DPM device owner, VPN, accessibility).
library;

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../challenge.dart';
import '../challenge_screen.dart';
import '../services/protection_bridge.dart';
import '../state/app_state.dart';
import '../theme.dart';

class AppsScreen extends StatefulWidget {
  const AppsScreen({super.key});

  @override
  State<AppsScreen> createState() => _AppsScreenState();
}

class _AppsScreenState extends State<AppsScreen> {
  String _query = '';
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    await context.read<AppState>().reloadInstalledApps();
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _block(FocusApp app) async {
    final AppState store = context.read<AppState>();
    final bool owner = store.deviceOwner;
    await store.suspendApp(app);
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(!owner
            ? 'يُحجب عبر VPN أثناء الجلسة النشطة.'
            : 'تم حجب التطبيق.'),
      ));
  }

  /// Unblocking is gated by the long typing challenge: to reopen a blocked app
  /// the user must first type the full challenge natively verified by the app.
  Future<void> _unblock(FocusApp app) async {
    final AppState store = context.read<AppState>();
    final NavigatorState navigator = Navigator.of(context);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

    final Challenge challenge = await store.beginChallenge();
    if (!mounted || challenge.text.isEmpty) {
      return;
    }
    await navigator.push<void>(
      MaterialPageRoute<void>(
        builder: (_) => ChallengeScreen(
          challenge: challenge,
          onFinished: (typed) async {
            final ok = await store.unblockAppWithChallenge(app, challenge, typed);
            navigator.pop();
            messenger
              ..hideCurrentSnackBar()
              ..showSnackBar(SnackBar(
                content: Text(ok
                    ? 'انفتح التطبيق — أصبح مسموحاً.'
                    : 'التحدي غير مكتمل — التطبيق ما يزال محجوباً.'),
              ));
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = context.watch<AppState>();

    final List<FocusApp> visible = state.installedApps
        .where((FocusApp app) =>
            _query.isEmpty ||
            app.name.toLowerCase().contains(_query.toLowerCase()) ||
            app.packageName.toLowerCase().contains(_query.toLowerCase()))
        .toList();

    return Scaffold(
      appBar: AppBar(title: const Text('حجب التطبيقات')),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              onChanged: (value) => setState(() => _query = value),
              decoration: const InputDecoration(
                hintText: 'ابحث عن تطبيق...',
                hintStyle: TextStyle(color: kMuted),
                prefixIcon: Icon(Icons.search, color: kMuted),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              !state.deviceOwner
                  ? 'ملاحظة: لا تملك صلاحيات مالك الجهاز، لذلك سيُستخدم حجب VPN أو إمكانية الوصول.'
                  : 'مالك الجهاز مفعّل — الحجب المباشر متاح.',
              style: const TextStyle(color: kMuted, fontSize: 12),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator(color: kAccent))
                : visible.isEmpty
                    ? const Center(
                        child: Text('لا توجد تطبيقات.', style: TextStyle(color: kMuted)),
                      )
                    : RefreshIndicator(
                        onRefresh: _load,
                        child: ListView.builder(
                          padding: const EdgeInsets.all(16),
                          itemCount: visible.length,
                          itemBuilder: (context, index) {
                            final FocusApp app = visible[index];
                            final bool blocked = state.isAppBlocked(app.packageName);
                            return Card(
                              margin: const EdgeInsets.only(bottom: 8),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                child: Row(
                                  children: <Widget>[
                                    _AppIcon(
                                      name: app.name,
                                      bytes: app.icon,
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: <Widget>[
                                          Text(
                                            app.name,
                                            style: const TextStyle(color: kText, fontSize: 16),
                                          ),
                                          Text(
                                            app.packageName,
                                            style: const TextStyle(color: kMuted, fontSize: 12),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Switch(
                                      value: blocked,
                                      onChanged: (value) =>
                                          value ? _block(app) : _unblock(app),
                                    ),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                      ),
          ),
        ],
      ),
    );
  }
}

class _AppIcon extends StatelessWidget {
  const _AppIcon({required this.name, this.bytes});

  final String name;
  final dynamic bytes;

  @override
  Widget build(BuildContext context) {
    Widget icon;
    if (bytes is Uint8List && bytes.isNotEmpty) {
      icon = ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Image.memory(
          bytes as Uint8List,
          width: 40,
          height: 40,
          errorBuilder: (_, _, _) => _fallback(),
        ),
      );
    } else {
      icon = _fallback();
    }
    return icon;
  }

  Widget _fallback() {
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: kSurface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Center(
        child: Text(
          name.isEmpty ? '؟' : name.characters.first,
          style: const TextStyle(color: kAccent, fontWeight: FontWeight.bold),
        ),
      ),
    );
  }
}