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

  @override
  Widget build(BuildContext context) {
    final List<Widget> pages = <Widget>[
      DashboardScreen(onPauseRequested: widget.onPauseRequested),
      const WebsitesScreen(),
      const AppsScreen(),
      const CategoriesScreen(),
      const SettingsScreen(),
    ];

    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
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