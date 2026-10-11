import AppKit
import CoreGraphics

final class MouseLook: @unchecked Sendable {
    var locked = false
    var origin = CGPoint.zero
    var deadline = Date.distantPast
    var foreground: pid_t?
    func report(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
    }
    func release() {
        guard locked else { return }
        CGAssociateMouseAndMouseCursorPosition(1)
        CGDisplayShowCursor(CGMainDisplayID())
        locked = false
        report(["locked": false])
    }
    func lock() {
        guard !locked else { return }
        origin = CGEvent(source: nil)?.location ?? .zero
        let status = CGAssociateMouseAndMouseCursorPosition(0)
        guard status == .success else { report(["error": "cursor_association", "status": status.rawValue]); return }
        locked = true
        foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        deadline = Date().addingTimeInterval(10)
        CGDisplayHideCursor(CGMainDisplayID())
        report(["locked": true])
    }
    func tick() {
        guard locked else { return }
        if Date() >= deadline || NSWorkspace.shared.frontmostApplication?.processIdentifier != foreground
            || CGEventSource.flagsState(.combinedSessionState).contains(.maskCommand)
            || CGEventSource.keyState(.combinedSessionState, key: 53) { release(); return }
        let delta = CGGetLastMouseDelta()
        guard CGWarpMouseCursorPosition(origin) == .success else { release(); return }
        if delta.x != 0 || delta.y != 0 { report(["dx": delta.x, "dy": delta.y]) }
    }
}

let look = MouseLook()
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(8))
timer.setEventHandler { look.tick() }
timer.resume()
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
termination.setEventHandler { look.release(); exit(0) }
termination.resume()
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async {
            if line == "lock" { look.lock() } else { look.release() }
        }
    }
    DispatchQueue.main.async { look.release(); exit(0) }
}
dispatchMain()
