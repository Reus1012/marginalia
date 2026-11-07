import Foundation
import CoreServices

@_silgen_name("DCSDictionaryCreateWithIdentifier")
func DCSDictionaryCreateWithIdentifier(_ id: CFString) -> Unmanaged<DCSDictionary>?

@_silgen_name("DCSDictionaryGetName")
func DCSDictionaryGetName(_ d: DCSDictionary) -> Unmanaged<CFString>?

struct Entry: Codable {
    let id: String
    let name: String
    let text: String
}

struct Response: Codable {
    let ok: Bool
    let word: String
    let entries: [Entry]
    let error: String?
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("{\"ok\":false,\"word\":\"\",\"entries\":[],\"error\":\"no word\"}")
    exit(2)
}
let word = args[1]
let ids = args.count > 2 ? Array(args.dropFirst(2)) : [
    "com.apple.dictionary.zh_CN-en.OCD",
    "com.apple.dictionary.zh_TW-en.DrEye",
    "com.apple.dictionary.zh_TW-en.idioms"
]

var entries: [Entry] = []
for id in ids {
    guard let dref = DCSDictionaryCreateWithIdentifier(id as CFString) else { continue }
    let dict = dref.takeRetainedValue()
    let ns = word as NSString
    let range = DCSGetTermRangeInString(dict, ns as CFString, 0)
    if range.location == kCFNotFound { continue }
    guard let raw = DCSCopyTextDefinition(dict, ns as CFString, range) else { continue }
    let text = raw.takeRetainedValue() as String
    let name = DCSDictionaryGetName(dict)?.takeRetainedValue() as String? ?? id
    entries.append(Entry(id: id, name: name, text: text))
}

let response = Response(ok: !entries.isEmpty, word: word, entries: entries, error: entries.isEmpty ? "not found" : nil)
let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
if let data = try? encoder.encode(response), let json = String(data: data, encoding: .utf8) {
    print(json)
} else {
    print("{\"ok\":false,\"word\":\"\",\"entries\":[],\"error\":\"encode failed\"}")
}
