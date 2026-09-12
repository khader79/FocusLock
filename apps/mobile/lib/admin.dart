import 'package:flutter/services.dart';

/// Bridge to the Android device-admin layer ('focuslock/admin' MethodChannel).
///
/// How to become a Device Owner so these methods actually work:
///
///   1. Build & install the app on the device.
///   2. From the host machine's terminal run:
///
///        adb shell dpm set-device-owner com.example.focuslock/.AdminReceiver
///
///   3. The manifest declares android:testOnly=true, so existing accounts on
///      the device do not block provisioning. Only one Device Owner can exist
///      per device; remove it with:
///
///        adb shell dpm remove-active-admin com.example.focuslock/.AdminReceiver
///
/// When the app is NOT the Device Owner, calls throw a PlatformException with
/// code NOT_DEVICE_OWNER.
class Admin {
  Admin._();

  static const MethodChannel _channel = MethodChannel('focuslock/admin');

  /// Whether this app is the current Device Owner on the device.
  static Future<bool> isDeviceOwner() async {
    return await _channel.invokeMethod<bool>('isDeviceOwner') ?? false;
  }

  /// Blocks (true) or unblocks (false) uninstallation of this app.
  static Future<void> setUninstallBlocked(bool blocked) async {
    await _channel.invokeMethod<void>(
      'setUninstallBlocked',
      <String, dynamic>{'blocked': blocked},
    );
  }

  /// Locks the screen immediately (as if the power button was pressed).
  static Future<void> lockNow() async {
    await _channel.invokeMethod<void>('lockNow');
  }
}