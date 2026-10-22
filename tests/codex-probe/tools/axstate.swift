// 读取指定进程的 AX 窗口是否处于聚焦状态；只读。
import ApplicationServices

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

let pid = Int32(CommandLine.arguments[1])!
let ax = AXUIElementCreateApplication(pid)
let wins = attr(ax, kAXWindowsAttribute) as? [AXUIElement] ?? []
var focused = false
var main = false
for w in wins {
    if (attr(w, kAXFocusedAttribute) as? Bool) == true { focused = true }
    if (attr(w, kAXMainAttribute) as? Bool) == true { main = true }
}
print("focused=\(focused) main=\(main)")
