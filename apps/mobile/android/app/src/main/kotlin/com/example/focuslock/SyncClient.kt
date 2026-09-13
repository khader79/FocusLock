package com.example.focuslock

import android.content.Context
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/**
 * Minimal sync client for the "Sync with Desktop" requirement.
 *
 * Operates against a Supabase table `focuslock_sync` with a single row whose
 * `payload` column holds a base64 AES-256-GCM ciphertext. The encryption key is
 * derived from a shared passphrase (SHA-256), so the same passphrase configured
 * on the Desktop and on this device lets both endpoint decrypt each other's
 * state. Real-time post/update streaming is handled on the Dart side (it owns
 * the websocket); this client covers push + pull for the native layer.
 */
object SyncClient {

    private const val TABLE = "focuslock_sync"
    private const val COLUMN_PAYLOAD = "payload"

    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    private val random = SecureRandom()

    // -------------------------------------------------------------- crypto

    /** SHA-256 of the shared passphrase -> 32-byte AES key. */
    fun deriveKey(secret: String): SecretKeySpec {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(secret.toByteArray(Charset.forName("UTF-8")))
        return SecretKeySpec(digest, "AES")
    }

    fun encrypt(secret: String, plaintext: String): String {
        val key = deriveKey(secret)
        val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        val ct = cipher.doFinal(plaintext.toByteArray(Charset.forName("UTF-8")))
        val boxed = ByteArray(iv.size + ct.size)
        iv.copyInto(boxed, 0)
        ct.copyInto(boxed, iv.size)
        return Base64.encodeToString(boxed, Base64.NO_WRAP)
    }

    fun decrypt(secret: String, encoded: String): String {
        val key = deriveKey(secret)
        val boxed = Base64.decode(encoded, Base64.NO_WRAP)
        val iv = boxed.copyOfRange(0, IV_BYTES)
        val ct = boxed.copyOfRange(IV_BYTES, boxed.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        return String(cipher.doFinal(ct), Charset.forName("UTF-8"))
    }

    // ------------------------------------------------------------------- api

    /** Pushes an encrypted snapshot of the protection state up to Supabase. */
    fun push(context: Context, payload: JSONObject): JSONObject {
        val secret = ProtectionStore.syncSecret(context) ?: return JSONObject()
        val url = ProtectionStore.syncUrl(context) ?: return JSONObject()
        val anonKey = ProtectionStore.syncAnonKey(context) ?: return JSONObject()
        val rowId = ProtectionStore.syncRowId(context) ?: return JSONObject()

        val encrypted = encrypt(secret, payload.toString())
        val body = JSONObject().put(COLUMN_PAYLOAD, encrypted)
        val conn = URL("$url/rest/v1/$TABLE?id=eq.$rowId").openConnection()
            as HttpURLConnection
        conn.requestMethod = "PATCH"
        conn.setRequestProperty("apikey", anonKey)
        conn.setRequestProperty("Authorization", "Bearer $anonKey")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        conn.disconnect()
        return if (code in 200..299) body else JSONObject()
    }

    /** Pulls the encrypted payload, decrypts it and returns the plaintext. */
    fun pull(context: Context): JSONObject? {
        val secret = ProtectionStore.syncSecret(context) ?: return null
        val url = ProtectionStore.syncUrl(context) ?: return null
        val anonKey = ProtectionStore.syncAnonKey(context) ?: return null
        val rowId = ProtectionStore.syncRowId(context) ?: return null

        val conn = URL("$url/rest/v1/$TABLE?id=eq.$rowId&select=$COLUMN_PAYLOAD")
            .openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("apikey", anonKey)
        conn.setRequestProperty("Authorization", "Bearer $anonKey")
        return try {
            if (conn.responseCode != 200) {
                null
            } else {
                val raw = conn.inputStream.bufferedReader().use { it.readText() }
                if (raw.isBlank()) {
                    null
                } else {
                    val arr = org.json.JSONArray(raw)
                    if (arr.length() == 0) {
                        null
                    } else {
                        val encrypted = arr.getJSONObject(0).optString(COLUMN_PAYLOAD, "")
                        if (encrypted.isBlank()) null else JSONObject(decrypt(secret, encrypted))
                    }
                }
            }
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }
}