/// Shared visual tokens for the companion app, matching the in-app challenge
/// screen and the desktop's dark violet palette.
library;

import 'package:flutter/material.dart';

const Color kBackground = Color(0xFF0b0b12);
const Color kSurface = Color(0xFF15151f);
const Color kSurfaceHigh = Color(0xFF1c1c2a);
const Color kText = Color(0xFFf2f2f7);
const Color kMuted = Color(0xFF8b8ba0);
const Color kBorder = Color(0xFF2a2a3a);
const Color kAccent = Color(0xFF7c5cff);
const Color kAccent2 = Color(0xFF4f46e5);
const Color kSuccess = Color(0xFF3ddc84);
const Color kWarning = Color(0xFFf5a623);
const Color kError = Color(0xFFff5252);

/// Accent gradient used for the hero status card and primary CTAs.
const LinearGradient kGradient = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: <Color>[kAccent, kAccent2],
);

/// Muted gradient surface for secondary panels.
const LinearGradient kSurfaceGradient = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: <Color>[Color(0xFF1a1a28), Color(0xFF131320)],
);

ThemeData buildTheme() {
  final ColorScheme scheme = ColorScheme.dark(
    surface: kBackground,
    primary: kAccent,
    secondary: kAccent2,
    tertiary: kSuccess,
    error: kError,
    outline: kBorder,
    outlineVariant: const Color(0xFF232334),
    surfaceContainerHigh: kSurface,
    surfaceContainerHighest: kSurfaceHigh,
    onSurface: kText,
    onPrimary: Colors.white,
    onSecondary: Colors.white,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: kBackground,
    textTheme: const TextTheme(
      titleLarge: TextStyle(color: kText, fontSize: 24, fontWeight: FontWeight.w700, height: 1.2),
      titleMedium: TextStyle(color: kText, fontSize: 17, fontWeight: FontWeight.w600, height: 1.25),
      bodyMedium: TextStyle(color: kText, fontSize: 15),
      bodySmall: TextStyle(color: kMuted, fontSize: 13),
      labelLarge: TextStyle(color: kText, fontSize: 15, fontWeight: FontWeight.w600),
    ),
    cardTheme: CardThemeData(
      color: kSurface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: kBorder.withValues(alpha: 0.8)),
      ),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: kBackground.withValues(alpha: 0.92),
      elevation: 0,
      centerTitle: true,
      scrolledUnderElevation: 0,
      titleTextStyle: const TextStyle(
        color: kText,
        fontSize: 20,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.2,
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: kSurfaceHigh.withValues(alpha: 0.85),
      elevation: 0,
      indicatorColor: kAccent.withValues(alpha: 0.18),
      overlayColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.pressed) ? kAccent.withValues(alpha: 0.12) : null,
      ),
      height: 68,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => TextStyle(
          fontSize: 12,
          fontWeight: states.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w500,
          color: states.contains(WidgetState.selected) ? kAccent : kMuted,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          color: states.contains(WidgetState.selected) ? kAccent : kMuted,
          size: 24,
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
      trackOutlineColor: WidgetStateProperty.resolveWith((_) => Colors.transparent),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        side: const BorderSide(color: kBorder),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kSurface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: kBorder),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: kAccent, width: 1.5),
      ),
    ),
    dividerTheme: const DividerThemeData(color: kBorder, thickness: 1),
  );
}