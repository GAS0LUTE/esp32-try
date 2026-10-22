// 列出指定应用的可见窗口（标题、编号、位置、是否聚焦）。
// 只读，不激活应用、不发送事件。编译：
//   swiftc tests/codex-probe/tools/winlist.swift -o /tmp/codex-winlist
import CoreGraphics
import Foundation

let filter = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ChatGPT"
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}
for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    if !owner.contains(filter) { continue }
    let title = w[kCGWindowName as String] as? String ?? ""
    let number = w[kCGWindowNumber as String] as? Int ?? -1
    let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let obj: [String: Any] = [
        "owner": owner, "title": title, "number": number, "pid": pid,
        "layer": layer, "bounds": bounds,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}
