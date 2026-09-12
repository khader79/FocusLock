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
 * Local VPN that tunnels all traffic and answers DNS queries for blocked
 * domains with NXDOMAIN, so blocked sites cannot be resolved.
 */
class FocusVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.example.focuslock.action.START"
        const val ACTION_STOP = "com.example.focuslock.action.STOP"

        private const val CHANNEL_ID = "focuslock_vpn"
        private const val NOTIFICATION_ID = 1
        private const val DNS_SERVER = "10.0.0.1"
        private const val CLIENT_ADDRESS = "10.0.0.2"
        private const val CLIENT_PREFIX = 32
        private const val MTU = 1280
        private const val IP_HEADER_LENGTH = 20
        private const val UDP_HEADER_LENGTH = 8
        private const val UDP_PROTOCOL = 17
        private const val DNS_PORT = 53
    }

    private val running = AtomicBoolean(false)
    private val blocklist = Blocklist()
    private var tunnel: ParcelFileDescriptor? = null
    private var worker: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopVpn()
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

        val established = Builder()
            .setSession("FocusLock")
            .addAddress(CLIENT_ADDRESS, CLIENT_PREFIX)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(DNS_SERVER)
            .setMtu(MTU)
            .establish()

        if (established == null) {
            stopSelf()
            return
        }

        tunnel = established
        running.set(true)
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

            val packet = buffer.copyOf(read)
            val replacement = handlePacket(packet)
            try {
                output.write(replacement)
                output.flush()
            } catch (_: IOException) {
                break
            }
        }

        stopVpn()
    }

    private fun handlePacket(packet: ByteArray): ByteArray {
        if (packet.size < IP_HEADER_LENGTH) {
            return packet
        }

        val version = (packet[0].toInt() and 0xFF) ushr 4
        val headerLength = (packet[0].toInt() and 0x0F) shl 2
        if (version != 4 || headerLength < IP_HEADER_LENGTH ||
            headerLength + UDP_HEADER_LENGTH > packet.size
        ) {
            return packet
        }

        if ((packet[9].toInt() and 0xFF) != UDP_PROTOCOL) {
            return packet
        }

        if (DnsPacket.getU16(packet, headerLength + 2) != DNS_PORT) {
            return packet
        }

        val dnsStart = headerLength + UDP_HEADER_LENGTH
        val dns = packet.copyOfRange(dnsStart, packet.size)
        if (!DnsPacket.isQuery(dns)) {
            return packet
        }

        val question = DnsPacket.parseQuestion(dns)
        if (question == null || !blocklist.isBlocked(question.name)) {
            return packet
        }

        val nxDomain = DnsPacket.buildNxDomainResponse(dns, question)
        return buildDnsResponsePacket(packet, headerLength, nxDomain)
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

        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("FocusLock")
            .setContentText("Focus mode active - distractions blocked")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopVpn() {
        if (!running.get()) {
            return
        }
        stopWorker()
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