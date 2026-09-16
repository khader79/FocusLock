package com.example.focuslock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Local VPN that tunnels all traffic and filters it in three layers:
 *
 *  1. DNS: blocked domains get an NXDOMAIN answer, so they cannot resolve.
 *  2. HTTPS: the TLS ClientHello of every TCP:443 connection is inspected and
 *     its SNI hostname is matched against the same blocklist; blocked
 *     handshakes are dropped before any content flows.
 *  3. QUIC: UDP to :443 is dropped so HTTP/3 applications fall back to
 *     plain TLS over TCP, where the SNI filter can see them.
 *
 * When the sticky strict mode (الوضع الصارم) is armed, filtering cannot be
 * paused and the tunnel is set as the Android always-on VPN with lockdown, so
 * every connection must cross this filter.
 */
class FocusVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.example.focuslock.action.START"
        const val ACTION_STOP = "com.example.focuslock.action.STOP"
        const val ACTION_RECONFIGURE = "com.example.focuslock.action.RECONFIGURE"

        private const val CHANNEL_ID = "focuslock_vpn"
        private const val NOTIFICATION_ID = 1
        private const val DNS_SERVER = "10.0.0.1"
        private const val CLIENT_ADDRESS = "10.0.0.2"
        private const val CLIENT_PREFIX = 32
        private const val MTU = 1280
        private const val IP_HEADER_LENGTH = 20
        private const val UDP_HEADER_LENGTH = 8
        private const val TCP_PROTOCOL = 6
        private const val UDP_PROTOCOL = 17
        private const val DNS_PORT = 53
        private const val HTTPS_PORT = 443
        private const val TLS_HANDSHAKE = 0x16
        private const val TLS_CLIENT_HELLO = 0x01
        private const val TLS_EXT_SERVER_NAME = 0x0000
    }

    private val running = AtomicBoolean(false)
    private val blocklist = Blocklist()

    /** True when the tunnel is limited to blocked apps whose traffic we drop. */
    @Volatile
    private var quarantineActive = false

    /** Last time a block was counted, to dedupe the "blocked today" counter. */
    @Volatile
    private var lastBlockCountedAt = 0L

    private var tunnel: ParcelFileDescriptor? = null
    private var worker: Thread? = null

    /** True when the session is active AND not paused (i.e. blocking) — or when
     *  the sticky strict mode is armed, which never pauses. */
    private fun blockingEnabled(): Boolean {
        return !ProtectionStore.isPaused(this) || ProtectionStore.isGuard(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopVpn()
            ACTION_RECONFIGURE -> {
                // Pick up the latest blocked-app list (added/removed via
                // MethodChannel) and rebuild the tunnel.
                stopWorker()
                startVpn()
            }
            else -> startVpn()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopWorker()
        super.onDestroy()
    }

    override fun onRevoke() {
        stopVpn()
    }

    private fun startVpn() {
        if (running.get()) {
            return
        }

        val builder = Builder()
            .setSession("FocusLock")
            .addAddress(CLIENT_ADDRESS, CLIENT_PREFIX)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(DNS_SERVER)
            .setMtu(MTU)

        // App-blocking fallback: only the blocked packages ride the tunnel and
        // every packet they send is dropped, so their network dies while all
        // other apps bypass the VPN untouched. Requires Android 11+.
        val blockedPackages = AppBlocker.readBlockedPackages(this)
        quarantineActive = blockedPackages.isNotEmpty() &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        if (quarantineActive) {
            for (pkg in blockedPackages) {
                try {
                    builder.addAllowedApplication(pkg)
                } catch (_: Exception) {
                    // Package uninstalled or not routable; the remaining ones
                    // still get quarantined.
                }
            }
        }

        // Strict mode: the tunnel owns the whole route even if the VPN was
        // revoked/restarted, so filtering is always in the path.
        val established = builder.establish()

        if (established == null) {
            stopSelf()
            return
        }

        tunnel = established
        running.set(true)
        ProtectionStore.setActive(this, true)
        startAsForeground()

        worker = Thread(
            { readLoop(established) },
            "focuslock-vpn-thread",
        ).apply { start() }
    }

    private fun readLoop(tunnel: ParcelFileDescriptor) {
        val input = FileInputStream(tunnel.fileDescriptor)
        val output = FileOutputStream(tunnel.fileDescriptor)
        val buffer = ByteArray(MTU * 2)

        blocklist.load(applicationContext)

        while (running.get()) {
            val read = try {
                input.read(buffer)
            } catch (_: IOException) {
                break
            }
            if (read < 0) {
                break
            }
            if (read == 0) {
                continue
            }
            if (quarantineActive) {
                // Blocked-app traffic: drain and drop without answering.
                continue
            }

            val packet = buffer.copyOf(read)
            val replacement = handlePacket(packet)
            if (replacement == null) {
                // Blocked SNI handshake or UDP:443 (QUIC): drop silently.
                continue
            }
            try {
                output.write(replacement)
                output.flush()
            } catch (_: IOException) {
                break
            }
        }

        stopVpn()
    }

    /** Returns the (possibly rewritten) packet, or null when it must be
     *  dropped. */
    private fun handlePacket(packet: ByteArray): ByteArray? {
        if (packet.size < IP_HEADER_LENGTH) {
            return packet
        }

        // Paused sessions let blocked domains resolve again — unless the strict
        // mode is armed, in which case nothing may be un-paused anyway.
        if (!blockingEnabled()) {
            return packet
        }

        val version = (packet[0].toInt() and 0xFF) ushr 4
        val headerLength = (packet[0].toInt() and 0x0F) shl 2
        if (version != 4 || headerLength < IP_HEADER_LENGTH) {
            return packet
        }

        val protocol = packet[9].toInt() and 0xFF
        return when (protocol) {
            UDP_PROTOCOL -> handleUdp(packet, headerLength)
            TCP_PROTOCOL -> handleTcp(packet, headerLength)
            else -> packet
        }
    }

    private fun handleUdp(packet: ByteArray, ipHeaderLength: Int): ByteArray? {
        if (ipHeaderLength + UDP_HEADER_LENGTH > packet.size) {
            return packet
        }
        val dstPort = DnsPacket.getU16(packet, ipHeaderLength + 2)
        if (dstPort == HTTPS_PORT) {
            // QUIC (HTTP/3) carries no inspectable SNI; dropping it forces the
            // app to retry over TLS-on-TCP so [handleTcp] can filter it.
            return null
        }
        if (dstPort != DNS_PORT) {
            return packet
        }

        val dnsStart = ipHeaderLength + UDP_HEADER_LENGTH
        val dns = packet.copyOfRange(dnsStart, packet.size)
        if (!DnsPacket.isQuery(dns)) {
            return packet
        }

        val question = DnsPacket.parseQuestion(dns)
        if (question == null || !blocklist.isBlocked(question.name)) {
            return packet
        }

        countBlock()
        val nxDomain = DnsPacket.buildNxDomainResponse(dns, question)
        return buildDnsResponsePacket(packet, ipHeaderLength, nxDomain)
    }

    private fun handleTcp(packet: ByteArray, ipHeaderLength: Int): ByteArray? {
        // Only connections whose TLS ClientHello carries a blocked hostname are
        // dropped; everything else is forwarded untouched.
        val sni = readSni(packet, ipHeaderLength) ?: return packet
        return if (blocklist.isBlocked(sni)) null else packet
    }

    /**
     * Extracts the server_name (SNI) from a TLS ClientHello carried in the
     * first TCP segment of an outbound connection to :443. Returns null when
     * the segment does not contain a complete ClientHello (a split handshake
     * is forwarded, which is rare for ClientHello packets).
     */
    private fun readSni(packet: ByteArray, ipHeaderLength: Int): String? {
        if (packet.size < ipHeaderLength + 20) {
            return null
        }
        val tcpStart = ipHeaderLength
        val dstPort = DnsPacket.getU16(packet, tcpStart + 2)
        if (dstPort != HTTPS_PORT) {
            return null
        }
        val dataOffset = ((packet[tcpStart + 12].toInt() and 0xF0) ushr 4) * 4
        val payload = tcpStart + dataOffset

        if (payload + 5 > packet.size) {
            return null
        }
        if (packet[payload].toInt() and 0xFF != TLS_HANDSHAKE) {
            return null
        }

        val recordLength = DnsPacket.getU16(packet, payload + 3)
        val recordEnd = payload + 5 + recordLength
        if (recordEnd > packet.size) {
            return null
        }

        val handshake = payload + 5
        if (handshake + 4 > recordEnd) {
            return null
        }
        if (packet[handshake].toInt() and 0xFF != TLS_CLIENT_HELLO) {
            return null
        }

        val body = handshake + 4
        var offset = body

        fun u8(at: Int): Int = if (at in 0 until packet.size) packet[at].toInt() and 0xFF else -1
        fun u16(at: Int): Int =
            if (at >= 0 && at + 1 < packet.size) DnsPacket.getU16(packet, at) else -1

        // client_version (2) + random (32)
        if (u8(offset) < 0) return null
        offset += 34

        // session_id
        val sessionIdLen = u8(offset)
        if (sessionIdLen < 0) return null
        offset += 1 + sessionIdLen

        // cipher_suites
        val cipherLen = u16(offset)
        if (cipherLen < 0) return null
        offset += 2 + cipherLen

        // compression_methods
        val compressionLen = u8(offset)
        if (compressionLen < 0) return null
        offset += 1 + compressionLen

        // extensions
        if (offset + 2 > packet.size) return null
        val extensionsLength = u16(offset)
        if (extensionsLength < 0) return null
        offset += 2
        val extensionsEnd = offset + extensionsLength
        if (extensionsEnd > packet.size) return null

        while (offset + 4 <= extensionsEnd) {
            val type = u16(offset)
            val extLength = u16(offset + 2)
            if (type < 0 || extLength < 0) return null

            val data = offset + 4
            if (type == TLS_EXT_SERVER_NAME) {
                if (data + 2 > packet.size) return null
                val listLength = u16(data)
                if (listLength < 0) return null
                var pos = data + 2
                if (pos + 1 > packet.size) return null
                val nameType = u8(pos)
                if (nameType < 0) return null
                if (nameType == 0) {
                    if (pos + 3 > packet.size) return null
                    val nameLength = u16(pos + 1)
                    if (nameLength < 0) return null
                    if (pos + 3 + nameLength > packet.size) return null
                    val builder = StringBuilder(nameLength)
                    for (i in 0 until nameLength) {
                        builder.append((packet[pos + 3 + i].toInt() and 0xFF).toChar())
                    }
                    return builder.toString().lowercase()
                }
            }

            offset = data + extLength
        }
        return null
    }

    /** Counts a blocked domain, at most once per second regardless of fan-out. */
    private fun countBlock() {
        val now = System.currentTimeMillis()
        if (now - lastBlockCountedAt < 1_000L) {
            return
        }
        lastBlockCountedAt = now
        ProtectionStore.incrementBlocked(this)
        ProtectionStore.touchLastUpdate(this)
    }

    private fun buildDnsResponsePacket(
        original: ByteArray,
        ipHeaderLength: Int,
        dns: ByteArray,
    ): ByteArray {
        val clientIp = original.copyOfRange(12, 16)
        val serverIp = original.copyOfRange(16, 20)
        val clientPort = DnsPacket.getU16(original, ipHeaderLength)
        val serverPort = DnsPacket.getU16(original, ipHeaderLength + 2)

        val udpLength = UDP_HEADER_LENGTH + dns.size
        val totalLength = IP_HEADER_LENGTH + udpLength

        val out = ByteArray(totalLength)
        out[0] = 0x45.toByte()
        out[2] = (totalLength ushr 8).toByte()
        out[3] = (totalLength and 0xFF).toByte()
        out[4] = original[4]
        out[5] = original[5]
        out[8] = 64
        out[9] = UDP_PROTOCOL.toByte()

        clientIp.copyInto(out, 12)
        serverIp.copyInto(out, 16)

        putU16(out, IP_HEADER_LENGTH, serverPort)
        putU16(out, IP_HEADER_LENGTH + 2, clientPort)
        putU16(out, IP_HEADER_LENGTH + 4, udpLength)

        dns.copyInto(out, IP_HEADER_LENGTH + UDP_HEADER_LENGTH)

        putU16(out, IP_HEADER_LENGTH + 6, udpChecksum(out, clientIp, serverIp, udpLength))
        putU16(out, 10, ipChecksum(out))
        return out
    }

    /** Writes a 16-bit big-endian value into [buffer] at [offset]. */
    private fun putU16(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = (value ushr 8).toByte()
        buffer[offset + 1] = (value and 0xFF).toByte()
    }

    /** IPv4 header checksum over the first 20 bytes. */
    private fun ipChecksum(header: ByteArray): Int {
        val folded = foldChecksum(sumWords(header, 0, IP_HEADER_LENGTH))
        return if (folded == 0) 0xFFFF else folded
    }

    /** UDP checksum over the UDP segment plus the IPv4 pseudo header. */
    private fun udpChecksum(
        packet: ByteArray,
        clientIp: ByteArray,
        serverIp: ByteArray,
        udpLength: Int,
    ): Int {
        var sum = 0L
        sum += wordAt(clientIp, 0)
        sum += wordAt(clientIp, 2)
        sum += wordAt(serverIp, 0)
        sum += wordAt(serverIp, 2)
        sum += UDP_PROTOCOL
        sum += udpLength
        sum += sumWords(packet, IP_HEADER_LENGTH, IP_HEADER_LENGTH + udpLength)

        val folded = foldChecksum(sum)
        return if (folded == 0) 0xFFFF else folded
    }

    private fun sumWords(bytes: ByteArray, start: Int, end: Int): Long {
        var sum = 0L
        var cursor = start
        while (cursor < end - 1) {
            sum += wordAt(bytes, cursor)
            cursor += 2
        }
        if (cursor < end) {
            sum += ((bytes[cursor].toInt() and 0xFF) shl 8).toLong()
        }
        return sum
    }

    private fun wordAt(bytes: ByteArray, offset: Int): Long {
        return (((bytes[offset].toInt() and 0xFF) shl 8) or
            (bytes[offset + 1].toInt() and 0xFF)).toLong()
    }

    private fun foldChecksum(sum: Long): Int {
        var folded = sum
        while (folded > 0xFFFF) {
            folded = (folded and 0xFFFF) + (folded shr 16)
        }
        return (folded.inv() and 0xFFFF).toInt()
    }

    private fun startAsForeground() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "FocusLock",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps FocusLock active while you focus"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        manager.createNotificationChannel(channel)

        val guard = ProtectionStore.isGuard(this)
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(if (guard) "FocusLock - وضع صارم مفعّل" else "FocusLock")
            .setContentText(
                if (guard) "الحماية الإباحية مفعّلة بشكل دائم"
                else "Focus mode active - distractions blocked",
            )
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopVpn() {
        if (!running.get()) {
            quarantineActive = false
            return
        }
        stopWorker()
        quarantineActive = false
        ProtectionStore.setActive(this, false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun stopWorker() {
        running.set(false)
        worker?.interrupt()
        worker = null
        try {
            tunnel?.close()
        } catch (_: IOException) {
            // Already closed.
        }
        tunnel = null
    }
}