// macdotool: a small ydotool-style input/window helper for macOS.
//
// Input subcommands mirror ydotool's argv so callers can share code:
//   click [-r N] [-D ms] <0xNN>...   0x40 down, 0x80 up, 0xC0 down+up; low nibble 0 left, 1 right, 2 middle
//   mousemove [-a|--absolute] [-w|--wheel] -x N -y N [--smooth ms] [--ease minjerk|linear]
//   type [-d ms] [-H ms] [-D ms] [-e 0|1] [--chunk N] [--file path|-] [text...]
//   key [--key-delay ms] <keycode:state>...   macOS virtual keycodes, state 1 down / 0 up
//   debug                            exit 0 only when Accessibility input is allowed
// Window/screen subcommands return hyprctl-shaped JSON (global points, top-left origin):
//   activewindow | clients | cursorpos
//   capture -g "x,y wxh"             PNG on stdout at one pixel per point
//   watch                            prints "x y" per left click/scroll until stdin closes
// Daemon (our ydotoold): `serve` reads {"id":1,"argv":[...],"input":"stdin text"} lines on stdin and
// answers {"id":1,"ok":true,"out":"<base64 stdout>"} or {"id":1,"ok":false,"code":N,"error":"..."};
// {"cancel":1} interrupts request 1 between events. The CLI and serve share one dispatch (run).
// MACDOTOOL_DRY=1 counts and discards posted events (tests only).
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Fail: Error { let message: String; let code: Int32 }
struct Cancelled: Error {}
func fail(_ message: String, _ code: Int32 = 1) -> Fail { Fail(message: message, code: code) }
func die(_ message: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

// One lock guards everything shared between the reader, the worker and signal handlers.
let cond = NSCondition()
var queue: [(id: Any, argv: [String], input: String?)] = []
var pending = Set<String>(), cancelled = Set<String>(), current: String?
var closing = false
var heldButtons = Set<UInt32>(), heldKeys = Set<UInt16>()
var inServe = false, promptedAX = false, axTrusted = false, screenOK = false
var outBuf = Data(), stdinText: String?
var serving = false
let dry = ProcessInfo.processInfo.environment["MACDOTOOL_DRY"] == "1"
var posted = 0
var displayStore: [SCDisplay]?
let writeLock = NSLock()

func writeAll(_ data: Data) {
  writeLock.lock(); defer { writeLock.unlock() }
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    var off = 0
    while off < raw.count {
      let n = write(1, raw.baseAddress! + off, raw.count - off)
      if n <= 0 { if n < 0 && errno == EINTR { continue }; return }
      off += n
    }
  }
}

// Stdout goes through a buffer so serve can frame it; the CLI flushes it at exit.
func emit(_ data: Data) { outBuf.append(data) }
func emitJSON(_ value: Any) throws {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { throw fail("JSON encoding failed") }
  emit(data); emit(Data([10]))
}

// Precise pacer: absolute mach deadlines so cadence does not drift; checks cancel every <=4 ms.
var timebase = mach_timebase_info_data_t()
let _ = mach_timebase_info(&timebase)
func ticks(_ ms: Double) -> UInt64 { UInt64(max(0, ms) * 1e6 * Double(timebase.denom) / Double(timebase.numer)) }

func checkCancel() throws {
  cond.lock()
  let stop = closing || (current.map { cancelled.contains($0) } ?? false)
  cond.unlock()
  if stop { throw Cancelled() }
}

func waitUntil(_ deadline: UInt64) throws {
  let step = ticks(4)
  while true {
    try checkCancel()
    let now = mach_absolute_time()
    if now >= deadline { return }
    mach_wait_until(min(deadline, now + step))
  }
}

struct Pacer {
  var t = mach_absolute_time()
  mutating func advance(_ ms: Int) throws {
    t += ticks(Double(ms))
    let now = mach_absolute_time()
    if now > t + ticks(50) { t = now }  // far behind: resync instead of bursting
    try waitUntil(t)
  }
}

// Parses "-x 5"/"--key-delay 2"-style options; leftover values are returned in order.
func parse(_ args: [String], flags: Set<String>, values: Set<String>) throws -> (opts: [String: String], rest: [String]) {
  var opts: [String: String] = [:], rest: [String] = [], i = 0
  while i < args.count {
    let a = args[i]
    if flags.contains(a) { opts[a] = "1" }
    else if values.contains(a) {
      guard i + 1 < args.count else { throw fail("Missing value for \(a)", 2) }
      opts[a] = args[i + 1]; i += 1
    } else { rest.append(a) }
    i += 1
  }
  return (opts, rest)
}

func intOpt(_ opts: [String: String], _ keys: String..., fallback: Int? = nil) throws -> Int {
  for k in keys { if let v = opts[k] { guard let n = Int(v) else { throw fail("Invalid number for \(k)", 2) }; return n } }
  guard let fallback else { throw fail("Missing \(keys[0])", 2) }
  return fallback
}

let source: CGEventSource? = {
  let s = CGEventSource(stateID: .combinedSessionState)
  s?.localEventsSuppressionInterval = 0  // real and synthetic input must not stall each other
  return s
}()
func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
func post(_ event: CGEvent) { posted += 1; if !dry { event.post(tap: .cghidEventTap) } }

// Held state is tracked from what we post so EOF/SIGTERM/cancel can release it.
func postMouse(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton, state: Int64 = 0, delta: CGPoint = .zero) throws {
  guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { throw fail("Could not create input event") }
  if state > 0 { e.setIntegerValueField(.mouseEventClickState, value: state) }
  if delta != .zero {
    e.setIntegerValueField(.mouseEventDeltaX, value: Int64(delta.x.rounded()))
    e.setIntegerValueField(.mouseEventDeltaY, value: Int64(delta.y.rounded()))
  }
  cond.lock()
  switch type {
  case .leftMouseDown, .rightMouseDown, .otherMouseDown: heldButtons.insert(button.rawValue)
  case .leftMouseUp, .rightMouseUp, .otherMouseUp: heldButtons.remove(button.rawValue)
  default: break
  }
  cond.unlock()
  post(e)
}

func postKey(_ code: UInt16, down: Bool, units: [UInt16]? = nil, noFlags: Bool = false) throws {
  guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { throw fail("Could not create input event") }
  if var u = units { e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u) }
  if noFlags { e.flags = [] }  // a physically held Shift/Cmd must not corrupt typed text
  cond.lock(); if down { heldKeys.insert(code) } else { heldKeys.remove(code) }; cond.unlock()
  post(e)
}

// Releases what we hold (optionally keeping what was already down before a request began).
func releaseHeld(except keep: (buttons: Set<UInt32>, keys: Set<UInt16>) = ([], [])) {
  cond.lock()
  let buttons = heldButtons.subtracting(keep.buttons), keys = heldKeys.subtracting(keep.keys)
  cond.unlock()
  for b in buttons {
    let (up, button): (CGEventType, CGMouseButton) = b == 0 ? (.leftMouseUp, .left) : b == 1 ? (.rightMouseUp, .right) : (.otherMouseUp, .center)
    try? postMouse(up, cursor(), button, state: 1)
  }
  for k in keys { try? postKey(k, down: false) }
  if dry { FileHandle.standardError.write("dry: released \(buttons.count) buttons \(keys.count) keys\n".data(using: .utf8)!) }
}

func click(_ args: [String]) throws {
  let (opts, specs) = try parse(args, flags: [], values: ["-r", "--repeat", "-D", "--next-delay"])
  let repeats = try intOpt(opts, "-r", "--repeat", fallback: 1), gap = try intOpt(opts, "-D", "--next-delay", fallback: 25)
  guard repeats >= 1, repeats <= 1000, gap >= 0 else { throw fail("Invalid repeat or delay", 2) }
  guard !specs.isEmpty else { throw fail("click needs a code", 2) }
  var codes: [(code: UInt8, button: CGMouseButton, down: CGEventType, up: CGEventType)] = []
  for spec in specs {
    let hex = spec.lowercased().hasPrefix("0x") ? String(spec.dropFirst(2)) : spec
    guard let code = UInt8(hex, radix: 16) else { throw fail("Invalid click code \(spec)", 2) }
    switch code & 0x0F {
    case 0: codes.append((code, .left, .leftMouseDown, .leftMouseUp))
    case 1: codes.append((code, .right, .rightMouseDown, .rightMouseUp))
    case 2: codes.append((code, .center, .otherMouseDown, .otherMouseUp))
    default: throw fail("Unsupported mouse button", 2)
    }
  }
  // Clicks inside the system double-click window on one button count 1, 2, ... so apps see a real double click.
  let window = ticks(NSEvent.doubleClickInterval * 1000)
  var pacer = Pacer(), lastUp: UInt64 = 0, lastButton: UInt32 = .max, count: Int64 = 0, first = true
  for _ in 0..<repeats {
    for c in codes {
      if !first { try pacer.advance(gap) }
      first = false
      let at = cursor()
      if c.code & 0x40 != 0 {
        count = lastButton == c.button.rawValue && mach_absolute_time() - lastUp <= window ? count + 1 : 1
        lastButton = c.button.rawValue
        try postMouse(c.down, at, c.button, state: count)
      }
      if c.code & 0xC0 == 0xC0 { try pacer.advance(8) }
      if c.code & 0x80 != 0 {
        try postMouse(c.up, at, c.button, state: max(count, 1))
        lastUp = mach_absolute_time()
      }
    }
  }
}

func mousemove(_ args: [String]) throws {
  let (opts, _) = try parse(args, flags: ["-a", "--absolute", "-w", "--wheel"], values: ["-x", "--xpos", "-y", "--ypos", "--smooth", "--ease"])
  let x = try intOpt(opts, "-x", "--xpos", fallback: 0), y = try intOpt(opts, "-y", "--ypos", fallback: 0)
  if opts["-w"] != nil || opts["--wheel"] != nil {
    // ydotool passes x then y: x is horizontal, y vertical; positive y scrolls up like REL_WHEEL.
    guard let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(clamping: y), wheel2: Int32(clamping: x), wheel3: 0) else { throw fail("Could not create input event") }
    post(e)
    return
  }
  let smooth = min(2000, max(0, try intOpt(opts, "--smooth", fallback: 0)))
  let ease = opts["--ease"] ?? "minjerk"
  guard ease == "minjerk" || ease == "linear" else { throw fail("Unknown --ease \(ease)", 2) }
  let from = cursor()
  let to = opts["-a"] != nil || opts["--absolute"] != nil ? CGPoint(x: x, y: y) : CGPoint(x: from.x + CGFloat(x), y: from.y + CGFloat(y))
  // A held button must move as a drag, or apps never see the drag gesture.
  func down(_ b: CGMouseButton) -> Bool {
    cond.lock(); let ours = heldButtons.contains(b.rawValue); cond.unlock()
    return ours || CGEventSource.buttonState(.combinedSessionState, button: b)
  }
  let (type, button): (CGEventType, CGMouseButton) =
    down(.left) ? (.leftMouseDragged, .left) : down(.right) ? (.rightMouseDragged, .right) :
    down(.center) ? (.otherMouseDragged, .center) : (.mouseMoved, .left)
  // About 120 Hz along a straight line; the last event always lands exactly on the target.
  let steps = smooth == 0 ? 1 : max(1, Int((Double(smooth) * 0.12).rounded()))
  let start = mach_absolute_time()
  var prev = from
  for i in 1...steps {
    let f = Double(i) / Double(steps), s = ease == "linear" ? f : f * f * f * (10 - 15 * f + 6 * f * f)
    let p = i == steps ? to : CGPoint(x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s)
    if steps > 1 { try waitUntil(start + ticks(Double(smooth) * f)) }
    try postMouse(type, p, button, delta: CGPoint(x: p.x - prev.x, y: p.y - prev.y))
    prev = p
  }
}

enum Tok { case units([UInt16]); case key(UInt16) }

// ydotool -e: \n, \t and \\ are translated. A scalar never splits across chunks, so surrogate pairs stay whole.
func tokens(_ s: String, escape: Bool, chunk: Int) -> [Tok] {
  var out: [Tok] = [], cur: [UInt16] = []
  func flush() { if !cur.isEmpty { out.append(.units(cur)); cur = [] } }
  let sc = Array(s.unicodeScalars)
  var i = 0
  while i < sc.count {
    var c = sc[i]
    if escape, c == "\\", i + 1 < sc.count {
      switch sc[i + 1] {
      case "n": flush(); out.append(.key(36)); i += 2; continue
      case "t": flush(); out.append(.key(48)); i += 2; continue
      case "\\": c = "\\"; i += 1
      default: break
      }
    }
    let u = Array(c.utf16)
    if cur.count + u.count > chunk { flush() }
    cur += u; i += 1
  }
  flush()
  return out
}

func type(_ args: [String]) throws {
  let (opts, rest) = try parse(args, flags: [], values: ["-d", "--key-delay", "-H", "--key-hold", "-D", "--next-delay", "-e", "--escape", "-f", "--file", "--chunk"])
  let delay = try intOpt(opts, "-d", "--key-delay", fallback: 12), hold = try intOpt(opts, "-H", "--key-hold", fallback: 12)
  let gap = try intOpt(opts, "-D", "--next-delay", fallback: 0), esc = try intOpt(opts, "-e", "--escape", fallback: 1)
  let chunk = try intOpt(opts, "--chunk", fallback: 1)
  guard (1...20).contains(chunk), esc == 0 || esc == 1, delay >= 0, hold >= 0, gap >= 0 else { throw fail("Invalid type option", 2) }
  // Without -D the args are one space-joined string, as before; with -D each is typed on its own with a pause between.
  var strings = opts["-D"] != nil || opts["--next-delay"] != nil ? rest : [rest.joined(separator: " ")]
  if let file = opts["-f"] ?? opts["--file"] {
    let data = file == "-" ? (inServe ? Data((stdinText ?? "").utf8) : FileHandle.standardInput.readDataToEndOfFile()) : (FileManager.default.contents(atPath: file) ?? Data())
    guard let s = String(data: data, encoding: .utf8) else { throw fail("Input is not UTF-8", 2) }
    strings = [s]
  }
  var toks: [Tok] = [], breaks: Set<Int> = []
  for (n, s) in strings.enumerated() {
    if n > 0 { toks += tokens(" ", escape: false, chunk: chunk); breaks.insert(toks.count - 1) }
    toks += tokens(s, escape: esc == 1, chunk: chunk)
  }
  // Unicode payloads on one virtual key are layout independent; keycode 0 carries them. Return/Tab are real keys.
  var pacer = Pacer()
  for (n, t) in toks.enumerated() {
    switch t {
    case .units(let u):
      try postKey(0, down: true, units: u, noFlags: true)
      try pacer.advance(hold)
      try postKey(0, down: false, units: u, noFlags: true)
    case .key(let k):
      try postKey(k, down: true, noFlags: true)
      try pacer.advance(hold)
      try postKey(k, down: false, noFlags: true)
    }
    if n < toks.count - 1 { try pacer.advance(breaks.contains(n) ? delay + gap : delay) }
  }
}

func key(_ args: [String]) throws {
  let (opts, rest) = try parse(args, flags: [], values: ["-d", "--key-delay"])
  let delay = try intOpt(opts, "-d", "--key-delay", fallback: 12)
  var items: [(UInt16, Bool)] = []
  for item in rest {
    let parts = item.split(separator: ":")
    guard parts.count == 2, let code = UInt16(parts[0]), code < 128, let state = Int(parts[1]), state == 0 || state == 1 else { throw fail("Invalid key \(item)", 2) }
    items.append((code, state == 1))
  }
  var pacer = Pacer()
  for (n, (code, down)) in items.enumerated() {
    try postKey(code, down: down)
    if n < items.count - 1 { try pacer.advance(delay) }
  }
}

func debug() throws {
  // Prompt once per process; a daemon must not pop the dialog on every call.
  if !axTrusted {
    if promptedAX { axTrusted = AXIsProcessTrusted() }
    else { promptedAX = true; axTrusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
  }
  if !axTrusted { throw fail("Accessibility access is required. Allow the app in System Settings > Privacy & Security > Accessibility.") }
  emit(Data("ok\n".utf8))
}

// hyprctl-shaped window records, front to back.
func windows(pid only: Int? = nil) -> [[String: Any]] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  var bundles: [Int: String] = [:]
  return list.compactMap { info in
    guard let number = info[kCGWindowNumber as String] as? Int,
          let pid = info[kCGWindowOwnerPID as String] as? Int,
          only == nil || only == pid,
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

// Live focus: NSWorkspace.frontmostApplication lagged ~3 s in the daemon and skipped whole app switches,
// which blinded the focus guard while typing. The system-wide AX element answers in ~1 ms and stays current.
func frontPid() throws -> pid_t {
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.5)
  var value: CFTypeRef?, pid: pid_t = 0
  // Chromium apps return kAXErrorNoValue with the correct element filled in, so judge the value, not the status.
  _ = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &value)
  if let app = value, CFGetTypeID(app) == AXUIElementGetTypeID(), AXUIElementGetPid(app as! AXUIElement, &pid) == .success, pid > 0 { return pid }
  // A one-shot CLI reads NSWorkspace fresh; the daemon must fail closed rather than trust a stale answer.
  if !serving, let app = NSWorkspace.shared.frontmostApplication { return app.processIdentifier }
  throw fail("No frontmost application")
}

func activeWindow() throws {
  let front = try frontPid()
  let pid = Int(front)
  let own = windows(pid: pid).filter { ($0["layer"] as? Int) == 0 }
  // Fullscreen apps stack toolbar strips above the real window, so match the
  // Accessibility focused-window frame; without access, take the topmost sizable window.
  var focused: [Int]? = nil
  var value: CFTypeRef?
  let axApp = AXUIElementCreateApplication(front)
  AXUIElementSetMessagingTimeout(axApp, 0.5)  // a hung app must not stall the daemon for the 6 s default
  if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &value) == .success,
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
  guard let window = match else { throw fail("No focused window") }
  try emitJSON(window)
}

// Locked access to the display cache (NSCondition cannot be locked directly from async code).
func displayCache(_ set: [SCDisplay]?) -> [SCDisplay]? {
  cond.lock(); defer { cond.unlock() }
  if let set { displayStore = set }
  return displayStore
}
final class Box: @unchecked Sendable { var result: Result<Data, Error>? }

// Displays are cached across calls; a reconfiguration callback or a failure drops the cache.
func grab(_ rect: CGRect, _ w: Int, _ h: Int, fresh: Bool) async throws -> Data {
  func displays(_ fetch: Bool) async throws -> [SCDisplay] {
    if !fetch, let cached = displayCache(nil) { return cached }
    let list = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true).displays
    _ = displayCache(list)
    return list
  }
  var list = try await displays(fresh)
  var found = list.first(where: { CGDisplayBounds($0.displayID).contains(rect) })
  if found == nil && !fresh { list = try await displays(true); found = list.first(where: { CGDisplayBounds($0.displayID).contains(rect) }) }
  guard let display = found else { throw fail("Region must fit inside one display") }
  let origin = CGDisplayBounds(display.displayID).origin
  let config = SCStreamConfiguration()
  config.sourceRect = rect.offsetBy(dx: -origin.x, dy: -origin.y)
  config.width = w; config.height = h
  config.showsCursor = false
  let filter = SCContentFilter(display: display, excludingWindows: [])
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  let data = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw fail("PNG encoder unavailable") }
  let png = [kCGImagePropertyPNGDictionary: [kCGImagePropertyPNGCompressionFilter: 0x08]] as CFDictionary
  CGImageDestinationAddImage(dest, image, png)
  guard CGImageDestinationFinalize(dest) else { throw fail("PNG encoding failed") }
  return data as Data
}

func capture(_ args: [String]) throws {
  let (opts, _) = try parse(args, flags: [], values: ["-g"])
  guard let geometry = opts["-g"] else { throw fail("capture needs -g \"x,y wxh\"", 2) }
  let scanner = Scanner(string: geometry)
  var x = 0, y = 0, w = 0, h = 0
  guard scanner.scanInt(&x), scanner.scanString(",") != nil, scanner.scanInt(&y), scanner.scanInt(&w),
        scanner.scanString("x") != nil, scanner.scanInt(&h), scanner.isAtEnd, w > 0, h > 0, w <= 32768, h <= 32768 else { throw fail("Invalid geometry \(geometry)", 2) }
  let rect = CGRect(x: x, y: y, width: w, height: h)
  if !screenOK {
    if !CGPreflightScreenCaptureAccess() {
      CGRequestScreenCaptureAccess()
      throw fail("Screen Recording access is required. Allow the app in System Settings > Privacy & Security > Screen Recording.")
    }
    screenOK = true
  }
  // SCK is async: run it on the cooperative pool and park this (worker or main) thread on a semaphore.
  var failure: Error?
  for attempt in 0..<2 {
    let box = Box(), sem = DispatchSemaphore(value: 0)
    Task.detached {
      do { box.result = .success(try await grab(rect, w, h, fresh: attempt == 1)) } catch { box.result = .failure(error) }
      sem.signal()
    }
    sem.wait()
    switch box.result! {
    case .success(let png): emit(png); return
    case .failure(let error as Fail): throw error
    case .failure(let error): failure = error; cond.lock(); displayStore = nil; cond.unlock()
    }
  }
  throw fail("Screen capture failed: \(failure?.localizedDescription ?? "unknown")")
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
    die("Could not observe mouse activity. Allow the app in System Settings > Privacy & Security > Input Monitoring.")
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  print("ready"); fflush(stdout)
  // The parent owns this process: exit as soon as it closes our stdin or dies.
  Thread.detachNewThread { _ = FileHandle.standardInput.readDataToEndOfFile(); exit(0) }
  CFRunLoopRun()
  exit(0)
}

// The one dispatch behind both the CLI and serve, so behaviours cannot drift.
func run(_ argv: [String], input: String? = nil) throws {
  guard let command = argv.first else { throw fail("usage: macdotool <click|mousemove|type|key|debug|activewindow|clients|cursorpos|capture|watch|serve> ...", 2) }
  let rest = Array(argv.dropFirst())
  stdinText = input
  switch command {
  case "click": try click(rest)
  case "mousemove": try mousemove(rest)
  case "type": try type(rest)
  case "key": try key(rest)
  case "debug": try debug()
  case "activewindow": try activeWindow()
  case "clients": try emitJSON(windows())
  case "cursorpos": let p = cursor(); try emitJSON(["x": Int(p.x.rounded()), "y": Int(p.y.rounded())])
  case "capture": try capture(rest)
  case "watch", "serve": throw fail("\(command) is not available here", 2)
  default: throw fail("Unknown command \(command)", 2)
  }
}

func respond(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
  data.append(10)
  writeAll(data)
}

// Release what we hold and leave: stdin EOF and SIGTERM both end here.
func shutdown() {
  cond.lock(); closing = true; queue.removeAll(); cond.broadcast(); cond.unlock()
  // The worker normally exits after releasing; this is the backstop if it is stuck.
  DispatchQueue.global().asyncAfter(deadline: .now() + 2) { releaseHeld(); exit(0) }
}

func worker() {
  while true {
    cond.lock()
    while queue.isEmpty && !closing { cond.wait() }
    if closing { cond.unlock(); releaseHeld(); exit(0) }
    let req = queue.removeFirst()
    let key = String(describing: req.id)
    current = key
    let keep = (buttons: heldButtons, keys: heldKeys)
    cond.unlock()
    outBuf = Data(); posted = 0
    var reply: [String: Any] = ["id": req.id]
    do {
      try checkCancel()
      try run(req.argv, input: req.input)
      reply["ok"] = true; reply["out"] = outBuf.base64EncodedString()
    } catch is Cancelled {
      releaseHeld(except: keep)  // drop only what this request pressed
      reply["ok"] = false; reply["cancelled"] = true; reply["error"] = "cancelled"
    } catch let f as Fail {
      reply["ok"] = false; reply["code"] = Int(f.code); reply["error"] = f.message
    } catch {
      reply["ok"] = false; reply["code"] = 1; reply["error"] = error.localizedDescription
    }
    if dry { reply["events"] = posted }
    cond.lock(); current = nil; pending.remove(key); cancelled.remove(key); cond.unlock()
    respond(reply)
  }
}

func reader() {
  while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else {
      respond(["ok": false, "code": 2, "error": "malformed JSON"]); continue
    }
    if let c = obj["cancel"] {
      // Only ids still queued or running can be cancelled; anything else is a no-op.
      let key = String(describing: c)
      cond.lock(); if pending.contains(key) { cancelled.insert(key) }; cond.unlock()
      continue
    }
    guard let id = obj["id"], let argv = obj["argv"] as? [String] else {
      var r: [String: Any] = ["ok": false, "code": 2, "error": "request needs id and argv"]
      if let id = obj["id"] { r["id"] = id }
      respond(r); continue
    }
    cond.lock()
    pending.insert(String(describing: id))
    queue.append((id, argv, obj["input"] as? String))
    cond.signal(); cond.unlock()
  }
  shutdown()
}

var signalSources: [DispatchSourceSignal] = []

func serve() -> Never {
  serving = true
  inServe = true
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    s.setEventHandler { shutdown() }
    s.resume(); signalSources.append(s)
  }
  CGDisplayRegisterReconfigurationCallback({ _, _, _ in cond.lock(); displayStore = nil; cond.unlock() }, nil)
  // The system-wide AX element answers kAXErrorCannotComplete until an AppKit connection exists, so this
  // precedes the first request. .prohibited keeps us out of the Dock and app switcher.
  NSApplication.shared.setActivationPolicy(.prohibited)
  let w = Thread { worker() }
  w.qualityOfService = .userInteractive; w.start()
  Thread { reader() }.start()
  NSApplication.shared.run()  // also delivers display reconfiguration callbacks
  exit(0)
}

signal(SIGPIPE, SIG_IGN)
let args = Array(CommandLine.arguments.dropFirst())
if args.first == "watch" { watch() }
if args.first == "serve" { serve() }
do {
  try run(args)
  // Events still in flight die with this process: without this pause most one-shot input was lost.
  if posted > 0 && !dry { usleep(20_000) }
  writeAll(outBuf)
  if dry { FileHandle.standardError.write("dry: \(posted) events\n".data(using: .utf8)!) }
} catch let f as Fail {
  die(f.message, f.code)
} catch {
  die(error.localizedDescription)
}
