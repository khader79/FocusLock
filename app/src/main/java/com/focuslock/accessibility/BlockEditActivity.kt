package com.focuslock.accessibility

import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** Create or edit a single block: name, kind, terms, and whether it is locked. */
class BlockEditActivity : AppCompatActivity() {

    private var existingId: String? = null
    private lateinit var nameField: EditText
    private lateinit var termsField: EditText
    private lateinit var kindValue: TextView
    private lateinit var lockSwitch: android.widget.Switch
    private lateinit var wordsField: EditText
    private lateinit var wordsHint: TextView
    private lateinit var wordsLabel: TextView
    private lateinit var presetRow: LinearLayout
    private var kind = Block.Kind.DOMAINS

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        existingId = intent.getStringExtra(EXTRA_ID)
        setContentView(buildUi())
        applyLockVisibility(false)
        existingId?.let { loadExisting(it) }
    }

    private fun buildUi(): android.view.View {
        val d = resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }

        root.addView(TextView(this).apply {
            text = if (existingId == null) getString(R.string.editor_new) else getString(R.string.editor_edit)
            textSize = 22f
            setTextColor(TEXT)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(dp(20), dp(26), dp(20), dp(16))
        })

        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        col.addView(label(getString(R.string.field_name)))
        nameField = EditText(this).apply {
            hint = getString(R.string.field_name)
            setHintTextColor(MUTED); setTextColor(TEXT); setBackgroundColor(CARD)
            inputType = InputType.TYPE_CLASS_TEXT
            layoutParams = params()
        }
        col.addView(nameField)

        col.addView(label(getString(R.string.field_type)))
        kindValue = TextView(this).apply {
            textSize = 15f; setTextColor(ACCENT)
            setBackgroundColor(CARD); setPadding(dp(14), dp(14), dp(14), dp(14))
            setOnClickListener { cycleKind() }
        }
        col.addView(kindValue)
        col.addView(TextView(this).apply {
            text = getString(R.string.field_type_hint)
            textSize = 11f; setTextColor(MUTED); setPadding(dp(2), dp(4), 0, dp(12))
        })

        col.addView(label(getString(R.string.field_terms)))
        termsField = EditText(this).apply {
            hint = getString(R.string.field_terms_hint)
            setHintTextColor(MUTED); setTextColor(TEXT); setBackgroundColor(CARD)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            gravity = Gravity.TOP
            minLines = 8
            setPadding(dp(12), dp(12), dp(12), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(180)
            )
        }
        col.addView(termsField)

        col.addView(label(getString(R.string.field_lock)))
        lockSwitch = android.widget.Switch(this).apply {
            setTextColor(TEXT)
            setOnCheckedChangeListener { _, checked ->
                applyLockVisibility(checked)
            }
        }
        col.addView(lockSwitch)
        wordsHint = TextView(this).apply {
            text = getString(R.string.field_lock_hint)
            textSize = 11f; setTextColor(MUTED); setPadding(dp(2), 0, 0, dp(10))
        }
        col.addView(wordsHint)

        wordsLabel = label(getString(R.string.field_words))
        col.addView(wordsLabel)

        presetRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, dp(8))
        }
        listOf(10, 25, 50, 100).forEach { n ->
            presetRow.addView(Button(this).apply {
                text = n.toString()
                textSize = 12f
                isAllCaps = false
                setPadding(dp(8), dp(4), dp(8), dp(4))
                setOnClickListener { wordsField.setText(n.toString()) }
            }, LinearLayout.LayoutParams(0, dp(48), 1f).apply {
                leftMargin = dp(2); rightMargin = dp(2)
            })
        }
        col.addView(presetRow)

        wordsField = EditText(this).apply {
            setText("20")
            setTextColor(TEXT); setBackgroundColor(CARD)
            inputType = InputType.TYPE_CLASS_NUMBER
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))
        }
        col.addView(wordsField)
        col.addView(TextView(this).apply {
            text = getString(R.string.field_words_hint)
            textSize = 11f; setTextColor(MUTED); setPadding(dp(2), dp(4), 0, dp(20))
        })

        scroll.addView(col)
        root.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val save = Button(this).apply {
            text = getString(R.string.editor_save)
            setBackgroundColor(ACCENT); setTextColor(Color.BLACK)
            setOnClickListener { save() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(20); rightMargin = dp(20); bottomMargin = dp(24) }
        }
        root.addView(save)
        return root
    }

    private fun params() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { height = dp(52) }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun label(t: String) = TextView(this).apply {
        text = t; textSize = 12f; setTextColor(MUTED)
        setPadding(0, dp(18), 0, dp(6))
    }

    /** Word count only means something on a locked block, so hide it otherwise. */
    private fun applyLockVisibility(locked: Boolean) {
        val vis = if (locked) android.view.View.VISIBLE else android.view.View.GONE
        wordsLabel.visibility = vis
        presetRow.visibility = vis
        wordsField.visibility = vis
        wordsHint.visibility = vis
    }

    private fun cycleKind() {
        kind = if (kind == Block.Kind.DOMAINS) Block.Kind.KEYWORDS else Block.Kind.DOMAINS
        kindValue.text = kindLabel()
    }

    private fun kindLabel() = when (kind) {
        Block.Kind.DOMAINS -> getString(R.string.kind_domains)
        Block.Kind.KEYWORDS -> getString(R.string.kind_keywords)
    }

    private fun loadExisting(id: String) {
        val block = BlockStore.load(this).firstOrNull { it.id == id } ?: return
        nameField.setText(block.name)
        termsField.setText(block.terms.joinToString("\n"))
        kind = block.kind
        kindValue.text = kindLabel()
        lockSwitch.isChecked = block.locked
        applyLockVisibility(block.locked)
        wordsField.setText(if (block.challengeLength > 0) block.challengeLength.toString() else "20")
    }

    private fun save() {
        val name = nameField.text.toString().trim().ifEmpty { getString(R.string.editor_untitled) }
        val terms = termsField.text.toString()
            .split('\n', ',')
            .map { it.trim() }
            .filter { it.isNotBlank() }

        val block = Block(
            id = existingId ?: "b_${System.currentTimeMillis()}",
            name = name,
            kind = kind,
            terms = terms,
            enabled = true,
            locked = lockSwitch.isChecked,
            challengeLength = wordsField.text.toString().toIntOrNull() ?: 20
        )

        if (existingId == null) BlockStore.add(this, block) else BlockStore.update(this, block)
        setResult(RESULT_OK)
        finish()
    }

    companion object {
        const val EXTRA_ID = "block_id"

        private val BG = 0xFF15171C.toInt()
        private val CARD = 0xFF1F232C.toInt()
        private val TEXT = 0xFFFFFFFF.toInt()
        private val MUTED = 0xFF8A90A0.toInt()
        private val ACCENT = 0xFF6BCB4F.toInt()
    }
}