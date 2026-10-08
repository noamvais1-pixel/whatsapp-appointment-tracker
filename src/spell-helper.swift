// Spelling helper for the dashboard: the Mac's own speller (Hebrew + English), kept running by src/spell.js.
// Reads one JSON request per line on stdin, answers one JSON line on stdout:
//   {"id":1,"op":"check","text":"..."} -> {"id":1,"issues":[{"start":0,"len":5,"word":"...","guesses":["..."]}]}
//   {"id":2,"op":"learn","word":"..."} -> {"id":2,"ok":true}   (same list as "Learn Spelling" in any Mac app)
// Offsets are UTF-16 units, the same as JavaScript string indexes.
import AppKit

let sc = NSSpellChecker.shared
let tag = NSSpellChecker.uniqueSpellDocumentTag()
// a word may carry an inner geresh/quote: ג'ירפה, עו"ד, don't
let wordRe = try! NSRegularExpression(pattern: "[\\p{L}\\p{M}]+(?:['’\"״׳][\\p{L}\\p{M}]+)*")
// links, e-mail addresses, @mentions and #tags are not words
let skipRe = try! NSRegularExpression(pattern: "(?:https?://|www\\.)\\S+|\\S+@\\S+\\.\\S+|[@#]\\S+", options: [.caseInsensitive])
let maxIssues = 15

func isHebrew(_ s: String) -> Bool { s.unicodeScalars.contains { $0.value >= 0x0590 && $0.value <= 0x05FF } }
/** UTF-16 index of the first Latin letter, if any. */
func firstLatin(_ s: String) -> Int? {
    let u = Array(s.utf16)
    return u.firstIndex { ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0xC0 && $0 < 0x250 && $0 != 0xD7 && $0 != 0xF7) }
}

func check(_ text: String) -> [[String: Any]] {
    let ns = text as NSString
    let all = NSRange(location: 0, length: ns.length)
    let skips = skipRe.matches(in: text, range: all).map { $0.range }
    var issues: [[String: Any]] = []
    for m in wordRe.matches(in: text, range: all) {
        if issues.count >= maxIssues { break }
        var r = m.range
        if r.length < 2 || skips.contains(where: { NSIntersectionRange($0, r).length > 0 }) { continue }
        var word = ns.substring(with: r)
        var hebrew = isHebrew(word)
        if hebrew, let k = firstLatin(word) {
            // a Hebrew prefix on an English word (בZoom, לGoogle): judge only the English part
            let rest = (word as NSString).substring(from: k)
            if k > 4 || isHebrew(rest) || rest.utf16.count < 2 { continue }
            r = NSRange(location: r.location + k, length: r.length - k)
            word = rest
            hebrew = false
        }
        if !hebrew && firstLatin(word) == nil { continue } // other scripts: no speller picked for them
        if !hebrew && word == word.uppercased() { continue } // OK, PDF, ASAP
        let lang = hebrew ? "he" : "en"
        let wr = NSRange(location: 0, length: r.length)
        let misspelled = { (w: String) in sc.checkSpelling(of: w, startingAt: 0, language: lang, wrap: false, inSpellDocumentWithTag: tag, wordCount: nil).location != NSNotFound }
        // in Hebrew a keyboard apostrophe/quote stands for geresh/gershayim: ג'ינס is ג׳ינס (same length)
        let probe = hebrew ? word.replacingOccurrences(of: "'", with: "׳").replacingOccurrences(of: "’", with: "׳").replacingOccurrences(of: "\"", with: "״") : word
        if !misspelled(word) || (probe != word && !misspelled(probe)) { continue }
        // the dictionary lacks prefixed loanwords (וצ׳יפס): try without up to 3 prefix letters
        if probe != word, (1...3).contains(where: { n in
            let p = String(probe.prefix(n)), rest = String(probe.dropFirst(n))
            return p.allSatisfy { "ובכלמהש".contains($0) } && rest.count >= 2 && !misspelled(rest)
        }) { continue }
        var guesses: [String] = []
        if let c = sc.correction(forWordRange: wr, in: probe, language: lang, inSpellDocumentWithTag: tag) { guesses.append(c) }
        for g in sc.guesses(forWordRange: wr, in: probe, language: lang, inSpellDocumentWithTag: tag) ?? [] where !guesses.contains(g) && !g.contains(" ") && !g.contains("-") {
            guesses.append(g)
        }
        issues.append(["start": r.location, "len": r.length, "word": word, "guesses": Array(guesses.prefix(4))])
    }
    return issues
}

func reply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

while let line = readLine() {
    guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    let id = req["id"] ?? 0
    switch req["op"] as? String {
    case "check": reply(["id": id, "issues": check(req["text"] as? String ?? "")])
    case "learn":
        if let w = req["word"] as? String, !w.isEmpty { sc.learnWord(w) }
        reply(["id": id, "ok": true])
    default: reply(["id": id, "error": "unknown op"])
    }
}
