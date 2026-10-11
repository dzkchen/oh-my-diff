import AppKit
import CoreGraphics

final class MouseLook: @unchecked Sendable {
    var locked = false
    var origin = CGPoint.zero
    var deadline = Date.distantPast
    var foreground: pid_t?
    var monitor: Any?
    func report(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
    }
    func release(_ reason: String = "input") {
        guard locked else { return }
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        CGAssociateMouseAndMouseCursorPosition(1)
        CGDisplayShowCursor(CGMainDisplayID())
        locked = false
        report(["locked": false, "reason": reason])
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
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseDown]) { [self] event in
            guard locked, NSWorkspace.shared.frontmostApplication?.processIdentifier == foreground else { return }
            if event.modifierFlags.contains(.command) { release("command"); return }
            if event.type == .leftMouseDown { return }
            if event.deltaX != 0 || event.deltaY != 0 { report(["dx": event.deltaX, "dy": event.deltaY]) }
        }
        guard monitor != nil else { report(["error": "mouse_monitor"]); release("mouse_monitor"); return }
        report(["locked": true])
    }
    func tick() {
        guard locked else { return }
        if Date() >= deadline { release("timeout"); return }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != foreground { release("focus"); return }
        if CGEventSource.flagsState(.combinedSessionState).contains(.maskCommand) { release("command"); return }
        if CGEventSource.keyState(.combinedSessionState, key: 53) { release("escape"); return }
        guard CGWarpMouseCursorPosition(origin) == .success else { release(); return }
    }
}

let look = MouseLook()
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
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
application.run()
