// 剪贴板文本读写：has-text / read(base64) / write(base64 from stdin)。
// 只在内存中传递，不写文件、不打印明文。
import AppKit
import Foundation

let pb = NSPasteboard.general
let args = CommandLine.arguments
guard args.count >= 2 else { exit(64) }

switch args[1] {
case "has-text":
    let ok = pb.types?.contains(.string) ?? false
    print(ok ? "true" : "false")
case "has-only-text":
    let types = pb.types ?? []
    let ok = types.contains(.string) && types.allSatisfy { $0 == .string || $0.rawValue == "NSStringPboardType" }
    print(ok ? "true" : "false")
case "types":
    print((pb.types ?? []).map { $0.rawValue }.joined(separator: "\n"))
case "change-count":
    print(pb.changeCount)
case "dump":
    // 完整快照：所有 item 的所有类型数据，JSON 输出；由调用方在内存中保存。
    var items: [[String: Any]] = []
    for item in pb.pasteboardItems ?? [] {
        var types: [[String: Any]] = []
        for t in item.types {
            if let d = item.data(forType: t) {
                types.append(["type": t.rawValue, "b64": d.base64EncodedString()])
            }
        }
        items.append(["types": types])
    }
    let obj: [String: Any] = ["items": items]
    if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
        print(s)
    }
case "restore":
    let raw = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "{}"
    guard let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let items = obj["items"] as? [[String: Any]] else { exit(65) }
    pb.clearContents()
    var newItems: [NSPasteboardItem] = []
    for itemDict in items {
        let item = NSPasteboardItem()
        for t in (itemDict["types"] as? [[String: Any]] ?? []) {
            guard let name = t["type"] as? String, let b64 = t["b64"] as? String,
                  let d = Data(base64Encoded: b64) else { continue }
            item.setData(d, forType: NSPasteboard.PasteboardType(rawValue: name))
        }
        newItems.append(item)
    }
    pb.writeObjects(newItems)
    print(newItems.count)
case "read":
    // 无文本时返回空串，供“输入框为空”的读回判断使用。
    let s = pb.string(forType: .string) ?? ""
    print(Data(s.utf8).base64EncodedString())
case "write":
    let b64 = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    guard let data = Data(base64Encoded: b64.trimmingCharacters(in: .whitespacesAndNewlines)),
          let text = String(data: data, encoding: .utf8) else { exit(65) }
    pb.clearContents()
    pb.setString(text, forType: .string)
    print("ok")
default:
    exit(64)
}
