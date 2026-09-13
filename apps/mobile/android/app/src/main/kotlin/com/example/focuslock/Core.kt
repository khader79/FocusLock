package com.example.focuslock

import android.content.Context
import java.security.SecureRandom
import java.util.UUID
import kotlin.math.min

/**
 * Kotlin port of `@focuslock/core` (`packages/core/src/challenge.ts`).
 *
 * The canonical challenge logic lives in the desktop TypeScript package; this
 * file mirrors it exactly so that:
 *  - challenges are generated *natively* (trusted side) instead of in the UI,
 *  - the same word pool / difficulty table / diff semantics are used, and
 *  - the foreground service can verify completions without the Flutter engine.
 *
 * The BIP39-style word pool is read from `assets/challenge_words.txt`, which is
 * generated directly from `packages/core/src/words.ts` (2048 words).
 */
object Core {

    /** Mirror of core's `DIFFICULTY_CONFIG`. */
    data class DifficultyConfig(
        val minWords: Int,
        val maxWords: Int,
        val minutes: Int,
    )

    val DIFFICULTY_CONFIG: Map<Int, DifficultyConfig> = mapOf(
        1 to DifficultyConfig(minWords = 30, maxWords = 60, minutes = 5),
        2 to DifficultyConfig(minWords = 60, maxWords = 120, minutes = 10),
        3 to DifficultyConfig(minWords = 120, maxWords = 250, minutes = 20),
        4 to DifficultyConfig(minWords = 250, maxWords = 400, minutes = 30),
        5 to DifficultyConfig(minWords = 400, maxWords = 700, minutes = 60),
    )

    /** A generated word-typing challenge, matching core's `Challenge`. */
    data class Challenge(
        val id: String,
        val text: String,
        val wordCount: Int,
        val createdAtMillis: Long,
        val expiresAtMillis: Long,
        val difficulty: Int,
    ) {
        val minutes: Int get() = DIFFICULTY_CONFIG[difficulty]?.minutes ?: 0
    }

    private val random = SecureRandom()

    /** The word pool, cached after the first read of the asset. */
    @Volatile
    private var cachedWords: List<String>? = null

    fun words(context: Context): List<String> {
        cachedWords?.let { return it }
        val loaded = context.assets.open("challenge_words.txt").use { input ->
            input.bufferedReader(Charsets.UTF_8).use { reader -> reader.readLines() }
        }.map { it.trim() }.filter { it.isNotEmpty() }
        cachedWords = loaded
        return loaded
    }

    /** Mirrors core's `generateChallenge(difficulty)`. */
    fun generateChallenge(context: Context, difficulty: Int): Challenge {
        val config = DIFFICULTY_CONFIG[difficulty]
            ?: throw IllegalArgumentException(
                "Invalid difficulty: $difficulty. Expected a value between 1 and 5.",
            )

        val pool = words(context)
        val wordCount = config.minWords + random.nextInt(config.maxWords - config.minWords + 1)
        val selected = ArrayList<String>(wordCount)
        repeat(wordCount) { selected.add(pool[random.nextInt(pool.size)]) }

        val createdAt = System.currentTimeMillis()
        val expiresAt = createdAt + config.minutes * 60_000L

        return Challenge(
            id = UUID.randomUUID().toString(),
            text = selected.joinToString(" "),
            wordCount = wordCount,
            createdAtMillis = createdAt,
            expiresAtMillis = expiresAt,
            difficulty = difficulty,
        )
    }

    /** Mirrors core's `diffIndex(typed, target)`. */
    fun diffIndex(typed: String, target: String): Int {
        val maxLength = min(typed.length, target.length)
        for (i in 0 until maxLength) {
            if (typed[i] != target[i]) return i
        }
        if (typed.length == target.length) return -1
        return if (typed.length > target.length) target.length else typed.length
    }

    /** Mirrors core's `isComplete(typed, target)`. */
    fun isComplete(typed: String, target: String): Boolean = typed == target

    /** Mirrors core's `progress(typed, target)`. */
    fun progress(typed: String, target: String): Double {
        if (target.isEmpty()) return 1.0
        val firstError = diffIndex(typed, target)
        if (firstError == -1) return 1.0
        if (target.length == 0) return 1.0
        return firstError.toDouble() / target.length.toDouble()
    }
}