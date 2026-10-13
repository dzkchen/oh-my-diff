import AppKit
import CoreGraphics
import Darwin

final class MouseLook: @unchecked Sendable {
    var locked = false
    var deadline = Date.distantPast
    var foreground: NSRunningApplication?
    var monitor: Any?
    var localMonitor: Any?
    var timer: DispatchSourceTimer?
    var dx = 0.0
    var dy = 0.0
    var commandPending = false
    var outputFailed = false
    init() {
        signal(SIGPIPE, SIG_IGN)
        let flags = fcntl(STDOUT_FILENO, F_GETFL)
        outputFailed = flags == -1 || fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == -1
    }
    func report(_ value: [String: Any]) {
        guard !outputFailed, var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        let written = data.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }
        guard written == data.count else {
            outputFailed = true
            release("output")
            return
        }
    }
    func release(_ reason: String = "input") {
        guard timer != nil || monitor != nil || localMonitor != nil || foreground != nil else { return }
        let wasLocked = locked
        let restoreFocus = NSApplication.shared.isActive
        timer?.cancel()
        timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        monitor = nil
        localMonitor = nil
        if locked {
            CGAssociateMouseAndMouseCursorPosition(1)
            CGDisplayShowCursor(CGMainDisplayID())
        }
        locked = false
        dx = 0
        dy = 0
        commandPending = false
        NSApplication.shared.setActivationPolicy(.prohibited)
        if restoreFocus { foreground?.activate(options: []) }
        foreground = nil
        if wasLocked { report(["locked": false, "reason": reason]) }
    }
    func movement(_ event: NSEvent) {
        guard locked else { return }
        commandPending = commandPending || event.modifierFlags.contains(.command)
        guard event.type != .leftMouseDown else { return }
        dx += event.deltaX
        dy += event.deltaY
    }
    func lock() {
        guard timer == nil, !outputFailed else { return }
        foreground = NSWorkspace.shared.frontmostApplication
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseDown]
        monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [self] event in movement(event) }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [self] event in
            movement(event)
            return event
        }
        guard monitor != nil, localMonitor != nil else {
            release("mouse_monitor")
            report(["error": "mouse_monitor"])
            return
        }
        deadline = Date().addingTimeInterval(1)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(8))
        timer.setEventHandler { [weak self] in self?.tick() }
        self.timer = timer
        timer.resume()
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    func tick() {
        guard timer != nil else { return }
        if !locked {
            if Date() >= deadline {
                release("activation")
                report(["error": "activation"])
                return
            }
            guard NSApplication.shared.isActive else { return }
            let status = CGAssociateMouseAndMouseCursorPosition(0)
            guard status == .success else {
                release("cursor_association")
                report(["error": "cursor_association", "status": status.rawValue])
                return
            }
            let hideStatus = CGDisplayHideCursor(CGMainDisplayID())
            guard hideStatus == .success else {
                CGAssociateMouseAndMouseCursorPosition(1)
                release("cursor_hide")
                report(["error": "cursor_hide", "status": hideStatus.rawValue])
                return
            }
            locked = true
            deadline = Date().addingTimeInterval(10)
            report(["locked": true])
            return
        }
        if Date() >= deadline { release("timeout"); return }
        if !NSApplication.shared.isActive { release("focus"); return }
        if commandPending || CGEventSource.flagsState(.combinedSessionState).contains(.maskCommand) { release("command"); return }
        if CGEventSource.keyState(.combinedSessionState, key: 53) { release("escape"); return }
        if dx != 0 || dy != 0 { report(["dx": dx, "dy": dy]) }
        dx = 0
        dy = 0
    }
}

let look = MouseLook()
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
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
