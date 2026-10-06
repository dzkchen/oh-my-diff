import CoreGraphics
import Foundation

let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
guard let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }) else {
    print("null")
    exit(0)
}
let data = try! JSONSerialization.data(withJSONObject: ["id": window[kCGWindowNumber as String]!, "bounds": window[kCGWindowBounds as String]!])
print(String(data: data, encoding: .utf8)!)
