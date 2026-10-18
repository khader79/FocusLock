package com.focuslock.accessibility

import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * First-run flow: the user controls everything BEFORE protection starts.
 * Step 1 disclosure -> Step 2 blocked apps -> Step 3 DNS + enable -> ready.
 */
class SetupWizardActivity : AppCompatActivity() {

    private var step = 1
    private lateinit var step1: LinearLayout
    private lateinit var step2: LinearLayout
    private lateinit var step3: LinearLayout
    private lateinit var dots: TextView
    private lateinit var backBtn: Button
    private lateinit var nextBtn: Button
    private lateinit var blockedCount: TextView

    private fun prefs(): SharedPreferences =
        getSharedPreferences("focuslock_prefs", MODE_PRIVATE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup_wizard)

        step1 = findViewById(R.id.wizardStep1)
        step2 = findViewById(R.id.wizardStep2)
        step3 = findViewById(R.id.wizardStep3)
        dots = findViewById(R.id.wizardDots)
        backBtn = findViewById(R.id.wizardBack)
        nextBtn = findViewById(R.id.wizardNext)
        blockedCount = findViewById(R.id.wizardBlockedCount)

        findViewById<TextView>(R.id.wizardDisclosureText).text = getString(R.string.disclosure_text)

        findViewById<Button>(R.id.wizardChooseApps).setOnClickListener {
            startActivity(Intent(this, BlockedAppsActivity::class.java))
        }
        findViewById<Button>(R.id.wizardOpenDns).setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                startActivity(Intent("android.settings.PRIVATE_DNS_SETTINGS"))
            }
        }
        findViewById<Button>(R.id.wizardEnable).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        backBtn.setOnClickListener { if (step > 1) showStep(step - 1) }
        nextBtn.setOnClickListener {
            if (step == 1) {
                prefs().edit().putBoolean("disclosure_accepted", true).apply()
                showStep(2)
            } else if (step == 2) {
                showStep(3)
            } else {
                prefs().edit().putBoolean("setup_done", true).apply()
                startActivity(Intent(this, SettingsActivity::class.java))
                finish()
            }
        }
        showStep(1)
    }

    override fun onResume() {
        super.onResume()
        updateBlockedCount()
    }

    private fun updateBlockedCount() {
        val n = prefs().getStringSet("blocked_apps", setOf("com.twitter.android"))?.size ?: 1
        blockedCount.text = getString(R.string.blocked_count, n)
    }

    private fun showStep(s: Int) {
        step = s
        step1.visibility = if (s == 1) View.VISIBLE else View.GONE
        step2.visibility = if (s == 2) View.VISIBLE else View.GONE
        step3.visibility = if (s == 3) View.VISIBLE else View.GONE
        dots.text = when (s) {
            1 -> "● ○ ○"
            2 -> "○ ● ○"
            else -> "○ ○ ●"
        }
        backBtn.visibility = if (s == 1) View.INVISIBLE else View.VISIBLE
        nextBtn.text = when (s) {
            1 -> getString(R.string.accept_continue)
            2 -> getString(R.string.wizard_next)
            else -> getString(R.string.finish_setup)
        }
        if (s == 2) updateBlockedCount()
    }
}
