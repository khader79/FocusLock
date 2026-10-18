package com.focuslock.accessibility

import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Full-screen random-text gate shown before a locked block can be disabled.
 * Cancel is always available and never punished — the design is friction, not
 * imprisonment.
 */
class UnlockActivity : AppCompatActivity() {

    private lateinit var challengeView: TextView
    private lateinit var typedField: EditText
    private var challenge: String = ""
    private var blockId: String = ""
    private var mode: String = MODE_BLOCK

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        blockId = intent.getStringExtra(EXTRA_BLOCK_ID).orEmpty()
        mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_BLOCK
        setContentView(buildUi())
    }

    private fun buildUi(): android.view.View {
        val d = resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(24))
            setBackgroundColor(BG)
        }

        root.addView(TextView(this).apply {
            text = getString(
                if (mode == MODE_DNS) R.string.dns_unlock_title else R.string.unlock_title
            )
            textSize = 20f
            setTextColor(TEXT)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            gravity = Gravity.CENTER
        })

        root.addView(TextView(this).apply {
            text = getString(
                if (mode == MODE_DNS) R.string.dns_unlock_body else R.string.unlock_body
            )
            textSize = 13f
            setTextColor(MUTED)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(20))
        })

        root.addView(TextView(this).apply {
            text = getString(R.string.unlock_prompt)
            textSize = 11f
            setTextColor(MUTED)
            setPadding(0, 0, 0, dp(6))
        })

        challengeView = TextView(this).apply {
            textSize = 15f
            setTextColor(TEXT)
            setPadding(dp(14), dp(14), dp(14), dp(14))
            setBackgroundColor(CARD)
        }
        root.addView(challengeView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        typedField = EditText(this).apply {
            hint = getString(R.string.unlock_type_hint)
            setHintTextColor(MUTED)
            setTextColor(TEXT)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 3
            gravity = Gravity.TOP or Gravity.START
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(CARD)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(120)
            )
        }
        root.addView(typedField)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(Button(this).apply {
            text = getString(android.R.string.cancel)
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Button(this).apply {
            text = getString(R.string.unlock_action)
            setOnClickListener { attempt() }
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(row)

        newChallenge()
        return root
    }

    private fun requiredWords(): Int {
        if (mode == MODE_DNS) return intent.getIntExtra(EXTRA_WORDS, 25)
        val block = BlockStore.load(this).firstOrNull { it.id == blockId }
        val requested = intent.getIntExtra(EXTRA_WORDS, 0)
        return when {
            requested > 0 -> requested
            block != null && block.challengeLength > 0 -> block.challengeLength
            else -> 20
        }
    }

    private fun newChallenge() {
        challenge = UnlockChallenge.generate(requiredWords())
        challengeView.text = challenge
        typedField.setText("")
    }

    private fun attempt() {
        if (UnlockChallenge.matches(challenge, typedField.text.toString())) {
            if (mode == MODE_DNS) {
                getSharedPreferences("focuslock_prefs", MODE_PRIVATE)
                    .edit().putBoolean("dns_protection", false).apply()
                startActivity(
                    Intent("android.settings.PRIVATE_DNS_SETTINGS")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } else {
                val block = BlockStore.load(this).firstOrNull { it.id == blockId }
                if (block != null) {
                    block.enabled = false
                    BlockStore.update(this, block)
                }
            }
            setResult(RESULT_OK)
            finish()
        } else {
            Toast.makeText(this, R.string.unlock_mismatch, Toast.LENGTH_LONG).show()
            newChallenge()
        }
    }

    companion object {
        const val EXTRA_BLOCK_ID = "block_id"
        const val EXTRA_WORDS = "words"
        const val EXTRA_MODE = "mode"
        const val MODE_BLOCK = "block"
        const val MODE_DNS = "dns"

        private val BG = 0xFF1B1E26.toInt()
        private val CARD = 0xFF242833.toInt()
        private val TEXT = 0xFFFFFFFF.toInt()
        private val MUTED = 0xFF8A90A0.toInt()
    }
}