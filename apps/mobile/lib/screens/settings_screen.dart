/// Settings: Supabase sync (push/pull/realtime), device-owner status, and
/// setup guidance for the VPN + foreground service.
library;

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../state/app_state.dart';
import '../theme.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final FlutterSecureStorage _secure = const FlutterSecureStorage();

  final TextEditingController _url = TextEditingController();
  final TextEditingController _anon = TextEditingController();
  final TextEditingController _row = TextEditingController();
  final TextEditingController _secret = TextEditingController();

  bool _saving = false;
  bool _pushing = false;
  bool _guarding = false;
  String? _status;

  @override
  void initState() {
    super.initState();
    _loadStoredConfig();
  }

  Future<void> _loadStoredConfig() async {
    final prefs = await SharedPreferences.getInstance();
    final url = prefs.getString('sync_url') ?? '';
    final anon = prefs.getString('sync_anon') ?? '';
    final row = prefs.getString('sync_row') ?? '';
    final secret = await _secure.read(key: 'sync_secret') ?? '';
    _url.text = url;
    _anon.text = anon;
    _row.text = row;
    _secret.text = secret;
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final AppState state = context.read<AppState>();
    final bool ok = await state.saveSyncConfig(
      url: _url.text.trim(),
      anonKey: _anon.text.trim(),
      rowId: _row.text.trim(),
      secret: _secret.text.trim(),
    );
    if (!mounted) return;
    setState(() {
      _saving = false;
      _status = ok ? 'تم الحفظ. الانتظار للمزامنة مباشرة.' : 'تحقق من الحقول الفارغة.';
    });
  }

  Future<void> _push() async {
    setState(() => _pushing = true);
    final AppState state = context.read<AppState>();
    final saved = await state.pushSync();
    if (!mounted) return;
    setState(() {
      _pushing = false;
      _status = saved != null ? 'تم دفع الحالة إلى السحابة.' : 'فشل الدفع.';
    });
  }

  /// Arms the one-way strict mode after an explicit confirmation.
  Future<void> _activateGuard() async {
    final AppState state = context.read<AppState>();
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('تفعيل الوضع الصارم؟'),
        content: const Text(
          'هذا الإجراء نهائي ولا يمكن إلغاؤه من هذا الجهاز.\n\n'
          'بعد التفعيل:\n'
          '• لا يمكن إلغاء تثبيت FocusLock\n'
          '• لا يمكن إيقاف الحجب أو أخذ استراحة\n'
          '• منع الإباحية مفعّل بشكل دائم (حجب DNS + HTTPS/SNI)\n'
          '• إذا تعطّل الـ VPN يُقطع الإنترنت كله (Lockdown)\n\n'
          'الفك الوحيد من الجهاز غير موجود؛ الفك عبر إعادة ضبط المصنع '
          'أو بأمر adb من حاسوبك.\n\n'
          'هل أنت متأكد؟',
          textAlign: TextAlign.right,
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('تراجع'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: kError),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('تفعيل نهائياً'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _guarding = true);
    final Map<Object?, Object?> flags = await state.enableGuard();
    if (!mounted) return;
    setState(() => _guarding = false);

    final bool uninstall = flags['uninstallBlocked'] as bool? ?? false;
    final bool lockdown = flags['lockdownVpn'] as bool? ?? false;
    final String message = state.guard
        ? 'الوضع الصارم مفعّل. منع الحذف: ${uninstall ? 'مفعّل' : 'يحتاج Device Owner'}، '
            'قفل الـ VPN: ${lockdown ? 'مفعّل' : 'يحتاج إذن VPN + Device Owner'}.'
        : 'تعذّر التفعيل. تأكد من أنك مالك الجهاز (Device Owner).';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  @override
  void dispose() {
    _url.dispose();
    _anon.dispose();
    _row.dispose();
    _secret.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppState state = context.watch<AppState>();

    return Scaffold(
      appBar: AppBar(title: const Text('الإعدادات')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          _GuardCard(
            guarded: state.guard,
            deviceOwner: state.deviceOwner,
            busy: _guarding,
            onActivate: _activateGuard,
          ),
          const SizedBox(height: 24),
          const Text('مزامنة سطح المكتب', style: TextStyle(color: kText, fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 6),
          const Text(
            'شارك حالة الحماية (نشطة/موقوفة، الإحصائيات) عبر Supabase مع تطبيق سطح المكتب.'
            ' الحمولة مشفرة AES-256-GCM بمفتاح مشترك.',
            style: TextStyle(color: kMuted, fontSize: 13),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _url,
            decoration: const InputDecoration(
              labelText: 'Supabase URL',
              hintText: 'https://xyz.supabase.co',
              hintStyle: TextStyle(color: kMuted),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _anon,
            decoration: const InputDecoration(labelText: 'الأنون كي'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _row,
            decoration: const InputDecoration(
              labelText: 'معرف الصف (id)',
              hintText: 'device-1',
              hintStyle: TextStyle(color: kMuted),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _secret,
            obscureText: true,
            decoration: const InputDecoration(labelText: 'كلمة المزامنة المشتركة'),
          ),
          const SizedBox(height: 16),
          Row(
            children: <Widget>[
              Expanded(
                child: FilledButton(
                  onPressed: _saving ? null : _save,
                  style: FilledButton.styleFrom(backgroundColor: kAccent),
                  child: _saving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('حفظ المزامنة'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: state.sync.configured && !_pushing ? _push : null,
                  icon: const Icon(Icons.upload),
                  label: const Text('دفع الآن'),
                ),
              ),
            ],
          ),
          if (_status != null) ...<Widget>[
            const SizedBox(height: 12),
            Text(
              _status!,
              style: const TextStyle(color: kAccent, fontSize: 13),
            ),
          ],
          const SizedBox(height: 24),
          const Divider(color: kBorder),
          const SizedBox(height: 8),
          const Text('الإعداد', style: TextStyle(color: kText, fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: <Widget>[
                  Icon(
                    state.deviceOwner ? Icons.verified_user : Icons.warning_amber_outlined,
                    color: state.deviceOwner ? kSuccess : kError,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      state.deviceOwner
                          ? 'أنت مالك الجهاز (Device Owner) — حجب التطبيقات المباشر متاح.'
                          : 'سجّل مالك الجهاز عبر adb لتفعيل الحجب المباشر: '
'adb shell dpm set-device-owner com.example.focuslock/.DeviceAdminBlocker',
                      style: const TextStyle(color: kMuted, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Text('الخدمة والخلفية', style: TextStyle(color: kText, fontSize: 15)),
                  const SizedBox(height: 6),
                  const Text(
                    'عند بدء الجلسة يُشغَّل FocusLockService (خدمة أمامية مع إشعار دائم) ويقوم حجب VPN'
                    ' بتصفية DNS. الإيقاف المؤقت مقفل بتحدي كتابة.',
                    style: TextStyle(color: kMuted, fontSize: 13),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Strict-mode (الوضع الصارم) activation card. One-way: once armed there is
/// no local disable path, matching the "cannot uninstall / cannot unblock"
/// requirement.
class _GuardCard extends StatelessWidget {
  const _GuardCard({
    required this.guarded,
    required this.deviceOwner,
    required this.busy,
    required this.onActivate,
  });

  final bool guarded;
  final bool deviceOwner;
  final bool busy;
  final VoidCallback onActivate;

  @override
  Widget build(BuildContext context) {
    if (guarded) {
      return Card(
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: kError),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  const Icon(Icons.gpp_bad, color: kError),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Text(
                      'الوضع الصارم مفعّل',
                      style: TextStyle(color: kError, fontSize: 17, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              const Text(
                'منع المحتوى الإباحي مفعّل بشكل دائم ولا يمكن إيقافه من هذا الجهاز:\n'
                '• حجب النطاقات الإباحية (DNS)\n'
                '• حجب HTTPS عبر فحص SNI\n'
                '• لا إيقاف مؤقت ولا إنهاء للجلسة\n'
                '• منع إلغاء التثبيت + VPN بقفل كامل (Lockdown)\n\n'
                'الفك الوحيد: إعادة ضبط المصنع أو adb من حاسوبك.',
                style: TextStyle(color: kMuted, fontSize: 13),
              ),
            ],
          ),
        ),
      );
    }

    final bool canArm = deviceOwner && !busy;
    return Card(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: kBorder),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(!deviceOwner ? Icons.warning_amber_outlined : Icons.gpp_maybe, color: !deviceOwner ? kError : kAccent),
                const SizedBox(width: 12),
                const Expanded(
                  child: Text(
                    'الوضع الصارم',
                    style: TextStyle(color: kText, fontSize: 17, fontWeight: FontWeight.bold),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            const Text(
              'حماية نهائية غير قابلة للإلغاء من الجهاز: منع الإباحية (DNS + SNI)، منع إلغاء التثبيت،'
              ' وقفل الـ VPN كله. بمجرد التفعيل لا يمكن إيقافها محلياً.',
              style: TextStyle(color: kMuted, fontSize: 13),
            ),
            const SizedBox(height: 12),
            if (!deviceOwner) ...<Widget>[
              const Text(
                'المطلوب: صيّر التطبيق مالك الجهاز أولاً عبر adb:\n'
                'adb shell dpm set-device-owner com.example.focuslock/.DeviceAdminBlocker',
                style: TextStyle(color: kError, fontSize: 13),
              ),
              const SizedBox(height: 12),
            ],
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: canArm ? onActivate : null,
                style: FilledButton.styleFrom(backgroundColor: kError),
                icon: busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.lock_outline),
                label: Text(busy ? 'جارٍ التفعيل...' : 'تفعيل الوضع الصارم نهائياً'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}