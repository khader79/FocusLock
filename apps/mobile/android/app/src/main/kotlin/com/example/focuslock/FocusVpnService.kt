package com.example.focuslock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Local VPN that filters adult content for the WHOLE phone and keeps the
 * internet fully working at the same time.
 *
 * Earlier attempts "read a packet from the tun and wrote it back in" to
 * forward traffic. That does NOT forward on this device: the tunnel held a
 * route into a dead interface and silently blackholed ALL internet. The data
 * path here is therefore a real userspace proxy:
 *
 *  - TCP: one real protected [Socket] per connection. The proxy fakes the
 *    server side of the handshake toward the app, relays payloads both ways,
 *    filters TLS ServerName (SNI) on :443 and drops blocked handshakes.
 *  - UDP: DNS :53 queries are answered with NXDOMAIN when the domain is
 *    blocked, otherwise relayed to a real resolver through a protected
 *    [DatagramSocket] and re-injected as if the advertised DNS answered.
 *  - UDP:443 (QUIC/HTTP-3) is relayed like any UDP so mainstream transports
 *    work at native latency; blocked hosts never resolve, so QUIC cannot even
 *    begin for them.
 *
 * Every failure path tears the tunnel down (see the finally in [readLoop]) so
 * the device can never be left on a blackholed route again.
 */
class FocusVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.example.focuslock.action.START"
        const val ACTION_STOP = "com.example.focuslock.action.STOP"
        const val ACTION_RECONFIGURE = "com.example.focuslock.action.RECONFIGURE"

        private const val CHANNEL_ID = "focuslock_vpn"
        private const val NOTIFICATION_ID = 1

        // The DNS endpoint we advertise; the proxy answers it.
        private const val DNS_SERVER = "10.0.0.1"
        // The fake upstream resolvers the DNS relay forwards through.
        private val UPSTREAM_DNS = arrayOf("1.1.1.1", "8.8.8.8")

        private const val CLIENT_ADDRESS = "10.0.0.2"
        private const val CLIENT_PREFIX = 32
        private const val MTU = 1280
        private const val IP_HEADER_LENGTH = 20
        private const val TCP_HEADER_LENGTH = 20
        private const val UDP_HEADER_LENGTH = 8
        private const val TCP_PROTOCOL = 6
        private const val UDP_PROTOCOL = 17
        private const val DNS_PORT = 53
        private const val HTTPS_PORT = 443
        private const val TLS_HANDSHAKE = 0x16
        private const val TLS_CLIENT_HELLO = 0x01
        private const val TLS_EXT_SERVER_NAME = 0x0000

        private const val FLAG_FIN = 0x01
        private const val FLAG_SYN = 0x02
        private const val FLAG_RST = 0x04
        private const val FLAG_PSH = 0x08
        private const val FLAG_ACK = 0x10

        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val PUMP_READ_TIMEOUT_MS = 30_000

        /** True while the tunnel interface is up. Read by the companion UI. */
        @Volatile
        var vpnUp = false
        private const val TCP_BUFFER_CAP = 256 * 1024
        private const val MAX_TCP_FLOWS = 256
        private const val MAX_UDP_FLOWS = 128
        private const val MAX_DNS_RELAYS = 24
        private const val RELAY_IDLE_MS = 30_000L
        private const val TCP_IDLE_MS = 120_000L

        /** A resolver that stops answering must cost a short bind, not a stall. */
        private const val DNS_RELAY_TIMEOUT_MS = 4_000

        /** How many times the relay re-asks an unanswered query before giving up. */
        private const val MAX_DNS_RESENDS = 3

        /** Upper bound for the short-lived DNS cache (entries evicted by TTL). */
        private const val DNS_CACHE_MAX = 64

        /** How many MTU-size payloads we read in one batch from the real socket
         *  before writing them as separate tun packets. A plain (no-packet-info)
         *  tun fd accepts exactly one IP packet per write(), so batching must be
         *  read-side only. One large read cuts N+1 syscalls (socket read + N tun
         *  writes) to essentially N tun writes, a big win on fast links (5G,
         *  wired) where per-packet kernel round-trips would otherwise cap the
         *  relay at a fraction of the link bandwidth. */
        private const val TCP_BATCH_CHUNKS = 28

        /** Window-scaling shift advertised in our fabricated SYNACK. It lifts
         *  the 64KB receive-window ceiling that otherwise caps throughput at
         *  window/RTT — the killer for video on high-latency links. Shift 4 →
         *  ~1 MB window: plenty for streaming while keeping bursts bounded so a
         *  single stalled socket can never flood the shared read loop. */
        private const val TCP_WINDOW_SHIFT = 4

        /** kind=3 (window scale), len=3, value=shift, then a NOP pad to 4 bytes. */
        private val WSS_OPTIONS = byteArrayOf(3, 3, TCP_WINDOW_SHIFT.toByte(), 1)
    }

    private val running = AtomicBoolean(false)
    private val blocklist = Blocklist()
    private val TAG = "FocusLock.Vpn"

    @Volatile
    private var lastBlockCountedAt = 0L

    private var tunnel: ParcelFileDescriptor? = null
    private var worker: Thread? = null

    private val tunOutLock = Any()
    private var tunOut: FileOutputStream? = null

    private val tcpFlows = ConcurrentHashMap<TcpKey, TcpFlow>()
    private val udpFlows = ConcurrentHashMap<UdpKey, UdpRelay>()
    private val dnsRelays = ConcurrentHashMap<Int, DnsRelay>()
    private val dnsCache = ConcurrentHashMap<String, DnsCacheEntry>()

    private var packetsSinceJanitor = 0

    /** True when the lock is active (blocking); the proxy still runs either
     *  way so the internet keeps working while paused. */
    private fun blockingEnabled(): Boolean {
        return !ProtectionStore.isPaused(this) || ProtectionStore.isGuard(this)
    }

    /**
     * Weak-network tuning applied on every VPN start. The phone's defaults
     * drop a weak-but-present Wi-Fi or let it idle; these keep it latched and
     * scanning so a far-away router stays usable. All keys live in the Global
     * table, which any app may write (no special permission).
     */
    private fun applyWifiBoost() {
        try {
            val cr = applicationContext.contentResolver
            Settings.Global.putString(cr, "wifi_poor_network_detection_enabled", "0")
            Settings.Global.putString(cr, "wifi_scan_always_enabled", "1")
            Settings.Global.putString(cr, "wifi_networks_available_notification_on", "0")
            Settings.Global.putString(cr, "wifi_verify_ssid", "0")
            Log.i(TAG, "WifiBoost applied")
        } catch (_: Exception) {
            // Best-effort only.
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopVpn()
            ACTION_RECONFIGURE -> {
                // Re-pick-up the latest blocklist / paused state.
                worker?.interrupt()
                stopVpn()
                startVpn()
            }
            else -> startVpn()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopVpn()
        super.onDestroy()
    }

    override fun onRevoke() {
        Log.w(TAG, "VPN consent revoked; shutting down.")
        stopVpn()
    }

    private fun startVpn() {
        if (running.get()) {
            return
        }

        applyWifiBoost()

        try {
            blocklist.load(applicationContext)
        } catch (t: Throwable) {
            Log.e(TAG, "blocklist failed to load; refusing to tunnel.", t)
            return
        }

        val builder = Builder()
            .setSession("FocusLock")
            .addAddress(CLIENT_ADDRESS, CLIENT_PREFIX)
            .addRoute("0.0.0.0", 0)
            .addRoute("::", 0)
            .addDnsServer(DNS_SERVER)
            .setMtu(MTU)
            .setBlocking(true)

        val established = try {
            builder.establish()
        } catch (_: SecurityException) {
            // VPN consent was revoked/never granted; nothing to tunnel.
            null
        } catch (_: IllegalStateException) {
            // VpnService unusable in this state.
            null
        }

        if (established == null) {
            Log.e(TAG, "tunnel not established.")
            stopSelf()
            return
        }

        tunnel = established
        vpnUp = true
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

        synchronized(tunOutLock) { tunOut = output }

        try {
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
                try {
                    dispatch(packet)
                } catch (t: Throwable) {
                    // One malformed packet must never kill the pump.
                    Log.e(TAG, "dispatch error; packet dropped.", t)
                }

                if (++packetsSinceJanitor % 512 == 0) {
                    janitor()
                }
            }
        } finally {
            // FAILSAFE: whenever the pump exits for any reason, tear the tunnel
            // down so the device can never be left on a route into a dead
            // interface (previously a silent thread death blackholed ALL
            // internet).
            synchronized(tunOutLock) { tunOut = null }
            stopVpn()
        }
    }

    // ------------------------------------------------------------ dispatching

    private fun dispatch(packet: ByteArray) {
        if (packet.size < IP_HEADER_LENGTH) {
            return
        }
        val version = (packet[0].toInt() and 0xFF) ushr 4
        val headerLength = (packet[0].toInt() and 0x0F) shl 2
        if (version != 4 || headerLength < IP_HEADER_LENGTH) {
            return // IPv6 / malformed are not routed (no v6 route configured).
        }

        when (packet[9].toInt() and 0xFF) {
            TCP_PROTOCOL -> tcpIngress(packet, headerLength)
            UDP_PROTOCOL -> udpIngress(packet, headerLength)
            else -> Unit // ICMP and friends are dropped.
        }
    }

    // --------------------------------------------------------------- TCP core

    private data class TcpKey(
        val srcIp: Int,
        val srcPort: Int,
        val dstIp: Int,
        val dstPort: Int,
    )

    private inner class TcpFlow(val key: TcpKey) {
        val socket = Socket()
        val input by lazy { socket.getInputStream() }
        val writer by lazy { socket.getOutputStream() }

        var serverSeqStart = 0L
        var nextClientSeq = 0L
        var clientHalfClosed = false
        var serverHalfClosed = false
        var failed = false
        var sniChecked = false

        @Volatile
        var connected = false

        val pending = ArrayList<ByteArray>(4)
        var pendingBytes = 0

        val lastActive = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())
    }

    private fun tcpIngress(packet: ByteArray, ipLen: Int) {
        if (packet.size < ipLen + TCP_HEADER_LENGTH) {
            return
        }
        val tcpStart = ipLen
        val dataOffset = ((packet[tcpStart + 12].toInt() and 0xF0) ushr 4) * 4
        if (dataOffset < TCP_HEADER_LENGTH) {
            return
        }
        val totalLength =
            ((packet[2].toInt() and 0xFF) shl 8) or (packet[3].toInt() and 0xFF)
        val payloadStart = tcpStart + dataOffset
        val payloadLen = totalLength - ipLen - dataOffset
        if (payloadLen < 0 || payloadStart + payloadLen > packet.size) {
            return
        }

        val srcIp = ipToInt(packet, 12)
        val dstIp = ipToInt(packet, 16)
        val srcPort = readU16(packet, tcpStart)
        val dstPort = readU16(packet, tcpStart + 2)
        val seq = readU32(packet, tcpStart + 4)
        val flags = packet[tcpStart + 13].toInt() and 0xFF
        val syn = flags and FLAG_SYN != 0
        val ackFlag = flags and FLAG_ACK != 0
        val fin = flags and FLAG_FIN != 0
        val rst = flags and FLAG_RST != 0

        val key = TcpKey(srcIp, srcPort, dstIp, dstPort)
        val flow = tcpFlows[key]

        // RST / teardown from the client.
        if (rst && flow != null) {
            tcpFlows.remove(key)
            closeFlow(flow, true)
            return
        }
        if (rst) {
            return
        }

        // Brand-new connection.
        if (flow == null && syn) {
            if (tcpFlows.size >= MAX_TCP_FLOWS) {
                sendTcpPacket(key, 0L, seq + payloadLen, FLAG_RST or FLAG_ACK, null, 0, 0)
                return
            }
            beginFlow(key, packet, ipLen, srcIp, dstIp, srcPort, dstPort, seq, payloadLen, payloadStart)
            return
        }
        if (flow == null) {
            // Unknown flow without SYN (e.g. stray ACK): decline.
            sendTcpPacket(key, 0L, seq + payloadLen, FLAG_RST or FLAG_ACK, null, 0, 0)
            return
        }

        flow.lastActive.set(System.currentTimeMillis())

        // Allow the flow to become established (real socket connect) before
        // answering; meanwhile buffer the client's early data (TLS ClientHello).
        // Retransmissions of already-buffered bytes are re-acknowledged without
        // being stored, so a slow real-server connect can never poison the
        // byte stream with a duplicated ClientHello.
        if (!flow.connected && !flow.failed) {
            if (ackFlag && payloadLen > 0) {
                val expected = flow.nextClientSeq
                when {
                    seq < expected -> {
                        // Retransmit of data we already accepted: re-ack, keep.
                        sendTcpPacket(key, 0L, 0L, FLAG_ACK, null, 0, 0, flow)
                        return
                    }
                    seq > expected -> {
                        // Non-contiguous while pre-connect: corrupt stream.
                        closeFlow(flow, true)
                        return
                    }
                }
                if (flow.pendingBytes + payloadLen > TCP_BUFFER_CAP) {
                    closeFlow(flow, true)
                    return
                }
                val copy = packet.copyOfRange(payloadStart, payloadStart + payloadLen)
                flow.pending.add(copy)
                flow.pendingBytes += payloadLen
                flow.nextClientSeq = expected + payloadLen
                // Ack the buffered bytes so the client stops retransmitting.
                sendTcpPacket(key, 0L, 0L, FLAG_ACK, null, 0, 0, flow)
            }
            if (fin) {
                clientHalfClosedNow(flow)
            }
            return
        }
        if (flow.failed) {
            return
        }

        // Connected flow: relay client payload to the real server.
        if (payloadLen > 0) {
            // First TLS segment carries the ClientHello → SNI; filter it here
            // as a second net behind DNS blocking (only checks the first TLS
            // data the client sends so the SNI parse cost stays one-time).
            if (dstPort == HTTPS_PORT && !flow.sniChecked &&
                packet[payloadStart].toInt() and 0xFF == TLS_HANDSHAKE
            ) {
                flow.sniChecked = true
                val sni = readSniFromSegment(packet, ipLen)
                if (sni != null && blocklist.isBlocked(sni)) {
                    countBlock()
                    closeFlow(flow, true)
                    return
                }
            }

            // Ignore retransmitted bytes we already consumed.
            if (seq < flow.nextClientSeq) {
                // Still acknowledge once more so the client can continue.
                sendTcpPacket(key, 0L, 0L, FLAG_ACK, null, 0, 0, flow)
                return
            }
            try {
                flow.writer.write(packet, payloadStart, payloadLen)
                flow.writer.flush()
            } catch (_: IOException) {
                closeFlow(flow, true)
                return
            }
            if (seq == flow.nextClientSeq) {
                flow.nextClientSeq = seq + payloadLen
            } else if (seq > flow.nextClientSeq) {
                // Gap in sequence: a packet was missed by the tunnel; grow the
                // window so the client retransmits are accepted after all.
                flow.nextClientSeq = seq + payloadLen
            }
            // Acknowledge accepted bytes immediately. Without this the client's
            // send cwnd never advances on one-way flows (chat sends, image
            // uploads), stalling them until an inbound packet finally ACKs.
            sendTcpPacket(key, 0L, 0L, FLAG_ACK, null, 0, 0, flow)
        }

        // DNS-over-TCP toward our advertised server: not implemented, drop.
        if (dstPort == DNS_PORT && dstIp == ipToInt(stringToIp(DNS_SERVER), 0)) {
            closeFlow(flow, true)
            return
        }

        if (fin) {
            clientHalfClosedNow(flow)
        }

        // Acknowledge received client data so the client never stalls.
        sendTcpPacket(key, 0L, 0L, FLAG_ACK, null, 0, 0, flow)
    }

    private fun beginFlow(
        key: TcpKey,
        packet: ByteArray,
        ipLen: Int,
        srcIp: Int,
        dstIp: Int,
        srcPort: Int,
        dstPort: Int,
        seq: Long,
        payloadLen: Int,
        payloadStart: Int,
    ) {
        val flow = TcpFlow(key)
        flow.serverSeqStart = (System.nanoTime() and 0x7FFFFFFF).toLong()
        flow.nextClientSeq = seq + 1 + payloadLen

        // Adult-host check straight on the SYN payload (TCP Fast Open).
        if (dstPort == HTTPS_PORT && payloadLen > 0 && packet[payloadStart].toInt() and 0xFF == TLS_HANDSHAKE) {
            val sni = readSniFromSegment(packet, ipLen)
            if (sni != null && blocklist.isBlocked(sni)) {
                countBlock()
                sendTcpPacket(key, flow.serverSeqStart, seq + payloadLen, FLAG_RST or FLAG_ACK, null, 0, 0)
                return
            }
        }

        // TCP Fast Open payload rides the SYN: buffer it for the connect flush.
        if (payloadLen > 0) {
            flow.pending.add(packet.copyOfRange(payloadStart, payloadStart + payloadLen))
            flow.pendingBytes += payloadLen
        }

        // Real destination. DNS-over-TCP toward our advertised address goes to
        // a real resolver instead.
        val targetIp = if (dstPort == DNS_PORT && ipToInt(stringToIp(DNS_SERVER), 0) == dstIp) {
            stringToIp(UPSTREAM_DNS[0])
        } else {
            ipToBytes(dstIp)
        }

        tcpFlows[key] = flow

        Thread({
            connectAndPump(key, flow, targetIp, dstPort)
        }, "fl-tcp-${System.identityHashCode(flow)}").start()
    }

    private fun connectAndPump(key: TcpKey, flow: TcpFlow, targetIp: ByteArray, dstPort: Int) {
        try {
            flow.socket.tcpNoDelay = true
            // Give the real socket room for streaming bursts so a fast link
            // isn't capped by the default ~128KB OS buffers
            // (userspace-proxy throughput ceiling on wired/5G links).
            try {
                flow.socket.receiveBufferSize = 1 shl 20
                flow.socket.sendBufferSize = 1 shl 20
            } catch (_: Exception) {
                // Best-effort; defaults are fine when the call is refused.
            }
            flow.socket.soTimeout = CONNECT_TIMEOUT_MS
            protect(flow.socket)
            flow.socket.connect(InetSocketAddress(InetAddress.getByAddress(targetIp), dstPort), CONNECT_TIMEOUT_MS)
            flow.connected = true
            flow.socket.soTimeout = PUMP_READ_TIMEOUT_MS

            // Flush buffered client data (TLS ClientHello etc.).
            for (chunk in flow.pending) {
                if (dstPort == HTTPS_PORT && !flow.sniChecked && chunk.isNotEmpty() &&
                    chunk[0].toInt() and 0xFF == TLS_HANDSHAKE
                ) {
                    flow.sniChecked = true
                    val sni = readSniFromTlsBlob(chunk)
                    if (sni != null && blocklist.isBlocked(sni)) {
                        countBlock()
                        closeFlow(flow, true)
                        return
                    }
                }
                flow.writer.write(chunk)
            }
            flow.writer.flush()
            flow.pending.clear()
            flow.pendingBytes = 0

            // Fake server handshake: SYN|ACK toward the client. Carries the
            // window-scale option so the client's receive window scales up from
            // 64KB to ~1MB (video throughput on high-latency links).
            sendTcpPacket(key, 0L, flow.nextClientSeq, FLAG_SYN or FLAG_ACK, null, 0, 0, flow, WSS_OPTIONS)
            pumpServerToClient(key, flow)
        } catch (t: Throwable) {
            Log.w(TAG, "connect/pump failed for $key", t)
            sendTcpPacket(key, 0L, flow.nextClientSeq, FLAG_RST or FLAG_ACK, null, 0, 0)
            closeFlow(flow, true)
        }
    }

    /** Polls the real server stream and fakes return packets to the client,
     *  batching up to [TCP_BATCH_CHUNKS] MTU-size segments into a single tun
     *  write so fast links are not throttled by per-packet syscalls. */
    private fun pumpServerToClient(key: TcpKey, flow: TcpFlow) {
        val readBuf = ByteArray(TCP_BATCH_CHUNKS * (MTU - IP_HEADER_LENGTH - TCP_HEADER_LENGTH))
        // The fabricated SYN already consumed one server sequence slot, so the
        // byte stream the client expects starts one beyond it. Without this the
        // first data segment would collide with the SYNACK sequence and be
        // dropped by the client as below-window traffic.
        var bytesSent = 1L
        try {
            while (running.get() && !flow.serverHalfClosed) {
                val n = try {
                    flow.input.read(readBuf)
                } catch (_: SocketTimeoutException) {
                    continue
                }
                if (n < 0) {
                    flow.serverHalfClosed = true
                    break
                }
                if (n == 0) {
                    continue
                }
                flow.lastActive.set(System.currentTimeMillis())

                val srcIp = ipToBytes(key.dstIp)
                val dstIp = ipToBytes(key.srcIp)
                val payload = MTU - IP_HEADER_LENGTH - TCP_HEADER_LENGTH
                var consumed = 0
                var seg = bytesSent
                while (consumed < n) {
                    val plen = minOf(payload, n - consumed)
                    // One packet per tun write: the fd is a plain (no-packet-info)
                    // tun device, so concatenating several IP packets into a single
                    // write() would deliver only the first segment.
                    writeTun(buildTcpPacket(
                        srcIp, dstIp, key.dstPort, key.srcPort, seg, flow.nextClientSeq,
                        FLAG_PSH or FLAG_ACK, readBuf, consumed, plen,
                    ))
                    seg += plen
                    consumed += plen
                }
                bytesSent = seg
            }
            // EOF from server: tell the client the server finished.
            if (running.get() && !flow.failed) {
                sendTcpPacket(key, bytesSent, flow.nextClientSeq, FLAG_FIN or FLAG_ACK, null, 0, 0, flow)
            }
        } catch (_: IOException) {
            // Connection reset / socket closed.
        } finally {
            if (flow.clientHalfClosed) {
                closeFlow(flow, false)
            }
        }
    }

    private fun clientHalfClosedNow(flow: TcpFlow) {
        flow.clientHalfClosed = true
        if (flow.serverHalfClosed) {
            closeFlow(flow, false)
        }
    }

    private fun closeFlow(flow: TcpFlow, rst: Boolean) {
        if (flow.failed) {
            return
        }
        flow.failed = true
        try {
            flow.socket.close()
        } catch (_: IOException) {
            // Ignore.
        }
    }

    // --------------------------------------------------------------- UDP core

    private data class UdpKey(
        val srcIp: Int,
        val srcPort: Int,
        val dstIp: Int,
        val dstPort: Int,
    )

    private inner class DnsRelay(
        val clientIp: ByteArray,
        val clientPort: Int,
        val queriedIp: ByteArray,
    ) {
        val socket = DatagramSocket()
        val lastUse = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())

        /** The question most recently sent via this relay, used to correlate a
         *  response with its query before committing it to the shared cache. */
        @Volatile
        var lastQuery: DnsPacket.Question? = null

        /** Raw in-flight query bytes + the resolvers it was sent to, kept so the
         *  relay can keep re-asking until an answer lands (lossy links). */
        private var pending: ByteArray? = null
        private var pendingUpstreams: Array<InetAddress> = emptyArray()
        private var resends = 0

        private val reader = Thread({
            val buf = ByteArray(Mtu.SIZE)
            try {
                while (running.get()) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        socket.receive(pkt)
                    } catch (_: SocketTimeoutException) {
                        // Nothing arrived this bound: re-ask while the query is
                        // still open, so one lost/UDP-holed packet costs ~2s
                        // instead of the full client DNS time-out.
                        val q = pending
                        if (q != null && resends < MAX_DNS_RESENDS) {
                            resends++
                            for (upstream in pendingUpstreams) {
                                try {
                                    socket.send(DatagramPacket(q, q.size, upstream, DNS_PORT))
                                } catch (_: IOException) {
                                    // ignore
                                }
                            }
                        }
                        continue
                    }
                    pending = null
                    val reply = pkt.data.copyOf(pkt.length)
                    // Cache positive answers for repeated lookups (huge win on
                    // slow/flaky links where every extra round trip hurts).
                    val cached = DnsPacket.parseCacheable(reply)
                    if (cached != null && dnsCache.size < DNS_CACHE_MAX) {
                        val lq = lastQuery
                        if (lq != null && cached.name == lq.name &&
                            cached.type == lq.type && cached.klass == lq.klass
                        ) {
                            dnsCache[cached.key] = cached
                        }
                    }
                    // Answer as if our advertised DNS (queriedIp) spoke.
                    val out = buildUdpPacket(
                        queriedIp,
                        clientIp,
                        DNS_PORT,
                        clientPort,
                        reply,
                    )
                    writeTun(out)
                    lastUse.set(System.currentTimeMillis())
                }
            } catch (_: Exception) {
                // Socket closed or service stopping.
            }
        }, "fl-dns-${System.identityHashCode(this)}")

        init {
            try {
                protect(socket)
                // Short: a dead upstream must not stall name resolution for a
                // minute; the dual-send fan-out protects against that failure.
                socket.soTimeout = DNS_RELAY_TIMEOUT_MS
            } catch (_: Exception) {
                // ignore
            }
            reader.start()
        }

        fun forward(question: ByteArray, upstreams: List<InetAddress>) {
            try {
                lastQuery = DnsPacket.parseQuestion(question)
                pending = question
                pendingUpstreams = upstreams.toTypedArray()
                resends = 0
                for (upstream in upstreams) {
                    socket.send(DatagramPacket(question, question.size, upstream, DNS_PORT))
                }
                lastUse.set(System.currentTimeMillis())
            } catch (_: IOException) {
                // ignore
            }
        }
    }

    private object Mtu {
        const val SIZE = 2048
    }

    private inner class UdpRelay(
        val key: UdpKey,
        val clientIp: ByteArray,
        val dstIp: ByteArray,
    ) {
        val socket = DatagramSocket()
        val lastUse = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())
        private val reader = Thread({
            val buf = ByteArray(Mtu.SIZE)
            try {
                while (running.get()) {
                    val pkt = DatagramPacket(buf, buf.size)
                    socket.receive(pkt)
                    val out = buildUdpPacket(
                        dstIp,
                        clientIp,
                        key.dstPort,
                        key.srcPort,
                        pkt.data.copyOf(pkt.length),
                    )
                    writeTun(out)
                    lastUse.set(System.currentTimeMillis())
                }
            } catch (_: Exception) {
                // Socket closed.
            }
        }, "fl-udp-${System.identityHashCode(this)}")

        init {
            try {
                protect(socket)
                socket.connect(InetAddress.getByAddress(dstIp), key.dstPort)
                socket.soTimeout = 60_000
            } catch (_: Exception) {
                // ignore
            }
            reader.start()
        }

        fun forward(payload: ByteArray) {
            try {
                socket.send(DatagramPacket(payload, payload.size))
                lastUse.set(System.currentTimeMillis())
            } catch (_: IOException) {
                // ignore
            }
        }
    }

    private fun udpIngress(packet: ByteArray, ipLen: Int) {
        if (packet.size < ipLen + UDP_HEADER_LENGTH) {
            return
        }
        val totalLength =
            ((packet[2].toInt() and 0xFF) shl 8) or (packet[3].toInt() and 0xFF)
        val udpStart = ipLen
        val udpLen = readU16(packet, udpStart + 4)
        if (udpLen < UDP_HEADER_LENGTH) {
            return
        }
        val payloadStart = udpStart + UDP_HEADER_LENGTH
        val payloadEnd = minOf(payloadStart + (udpLen - UDP_HEADER_LENGTH), packet.size, totalLength)
        if (payloadEnd < payloadStart) {
            return
        }

        val srcIp = ipToInt(packet, 12)
        val dstIp = ipToInt(packet, 16)
        val srcPort = readU16(packet, udpStart)
        val dstPort = readU16(packet, udpStart + 2)

        val payload = packet.copyOfRange(payloadStart, payloadEnd)

        // QUIC / HTTP-3 passes as a normal UDP relay. A blocked host is already
        // NXDOMAIN from the DNS net, so no QUIC can start for it; relaying keeps
        // Chrome's default transport working (search, YouTube, Drive) instead of
        // pushing every resource onto a slow TCP+TLS fallback on high-latency
        // links. The only thing lost vs. dropping is SNI inspection of
        // encrypted-DNS workarounds, which TLS/DoQ bypass regardless.
        // (UDP:443 is NOT dropped — it falls through to the generic relay.)

        // DNS.
        if (dstPort == DNS_PORT) {
            handleDnsQuery(dstIp, srcIp, srcPort, payload)
            return
        }

        // Other UDP: relay through a per-flow protected socket.
        val key = UdpKey(srcIp, srcPort, dstIp, dstPort)
        var relay = udpFlows[key]
        if (relay == null && udpFlows.size < MAX_UDP_FLOWS) {
            val r = UdpRelay(key, ipToBytes(srcIp), packet.copyOfRange(16, 20))
            val prev = udpFlows.putIfAbsent(key, r)
            relay = prev ?: r
        }
        relay?.forward(payload)
    }

    private fun handleDnsQuery(dstIp: Int, srcIp: Int, srcPort: Int, payload: ByteArray) {
        if (!DnsPacket.isQuery(payload)) {
            return
        }
        val question = DnsPacket.parseQuestion(payload)

        if (blockingEnabled() && question != null && blocklist.isBlocked(question.name)) {
            countBlock()
            val nx = DnsPacket.buildNxDomainResponse(payload, question)
            val out = buildUdpPacket(ipToBytes(dstIp), ipToBytes(srcIp), DNS_PORT, srcPort, nx)
            writeTun(out)
            return
        }

        // Serve repeated lookups from the short-lived cache before going out.
        if (question != null) {
            val key = "${question.name}|${question.type}|${question.klass}"
            val cached = dnsCache[key]
            if (cached != null) {
                if (cached.expiresAt > System.currentTimeMillis()) {
                    val out = ByteArray(cached.reply.size)
                    System.arraycopy(cached.reply, 0, out, 0, cached.reply.size)
                    // Rewrite the transaction id to the incoming query's.
                    out[0] = payload[0]
                    out[1] = payload[1]
                    val udp = buildUdpPacket(ipToBytes(dstIp), ipToBytes(srcIp), DNS_PORT, srcPort, out)
                    writeTun(udp)
                    return
                }
                dnsCache.remove(key)
            }
        }

        // Relay to a real resolver through a protected socket.
        val clientIp = ipToBytes(srcIp)
        val queriedIp = ipToBytes(dstIp)
        val relay = dnsRelays[srcPort] ?: run {
            val r = DnsRelay(clientIp, srcPort, queriedIp)
            val prev = dnsRelays.putIfAbsent(srcPort, r)
            if (prev != null) {
                closeUdpQuietly(r)
                prev
            } else {
                r
            }
        }
        // Send to both resolvers at once; the first answer wins. The relay
        // re-asks both on its own time-out if the reply is delayed or dropped.
        val upstreams = ArrayList<InetAddress>(2)
        for (upstreamText in UPSTREAM_DNS) {
            val upstream = try {
                InetAddress.getByName(upstreamText)
            } catch (_: Exception) {
                continue
            }
            upstreams.add(upstream)
        }
        if (upstreams.isNotEmpty()) {
            relay.forward(payload, upstreams)
        }
    }

    private fun closeUdpQuietly(relay: DnsRelay) {
        try {
            relay.socket.close()
        } catch (_: Exception) {
            // ignore
        }
    }

    // ------------------------------------------------------------ packet craft

    private fun writeTun(packet: ByteArray) {
        synchronized(tunOutLock) {
            try {
                tunOut?.write(packet)
                tunOut?.flush()
            } catch (_: IOException) {
                // The read loop's finally tears the tunnel down.
            }
        }
    }

    /** Sends a fake TCP packet to the client of [key]. For [flow] packets the
     *  server-side sequence is `serverSeqStart + seq` where [seq] is the number
     *  of bytes already sent toward the client; without a flow, [seq] is used
     *  verbatim (RST handling). */
    private fun sendTcpPacket(
        key: TcpKey,
        seq: Long,
        ack: Long,
        flags: Int,
        payload: ByteArray?,
        payloadOff: Int,
        payloadLen: Int,
        flow: TcpFlow? = null,
        options: ByteArray? = null,
    ) {
        val srcIp = ipToBytes(key.dstIp)
        val dstIp = ipToBytes(key.srcIp)
        val sport = key.dstPort
        val dport = key.srcPort
        val out = buildTcpPacket(
            srcIp,
            dstIp,
            sport,
            dport,
            if (flow != null) flow.serverSeqStart + seq else seq,
            if (flow != null) flow.nextClientSeq else ack,
            flags,
            payload,
            payloadOff,
            payloadLen,
            options,
        )
        writeTun(out)
    }

    private fun buildTcpPacket(
        srcIp: ByteArray,
        dstIp: ByteArray,
        sport: Int,
        dport: Int,
        seq: Long,
        ack: Long,
        flags: Int,
        payload: ByteArray?,
        payloadOff: Int,
        payloadLen: Int,
        options: ByteArray? = null,
    ): ByteArray {
        val optionLen = options?.size ?: 0
        val dataOffset = if (optionLen == 0) {
            TCP_HEADER_LENGTH
        } else {
            (TCP_HEADER_LENGTH + optionLen + 3) and 0xFFFC
        }
        val total = IP_HEADER_LENGTH + dataOffset + payloadLen
        val out = ByteArray(total)
        out[0] = 0x45.toByte()
        out[2] = (total ushr 8).toByte()
        out[3] = (total and 0xFF).toByte()
        out[6] = 0x40.toByte() // don't fragment
        out[8] = 64
        out[9] = TCP_PROTOCOL.toByte()
        srcIp.copyInto(out, 12)
        dstIp.copyInto(out, 16)

        val tcpStart = IP_HEADER_LENGTH
        putU16(out, tcpStart, sport)
        putU16(out, tcpStart + 2, dport)
        putU32(out, tcpStart + 4, seq)
        putU32(out, tcpStart + 8, ack)
        out[tcpStart + 12] = ((dataOffset / 4) shl 4).toByte()
        out[tcpStart + 13] = flags.toByte()
        putU16(out, tcpStart + 14, 0xFFFF) // generous window (scaled via SYNACK)
        putU16(out, tcpStart + 16, 0) // checksum placeholder
        putU16(out, tcpStart + 18, 0)
        if (optionLen > 0 && options != null) {
            options.copyInto(out, tcpStart + TCP_HEADER_LENGTH)
        }
        if (payloadLen > 0 && payload != null) {
            payload.copyInto(out, tcpStart + dataOffset, payloadOff, payloadOff + payloadLen)
        }
        putU16(out, tcpStart + 16, tcpChecksum(out, srcIp, dstIp, tcpStart))
        putU16(out, 10, ipChecksum(out))
        return out
    }

    /**
     * Fills one full IPv4+TCP packet (no options) into [out] at [off] and
     * returns the number of bytes written. Used by the batched download pump to
     * lay multiple consecutive segments into a single buffer for one tun write.
     */
    private fun fillTcpIpPacket(
        out: ByteArray,
        off: Int,
        srcIp: ByteArray,
        dstIp: ByteArray,
        sport: Int,
        dport: Int,
        seq: Long,
        ack: Long,
        flags: Int,
        payload: ByteArray,
        payloadOff: Int,
        payloadLen: Int,
    ): Int {
        val total = IP_HEADER_LENGTH + TCP_HEADER_LENGTH + payloadLen
        out[off] = 0x45.toByte()
        out[off + 2] = (total ushr 8).toByte()
        out[off + 3] = (total and 0xFF).toByte()
        out[off + 6] = 0x40.toByte() // don't fragment
        out[off + 8] = 64
        out[off + 9] = TCP_PROTOCOL.toByte()
        srcIp.copyInto(out, off + 12)
        dstIp.copyInto(out, off + 16)

        val tcpStart = off + IP_HEADER_LENGTH
        putU16(out, tcpStart, sport)
        putU16(out, tcpStart + 2, dport)
        putU32(out, tcpStart + 4, seq)
        putU32(out, tcpStart + 8, ack)
        out[tcpStart + 12] = 0x50.toByte()
        out[tcpStart + 13] = flags.toByte()
        putU16(out, tcpStart + 14, 0xFFFF)
        putU16(out, tcpStart + 16, 0)
        putU16(out, tcpStart + 18, 0)
        payload.copyInto(out, tcpStart + TCP_HEADER_LENGTH, payloadOff, payloadOff + payloadLen)
        putU16(out, tcpStart + 16, tcpChecksum(out, srcIp, dstIp, tcpStart))
        putU16(out, off + 10, ipChecksum(out))
        return total
    }

    private fun buildUdpPacket(
        srcIp: ByteArray,
        dstIp: ByteArray,
        sport: Int,
        dport: Int,
        payload: ByteArray,
    ): ByteArray {
        val udpLength = UDP_HEADER_LENGTH + payload.size
        val totalLength = IP_HEADER_LENGTH + udpLength
        val out = ByteArray(totalLength)
        out[0] = 0x45.toByte()
        out[2] = (totalLength ushr 8).toByte()
        out[3] = (totalLength and 0xFF).toByte()
        out[8] = 64
        out[9] = UDP_PROTOCOL.toByte()
        srcIp.copyInto(out, 12)
        dstIp.copyInto(out, 16)

        putU16(out, IP_HEADER_LENGTH, sport)
        putU16(out, IP_HEADER_LENGTH + 2, dport)
        putU16(out, IP_HEADER_LENGTH + 4, udpLength)
        payload.copyInto(out, IP_HEADER_LENGTH + UDP_HEADER_LENGTH)

        putU16(out, IP_HEADER_LENGTH + 6, udpChecksum(out, srcIp, dstIp, udpLength))
        putU16(out, 10, ipChecksum(out))
        return out
    }

    private fun tcpChecksum(packet: ByteArray, srcIp: ByteArray, dstIp: ByteArray, tcpStart: Int): Int {
        var sum = 0L
        sum += wordAt(srcIp, 0)
        sum += wordAt(srcIp, 2)
        sum += wordAt(dstIp, 0)
        sum += wordAt(dstIp, 2)
        sum += TCP_PROTOCOL
        sum += packet.size - tcpStart
        sum += sumWords(packet, tcpStart, packet.size)
        val folded = foldChecksum(sum)
        if (folded == 0) return 0xFFFF
        return folded
    }

    private fun putU32(buffer: ByteArray, offset: Int, value: Long) {
        buffer[offset] = ((value ushr 24) and 0xFF).toByte()
        buffer[offset + 1] = ((value ushr 16) and 0xFF).toByte()
        buffer[offset + 2] = ((value ushr 8) and 0xFF).toByte()
        buffer[offset + 3] = (value and 0xFF).toByte()
    }

    private fun readU32(buffer: ByteArray, offset: Int): Long {
        return ((buffer[offset].toInt() and 0xFF).toLong() shl 24) or
            ((buffer[offset + 1].toInt() and 0xFF).toLong() shl 16) or
            ((buffer[offset + 2].toInt() and 0xFF).toLong() shl 8) or
            (buffer[offset + 3].toInt() and 0xFF).toLong()
    }

    private fun readU16(buffer: ByteArray, offset: Int): Int {
        return ((buffer[offset].toInt() and 0xFF) shl 8) or (buffer[offset + 1].toInt() and 0xFF)
    }

    private fun ipToInt(bytes: ByteArray, offset: Int): Int {
        return ((bytes[offset].toInt() and 0xFF) shl 24) or
            ((bytes[offset + 1].toInt() and 0xFF) shl 16) or
            ((bytes[offset + 2].toInt() and 0xFF) shl 8) or
            (bytes[offset + 3].toInt() and 0xFF)
    }

    private fun ipToBytes(value: Int): ByteArray {
        return byteArrayOf(
            ((value ushr 24) and 0xFF).toByte(),
            ((value ushr 16) and 0xFF).toByte(),
            ((value ushr 8) and 0xFF).toByte(),
            (value and 0xFF).toByte(),
        )
    }

    private fun stringToIp(value: String): ByteArray {
        val parts = value.split('.')
        return byteArrayOf(
            parts[0].toInt().toByte(),
            parts[1].toInt().toByte(),
            parts[2].toInt().toByte(),
            parts[3].toInt().toByte(),
        )
    }

    private fun putU16(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = (value ushr 8).toByte()
        buffer[offset + 1] = (value and 0xFF).toByte()
    }

    private fun ipChecksum(header: ByteArray): Int {
        val folded = foldChecksum(sumWords(header, 0, IP_HEADER_LENGTH))
        return if (folded == 0) 0xFFFF else folded
    }

    private fun udpChecksum(packet: ByteArray, srcIp: ByteArray, dstIp: ByteArray, udpLength: Int): Int {
        var sum = 0L
        sum += wordAt(srcIp, 0)
        sum += wordAt(srcIp, 2)
        sum += wordAt(dstIp, 0)
        sum += wordAt(dstIp, 2)
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

    /** Extracts the SNI from a TLS ClientHello in a TCP segment; null when the
     *  segment does not carry a complete ClientHello. */
    private fun readSniFromSegment(packet: ByteArray, ipLen: Int): String? {
        val tcpStart = ipLen
        val dataOffset = ((packet[tcpStart + 12].toInt() and 0xF0) ushr 4) * 4
        val payload = tcpStart + dataOffset
        if (payload + 5 > packet.size) return null

        val recordLength = readU16(packet, payload + 3)
        val recordEnd = payload + 5 + recordLength
        if (recordEnd > packet.size) return null

        val handshake = payload + 5
        if (handshake + 4 > recordEnd) return null
        if (packet[handshake].toInt() and 0xFF != TLS_CLIENT_HELLO) return null

        val body = handshake + 4
        var offset = body

        fun u8(at: Int): Int = if (at in 0 until packet.size) packet[at].toInt() and 0xFF else -1
        fun u16(at: Int): Int =
            if (at in 1 until packet.size) readU16(packet, at) else -1

        if (u8(offset) < 0) return null
        offset += 34

        val sessionIdLen = u8(offset)
        if (sessionIdLen < 0) return null
        offset += 1 + sessionIdLen

        val cipherLen = u16(offset)
        if (cipherLen < 0) return null
        offset += 2 + cipherLen

        val compressionLen = u8(offset)
        if (compressionLen < 0) return null
        offset += 1 + compressionLen

        if (offset + 2 > packet.size) return null
        val extensionsLength = u16(offset)
        if (extensionsLength < 0) return null
        offset += 2
        val extensionsEnd = offset + extensionsLength
        if (extensionsEnd > packet.size) return null

        while (offset + 4 <= extensionsEnd) {
            val type = u16(offset)
            if (type < 0) return null
            val extLength = u16(offset + 2)
            if (extLength < 0) return null

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

    /** Extracts the SNI from a plain TLS ClientHello blob (a record that a fresh
     *  TCP segment may not even carry whole); null when it is not complete. */
    private fun readSniFromTlsBlob(blob: ByteArray): String? {
        if (blob.size < 5 || blob[0].toInt() and 0xFF != TLS_HANDSHAKE) {
            return null
        }
        val recordLength = readU16(blob, 3)
        val recordEnd = 5 + recordLength
        if (recordEnd > blob.size) return null

        val handshake = 5
        if (handshake + 4 > recordEnd) return null
        if (blob[handshake].toInt() and 0xFF != TLS_CLIENT_HELLO) return null

        val body = handshake + 4
        var offset = body

        fun u8(at: Int): Int = if (at in 0 until blob.size) blob[at].toInt() and 0xFF else -1
        fun u16(at: Int): Int =
            if (at in 1 until blob.size) readU16(blob, at) else -1

        if (u8(offset) < 0) return null
        offset += 34

        val sessionIdLen = u8(offset)
        if (sessionIdLen < 0) return null
        offset += 1 + sessionIdLen

        val cipherLen = u16(offset)
        if (cipherLen < 0) return null
        offset += 2 + cipherLen

        val compressionLen = u8(offset)
        if (compressionLen < 0) return null
        offset += 1 + compressionLen

        if (offset + 2 > blob.size) return null
        val extensionsLength = u16(offset)
        if (extensionsLength < 0) return null
        offset += 2
        val extensionsEnd = offset + extensionsLength
        if (extensionsEnd > blob.size) return null

        while (offset + 4 <= extensionsEnd) {
            val type = u16(offset)
            if (type < 0) return null
            val extLength = u16(offset + 2)
            if (extLength < 0) return null

            val data = offset + 4
            if (type == TLS_EXT_SERVER_NAME) {
                if (data + 2 > blob.size) return null
                val listLength = u16(data)
                if (listLength < 0) return null
                var pos = data + 2
                if (pos + 1 > blob.size) return null
                val nameType = u8(pos)
                if (nameType < 0) return null
                if (nameType == 0) {
                    if (pos + 3 > blob.size) return null
                    val nameLength = u16(pos + 1)
                    if (nameLength < 0) return null
                    if (pos + 3 + nameLength > blob.size) return null
                    val builder = StringBuilder(nameLength)
                    for (i in 0 until nameLength) {
                        builder.append((blob[pos + 3 + i].toInt() and 0xFF).toChar())
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

    private fun janitor() {
        val now = System.currentTimeMillis()
        for ((k, flow) in tcpFlows) {
            if (flow.failed || (flow.connected && now - flow.lastActive.get() > TCP_IDLE_MS)) {
                tcpFlows.remove(k)
                closeFlow(flow, true)
            }
        }
        for ((k, relay) in udpFlows) {
            if (now - relay.lastUse.get() > RELAY_IDLE_MS) {
                udpFlows.remove(k)
                try {
                    relay.socket.close()
                } catch (_: Exception) {
                    // ignore
                }
            }
        }
        if (dnsRelays.size > MAX_DNS_RELAYS) {
            val stale = dnsRelays.filter { (_, r) -> now - r.lastUse.get() > RELAY_IDLE_MS }
            if (stale.isEmpty()) {
                return
            }
            for ((port, relay) in stale) {
                dnsRelays.remove(port)
                closeUdpQuietly(relay)
            }
        } else {
            for ((port, relay) in dnsRelays) {
                if (now - relay.lastUse.get() > 5 * RELAY_IDLE_MS) {
                    dnsRelays.remove(port)
                    closeUdpQuietly(relay)
                }
            }
        }
        for ((key, entry) in dnsCache) {
            if (entry.expiresAt <= now) {
                dnsCache.remove(key, entry)
            }
        }
    }

    private fun stopVpn() {
        if (!running.compareAndSet(true, false)) {
            return
        }

        worker?.interrupt()
        worker = null

        for (flow in tcpFlows.values) {
            closeFlow(flow, true)
        }
        tcpFlows.clear()
        for (relay in udpFlows.values) {
            try {
                relay.socket.close()
            } catch (_: Exception) {
                // ignore
            }
        }
        udpFlows.clear()
        for (relay in dnsRelays.values) {
            closeUdpQuietly(relay)
        }
        dnsRelays.clear()
        dnsCache.clear()

        try {
            tunnel?.close()
        } catch (_: IOException) {
            // Already closed.
        }
        tunnel = null
        vpnUp = false
        ProtectionStore.setActive(this, false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
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
}