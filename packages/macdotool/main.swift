// macdotool: a small ydotool-style input/window helper for macOS.
//
// Input subcommands mirror ydotool's argv so callers can share code:
//   click <0xNN>                     0x40 down, 0x80 up, 0xC0 down+up; low nibble 0 left, 1 right, 2 middle
//   mousemove [-a|--absolute] [-w|--wheel] -x N -y N
//   type [--key-delay ms] [--key-hold ms] [--file path|-] [text...]
//   key [--key-delay ms] <keycode:state>...   macOS virtual keycodes, state 1 down / 0 up
//   debug                            exit 0 only when Accessibility input is allowed
// Window/screen subcommands return hyprctl-shaped JSON (global points, top-left origin):
//   activewindow | clients | cursorpos
//   capture -g "x,y wxh"             PNG on stdout at one pixel per point
//   watch                            prints "x y" per left click/scroll until stdin closes
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

func fail(_ message: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

func printJSON(_ value: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { fail("JSON encoding failed") }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func sleepMs(_ ms: Int) { if ms > 0 { usleep(useconds_t(ms) * 1000) } }

// Parses "-x 5"/"--key-delay 2"-style options; leftover values are returned in order.
func parse(_ args: [String], flags: Set<String>, values: Set<String>) -> (opts: [String: String], rest: [String]) {
  var opts: [String: String] = [:], rest: [String] = [], i = 0
  while i < args.count {
    let a = args[i]
    if flags.contains(a) { opts[a] = "1" }
    else if values.contains(a) {
      guard i + 1 < args.count else { fail("Missing value for \(a)", 2) }
      opts[a] = args[i + 1]; i += 1
    } else { rest.append(a) }
    i += 1
  }
  return (opts, rest)
}

func intOpt(_ opts: [String: String], _ keys: String..., fallback: Int? = nil) -> Int {
  for k in keys { if let v = opts[k] { guard let n = Int(v) else { fail("Invalid number for \(k)", 2) }; return n } }
  guard let fallback else { fail("Missing \(keys[0])", 2) }
  return fallback
}

let source = CGEventSource(stateID: .combinedSessionState)
func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
func post(_ event: CGEvent?) {
  guard let event else { fail("Could not create input event") }
  event.post(tap: .cghidEventTap)
}

func click(_ spec: String) {
  let hex = spec.lowercased().hasPrefix("0x") ? String(spec.dropFirst(2)) : spec
  guard let code = UInt8(hex, radix: 16) else { fail("Invalid click code \(spec)", 2) }
  let button: CGMouseButton, down: CGEventType, up: CGEventType
  switch code & 0x0F {
  case 0: (button, down, up) = (.left, .leftMouseDown, .leftMouseUp)
  case 1: (button, down, up) = (.right, .rightMouseDown, .rightMouseUp)
  case 2: (button, down, up) = (.center, .otherMouseDown, .otherMouseUp)
  default: fail("Unsupported mouse button", 2)
  }
  let at = cursor()
  if code & 0x40 != 0 {
    let e = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: at, mouseButton: button)
    e?.setIntegerValueField(.mouseEventClickState, value: 1)
    post(e)
  }
  if code & 0xC0 == 0xC0 { sleepMs(25) }
  if code & 0x80 != 0 {
    let e = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: at, mouseButton: button)
    e?.setIntegerValueField(.mouseEventClickState, value: 1)
    post(e)
  }
}

func mousemove(_ args: [String]) {
  let (opts, _) = parse(args, flags: ["-a", "--absolute", "-w", "--wheel"], values: ["-x", "--xpos", "-y", "--ypos"])
  let x = intOpt(opts, "-x", "--xpos", fallback: 0), y = intOpt(opts, "-y", "--ypos", fallback: 0)
  if opts["-w"] != nil || opts["--wheel"] != nil {
    // Same sign as ydotool's REL_WHEEL: positive y scrolls up.
    post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(y), wheel2: Int32(x), wheel3: 0))
    return
  }
  let from = cursor()
  let to = opts["-a"] != nil || opts["--absolute"] != nil ? CGPoint(x: x, y: y) : CGPoint(x: from.x + CGFloat(x), y: from.y + CGFloat(y))
  // A held button must move as a drag, or apps never see the drag gesture.
  let (type, button): (CGEventType, CGMouseButton) =
    CGEventSource.buttonState(.combinedSessionState, button: .left) ? (.leftMouseDragged, .left) :
    CGEventSource.buttonState(.combinedSessionState, button: .right) ? (.rightMouseDragged, .right) : (.mouseMoved, .left)
  post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: to, mouseButton: button))
}

func type(_ args: [String]) {
  let (opts, rest) = parse(args, flags: [], values: ["-d", "--key-delay", "-H", "--key-hold", "-f", "--file"])
  let delay = intOpt(opts, "-d", "--key-delay", fallback: 12), hold = intOpt(opts, "-H", "--key-hold", fallback: 12)
  var text = rest.joined(separator: " ")
  if let file = opts["-f"] ?? opts["--file"] {
    let data = file == "-" ? FileHandle.standardInput.readDataToEndOfFile() : (FileManager.default.contents(atPath: file) ?? Data())
    guard let s = String(data: data, encoding: .utf8) else { fail("Input is not UTF-8", 2) }
    text = s
  }
  // Unicode payloads on one virtual key are layout independent; keycode 0 is the only key this presses.
  for scalar in text.utf16 {
    var unit = scalar
    let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
    post(down)
    sleepMs(hold)
    let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
    post(up)
    sleepMs(delay)
  }
}

func key(_ args: [String]) {
  let (opts, rest) = parse(args, flags: [], values: ["-d", "--key-delay"])
  let delay = intOpt(opts, "-d", "--key-delay", fallback: 12)
  for item in rest {
    let parts = item.split(separator: ":")
    guard parts.count == 2, let code = UInt16(parts[0]), code < 128, let state = Int(parts[1]), state == 0 || state == 1 else { fail("Invalid key \(item)", 2) }
    post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: state == 1))
    sleepMs(delay)
  }
}

func debug() {
  let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  if !AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary) {
    fail("Accessibility access is required. Allow the app in System Settings > Privacy & Security > Accessibility.")
  }
  print("ok")
}

// hyprctl-shaped window records, front to back.
func windows() -> [[String: Any]] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  var bundles: [Int: String] = [:]
  return list.compactMap { info in
    guard let number = info[kCGWindowNumber as String] as? Int,
          let pid = info[kCGWindowOwnerPID as String] as? Int,
          let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
    if bundles[pid] == nil {
      bundles[pid] = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? (info[kCGWindowOwnerName as String] as? String) ?? ""
    }
    return [
      "address": String(format: "0x%x", number),
      "pid": pid,
      "class": bundles[pid]!,
      "title": info[kCGWindowName as String] as? String ?? "",
      "layer": info[kCGWindowLayer as String] as? Int ?? 0,
      "mapped": (info[kCGWindowIsOnscreen as String] as? Bool) ?? true,
      "at": [Int(bounds.origin.x.rounded()), Int(bounds.origin.y.rounded())],
      "size": [Int(bounds.width.rounded()), Int(bounds.height.rounded())],
    ]
  }
}

func activeWindow() {
  guard let app = NSWorkspace.shared.frontmostApplication else { fail("No frontmost application") }
  let pid = Int(app.processIdentifier)
  let own = windows().filter { ($0["pid"] as? Int) == pid && ($0["layer"] as? Int) == 0 }
  // Fullscreen apps stack toolbar strips above the real window, so match the
  // Accessibility focused-window frame; without access, take the topmost sizable window.
  var focused: [Int]? = nil
  var value: CFTypeRef?
  if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute as CFString, &value) == .success,
     let window = value, CFGetTypeID(window) == AXUIElementGetTypeID() {
    var pos: CFTypeRef?, size: CFTypeRef?, p = CGPoint.zero, s = CGSize.zero
    let ax = window as! AXUIElement
    if AXUIElementCopyAttributeValue(ax, kAXPositionAttribute as CFString, &pos) == .success,
       AXUIElementCopyAttributeValue(ax, kAXSizeAttribute as CFString, &size) == .success,
       AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) {
      focused = [Int(p.x.rounded()), Int(p.y.rounded()), Int(s.width.rounded()), Int(s.height.rounded())]
    }
  }
  let match = focused.flatMap { f in own.first { (($0["at"] as? [Int]) ?? []) + (($0["size"] as? [Int]) ?? []) == f } }
    ?? own.first { (($0["size"] as? [Int]) ?? []).allSatisfy { $0 >= 100 } }
  guard let window = match else { fail("No focused window") }
  printJSON(window)
}

func capture(_ args: [String]) async {
  let (opts, _) = parse(args, flags: [], values: ["-g"])
  guard let geometry = opts["-g"] else { fail("capture needs -g \"x,y wxh\"", 2) }
  let scanner = Scanner(string: geometry)
  var x = 0, y = 0, w = 0, h = 0
  guard scanner.scanInt(&x), scanner.scanString(",") != nil, scanner.scanInt(&y), scanner.scanInt(&w),
        scanner.scanString("x") != nil, scanner.scanInt(&h), scanner.isAtEnd, w > 0, h > 0, w <= 32768, h <= 32768 else { fail("Invalid geometry \(geometry)", 2) }
  let rect = CGRect(x: x, y: y, width: w, height: h)
  if !CGPreflightScreenCaptureAccess() {
    CGRequestScreenCaptureAccess()
    fail("Screen Recording access is required. Allow the app in System Settings > Privacy & Security > Screen Recording.")
  }
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(rect) }) else { fail("Region must fit inside one display") }
    let origin = CGDisplayBounds(display.displayID).origin
    let config = SCStreamConfiguration()
    config.sourceRect = rect.offsetBy(dx: -origin.x, dy: -origin.y)
    config.width = w; config.height = h
    config.showsCursor = false
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { fail("PNG encoder unavailable") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fail("PNG encoding failed") }
    FileHandle.standardOutput.write(data as Data)
  } catch {
    fail("Screen capture failed: \(error.localizedDescription)")
  }
}

var watchTap: CFMachPort?

func watch() -> Never {
  let mask = (1 << CGEventType.leftMouseUp.rawValue) | (1 << CGEventType.scrollWheel.rawValue)
  // Listen-only: the tap observes clicks/scrolls and never blocks or changes them.
  watchTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                               eventsOfInterest: CGEventMask(mask), callback: { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap = watchTap { CGEvent.tapEnable(tap: tap, enable: true) }
    } else {
      let p = event.location
      print("\(Int(p.x.rounded())) \(Int(p.y.rounded()))")
      fflush(stdout)
    }
    return Unmanaged.passUnretained(event)
  }, userInfo: nil)
  guard let tap = watchTap else {
    fail("Could not observe mouse activity. Allow the app in System Settings > Privacy & Security > Input Monitoring.")
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  print("ready"); fflush(stdout)
  // The parent owns this process: exit as soon as it closes our stdin or dies.
  Thread.detachNewThread { _ = FileHandle.standardInput.readDataToEndOfFile(); exit(0) }
  CFRunLoopRun()
  exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: macdotool <click|mousemove|type|key|debug|activewindow|clients|cursorpos|capture|watch> ...", 2) }
let rest = Array(args.dropFirst())
switch command {
case "click": guard let spec = rest.first else { fail("click needs a code", 2) }; click(spec)
case "mousemove": mousemove(rest)
case "type": type(rest)
case "key": key(rest)
case "debug": debug()
case "activewindow": activeWindow()
case "clients": printJSON(windows())
case "cursorpos": let p = cursor(); printJSON(["x": Int(p.x.rounded()), "y": Int(p.y.rounded())])
case "capture": await capture(rest)
case "watch": watch()
default: fail("Unknown command \(command)", 2)
}
