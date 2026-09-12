package com.example.focuslock

/** Parses DNS packets (header + question) and builds minimal NXDOMAIN responses. */
object DnsPacket {
    const val HEADER_LENGTH = 12

    private const val FLAG_QR = 0x8000
    private const val FLAG_RD = 0x0100
    private const val FLAG_RA = 0x0080
    private const val RCODE_NXDOMAIN = 0x0003

    data class Header(
        val id: Int,
        val flags: Int,
        val questionCount: Int,
    )

    data class Question(
        val name: String,
        val type: Int,
        val klass: Int,
        val endOffset: Int,
    )

    fun getU16(packet: ByteArray, offset: Int): Int {
        return ((packet[offset].toInt() and 0xFF) shl 8) or (packet[offset + 1].toInt() and 0xFF)
    }

    /** Reads the 12-byte DNS header, if the packet is large enough. */
    fun parseHeader(packet: ByteArray): Header? {
        if (packet.size < HEADER_LENGTH) {
            return null
        }
        return Header(
            id = getU16(packet, 0),
            flags = getU16(packet, 2),
            questionCount = getU16(packet, 4),
        )
    }

    /** True when the packet is a DNS query (QR=0) with at least one question. */
    fun isQuery(packet: ByteArray): Boolean {
        val header = parseHeader(packet) ?: return false
        return header.flags and FLAG_QR == 0 && header.questionCount > 0
    }

    /** Parses the first question (name + type + class) of the packet. */
    fun parseQuestion(packet: ByteArray): Question? {
        if (packet.size < HEADER_LENGTH) {
            return null
        }

        val questionCount = getU16(packet, 4)
        if (questionCount == 0) {
            return null
        }

        val name = readName(packet, HEADER_LENGTH) ?: return null
        val typeOffset = name.second
        if (typeOffset + 4 > packet.size) {
            return null
        }

        val type = getU16(packet, typeOffset)
        val klass = getU16(packet, typeOffset + 2)

        return Question(
            name = name.first,
            type = type,
            klass = klass,
            endOffset = typeOffset + 4,
        )
    }

    /**
     * Decodes a DNS name starting at [startOffset], following label-compression
     * pointers when present. Returns the lowercase name and the offset just past
     * the name in the original packet.
     */
    private fun readName(packet: ByteArray, startOffset: Int): Pair<String, Int>? {
        var offset = startOffset
        val builder = StringBuilder(128)
        var afterName = -1
        var jumps = 0
        var total = 0

        while (offset < packet.size) {
            val length = packet[offset].toInt() and 0xFF

            if (length == 0) {
                if (afterName == -1) {
                    afterName = offset + 1
                }
                return builder.toString().lowercase() to afterName
            }

            if (length and 0xC0 == 0xC0) {
                if (offset + 1 >= packet.size) {
                    return null
                }
                val pointer = ((length and 0x3F) shl 8) or (packet[offset + 1].toInt() and 0xFF)
                if (afterName == -1) {
                    afterName = offset + 2
                }
                if (pointer >= packet.size || ++jumps > 64) {
                    return null
                }
                offset = pointer
                continue
            }

            val labelLength = length
            if (offset + 1 + labelLength > packet.size) {
                return null
            }
            total += labelLength + 1
            if (total > 255) {
                return null
            }

            if (builder.isNotEmpty()) {
                builder.append('.')
            }
            for (i in 0 until labelLength) {
                builder.append((packet[offset + 1 + i].toInt() and 0xFF).toChar())
            }
            offset += 1 + labelLength
        }

        return null
    }

    /**
     * Builds a minimal NXDOMAIN response for [query]: the same transaction ID,
     * QR|RA|RCODE=3, QDCOUNT=1, and the original question echoed back. Any
     * additional section (for example an EDNS OPT record) is dropped.
     */
    fun buildNxDomainResponse(query: ByteArray, question: Question): ByteArray {
        val flags = getU16(query, 2)
        val responseFlags = (flags and FLAG_RD) or FLAG_QR or FLAG_RA or RCODE_NXDOMAIN

        val response = ByteArray(question.endOffset)
        response[0] = query[0]
        response[1] = query[1]
        response[2] = (responseFlags ushr 8).toByte()
        response[3] = (responseFlags and 0xFF).toByte()
        response[4] = 0
        response[5] = 1
        query.copyInto(
            response,
            destinationOffset = HEADER_LENGTH,
            startIndex = HEADER_LENGTH,
            endIndex = question.endOffset,
        )
        return response
    }
}