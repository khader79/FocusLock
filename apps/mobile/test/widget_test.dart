import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:focuslock/challenge.dart';
import 'package:focuslock/challenge_screen.dart';

void main() {
  final Challenge challenge = Challenge(
    id: 'test-id',
    text: 'abandon ability',
    wordCount: 2,
    createdAt: DateTime.fromMillisecondsSinceEpoch(0),
    expiresAt: DateTime.fromMillisecondsSinceEpoch(60 * 60 * 1000),
    difficulty: 1,
  );

  testWidgets('shows success screen once the text is fully typed', (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ChallengeScreen(challenge: challenge),
      ),
    );

    expect(find.text('انفتح'), findsNothing);

    await tester.enterText(find.byType(TextField), 'abandon');
    await tester.pump();
    expect(find.text('انفتح'), findsNothing);

    await tester.enterText(find.byType(TextField), 'abandon ability');
    await tester.pump();
    expect(find.text('انفتح'), findsOneWidget);
    expect(find.byType(RichText), findsWidgets);
  });
}