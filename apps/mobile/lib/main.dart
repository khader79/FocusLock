/// FocusLock companion app: RTL dark UI that matches the desktop's
/// challenge-gated focus protection, wired to the native Android services.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'challenge.dart';
import 'challenge_screen.dart';
import 'screens/home_shell.dart';
import 'services/protection_bridge.dart';
import 'state/app_state.dart';
import 'theme.dart';

const Color _background = Color(0xFF0b0b0f);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runZonedGuarded(
    () => runApp(const FocusLockApp()),
    (Object error, StackTrace stack) => debugPrint('FocusLock: $error\n$stack'),
  );
}

class FocusLockApp extends StatefulWidget {
  const FocusLockApp({super.key});

  @override
  State<FocusLockApp> createState() => _FocusLockAppState();
}

class _FocusLockAppState extends State<FocusLockApp> {
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  late final AppState _appState;

  @override
  void initState() {
    super.initState();
    _appState = AppState();
    _appState.init().then((_) => _handleLaunchAction());
  }

  @override
  void dispose() {
    _appState.dispose();
    super.dispose();
  }

  /// Builds + verifies a challenge and applies the native toggle.
  Future<void> _openChallengeFlow() async {
    final Challenge challenge = await _appState.beginToggle();
    if (!mounted) {
      return;
    }
    final NavigatorState navigator = _navigatorKey.currentState!;
    await navigator.push<void>(
      MaterialPageRoute<void>(
        builder: (_) => ChallengeScreen(
          challenge: challenge,
          onFinished: (typed) async {
            await _appState.finishToggle(challenge, typed);
            navigator.pop();
            _appState.refresh();
          },
        ),
      ),
    );
  }

  /// If the app was relaunched from the persistent notification tap, open the
  /// challenge flow straight away.
  Future<void> _handleLaunchAction() async {
    final String? action = await LaunchBridge.consumeLaunchAction();
    if (action == 'pause' && mounted) {
      await _openChallengeFlow();
    }
  }

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<AppState>.value(
      value: _appState,
      child: MaterialApp(
        title: 'FocusLock',
        debugShowCheckedModeBanner: false,
        navigatorKey: _navigatorKey,
        theme: buildTheme(),
        // Force right-to-left layout across all routes regardless of the
        // device locale so the Arabic UI mirrors the desktop design.
        builder: (context, child) => Directionality(
          textDirection: TextDirection.rtl,
          child: child ?? const SizedBox.shrink(),
        ),
        home: HomeShell(onPauseRequested: _openChallengeFlow),
        themeMode: ThemeMode.dark,
        darkTheme: buildTheme(),
        color: _background,
      ),
    );
  }
}