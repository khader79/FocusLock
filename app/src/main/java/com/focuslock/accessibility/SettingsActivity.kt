package com.focuslock.accessibility

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.preference.Preference
import androidx.preference.PreferenceFragmentCompat

/**
 * Plain preferences screen. It reports state and links to system settings when
 * the user wants to change something — it never edits a system setting itself
 * and never blocks the user from leaving.
 */
class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        supportFragmentManager.beginTransaction()
            .replace(android.R.id.content, SettingsFragment())
            .commit()
    }

    class SettingsFragment : PreferenceFragmentCompat() {

        override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
            setPreferencesFromResource(R.xml.preferences, rootKey)

            findPreference<Preference>("open_dns_settings")?.setOnPreferenceClickListener {
                startActivity(
                    Intent("android.settings.PRIVATE_DNS_SETTINGS")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                true
            }

            findPreference<Preference>("view_blocked_log")?.setOnPreferenceClickListener {
                startActivity(Intent(context, BlockedLogActivity::class.java))
                true
            }

            findPreference<Preference>("blocked_apps")?.setOnPreferenceClickListener {
                startActivity(Intent(context, BlockedAppsActivity::class.java))
                true
            }
        }
    }
}