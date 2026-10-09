// Renders the coach pane's Flueny mark: the white sunburst arch from
// app-frontend/public/flueny-logo.svg on a dark rounded square, so it reads on
// light and dark terminals alike. macOS 14 or later (NSImage reads SVG).
//
//   swift assets/render-mark.swift ../app-frontend/public/flueny-logo.svg assets/flueny-mark.png
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: render-mark.swift <logo.svg> <out.png>\n".data(using: .utf8)!)
    exit(1)
}
let size = 64
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let full = NSRect(x: 0, y: 0, width: size, height: size)
NSColor(srgbRed: 0x18 / 255, green: 0x18 / 255, blue: 0x1b / 255, alpha: 1).setFill()
NSBezierPath(roundedRect: full, xRadius: 14, yRadius: 14).fill()
logo.draw(in: full.insetBy(dx: 10, dy: 10), from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
