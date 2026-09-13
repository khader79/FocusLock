/// Shared visual tokens for the companion app, matching the in-app challenge
/// screen and the desktop's dark violet palette.
library;

import 'package:flutter/material.dart';

const Color kBackground = Color(0xFF0b0b0f);
const Color kSurface = Color(0xFF14141c);
const Color kText = Color(0xFFeeeeee);
const Color kMuted = Color(0xFF6f6f7a);
const Color kBorder = Color(0xFF2a2a33);
const Color kAccent = Color(0xFF7c5cff);
const Color kSuccess = Color(0xFF3ddc84);
const Color kError = Color(0xFFFF5252);

ThemeData buildTheme() {
  final ColorScheme scheme = ColorScheme.dark(
    surface: kBackground,
    primary: kAccent,
    secondary: kAccent,
    error: kError,
    onSurface: kText,
    onPrimary: Colors.white,
    onSecondary: Colors.white,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: kBackground,
    cardTheme: const CardThemeData(
      color: kSurface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(14)),
        side: BorderSide(color: kBorder),
      ),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: kBackground,
      elevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(color: kText, fontSize: 20, fontWeight: FontWeight.w600),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: kSurface,
      indicatorColor: kAccent,
      height: 64,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => TextStyle(
          fontSize: 12,
          color: states.contains(WidgetState.selected) ? kAccent : kMuted,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          color: states.contains(WidgetState.selected) ? kAccent : kMuted,
        ),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected) ? kAccent : kMuted,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? kAccent.withValues(alpha: 0.4)
            : kBorder,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kBackground,
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: kBorder),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: kAccent),
      ),
    ),
  );
}