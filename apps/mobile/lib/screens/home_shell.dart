/// RTL bottom-nav shell hosting the five companion screens.
library;

import 'package:flutter/material.dart';

import 'apps_screen.dart';
import 'categories_screen.dart';
import 'dashboard_screen.dart';
import 'settings_screen.dart';
import 'websites_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.onPauseRequested});

  /// Lets the dashboard trigger the challenge-gated pause flow.
  final Future<void> Function() onPauseRequested;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  final List<Widget?> _pages = List<Widget?>.filled(5, null);

  Widget _page(int index) {
    // Build each tab lazily on first visit so startup stays light (notably the
    // apps tab, which lists every installed app over the platform channel).
    return _pages[index] ??= switch (index) {
      0 => DashboardScreen(onPauseRequested: widget.onPauseRequested),
      1 => const WebsitesScreen(),
      2 => const AppsScreen(),
      3 => const CategoriesScreen(),
      4 => SettingsScreen(onBack: () => setState(() => _index = 0)),
      _ => const SizedBox.shrink(),
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: List<Widget>.generate(5, _page),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (index) => setState(() => _index = index),
        destinations: const <NavigationDestination>[
          NavigationDestination(
            icon: Icon(Icons.speed_outlined),
            selectedIcon: Icon(Icons.speed),
            label: 'الرئيسية',
          ),
          NavigationDestination(
            icon: Icon(Icons.public_outlined),
            selectedIcon: Icon(Icons.public),
            label: 'المواقع',
          ),
          NavigationDestination(
            icon: Icon(Icons.apps_outlined),
            selectedIcon: Icon(Icons.apps),
            label: 'التطبيقات',
          ),
          NavigationDestination(
            icon: Icon(Icons.category_outlined),
            selectedIcon: Icon(Icons.category),
            label: 'الفئات',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'الإعدادات',
          ),
        ],
      ),
    );
  }
}