// 界面动作工具：click / type / enter / escape / check。
// 执行前由本进程自行核实辅助功能与事件注入权限；任何动作失败返回非零。
import ApplicationServices
import CoreGraphics
import Foundation

func permsOK() -> Bool {
    return AXIsProcessTrusted() && CGPreflightPostEventAccess()
}

func postKey(_ code: CGKeyCode, shift: Bool = false, command: Bool = false) {
    let src = CGEventSource(stateID: .hidSystemState)
    var flags: CGEventFlags = []
    if shift { flags.insert(.maskShift) }
    if command { flags.insert(.maskCommand) }
    let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    usleep(12000)
    let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
    usleep(18000)
}

let map: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "-": 27, " ": 49, ".": 47, ",": 43,
]

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage"); exit(64) }
guard permsOK() else { print("perm=denied"); exit(2) }

switch args[1] {
case "check":
    print("perm=ok")
case "click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { print("bad args"); exit(64) }
    let p = CGPoint(x: x, y: y)
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(60000)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(50000)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    print("clicked")
case "type":
    guard args.count >= 3 else { print("bad args"); exit(64) }
    let text = args[2]
    for ch in text {
        let lower = Character(String(ch).lowercased())
        guard let code = map[lower] else { print("unsupported char: \(ch)"); exit(65) }
        let shift = (String(ch) != String(ch).lowercased())
        postKey(code, shift: shift)
    }
    print("typed")
case "enter":
    postKey(36)
    print("entered")
case "escape":
    postKey(53)
    print("escaped")
case "paste":
    postKey(9, command: true)
    print("pasted")
case "select-all":
    postKey(0, command: true)
    print("selected")
case "copy":
    postKey(8, command: true)
    print("copied")
default:
    print("unknown")
    exit(64)
}
