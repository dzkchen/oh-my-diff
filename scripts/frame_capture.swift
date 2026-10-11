import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreImage

final class Observer: NSObject, SCStreamOutput, @unchecked Sendable {
    var marker: (Int, Int, Double)?
    var timebase = mach_timebase_info_data_t()
    var offset: Double = 0
    var saved = false
    override init() {
        super.init()
        mach_timebase_info(&timebase)
        offset = Date().timeIntervalSince1970 * 1e9 - Double(mach_absolute_time()) * Double(timebase.numer) / Double(timebase.denom)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let buffer = sample.imageBuffer,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let info = attachments.first else { return }
        let status = info[.status] as? Int ?? -1
        let ticks = (info[.displayTime] as? NSNumber)?.doubleValue ?? 0
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let address = CVPixelBufferGetBaseAddress(buffer) else { return }
        let bytes = address.assumingMemoryBound(to: UInt8.self)
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer), stride = CVPixelBufferGetBytesPerRow(buffer)
        func color(_ x: Int, _ y: Int, _ kind: Int) -> Bool {
            guard x >= 0 && y >= 0 && x < width && y < height else { return false }
            let at = y * stride + x * 4
            if kind == 0 { return bytes[at] > 180 && bytes[at + 1] < 160 && bytes[at + 2] > 180 }
            if kind == 2 { return bytes[at] < 160 && bytes[at + 1] > 180 && bytes[at + 2] > 180 }
            return bytes[at] > 180 && bytes[at + 1] > 180 && bytes[at + 2] < 160
        }
        if marker == nil || !color(marker!.0 + Int(marker!.2 / 2), marker!.1, 0) {
            marker = nil
            outer: for y in Swift.stride(from: 4, to: height - 4, by: 4) {
                for x in Swift.stride(from: 0, to: width - 100, by: 4) where color(x, y, 0) {
                    var left = x, end = x
                    while left > 0 && color(left - 1, y, 0) { left -= 1 }
                    while end < width && color(end, y, 0) { end += 1 }
                    let tile = end - left
                    if tile >= 8 && left + 26 * tile < width && color(end + tile / 2, y, 1) {
                        var last = end + tile
                        while last < width && !color(last, y, 2) { last += 1 }
                        if last < width && Double(last - left) / Double(tile) > 23 && Double(last - left) / Double(tile) < 29 {
                            marker = (left, y, Double(last - left) / 26)
                            break outer
                        }
                    }
                }
            }
        }
        var sequence = -1
        if let (left, y, tile) = marker {
            var value = 0
            for bit in 0..<24 {
                let x = left + Int((Double(bit + 2) + 0.5) * tile)
                if x >= width { break }
                if bytes[y * stride + x * 4] > 127 { value |= 1 << bit }
            }
            let number = value & 65535, checksum = (value >> 16) & 255
            if checksum == ((number & 255) ^ (number >> 8) ^ 165) { sequence = number }
        }
        if !saved && CommandLine.arguments.count == 4 && status == 0 && sequence >= 0 {
            saved = true
            let image = CIImage(cvPixelBuffer: buffer)
            if let cg = CIContext().createCGImage(image, from: image.extent),
               let data = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
                try? data.write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
            }
        }
        let record: [String: Any] = ["sequence": sequence, "display_ns": ticks * Double(timebase.numer) / Double(timebase.denom) + offset,
            "callback_ns": Date().timeIntervalSince1970 * 1e9, "status": status, "width": width, "height": height,
            "marker": marker.map { [Double($0.0), Double($0.1), $0.2] } ?? []]
        if let data = try? JSONSerialization.data(withJSONObject: record) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
    }
}

@main struct Capture {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard (3...4).contains(arguments.count), let pid = Int32(arguments[1]), let seconds = Double(arguments[2]) else {
            fatalError("usage: frame_capture PID SECONDS [SNAPSHOT]")
        }
        NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
        try await Task.sleep(for: .milliseconds(500))
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.filter({ $0.owningApplication?.processID == pid && $0.frame.width > 300 }).max(by: { $0.frame.width < $1.frame.width }),
              let display = content.displays.first(where: { $0.frame.intersects(window.frame) }) else { fatalError("visible terminal window unavailable") }
        let config = SCStreamConfiguration()
        config.sourceRect = window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        let scale = Double(display.width) / display.frame.width
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
        config.minimumFrameInterval = .zero
        config.queueDepth = 8
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        let observer = Observer()
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: nil)
        try stream.addStreamOutput(observer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frame-capture"))
        try await stream.startCapture()
        try await Task.sleep(for: .seconds(seconds))
        try await stream.stopCapture()
    }
}
