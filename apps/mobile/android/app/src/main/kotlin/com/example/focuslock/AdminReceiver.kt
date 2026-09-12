package com.example.focuslock

import android.app.admin.DeviceAdminReceiver

/**
 * Device admin entry point used to become Device Owner.
 *
 * How to make FocusLock a Device Owner (needed for lockNow() and
 * setUninstallBlocked()) over USB:
 *
 *   1. Build & install the app on the target device (a test/debug build is
 *      fine; the manifest declares android:testOnly=true so accounts on the
 *      device do not block this).
 *   2. From the host machine's terminal run:
 *
 *        adb shell dpm set-device-owner com.example.focuslock/.AdminReceiver
 *
 *   3. Re-launch the app: isDeviceOwner() now returns true.
 *
 * Common failures:
 *  - "has existing accounts" -> install the testOnly build (already declared)
 *    or reset the device before provisioning.
 *  - "already set" -> run
 *        adb shell dpm remove-active-admin com.example.focuslock/.AdminReceiver
 *    or factory-reset the device.
 *  - Only ONE Device Owner can exist per device.
 */
class AdminReceiver : DeviceAdminReceiver()