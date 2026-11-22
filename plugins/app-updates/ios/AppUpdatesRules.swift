// The app-updates plugin's iOS rules with no UIKit or StoreKit in them (as android/.../AppUpdatesRules.kt), so a Mac
// unit suite checks them (ios/tests/plugins/app-updates: bun run tools/ios-unit-test.ts plugins/app-updates).
// Foundation only.
//
// iOS has no Play to ask, so isUpdateAvailable asks the App Store's public lookup
// (https://itunes.apple.com/lookup?bundleId=<this app>&country=<cc>): the newest version, its App Store id, the iOS it
// needs and when it came out. "available" = the store's version is newer than this build's CFBundleShortVersionString
// and this phone's iOS can run it.
import Foundation

enum AppUpdatesRules {
    /// The lookup's answer is kept this long (Apple's CDN lags a release by up to hours anyway).
    static let cacheSeconds: TimeInterval = 3600
    /// The lookup gives up after this.
    static let timeoutSeconds: TimeInterval = 10

    /// What the App Store says about the app (results[0] of the lookup).
    struct StoreInfo: Equatable {
        let version: String
        let trackId: Int64
        let minimumOsVersion: String?
        let releaseDate: String?
    }

    // MARK: Versions

    /// The numbers of a dotted version: "1.6.10" = [1, 6, 10]. A part that doesn't start with a digit counts as 0, and
    /// only a part's leading digits count ("2b3" = 2).
    static func parts(_ v: String) -> [Int] {
        v.trimmingCharacters(in: .whitespaces).split(separator: ".", omittingEmptySubsequences: false).map { p in
            Int(p.prefix { ("0"..."9").contains($0) }.prefix(9)) ?? 0
        }
    }

    /// -1, 0 or 1, part by part; a missing part is 0 ("1.6" == "1.6.0").
    static func compare(_ a: String, _ b: String) -> Int {
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l < r ? -1 : 1 }
        }
        return 0
    }

    static func newer(_ store: String, than current: String) -> Bool { compare(store, current) > 0 }

    /// This phone's iOS can run the store's build. No minimum known: yes.
    static func osAllows(_ minimumOs: String?, system: String) -> Bool {
        guard let m = minimumOs, !m.trimmingCharacters(in: .whitespaces).isEmpty else { return true }
        return compare(system, m) >= 0
    }

    /// Whole days since the store's version came out (Play's stalenessDays). nil when the date can't be read; 0 for
    /// one in the future (a clock that is behind).
    static func stalenessDays(_ releaseDate: String?, now: Date) -> Int? {
        guard let releaseDate, let at = ISO8601DateFormatter().date(from: releaseDate) else { return nil }
        return max(Int(now.timeIntervalSince(at) / 86_400), 0)
    }

    // MARK: The lookup

    /// The storefront to ask: the App Store account's country (StoreKit's Storefront, three letters), else the phone's
    /// region (two letters), else "us". The account's country is the one that counts: an app sold only in India answers
    /// no result for an Indian account on a phone set to the US region. An app not sold there answers no result.
    static func country(storefront: String?, region: String?) -> String {
        if let s = storefront.flatMap(alpha2) { return s }
        guard let r = region?.lowercased(), r.count == 2, r.allSatisfy({ ("a"..."z").contains($0) }) else { return "us" }
        return r
    }

    /// "IND" = "in": an ISO 3166 three-letter country as the lookup's two letters. nil for one it doesn't know.
    static func alpha2(_ alpha3: String) -> String? {
        let key = alpha3.uppercased()
        guard key.count == 3 else { return nil }
        return iso3[key]
    }

    /// ISO 3166's countries, three letters then two ("ASCAC" = ASC, AC), as ICU lists them (Storefront's countryCode is
    /// the three-letter one; the lookup wants two).
    private static let iso3: [String: String] = {
        let all = Array(
            "ASCACANDADAREAEAFGAFATGAGAIAAIALBALARMAMAGOAOATAAQARGARASMASAUTATAUSAUABWAWALAAXAZEAZBIHBABRBBBBGDBD" +
            "BELBEBFABFBGRBGBHRBHBDIBIBENBJBLMBLBMUBMBRNBNBOLBOBESBQBRABRBHSBSBTNBTBVTBVBWABWBLRBYBLZBZCANCACCKCC" +
            "CODCDCAFCFCOGCGCHECHCIVCICOKCKCHLCLCMRCMCHNCNCOLCOCPTCPCRQCQCRICRCUBCUCPVCVCUWCWCXRCXCYPCYCZECZDEUDE" +
            "DGADGDJIDJDNKDKDMADMDOMDODZADZXEAEAECUECESTEEEGYEGESHEHERIERESPESETHETFINFIFJIFJFLKFKFSMFMFROFOFRAFR" +
            "GABGAGBRGBGRDGDGEOGEGUFGFGGYGGGHAGHGIBGIGRLGLGMBGMGINGNGLPGPGNQGQGRCGRSGSGSGTMGTGUMGUGNBGWGUYGYHKGHK" +
            "HMDHMHNDHNHRVHRHTIHTHUNHUXICICIDNIDIRLIEISRILIMNIMINDINIOTIOIRQIQIRNIRISLISITAITJEYJEJAMJMJORJOJPNJP" +
            "KENKEKGZKGKHMKHKIRKICOMKMKNAKNPRKKPKORKRKWTKWCYMKYKAZKZLAOLALBNLBLCALCLIELILKALKLBRLRLSOLSLTULTLUXLU" +
            "LVALVLBYLYMARMAMCOMCMDAMDMNEMEMAFMFMDGMGMHLMHMKDMKMLIMLMMRMMMNGMNMACMOMNPMPMTQMQMRTMRMSRMSMLTMTMUSMU" +
            "MDVMVMWIMWMEXMXMYSMYMOZMZNAMNANCLNCNERNENFKNFNGANGNICNINLDNLNORNONPLNPNRUNRNIUNUNZLNZOMNOMPANPAPERPE" +
            "PYFPFPNGPGPHLPHPAKPKPOLPLSPMPMPCNPNPRIPRPSEPSPRTPTPLWPWPRYPYQATQAREUREROUROSRBRSRUSRURWARWSAUSASLBSB" +
            "SYCSCSDNSDSWESESGPSGSHNSHSVNSISJMSJSVKSKSLESLSMRSMSENSNSOMSOSURSRSSDSSSTPSTSLVSVSXMSXSYRSYSWZSZTAATA" +
            "TCATCTCDTDATFTFTGOTGTHATHTJKTJTKLTKTLSTLTKMTMTUNTNTONTOTURTRTTOTTTUVTVTWNTWTZATZUKRUAUGAUGUMIUMUSAUS" +
            "URYUYUZBUZVATVAVCTVCVENVEVGBVGVIRVIVNMVNVUTVUWLFWFWSMWSXKKXKYEMYEMYTYTZAFZAZMBZMZWEZW"
        )
        var out: [String: String] = [:]
        for i in stride(from: 0, to: all.count - 4, by: 5) { out[String(all[i..<i + 3])] = String(all[i + 3..<i + 5]).lowercased() }
        return out
    }()

    /// The lookup URL: by App Store id when given (all digits), else by bundle id. `minute` busts caches between Apple's
    /// CDN and the phone once a minute. nil with neither.
    static func lookupURL(bundleId: String?, appStoreId: String?, country: String, minute: Int) -> URL? {
        var c = URLComponents(string: "https://itunes.apple.com/lookup")!
        if let id = appStoreId, !id.isEmpty, id.count <= 12, id.allSatisfy({ ("0"..."9").contains($0) }) {
            c.queryItems = [URLQueryItem(name: "id", value: id)]
        } else if let b = bundleId, !b.isEmpty, b.count <= 155 {
            c.queryItems = [URLQueryItem(name: "bundleId", value: b)]
        } else {
            return nil
        }
        c.queryItems! += [URLQueryItem(name: "country", value: country), URLQueryItem(name: "_", value: String(minute))]
        return c.url
    }

    /// results[0] of the lookup's JSON. nil for no result (not on the App Store, or not in this storefront) or an
    /// answer it can't read.
    static func parse(_ data: Data) -> StoreInfo? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let first = (o["results"] as? [Any])?.first as? [String: Any],
              let version = first["version"] as? String, !version.isEmpty,
              let track = (first["trackId"] as? NSNumber)?.int64Value, track > 0 else { return nil }
        return StoreInfo(version: version, trackId: track, minimumOsVersion: first["minimumOsVersion"] as? String,
                         releaseDate: first["currentVersionReleaseDate"] as? String)
    }

    /// isUpdateAvailable's answer, in Android's shape plus `storeVersion` and `appStoreId`. versionCode is 0 (iOS has
    /// none). Both kinds are allowed when there is an update: the App Store sheet is the same for either.
    static func availability(_ info: StoreInfo?, current: String, system: String, now: Date) -> [String: Any] {
        guard let info else { return ["available": false, "versionCode": 0] }
        let available = newer(info.version, than: current) && osAllows(info.minimumOsVersion, system: system)
        var out: [String: Any] = ["available": available, "versionCode": 0, "immediateAllowed": available, "flexibleAllowed": available,
                                  "storeVersion": info.version, "appStoreId": String(info.trackId)]
        if available, let days = stalenessDays(info.releaseDate, now: now) { out["stalenessDays"] = days }
        return out
    }

    /// A kept answer is still good for the same question.
    static func fresh(savedAt: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(savedAt)
        return age >= 0 && age < cacheSeconds
    }

    // MARK: The App Store sheet

    /// The sheet closed. iOS never says whether the user tapped Update (the App Store installs and ends the app
    /// itself), so a closed optional sheet is "declined" and a closed forced one "canceled", as Play's answers.
    static func closedStatus(flexible: Bool) -> String { flexible ? "declined" : "canceled" }

    /// The app came to the front: open the forced sheet again (Android's IMMEDIATE can't be skipped), not while the app
    /// is busy (a payment) or while a sheet is open.
    static func reopen(forcedPending: Bool, busy: Bool, open: Bool) -> Bool { forcedPending && !busy && !open }

    /// A check ends a forced update's re-opening only when the App Store answered (a failed lookup, offline say, says
    /// nothing), about the same app the forced sheet is for, and has no update for it.
    static func endsForced(found: Bool, sameApp: Bool, available: Bool) -> Bool { found && sameApp && !available }
}
