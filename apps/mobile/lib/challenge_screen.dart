import 'package:flutter/material.dart';

import 'challenge.dart';

const Color _background = Color(0xFF0b0b0f);
const Color _text = Color(0xFFeeeeee);
const Color _muted = Color(0xFF6f6f7a);
const Color _correct = Color(0xFF3ddc84);
const Color _error = Color(0xFFFF5252);
const Color _border = Color(0xFF2a2a33);
const Color _accent = Color(0xFF7c5cff);

class ChallengeScreen extends StatefulWidget {
  const ChallengeScreen({super.key, required this.challenge, this.onFinished});

  final Challenge challenge;
  final VoidCallback? onFinished;

  @override
  State<ChallengeScreen> createState() => _ChallengeScreenState();
}

class _ChallengeScreenState extends State<ChallengeScreen> {
  String _typed = '';
  int _errorAt = 0;
  bool _unlocked = false;

  Challenge get _challenge => widget.challenge;

  void _handleChanged(String value) {
    setState(() {
      _typed = value;
      _errorAt = _challenge.diffIndex(value);
      _unlocked = _challenge.isComplete(value);
    });
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: _background,
        body: SafeArea(
          child: _unlocked ? _buildSuccess() : _buildChallenge(),
        ),
      ),
    );
  }

  Widget _buildChallenge() {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildTopBar(),
          const SizedBox(height: 16),
          Expanded(child: _buildColoredText()),
          const SizedBox(height: 16),
          TextField(
            onChanged: _handleChanged,
            maxLength: _challenge.text.length,
            enableInteractiveSelection: false,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: TextInputType.text,
            style: const TextStyle(color: _text, fontSize: 20),
            cursorColor: _accent,
            decoration: InputDecoration(
              filled: true,
              fillColor: _background,
              counterText: '',
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: _border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: _accent),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTopBar() {
    return Row(
      children: <Widget>[
        Text(
          'الإنجاز: ${(_challenge.progress(_typed) * 100).round()}%',
          style: const TextStyle(color: _muted, fontSize: 16),
        ),
        const Spacer(),
        Text(
          '${_typed.length}/${_challenge.text.length}',
          style: const TextStyle(color: _muted, fontSize: 16),
        ),
      ],
    );
  }

  Widget _buildColoredText() {
    final String target = _challenge.text;
    final List<TextSpan> spans = <TextSpan>[];

    for (int i = 0; i < target.length; i++) {
      Color color = _muted;

      if (_errorAt == -1 && i < _typed.length) {
        color = _correct;
      } else if (i < _errorAt) {
        color = _correct;
      } else if (i == _errorAt && _errorAt < target.length) {
        color = _error;
      }

      spans.add(TextSpan(text: target[i], style: TextStyle(color: color)));
    }

    return SingleChildScrollView(
      child: RichText(
        text: TextSpan(
          style: const TextStyle(
            color: _muted,
            fontSize: 24,
            height: 1.6,
            fontFamily: 'monospace',
          ),
          children: spans,
        ),
      ),
    );
  }

  Widget _buildSuccess() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const Text('✅', style: TextStyle(fontSize: 96)),
          const SizedBox(height: 16),
          const Text(
            'انفتح',
            style: TextStyle(color: _text, fontSize: 32, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          const Text(
            'أنهيت التحدي في الوقت المحدد. أنت حر الآن.',
            style: TextStyle(color: _muted, fontSize: 16),
          ),
          const SizedBox(height: 24),
          if (widget.onFinished != null)
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: _accent,
                padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 14),
              ),
              onPressed: widget.onFinished,
              child: const Text(
                'العودة للبداية',
                style: TextStyle(color: Colors.white, fontSize: 18),
              ),
            ),
        ],
      ),
    );
  }
}