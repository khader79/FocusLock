/// AES-256-GCM encryption for the shared-key sync payloads.
///
/// Byte-compatible with the Kotlin `SyncClient` on the Android side:
///  - key = SHA-256(shared passphrase)  (32 bytes, AES-256)
///  - plaintext = UTF-8 JSON
///  - output = base64(iv[12] || ciphertext)
///
/// The same key derivation + format lets the desktop app read these payloads.
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/export.dart';

const int _tagBits = 128;
const int _ivBytes = 12;

final Random _random = Random.secure();

Uint8List _iv() {
  return Uint8List.fromList(
    List<int>.generate(_ivBytes, (_) => _random.nextInt(256)),
  );
}

/// Derives the 32-byte AES key from the shared passphrase (SHA-256).
Uint8List deriveKey(String secret) {
  return crypto.sha256.convert(utf8.encode(secret)).bytes as Uint8List;
}

/// Encrypts [plaintext] with AES-256-GCM and returns base64(iv||ciphertext).
String encryptPayload(String secret, String plaintext) {
  final iv = _iv();
  final cipher = GCMBlockCipher(AESEngine())
    ..init(
      true,
      AEADParameters(KeyParameter(deriveKey(secret)), _tagBits, iv, Uint8List(0)),
    );
  final ciphertext = cipher.process(utf8.encode(plaintext));
  final boxed = Uint8List(iv.length + ciphertext.length);
  boxed.setRange(0, iv.length, iv);
  boxed.setRange(iv.length, boxed.length, ciphertext);
  return base64.encode(boxed);
}

/// Decrypts base64(iv||ciphertext); throws on wrong key or tampered payload.
String decryptPayload(String secret, String encoded) {
  final boxed = base64.decode(encoded);
  final iv = boxed.sublist(0, _ivBytes);
  final ciphertext = boxed.sublist(_ivBytes);
  final cipher = GCMBlockCipher(AESEngine())
    ..init(
      false,
      AEADParameters(KeyParameter(deriveKey(secret)), _tagBits, iv, Uint8List(0)),
    );
  final plaintext = cipher.process(ciphertext);
  return utf8.decode(plaintext);
}