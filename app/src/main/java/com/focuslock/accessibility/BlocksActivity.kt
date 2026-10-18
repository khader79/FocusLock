package com.focuslock.accessibility

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * The block list. Each row is a named, independently toggleable and
 * independently lockable rule — the same mental model as a desktop blocker,
 * adapted to touch.
 */
class BlocksActivity : AppCompatActivity() {

    private val unlockLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            reload()
        }
    }

    private val editLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { reload() }

    private lateinit var container: LinearLayout

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        reload()
    }

    private fun buildUi(): android.view.View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }

        root.addView(TextView(this).apply {
            text = getString(R.string.blocks_title)
            textSize = 26f
            setTextColor(TEXT)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(dp(20), dp(28), dp(20), dp(4))
        })

        root.addView(TextView(this).apply {
            text = getString(R.string.blocks_subtitle)
            textSize = 12f
            setTextColor(MUTED)
            setPadding(dp(20), 0, dp(20), dp(16))
        })

        val scroll = ScrollView(this)
        container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), 0, dp(20), dp(12))
        }
        scroll.addView(container)
        root.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        root.addView(Button(this).apply {
            text = getString(R.string.blocks_new)
            setOnClickListener {
                editLauncher.launch(Intent(this@BlocksActivity, BlockEditActivity::class.java))
            }
            setPadding(dp(16), dp(14), dp(16), dp(14))
            setBackgroundColor(ACCENT)
            setTextColor(Color.BLACK)
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { leftMargin = dp(20); rightMargin = dp(20); bottomMargin = dp(24) })

        return root
    }

    private fun reload() {
        container.removeAllViews()
        val blocks = BlockStore.load(this)
        if (blocks.isEmpty()) {
            container.addView(TextView(this).apply {
                text = getString(R.string.blocks_empty)
                setTextColor(MUTED)
                setPadding(0, dp(24), 0, 0)
            })
            return
        }
        blocks.forEach { container.addView(row(it)) }
    }

    private fun row(block: Block): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(CARD)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
            setOnClickListener {
                editLauncher.launch(
                    Intent(this@BlocksActivity, BlockEditActivity::class.java)
                        .putExtra(BlockEditActivity.EXTRA_ID, block.id)
                )
            }
        }

        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }

        header.addView(TextView(this).apply {
            text = block.name
            textSize = 17f
            setTextColor(if (block.enabled) TEXT else MUTED)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })

        header.addView(TextView(this).apply {
            text = if (block.locked) getString(R.string.block_locked) else ""
            textSize = 12f
            setTextColor(WARN)
            gravity = Gravity.END
            setPadding(0, dp(4), dp(8), 0)
        })

        header.addView(Switch(this).apply {
            isChecked = block.enabled
            setOnCheckedChangeListener { _, checked ->
                if (checked) {
                    block.enabled = true
                    BlockStore.update(this@BlocksActivity, block)
                    reload()
                } else if (block.locked) {
                    // Locked block: require the random-text challenge first.
                    isChecked = true
                    unlockLauncher.launch(
                        Intent(this@BlocksActivity, UnlockActivity::class.java)
                            .putExtra(UnlockActivity.EXTRA_BLOCK_ID, block.id)
                            .putExtra(UnlockActivity.EXTRA_WORDS, block.challengeLength)
                    )
                } else {
                    block.enabled = false
                    BlockStore.update(this@BlocksActivity, block)
                    reload()
                }
            }
        })
        card.addView(header)

        card.addView(TextView(this).apply {
            text = buildString {
                append(if (block.enabled) getString(R.string.block_active) else getString(R.string.block_inactive))
                append("   •   ")
                append("${block.terms.size} ${getString(R.string.block_entries)}")
                append("   •   ")
                append(getString(R.string.block_chars, block.charCount))
            }
            textSize = 12f
            setTextColor(MUTED)
            setPadding(0, dp(6), 0, 0)
        })

        return card
    }

    companion object {
        private val BG = 0xFF15171C.toInt()
        private val CARD = 0xFF1F232C.toInt()
        private val TEXT = 0xFFFFFFFF.toInt()
        private val MUTED = 0xFF8A90A0.toInt()
        private val ACCENT = 0xFF6BCB4F.toInt()
        private val WARN = 0xFFFFC857.toInt()
    }
}