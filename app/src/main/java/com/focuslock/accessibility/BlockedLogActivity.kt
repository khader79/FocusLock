package com.focuslock.accessibility

import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** Plain, chronological list of everything the app stopped. */
class BlockedLogActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        recreate()
    }

    private fun buildUi(): android.view.View {
        val d = resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(24))
        }

        val entries = BlockedLog.entries(this)

        root.addView(TextView(this).apply {
            text = getString(R.string.main_view_log)
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, dp(16))
        })

        if (entries.isEmpty()) {
            root.addView(TextView(this).apply {
                text = getString(R.string.log_empty)
                setPadding(0, dp(8), 0, 0)
            })
            return root
        }

        val scroll = ScrollView(this)
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        entries.forEach { e ->
            column.addView(TextView(this).apply {
                text = "${BlockedLog.formatTime(e.timestamp)}   ${e.value}"
                textSize = 14f
                gravity = Gravity.START
                setPadding(0, dp(10), 0, 0)
            })
        }
        scroll.addView(column)
        root.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }
}