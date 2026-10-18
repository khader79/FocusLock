/// Manage block categories: built-ins can be toggled, custom ones
/// added/removed. Patterns flow to the native rule store and the VPN matcher.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../theme.dart';

class CategoriesScreen extends StatefulWidget {
  const CategoriesScreen({super.key});

  @override
  State<CategoriesScreen> createState() => _CategoriesScreenState();
}

class _CategoriesScreenState extends State<CategoriesScreen> {
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _patternController = TextEditingController();

  @override
  void dispose() {
    _nameController.dispose();
    _patternController.dispose();
    super.dispose();
  }

  Future<void> _add() async {
    final String name = _nameController.text.trim();
    final String pattern = _patternController.text.trim().toLowerCase();
    if (name.isEmpty || pattern.isEmpty) {
      return;
    }
    await context.read<AppState>().addCategory(name, pattern);
    if (mounted) {
      _nameController.clear();
      _patternController.clear();
      Navigator.of(context).pop();
    }
  }

  void _showAddSheet() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Theme.of(context).colorScheme.surface,
      isScrollControlled: true,
      builder: (context) {
        return Padding(
          padding: EdgeInsets.only(
            left: 16,
            right: 16,
            top: 16,
            bottom: MediaQuery.of(context).viewInsets.bottom + 16,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Text(
                'فئة جديدة',
                style: TextStyle(color: kText, fontSize: 18, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _nameController,
                decoration: const InputDecoration(
                  hintText: 'اسم الفئة',
                  hintStyle: TextStyle(color: kMuted),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _patternController,
                decoration: const InputDecoration(
                  hintText: 'النمط: مثال reddit.com',
                  hintStyle: TextStyle(color: kMuted),
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _add,
                  style: FilledButton.styleFrom(backgroundColor: kAccent),
                  child: const Text('إضافة'),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = context.watch<AppState>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('الفئات'),
        actions: <Widget>[
          IconButton(
            onPressed: _showAddSheet,
            icon: const Icon(Icons.add, color: kAccent),
          ),
        ],
      ),
      body: state.categories.isEmpty
          ? const Center(child: Text('لا فئات.', style: TextStyle(color: kMuted)))
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: state.categories.length,
              itemBuilder: (context, index) {
                final Category category = state.categories[index];
                return Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                    child: Row(
                      children: <Widget>[
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                category.name,
                                style: const TextStyle(color: kText, fontSize: 16),
                              ),
                              Text(
                                category.pattern,
                                style: const TextStyle(color: kMuted, fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                        if (category.custom)
                          IconButton(
                            onPressed: () => state.removeCategory(category.id),
                            icon: const Icon(Icons.delete_outline, color: kMuted),
                          ),
                        Switch(
                          value: category.enabled,
                          onChanged: (_) => state.toggleCategory(category.id),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
    );
  }
}