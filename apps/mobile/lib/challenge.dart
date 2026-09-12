import 'dart:math';

import 'package:uuid/uuid.dart';

import 'words.dart';

class DifficultyConfig {
  const DifficultyConfig({
    required this.minWords,
    required this.maxWords,
    required this.minutes,
  });

  final int minWords;
  final int maxWords;
  final int minutes;
}

const Map<int, DifficultyConfig> difficultyConfig = <int, DifficultyConfig>{
  1: DifficultyConfig(minWords: 30, maxWords: 60, minutes: 5),
  2: DifficultyConfig(minWords: 60, maxWords: 120, minutes: 10),
  3: DifficultyConfig(minWords: 120, maxWords: 250, minutes: 20),
  4: DifficultyConfig(minWords: 250, maxWords: 400, minutes: 30),
  5: DifficultyConfig(minWords: 400, maxWords: 700, minutes: 60),
};

class Challenge {
  const Challenge({
    required this.id,
    required this.text,
    required this.wordCount,
    required this.createdAt,
    required this.expiresAt,
    required this.difficulty,
  });

  factory Challenge.generate(int difficulty) {
    final DifficultyConfig? config = difficultyConfig[difficulty];
    if (config == null) {
      throw RangeError(
        'Invalid difficulty: $difficulty. Expected a value between 1 and 5.',
      );
    }

    final Random random = Random.secure();
    final int wordCount =
        config.minWords + random.nextInt(config.maxWords - config.minWords + 1);

    final List<String> selectedWords = List<String>.generate(
      wordCount,
      (_) => words[random.nextInt(words.length)],
    );

    final DateTime createdAt = DateTime.now();
    final DateTime expiresAt = createdAt.add(Duration(minutes: config.minutes));

    return Challenge(
      id: const Uuid().v4(),
      text: selectedWords.join(' '),
      wordCount: wordCount,
      createdAt: createdAt,
      expiresAt: expiresAt,
      difficulty: difficulty,
    );
  }

  final String id;
  final String text;
  final int wordCount;
  final DateTime createdAt;
  final DateTime expiresAt;
  final int difficulty;

  int minutes() => difficultyConfig[difficulty]?.minutes ?? 0;

  int diffIndex(String typed) {
    final int maxLength = min(typed.length, text.length);
    for (int i = 0; i < maxLength; i++) {
      if (typed[i] != text[i]) {
        return i;
      }
    }
    if (typed.length == text.length) {
      return -1;
    }
    return typed.length > text.length ? text.length : typed.length;
  }

  bool isComplete(String typed) => typed == text;

  double progress(String typed) {
    if (text.isEmpty) {
      return 1;
    }
    final int firstError = diffIndex(typed);
    return firstError == -1 ? 1 : firstError / text.length;
  }
}