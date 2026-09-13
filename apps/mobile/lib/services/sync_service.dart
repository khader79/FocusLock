/// Supabase sync for the desktop companion: pushes an encrypted snapshot of
/// the local state and mirrors real-time changes from other FocusLock devices
/// (including the desktop app) back into the local state.
///
/// Schema (create once in your Supabase project):
///
/// ```sql
/// create table public.focuslock_sync (
///   id         text primary key,
///   payload    text not null,      -- base64(iv||ciphertext), AES-256-GCM
///   updated_at timestamptz default now()
/// );
/// alter table public.focuslock_sync enable row level security;
/// -- optionally: grant  authenticated  to make tables readable by the anon key flow
/// ```
///
/// The payload is encrypted with a shared passphrase keyed by SHA-256 (see
/// `crypt.dart`), so both endpoints must be configured with the same secret.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models.dart';
import 'crypt.dart';

class SyncConfig {
  const SyncConfig({required this.url, required this.anonKey, required this.rowId});

  final String url;
  final String anonKey;
  final String rowId;

  bool get isValid => url.isNotEmpty && anonKey.isNotEmpty && rowId.isNotEmpty;

  String get restBase => '$url/rest/v1/focuslock_sync';

  /// Realtime websocket endpoint (http -> ws, https -> wss).
  String get websocketUrl {
    final scheme = url.startsWith('https://') ? 'wss://' : 'ws://';
    return '$scheme${url.split('://')[1]}/realtime/v1/websocket?vsn=1.0.0&apikey=$anonKey';
  }
}

/// Real-time + push/pull sync of the encrypted FocusLock state.
class SyncService {
  SyncService({this.config, this.sharedSecret = ''});

  SyncConfig? config;
  String sharedSecret;

  final StreamController<FocusState> _remoteController =
      StreamController<FocusState>.broadcast();

  /// Incoming (decrypted, applied) state from other devices.
  Stream<FocusState> get remoteState => _remoteController.stream;

  WebSocketChannel? _channel;
  Timer? _reconnect;
  int _ref = 0;

  bool get configured =>
      config != null && config!.isValid && sharedSecret.isNotEmpty;

  Future<void> dispose() async {
    _reconnect?.cancel();
    await _channel?.sink.close();
    await _remoteController.close();
  }

  // ---------------------------------------------------------------- push

  /// PATCHes the encrypted snapshot into the shared Supabase row.
  Future<bool> push(FocusState state) async {
    final cfg = config;
    if (cfg == null || sharedSecret.isEmpty) {
      return false;
    }
    final plaintext = jsonEncode(state.toSyncMap());
    final encrypted = encryptPayload(sharedSecret, plaintext);
    try {
      final response = await http.patch(
        Uri.parse('${cfg.restBase}?id=eq.${cfg.rowId}'),
        headers: <String, String>{
          'apikey': cfg.anonKey,
          'Authorization': 'Bearer ${cfg.anonKey}',
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: jsonEncode(<String, String>{'payload': encrypted}),
      );
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------- pull

  /// Fetches and decrypts the latest shared row once.
  Future<FocusState?> pull() async {
    final cfg = config;
    if (cfg == null || sharedSecret.isEmpty) {
      return null;
    }
    try {
      final response = await http.get(
        Uri.parse('${cfg.restBase}?id=eq.${cfg.rowId}&select=payload'),
        headers: <String, String>{
          'apikey': cfg.anonKey,
          'Authorization': 'Bearer ${cfg.anonKey}',
        },
      );
      if (response.statusCode != 200) {
        return null;
      }
      final list = jsonDecode(response.body) as List<dynamic>?;
      if (list == null || list.isEmpty) {
        return null;
      }
      final encrypted = (list.first as Map<String, dynamic>)['payload'] as String?;
      if (encrypted == null || encrypted.isEmpty) {
        return null;
      }
      return FocusState.fromMap(
        jsonDecode(decryptPayload(sharedSecret, encrypted)) as Map<String, dynamic>,
      );
    } catch (_) {
      return null;
    }
  }

  // ------------------------------------------------------------- realtime

  /// Connects to the Supabase Realtime socket and subscribes to updates of the
  /// shared row. Reconnects on drop until [stop] is called.
  void start() {
    final cfg = config;
    if (cfg == null || !configured || _channel != null) {
      return;
    }
    _connect(cfg);
  }

  void stop() {
    _reconnect?.cancel();
    _reconnect = null;
    _channel?.sink.close();
    _channel = null;
  }

  void _connect(SyncConfig cfg) {
    final channel = WebSocketChannel.connect(Uri.parse(cfg.websocketUrl));
    _channel = channel;
    _ref = 0;

    channel.stream.listen(
      (message) => _handleMessage(cfg, message),
      onDone: _scheduleReconnect,
      onError: (_) => _scheduleReconnect(),
    );

    // Send the postgres_changes join request over the fresh socket.
    subscribe(cfg);
  }

  void _scheduleReconnect() {
    if (_channel == null) {
      return;
    }
    _channel = null;
    _reconnect?.cancel();
    // Retry if we have config and the service wasn't stopped.
    _reconnect = Timer(const Duration(seconds: 5), () {
      final cfg = config;
      if (cfg != null && configured) {
        _connect(cfg);
      }
    });
  }

  void _handleMessage(SyncConfig cfg, dynamic raw) {
    try {
      _handleMessageUnsafe(raw);
    } catch (_) {
      // Malformed/unknown frame; ignore without killing the socket handler.
    }
  }

  void _handleMessageUnsafe(dynamic raw) {
    final data = (raw is String) ? jsonDecode(raw) as Map<String, dynamic> : raw;
    final event = data['event'] as String?;
    if (event == null) {
      return;
    }
    switch (event) {
      case 'phx_reply':
        final payload = data['payload'] as Map<String, dynamic>? ?? const {};
        if (payload.containsKey('response') && payload['response'] != null) {
          _handlePostgresRecord(payload['response'] as Map<String, dynamic>?);
        }
        break;

      case 'postgres_changes':
        final payload = data['payload'] as Map<String, dynamic>?;
        _handlePostgresRecord(payload);
        break;

      case 'system':
      case 'phx_error':
        if (event == 'phx_error') {
          _scheduleReconnect();
        }
        break;
    }
  }

  void _handlePostgresRecord(Map<String, dynamic>? payload) {
    if (payload == null) {
      return;
    }
    final record = payload['record'] as Map<String, dynamic>?;
    if (record == null) {
      return;
    }
    final encrypted = record['payload'] as String?;
    if (encrypted == null || encrypted.isEmpty) {
      return;
    }
    try {
      final state = FocusState.fromMap(
        jsonDecode(decryptPayload(sharedSecret, encrypted)) as Map<String, dynamic>,
      );
      _remoteController.add(state);
    } catch (_) {
      // Wrong key / tampered payload; ignore silently.
    }
  }

  /// Joins the `postgres_changes` subscription for the shared row. Called once
  /// the socket is open; wrapped in a small send helper.
  void subscribe(SyncConfig cfg) {
    _ref += 1;
    _channel?.sink.add(<String, Object>{
      'topic': 'realtime:public:focuslock_sync:asterisk',
      'event': 'phx_join',
      'payload': <String, Object>{
        'config': <String, Object>{
          'broadcast': <String, bool>{'ack': false},
          'presence': <String, String>{'key': ''},
          'postgres_changes': <Map<String, String>>[
            <String, String>{
              'event': '*',
              'schema': 'public',
              'table': 'focuslock_sync',
              'filter': 'id=eq.${cfg.rowId}',
            },
          ],
        },
      },
      'ref': '$_ref',
    });
  }
}