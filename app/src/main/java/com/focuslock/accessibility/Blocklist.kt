package com.focuslock.accessibility

/**
 * Single source of truth for what gets blocked. Kept apart from any UI so the
 * lists can be reasoned about and tested without an Android device.
 *
 * Three tiers, deliberately:
 *   - PHRASES: unambiguous multi-word matches, safe to match anywhere.
 *   - TERMS:   single words risky enough to need word-boundary matching, so
 *              "class" and "assess" never trip them.
 *   - HOSTS:   domain suffixes checked against the requested hostname.
 */
object Blocklist {

    val PHRASES: Set<String> = setOf(
        "porn", "porno", "xxx", "sex", "seks", "nude", "nudes", "naked", "erotic",
        "erotica", "adult", "nsfw", "hentai", "rule34", "onlyfans", "fansly",
        "pornhub", "xvideos", "xnxx", "redtube", "youporn", "tube8",
        "spankbang", "xhamster", "brazzers", "realitykings", "bangbros",
        "naughtyamerica", "mofos", "fakeagent", "publicagent", "castingcouch",
        "backroomcasting", "milf", "hardcore", "blowjob", "cumshot",
        "creampie", "gangbang", "bukkake", "bdsm", "fetish", "domination",
        "bondage", "whipping", "spanking", "escort service", "prostitute",
        "hookup", "sexting", "leaked", "deepfake", "deepnude", "stepmom",
        "stepsis", "stepbro", "stepdad", "stepdaughter", "stepson",
        "threesome", "foursome", "orgy", "swinger", "cuckold", "femdom",
        "pegging", "squirting", "voyeur", "exhibitionist", "gloryhole",
        "dogging", "harem", "masochist", "sadist", "mistress", "foot fetish",
        "kink", "fetlife", "lolicon", "shotacon", "bestiality", "beastiality",
        "snuff", "femboy", "shemale", "ladyboy", "findom", "paypig",
        "chastity cage", "camgirl", "cam girl", "webcam sex", "pornstar",
        "casting couch", "fake taxi", "fakehub", "tushy", "digitalplayground",
        "playboy", "teamskeet", "mypervyfamily", "nubiles", "eporner",
        "tnaflix", "nuvid", "sunporno", "porndoe", "empflix", "keezmovies",
        "drtuber", "spankwire", "slut roulette", "fancentro", "iwantclips",
        "admireme", "fanvue", "friendfinder", "kinky", "babestation",
        "jerkmate", "flirt4free", "imlive", "xlovecam", "justforfans",
        "loyalfans", "nhentai", "hanime", "qahba", "kahba", "sharmota",
        // Gambling
        "casino", "gambling", "poker", "slots", "jackpot", "roulette",
        "sportsbook", "bet365", "betway", "1xbet", "pokerstars", "williamhill",
        "ladbrokes", "bwin", "unibet", "sky bet", "pokerdom", "coinbase casino",
        "roobet", "stake casino", "rainbet", "polymarket",
        // Disturbing / violent content
        "snuff video", "bestiality video", "gore video", "beheading video",
        "graphic violence", "murder video", "torture video"
    )

    /**
     * Short words that must never match as substrings. "tit" would otherwise
     * fire on "competition"; "ass" on "class". Word boundaries only.
     */
    val BOUNDARY_TERMS: Set<String> = setOf(
        "ass", "asses", "tit", "tits", "cum", "boob", "boobs", "dick", "cock",
        "slut", "whore", "skank", "bimbo", "fuck", "shit", "piss", "anal",
        "pussy", "titties", "boobies", "cameltoe", "upskirt", "downblouse",
        "paypig", "sugar daddy", "sugarbaby", "sugar baby", "blowjob",
        "shemale", "ladyboy", "hentai", "nsfw", "sexting"
    )

    val HOSTS: Set<String> = setOf(
        // Adult
        "pornhub.com", "xvideos.com", "xnxx.com", "redtube.com",
        "youporn.com", "tube8.com", "spankbang.com", "xhamster.com",
        "brazzers.com", "realitykings.com", "bangbros.com",
        "naughtyamerica.com", "mofos.com", "onlyfans.com", "fansly.com",
        "manyvids.com", "clips4sale.com", "chaturbate.com", "stripchat.com",
        "bongacams.com", "cam4.com", "livejasmin.com", "streamate.com",
        "myfreecams.com", "adultfriendfinder.com", "ashleymadison.com",
        "seeking.com", "tinder.com", "bumble.com", "hinge.com", "grindr.com",
        "scruff.com", "pornhub", "xvideos", "xnxx", "xhamster", "youporn",
        "eporner.com", "motherless.com", "camwhores.tv", "fapello.com",
        // Gambling
        "bet365.com", "betway.com", "1xbet.com", "pokerstars.com",
        "williamhill.com", "ladbrokes.com", "bwin.com", "unibet.com",
        "roobet.com", "stake.com", "polymarket.com", "casino.com",
        "888casino.com", "bovada.lv", "coinbase.com", "draftkings.com",
        "fanduel.com", "betmgm.com", "caesars.com", "stake.com",
        // Disturbing
        "bestialitytaboo.com", "snuff-videos.com", "crimesexuals.com",
        // Social
        "x.com", "twitter.com", "mobile.twitter.com", "t.co"
    )

    private val boundaryRegex: Regex =
        Regex("\\b(" + BOUNDARY_TERMS.joinToString("|") + ")\\b", RegexOption.IGNORE_CASE)

    private val phraseRegex: Regex =
        Regex("\\b(" + PHRASES.joinToString("|") { Regex.escape(it) } + ")\\b", RegexOption.IGNORE_CASE)

    /** Returns the exact term that matched, so the log always explains itself. */
    fun matchText(raw: String): String? {
        if (raw.isBlank()) return null
        val text = raw.lowercase()
        boundaryRegex.find(text)?.let { return it.value.lowercase() }
        phraseRegex.find(text)?.let { return it.value.lowercase() }
        return null
    }

    /** Suffix match so "www.x.com" and "x.com" both hit "x.com". */
    fun matchHost(rawHost: String): String? {
        val host = rawHost.trim().lowercase().removePrefix("www.")
        if (host.isEmpty()) return null
        for (blocked in HOSTS) {
            if (host == blocked || host.endsWith(".$blocked")) return blocked
        }
        return null
    }
}