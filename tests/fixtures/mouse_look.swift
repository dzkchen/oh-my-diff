import Foundation
import Darwin

extension CGPoint { static var zero: CGPoint { CGPoint(x: 0, y: 0) } }
enum CGError: Int32 { case success = 0, failure = 1 }
var associationFails = false
var hideFails = false
var associations: [Int32] = []
var hides = 0
var shows = 0
var warps = 0
func CGAssociateMouseAndMouseCursorPosition(_ value: Int32) -> CGError {
    associations.append(value)
    return associationFails && value == 0 ? .failure : .success
}
func CGMainDisplayID() -> Int { 0 }
func CGDisplayHideCursor(_ display: Int) -> CGError { hides += 1; return hideFails ? .failure : .success }
func CGDisplayShowCursor(_ display: Int) { shows += 1 }
func CGWarpMouseCursorPosition(_ point: CGPoint) -> CGError { warps += 1; return .success }
struct CGEvent { init?(source: Int?) {} ; var location: CGPoint { .zero } }
struct CGEventFlags: OptionSet {
    let rawValue: Int
    static let maskCommand = Self(rawValue: 1)
}
enum CGEventSourceStateID { case combinedSessionState }
enum CGEventSource {
    static var command = false
    static var escape = false
    static func flagsState(_ state: CGEventSourceStateID) -> CGEventFlags { command ? .maskCommand : [] }
    static func keyState(_ state: CGEventSourceStateID, key: Int) -> Bool { escape }
}
final class NSApplication {
    static let shared = NSApplication()
    enum ActivationPolicy { case prohibited, accessory }
    var isActive = false
    var policy = ActivationPolicy.prohibited
    var activations = 0
    func setActivationPolicy(_ value: ActivationPolicy) { policy = value }
    func activate(ignoringOtherApps: Bool) {
        precondition(ignoringOtherApps)
        activations += 1
    }
}
final class NSRunningApplication {
    let processIdentifier: pid_t = 10
    var activations = 0
    func activate(options: [Int]) { activations += 1; NSApplication.shared.isActive = false }
}
final class NSWorkspace {
    static let shared = NSWorkspace()
    var reads = 0
    var application: NSRunningApplication? = NSRunningApplication()
    var frontmostApplication: NSRunningApplication? {
        get { reads += 1; return application }
        set { application = newValue }
    }
}
final class NSEvent {
    struct EventTypeMask: OptionSet {
        let rawValue: Int
        static let mouseMoved = Self(rawValue: 1)
        static let leftMouseDragged = Self(rawValue: 2)
        static let rightMouseDragged = Self(rawValue: 4)
        static let otherMouseDragged = Self(rawValue: 8)
        static let leftMouseDown = Self(rawValue: 16)
    }
    struct ModifierFlags: OptionSet {
        let rawValue: Int
        static let command = Self(rawValue: 1)
    }
    enum EventType { case mouseMoved, leftMouseDown }
    let deltaX: Double
    let deltaY: Double
    var type = EventType.mouseMoved
    var modifierFlags: ModifierFlags = []
    init(_ x: Double, _ y: Double) { deltaX = x; deltaY = y }
    static var fail = false
    static var localFail = false
    static var handler: ((NSEvent) -> Void)?
    static var localHandler: ((NSEvent) -> NSEvent?)?
    static var removed = 0
    static func addGlobalMonitorForEvents(matching: EventTypeMask, handler callback: @escaping (NSEvent) -> Void) -> Any? {
        if fail { return nil }
        handler = callback
        return 1
    }
    static func addLocalMonitorForEvents(matching: EventTypeMask, handler callback: @escaping (NSEvent) -> NSEvent?) -> Any? {
        if localFail { return nil }
        localHandler = callback
        return 2
    }
    static func removeMonitor(_ token: Any) {
        if token as? Int == 1 { handler = nil } else { localHandler = nil }
        removed += 1
    }
}

// INSERT_MOUSE_LOOK

func timerOf(_ look: MouseLook) -> DispatchSourceTimer? {
    guard let timer = Mirror(reflecting: look).children.first(where: { $0.label == "timer" }) else {
        preconditionFailure("missing lock-scoped timer")
    }
    return Mirror(reflecting: timer.value).children.first?.value as? DispatchSourceTimer
}
func hasTimer(_ look: MouseLook) -> Bool { timerOf(look) != nil }
let scenario = CommandLine.arguments[1]
let look = MouseLook()
let terminal = NSWorkspace.shared.application!
func activateLock() {
    look.lock()
    precondition(!look.locked && associations.isEmpty && hides == 0)
    look.tick()
    precondition(!look.locked && associations.isEmpty && hides == 0)
    NSApplication.shared.isActive = true
    look.tick()
}
func cleaned() {
    precondition(!look.locked && !hasTimer(look) && NSEvent.handler == nil && NSEvent.localHandler == nil)
    precondition(NSApplication.shared.policy == .prohibited)
}
if scenario == "monitor" || scenario == "local_monitor" {
    NSEvent.fail = scenario == "monitor"
    NSEvent.localFail = scenario == "local_monitor"
    look.lock()
    precondition(!look.locked && associations.isEmpty && hides == 0 && shows == 0)
    precondition(NSEvent.removed == 1 && terminal.activations == 0)
    cleaned()
} else if scenario == "activation" {
    look.lock()
    look.tick()
    precondition(!look.locked && associations.isEmpty && hides == 0)
    look.deadline = .distantPast
    look.tick()
    cleaned()
    precondition(NSEvent.removed == 2 && terminal.activations == 0 && associations.isEmpty)
} else if scenario == "association" || scenario == "hide" {
    associationFails = scenario == "association"
    hideFails = scenario == "hide"
    activateLock()
    cleaned()
    precondition(NSEvent.removed == 2 && terminal.activations == 1 && shows == 0)
    precondition(associations == (hideFails ? [0, 1] : [0]) && hides == (hideFails ? 1 : 0))
} else {
    if scenario == "movement" { precondition(!hasTimer(look)) }
    activateLock()
    precondition(look.locked)
    if scenario == "movement" { precondition(hasTimer(look)) }
    if scenario == "movement" {
        let reads = NSWorkspace.shared.reads
        let timer = timerOf(look)!
        NSEvent.handler?(NSEvent(1.25, -2))
        let local = NSEvent(2.75, 1.5)
        precondition(NSEvent.localHandler?(local) === local)
        let click = NSEvent(100, 100)
        click.type = .leftMouseDown
        NSEvent.handler?(click)
        precondition(NSWorkspace.shared.reads == reads)
        look.tick()
        look.tick()
        precondition(warps == 0)
        look.release()
        precondition(timer.isCancelled)
    } else if scenario == "closed" || scenario == "full" {
        let stdoutMode = fcntl(STDOUT_FILENO, F_GETFL) & O_NONBLOCK
        var descriptors: [Int32] = [0, 0]
        precondition(pipe(&descriptors) == 0)
        precondition(fcntl(descriptors[1], F_SETFL, O_NONBLOCK) == 0)
        if scenario == "closed" { close(descriptors[0]) }
        else {
            let bytes = [UInt8](repeating: 0, count: 4096)
            while bytes.withUnsafeBytes({ Darwin.write(descriptors[1], $0.baseAddress, $0.count) }) > 0 {}
            precondition(errno == EAGAIN)
        }
        precondition(fcntl(descriptors[1], F_SETFL, stdoutMode) == 0)
        precondition(dup2(descriptors[1], STDOUT_FILENO) == STDOUT_FILENO)
        close(descriptors[1])
        NSEvent.handler?(NSEvent(1, 1))
        look.tick()
        precondition(!look.locked)
        look.lock()
        precondition(!look.locked && associations == [0, 1])
    } else {
        NSEvent.handler?(NSEvent(99, 99))
        switch scenario {
        case "focus": NSApplication.shared.isActive = false
        case "command": CGEventSource.command = true
        case "command_click":
            let click = NSEvent(100, 100)
            click.type = .leftMouseDown
            click.modifierFlags = .command
            NSEvent.handler?(click)
            precondition(look.locked, "release must wait for tick")
        case "escape": CGEventSource.escape = true
        case "timeout": look.deadline = .distantPast
        default: preconditionFailure("unknown scenario")
        }
        look.tick()
    }
    cleaned()
    precondition(terminal.activations == (scenario == "focus" ? 0 : 1))
    if scenario == "movement" { precondition(!hasTimer(look)) }
    precondition(hides == 1 && shows == 1 && associations == [0, 1])
    look.release()
    precondition(shows == 1)
}
