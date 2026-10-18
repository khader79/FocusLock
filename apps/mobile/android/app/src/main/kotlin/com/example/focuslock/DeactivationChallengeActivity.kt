package com.example.focuslock

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * Full-screen, high-friction gate that must be crossed before FocusLock's
 * device admin may be deactivated (and the app uninstalled).
 *
 *  - Renders the current 200-character challenge (from [DeactivationGate]).
 *  - Every keystroke is live-verified against the target. Any single wrong,
 *    missing or extra character marks that position red; only a *perfect*
 *    character-for-character match enables the "Continue" button. This mirrors
 *    the Cold Turkey "type the code" screen and is deliberately the only way
 *    through other than the 2-hour cooldown.
 *  - There is no back button escape, no swipe-away and no system dismissal:
 *    [onBackPressed] re-launches the screen instead of letting the user slip
 *    past to Settings.
 *  - The "Wait 2 hours instead" button starts [DeactivationCooldownService]
 *    and dismisses the gate; the persistent notification then runs the
 *    mandatory wait and re-arms the admin in the background.
 *
 * The activity runs on its own empty task (taskAffinity="") so it sits above
 * Settings but never re-orders the user's task stack, and it is excluded from
 * recents so it cannot be found by accident.
 */
class DeactivationChallengeActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())

    private lateinit var targetView: TextView
    private lateinit var progressView: TextView
    private lateinit var input: EditText
    private lateinit var unlockButton: Button
    private lateinit var waitButton: Button
    private lateinit var progressBar: ProgressBar

    private var target: String = ""
    private var showing = false

    private val refreshRunnable = Runnable { render() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        target = DeactivationGate.currentChallenge(this) ?: run {
            // No challenge persisted (e.g. launched while idle) — issue one.
            DeactivationGate.newChallenge(this)
            DeactivationGate.currentChallenge(this) ?: return
        }
        buildUi()
        render()
    }

    override fun onResume() {
        super.onResume()
        if (!showing) {
            showing = true
            input.requestFocus()
            handler.postDelayed(refreshRunnable, 0)
        }
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(refreshRunnable)
        showing = false
    }

    override fun onDestroy() {
        handler.removeCallbacks(refreshRunnable)
        super.onDestroy()
    }

    /** No escape except completing the challenge or committing to the wait. */
    override fun onBackPressed() {
        // Block: re-show the gate so the deactivation is stalled.
        DeactivationChallengeActivity.launch(this)
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(24))
        }
        val bg = ContextCompat.getColor(this, android.R.color.background_dark)
        root.setBackgroundColor(bg)

        root.addView(TextView(this).apply {
            text = getString(R.string.deactivation_challenge_title)
            setTextColor(Color.WHITE)
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
        })

        root.addView(TextView(this).apply {
            text = getString(R.string.deactivation_challenge_instructions)
            setTextColor(Color.LTGRAY)
            textSize = 14f
            setPadding(0, dp(8), 0, dp(16))
        })

        progressView = TextView(this).apply {
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.WHITE)
        }
        root.addView(progressView)

        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = DeactivationGate.CHALLENGE_LENGTH
            progress = 0
            setPadding(0, dp(6), 0, dp(10))
        }
        root.addView(progressBar)

        targetView = TextView(this).apply {
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.WHITE)
        }
        val targetScroll = ScrollView(this).apply {
            addView(targetView, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
            isFillViewport = false
            isVerticalScrollBarEnabled = true
        }
        root.addView(
            targetScroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(220),
            ),
        )

        input = EditText(this).apply {
            hint = getString(R.string.deactivation_challenge_hint)
            setHintTextColor(Color.DKGRAY)
            setTextColor(Color.WHITE)
            textSize = 14f
            typeface = Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            maxLines = 3
            setSingleLine(false)
            filters = arrayOf(InputFilter.LengthFilter(512))
        }
        root.addView(input, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(12) })

        unlockButton = Button(this).apply {
            text = getString(R.string.deactivation_challenge_continue)
            isEnabled = false
            setOnClickListener {
                // Perfect match: this is the user's informed choice — let the
                // Settings deactivation dialog proceed.
                DeactivationGate.clearState(this@DeactivationChallengeActivity)
                finish()
            }
        }
        root.addView(
            unlockButton,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(16) },
        )

        waitButton = Button(this).apply {
            text = getString(R.string.deactivation_challenge_wait)
            setTextColor(Color.WHITE)
            setOnClickListener {
                // Commit to the 2-hour wait: persistent notification + admin
                // watchdog start; the gate is dismissed.
                DeactivationGate.startCooldown(this@DeactivationChallengeActivity)
                finish()
            }
        }
        root.addView(
            waitButton,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(8) },
        )

        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {
                handler.removeCallbacks(refreshRunnable)
                handler.post(refreshRunnable)
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        setContentView(root)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
    }

    private fun render() {
        if (target.isEmpty()) return
        val typed = input.text.toString().filterNot { it.isWhitespace() }

        // Exact prefix match length — anything from the first error on is wrong.
        val correct = DeactivationGate.progress(this, typed)
        val done = DeactivationGate.verify(this, typed)

        var firstMismatch = target.length
        if (typed.length > target.length) {
            // Too many characters: the last visible char is the overflow error.
            firstMismatch = target.length - 1
        } else if (correct < typed.length) {
            firstMismatch = correct
        }

        val grouped = target.toCharArray()
        val styled = android.text.SpannableStringBuilder(grouped.joinToString(" "))

        // Color exact prefix green, everything after the first mistake red.
        val limit = correct
        for (i in 0 until grouped.size) {
            val spanStart = i * 2
            if (i < limit) {
                styled.setSpan(
                    ForegroundColorSpan(Color.rgb(120, 220, 120)),
                    spanStart,
                    spanStart + 1,
                    android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            } else if (i >= firstMismatch) {
                styled.setSpan(
                    ForegroundColorSpan(Color.rgb(255, 90, 90)),
                    spanStart,
                    spanStart + 1,
                    android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            } else {
                styled.setSpan(
                    ForegroundColorSpan(Color.WHITE),
                    spanStart,
                    spanStart + 1,
                    android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            }
            styled.setSpan(
                BackgroundColorSpan(if (i < limit) Color.argb(60, 80, 180, 80) else Color.TRANSPARENT),
                spanStart,
                spanStart + 1,
                android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }

        targetView.text = styled
        progressBar.max = target.length
        progressBar.progress = correct
        progressView.text = String.format(
            Locale.US,
            "%s · %d / %d",
            getString(R.string.deactivation_challenge_progress),
            correct,
            target.length,
        )

        unlockButton.isEnabled = done
        unlockButton.alpha = if (done) 1f else 0.4f
        unlockButton.text = getString(
            if (done) R.string.deactivation_challenge_continue_ready
            else R.string.deactivation_challenge_continue,
        )
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val EXTRA = "focuslock:deactivation_gate"

        /** Launches the gate on its own task, above whatever screen is showing. */
        fun launch(context: Context) {
            if (context is DeactivationChallengeActivity) return
            try {
                val intent = Intent(context, DeactivationChallengeActivity::class.java)
                    .addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP or
                            Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                            Intent.FLAG_ACTIVITY_NO_ANIMATION,
                    )
                    .putExtra(EXTRA, true)
                context.startActivity(intent)
            } catch (_: Exception) {
                // Settings race / background restriction: the receiver will
                // retry on the next disable attempt.
            }
        }
    }
}