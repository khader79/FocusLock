/// Manage custom blocked sites. Additions flow through the native rules
/// channel so the VPN blocklist merges them with its own matcher.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';

class WebsitesScreen extends StatefulWidget {
  const WebsitesScreen({super.key});

  @override
  State<WebsitesScreen> createState() => _WebsitesScreenState();
}

class _WebsitesScreenState extends State<WebsitesScreen> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _add() async {
    final String site = _controller.text.trim().toLowerCase();
    final AppState state = context.read<AppState>();
    if (site.isEmpty) {
      return;
    }
    await state.addSite(site);
    _controller.clear();
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = context.watch<AppState>();

    return Scaffold(
      appBar: AppBar(title: const Text('المواقع المحجوبة')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: TextField(
                  controller: _controller,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _add(),
                  decoration: const InputDecoration(
                    hintText: 'مثال: youtube.com',
                    hintStyle: TextStyle(color: kMuted),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                onPressed: _add,
                icon: const Icon(Icons.add),
                color: Colors.white,
                style: IconButton.styleFrom(backgroundColor: kAccent),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            '${state.sites.length} موقع مخصص',
            style: const TextStyle(color: kMuted, fontSize: 13),
          ),
          const SizedBox(height: 8),
          if (state.sites.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text('لا مواقع مخصصة بعد.', style: TextStyle(color: kMuted)),
              ),
            )
          else
            ...state.sites.map((String site) {
              return Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: Row(
                    children: <Widget>[
                      const Icon(Icons.language, color: kAccent, size: 20),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(site, style: const TextStyle(color: kText, fontSize: 16)),
                      ),
                      IconButton(
                        onPressed: () => context.read<AppState>().removeSite(site),
                        icon: const Icon(Icons.close, color: kMuted),
                      ),
                    ],
                  ),
                ),
              );
            }),
        ],
      ),
    );
  }
}