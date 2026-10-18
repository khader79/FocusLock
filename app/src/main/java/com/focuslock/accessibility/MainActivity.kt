package com.focuslock.accessibility

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Single screen, no surprises. It reports what is on, offers one obvious way
 * to turn things on, and never touches an OS setting on the user's behalf.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var searchStatus: TextView
    private lateinit var dnsStatus: TextView
    private lateinit var networkStatus: TextView
    private lateinit var todayCount: TextView
    private lateinit var streakCount: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun buildUi(): android.view.View {
        val d = resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(24))
            setBackgroundColor(Color.parseColor("#0F1115"))
        }

        root.addView(TextView(this).apply {
            text = getString(R.string.app_name)
            textSize = 28f
            setTextColor(Color.WHITE)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })

        root.addView(TextView(this).apply {
            text = getString(R.string.main_tagline)
            textSize = 13f
            setTextColor(Color.parseColor("#8A8F98"))
            setPadding(0, dp(4), 0, dp(24))
        })

        root.addView(card(dp(16)).apply {
            addView(header("Search guard"))
            searchStatus = statusLine()
            addView(searchStatus)
            addView(Button(this@MainActivity).apply {
                text = getString(R.string.main_open_accessibility)
                setOnClickListener {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
            })
        })

        root.addView(card(dp(16)).apply {
            addView(header(getString(R.string.main_dns_guard)))
            dnsStatus = statusLine()
            addView(dnsStatus)
            addView(Button(this@MainActivity).apply {
                text = getString(R.string.main_change_dns)
                setOnClickListener {
                    if (dnsGuardOn()) {
                        startActivity(Intent(this@MainActivity, UnlockActivity::class.java)
                            .putExtra(UnlockActivity.EXTRA_MODE, UnlockActivity.MODE_DNS))
                    } else {
                        startActivity(Intent("android.settings.PRIVATE_DNS_SETTINGS"))
                    }
                }
            })
        })

        root.addView(card(dp(16)).apply {
            addView(header(getString(R.string.main_today)))
            todayCount = bigNumber()
            addView(todayCount)
            addView(TextView(this@MainActivity).apply {
                text = getString(R.string.main_streak)
                setTextColor(Color.parseColor("#8A8F98"))
                setPadding(0, dp(16), 0, dp(2))
            })
            streakCount = bigNumber()
            addView(streakCount)
        })

        root.addView(Button(this).apply {
            text = getString(R.string.main_view_log)
            setOnClickListener { startActivity(Intent(this@MainActivity, BlockedLogActivity::class.java)) }
        })

        root.addView(Button(this).apply {
            text = getString(R.string.main_settings)
            setOnClickListener { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) }
        })

        val scroll = ScrollView(this)
        scroll.addView(root)
        return scroll
    }

    private fun card(pad: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(pad, pad, pad, pad)
        setBackgroundColor(Color.parseColor("#181B22"))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = resources.displayMetrics.density.times(16).toInt() }
    }

    private fun header(text: String) = TextView(this).apply {
        this.text = text
        textSize = 12f
        setTextColor(Color.parseColor("#7FB2FF"))
        setPadding(0, 0, 0, dpOf(8))
    }

    private fun statusLine() = TextView(this).apply {
        textSize = 16f
        setTextColor(Color.WHITE)
        setPadding(0, 0, 0, dpOf(12))
    }

    private fun bigNumber() = TextView(this).apply {
        textSize = 40f
        setTextColor(Color.WHITE)
        setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun dpOf(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun refresh() {
        val enabled = Settings.Secure.getString(contentResolver, "enabled_accessibility_services")
            ?.contains(packageName) == true
        searchStatus.text = if (enabled) getString(R.string.main_on) else getString(R.string.main_off)
        searchStatus.setTextColor(if (enabled) GREEN else RED)

        todayCount.text = BlockedLog.countToday(this).toString()
        streakCount.text = StreakManager.currentStreak(this).toString()

        dnsStatus.text = getString(
            if (dnsGuardOn()) R.string.main_dns_on else R.string.main_dns_off
        )
        dnsStatus.setTextColor(if (dnsGuardOn()) GREEN else RED)

        if (enabled) StreakManager.markActive(this)
    }

    private fun dnsGuardOn(): Boolean =
        getSharedPreferences("focuslock_prefs", MODE_PRIVATE)
            .getBoolean("dns_protection", true)

    companion object {
        private val GREEN = Color.parseColor("#5CD67A")
        private val RED = Color.parseColor("#FF6B6B")
    }
}