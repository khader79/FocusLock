package com.focuslock.accessibility

import java.security.SecureRandom

/**
 * Random-text challenge used to unlock a locked block.
 *
 * Nothing here is secret and nothing can be guessed — the words are printed on
 * screen. The whole cost is the effort of reading and retyping them, which is
 * exactly what buys a gap between the urge and the action. A block that is
 * locked is never impossible to unlock, only expensive.
 */
object UnlockChallenge {

    private val random = SecureRandom()

    private val WORDS = listOf(
        "departure", "position", "guide", "context", "money", "competition",
        "assistant", "desk", "midnight", "improvement", "computer", "answer",
        "development", "night", "patience", "percentage", "task", "hall",
        "price", "field", "form", "analyst", "atmosphere", "question",
        "intention", "balance", "capture", "deposit", "element", "furnace",
        "gallery", "harvest", "impulse", "journey", "kingdom", "lantern",
        "measure", "notion", "outline", "pattern", "quality", "reflect",
        "segment", "texture", "utility", "vantage", "window", "yield",
        "absence", "bracket", "circuit", "diagram", "entropy", "fable",
        "gradient", "horizon", "interval", "kernel", "latency", "matrix"
    )

    /**
     * @param wordCount how many words to print. More words, more typing.
     */
    fun generate(wordCount: Int): String {
        val n = wordCount.coerceIn(5, 120)
        return (0 until n).map { WORDS[random.nextInt(WORDS.size)] }.joinToString(" ")
    }

    /**
     * Whitespace and case insensitive so the user is never punished for
     * autocorrect capitalising or a stray double space — only for getting the
     * words wrong or skipping one.
     */
    fun matches(shown: String, typed: String): Boolean {
        val a = shown.trim().lowercase().split(Regex("\\s+")).filter { it.isNotBlank() }
        val b = typed.trim().lowercase().split(Regex("\\s+")).filter { it.isNotBlank() }
        if (a.size != b.size) return false
        return a.indices.all { a[it] == b[it] }
    }

    /** Characters the user must type, for the "200 chars" style hint. */
    fun charCount(text: String): Int = text.length
}