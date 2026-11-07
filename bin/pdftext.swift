import Foundation
import PDFKit
import AppKit

struct LineOut: Codable {
    let page: Int
    let text: String
    let size: Double
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let pageWidth: Double
    let pageHeight: Double
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: pdftext <file.pdf>\n".data(using: .utf8)!)
    exit(2)
}
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("cannot open PDF\n".data(using: .utf8)!)
    exit(1)
}

var out: [LineOut] = []
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i), let attr = page.attributedString else { continue }
    let box = page.bounds(for: .mediaBox)
    let ns = attr.string as NSString
    var idx = 0
    while idx < ns.length {
        let lineRange = ns.lineRange(for: NSRange(location: idx, length: 0))
        let raw = ns.substring(with: lineRange).trimmingCharacters(in: .whitespacesAndNewlines)
        idx = lineRange.location + lineRange.length
        if raw.isEmpty { continue }
        var sizes: [CGFloat] = []
        attr.enumerateAttribute(.font, in: lineRange, options: []) { value, _, _ in
            if let font = value as? NSFont { sizes.append(font.pointSize) }
        }
        let size = sizes.max() ?? 0
        var rect = CGRect.zero
        if let sel = page.selection(for: lineRange) {
            rect = sel.bounds(for: page)
        }
        out.append(LineOut(
            page: i + 1,
            text: raw,
            size: Double(size),
            x: Double(rect.origin.x),
            y: Double(rect.origin.y),
            width: Double(rect.width),
            height: Double(rect.height),
            pageWidth: Double(box.width),
            pageHeight: Double(box.height)
        ))
    }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
let data = try! encoder.encode(out)
FileHandle.standardOutput.write(data)
