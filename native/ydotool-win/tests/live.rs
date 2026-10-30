//! Live tests on the real desktop. Every injected key, button and wheel event is swallowed by
//! low-level hooks installed here before the exe is spawned; injected cursor moves pass through.
//! Run: cargo test --release -- --ignored --test-threads=1 --nocapture
#![cfg(windows)]

use std::process::Command;
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetDoubleClickTime, GetKeyState, GetKeyboardLayout, VK_CAPITAL};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const EXE: &str = env!("CARGO_BIN_EXE_ydotool");

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Key { scan: u32, vk: u32, ext: bool, down: bool },
    Btn { id: u8, down: bool },
    Wheel { delta: i32, horiz: bool },
    Move,
}

#[derive(Clone, Debug)]
struct Ev {
    t: u64,
    kind: Kind,
    pos: (i32, i32),
}

static EVENTS: Mutex<Vec<Ev>> = Mutex::new(Vec::new());
static LOCK: Mutex<()> = Mutex::new(());
static HOOKS: OnceLock<()> = OnceLock::new();

fn now_us() -> u64 {
    static F: OnceLock<i64> = OnceLock::new();
    let f = *F.get_or_init(|| {
        let mut f = 0;
        unsafe { QueryPerformanceFrequency(&mut f) };
        f
    });
    let mut c = 0;
    unsafe { QueryPerformanceCounter(&mut c) };
    (c as u128 * 1_000_000 / f as u128) as u64
}

fn push(kind: Kind, pos: (i32, i32)) {
    EVENTS.lock().unwrap().push(Ev { t: now_us(), kind, pos });
}

unsafe extern "system" fn kb_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = &*(l as *const KBDLLHOOKSTRUCT);
        if k.flags & LLKHF_INJECTED != 0 {
            let down = w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN;
            push(Kind::Key { scan: k.scanCode, vk: k.vkCode, ext: k.flags & LLKHF_EXTENDED != 0, down }, (0, 0));
            return 1;
        }
    }
    CallNextHookEx(null_hook(), code, w, l)
}

unsafe extern "system" fn ms_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let m = &*(l as *const MSLLHOOKSTRUCT);
        if m.flags & 3 != 0 {
            let pos = (m.pt.x, m.pt.y);
            let hi = (m.mouseData >> 16) as u16;
            let kind = match w as u32 {
                WM_MOUSEMOVE => {
                    push(Kind::Move, pos);
                    return CallNextHookEx(null_hook(), code, w, l);
                }
                WM_LBUTTONDOWN => Kind::Btn { id: 0, down: true },
                WM_LBUTTONUP => Kind::Btn { id: 0, down: false },
                WM_RBUTTONDOWN => Kind::Btn { id: 1, down: true },
                WM_RBUTTONUP => Kind::Btn { id: 1, down: false },
                WM_MBUTTONDOWN => Kind::Btn { id: 2, down: true },
                WM_MBUTTONUP => Kind::Btn { id: 2, down: false },
                WM_XBUTTONDOWN => Kind::Btn { id: 2 + hi as u8, down: true },
                WM_XBUTTONUP => Kind::Btn { id: 2 + hi as u8, down: false },
                WM_MOUSEWHEEL => Kind::Wheel { delta: hi as i16 as i32, horiz: false },
                WM_MOUSEHWHEEL => Kind::Wheel { delta: hi as i16 as i32, horiz: true },
                _ => Kind::Move,
            };
            push(kind, pos);
            return 1;
        }
    }
    CallNextHookEx(null_hook(), code, w, l)
}

fn null_hook() -> *mut core::ffi::c_void {
    std::ptr::null_mut()
}

fn setup() -> MutexGuard<'static, ()> {
    let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    HOOKS.get_or_init(|| {
        unsafe { SetProcessDpiAwarenessContext(-4isize as _) };
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            let k = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kb_proc), std::ptr::null_mut(), 0);
            let m = SetWindowsHookExW(WH_MOUSE_LL, Some(ms_proc), std::ptr::null_mut(), 0);
            tx.send(!k.is_null() && !m.is_null()).unwrap();
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        // never spawn the exe unless both swallowing hooks are live
        assert!(rx.recv().unwrap(), "hooks not installed");
    });
    wait_idle();
    g
}

// The user may be on this machine; a moving pointer would trip interference detection.
fn wait_idle() {
    let (mut last, mut since, start) = (cursor(), Instant::now(), Instant::now());
    while since.elapsed().as_secs_f64() < 3.0 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let c = cursor();
        if c != last {
            (last, since) = (c, Instant::now());
        }
        assert!(start.elapsed().as_secs() < 300, "pointer never went idle");
    }
}

struct Out {
    rc: i32,
    stdout: String,
    stderr: String,
    ev: Vec<Ev>,
    wall_ms: f64,
}

fn cursor() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

fn set_cursor(p: (i32, i32)) {
    unsafe { SetCursorPos(p.0, p.1) };
    std::thread::sleep(Duration::from_millis(10));
}

struct Restore((i32, i32));
impl Drop for Restore {
    fn drop(&mut self) {
        unsafe { SetCursorPos(self.0 .0, self.0 .1) };
    }
}

fn spawn(args: &[&str]) -> std::process::Child {
    EVENTS.lock().unwrap().clear();
    Command::new(EXE)
        .args(args)
        .env("YDOTOOL_STATS", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

fn finish(c: std::process::Child, t0: Instant) -> Out {
    let o = c.wait_with_output().unwrap();
    let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
    std::thread::sleep(Duration::from_millis(30));
    Out {
        rc: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into(),
        stderr: String::from_utf8_lossy(&o.stderr).into(),
        ev: std::mem::take(&mut *EVENTS.lock().unwrap()),
        wall_ms,
    }
}

fn run(args: &[&str]) -> Out {
    let t0 = Instant::now();
    finish(spawn(args), t0)
}

fn keys(o: &Out) -> Vec<(u32, bool, bool)> {
    o.ev.iter().filter_map(|e| if let Kind::Key { scan, ext, down, .. } = e.kind { Some((scan, ext, down)) } else { None }).collect()
}

fn btns(o: &Out) -> Vec<(u8, bool)> {
    o.ev.iter().filter_map(|e| if let Kind::Btn { id, down } = e.kind { Some((id, down)) } else { None }).collect()
}

fn wheels(o: &Out) -> Vec<(i32, bool)> {
    o.ev.iter().filter_map(|e| if let Kind::Wheel { delta, horiz } = e.kind { Some((delta, horiz)) } else { None }).collect()
}

fn stat(o: &Out, k: &str) -> i64 {
    o.stderr.split_whitespace().find_map(|t| t.strip_prefix(&format!("{k}="))).and_then(|v| v.parse().ok()).unwrap_or(-1)
}

fn tap(scan: u32, ext: bool) -> [(u32, bool, bool); 2] {
    [(scan, ext, true), (scan, ext, false)]
}

fn monitors() -> Vec<RECT> {
    unsafe extern "system" fn cb(_: HMONITOR, _: HDC, r: *mut RECT, l: LPARAM) -> i32 {
        (*(l as *mut Vec<RECT>)).push(*r);
        1
    }
    let mut v: Vec<RECT> = Vec::new();
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(cb), &mut v as *mut _ as LPARAM) };
    v
}

fn primary() -> RECT {
    let m = monitors();
    *m.iter().find(|r| r.left == 0 && r.top == 0).unwrap_or(&m[0])
}

fn us_layout() -> bool {
    unsafe {
        let tid = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
        GetKeyboardLayout(tid) as usize & 0xFFFF == 0x0409
    }
}

fn caps() -> bool {
    unsafe { GetKeyState(VK_CAPITAL as i32) & 1 != 0 }
}

fn median(v: &mut Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

// ---- tests

#[test]
#[ignore]
fn cli_basics() {
    let _g = setup();
    let o = run(&[]);
    assert!(o.rc == 0 && o.stdout.contains("Available commands"));
    assert_eq!(run(&["help"]).rc, 0);
    assert_eq!(run(&["--help"]).rc, 0);
    let o = run(&["bogus"]);
    assert!(o.rc == 1 && o.stderr.contains("Unknown command: bogus"));
    for c in ["click", "key", "type", "mousemove", "click-at", "drag", "scroll"] {
        let o = run(&[c]);
        assert_eq!(o.rc, 0, "{c}");
        assert!(o.stdout.contains("Usage"), "{c}");
    }
    let o = run(&["debug"]);
    assert!(o.rc == 0 && o.stdout.contains("no daemon required on Windows"));
    assert!(run(&["bakers"]).stdout.contains("Dustin Van Tate Testa"));
    assert_eq!(run(&["mousemove", "-w", "-a", "--", "1", "2"]).rc, 1);
    assert_eq!(run(&["mousemove", "1"]).rc, 1);
    assert_eq!(run(&["scroll", "1", "2"]).rc, 1);
    assert_eq!(run(&["type", "-f", "Z:\\definitely\\missing.txt"]).rc, 3);
    assert!(run(&["debug"]).ev.is_empty());
}

#[test]
#[ignore]
fn startup_time() {
    let _g = setup();
    let mut v: Vec<f64> = (0..50).map(|_| run(&["debug"]).wall_ms).collect();
    let m = median(&mut v);
    println!("MEASURE debug startup median={m:.2}ms min={:.2} max={:.2}", v[0], v[49]);
    assert!(m < 15.0);
}

#[test]
#[ignore]
fn key_codes() {
    let _g = setup();
    let o = run(&["key", "-d", "1", "30:1", "30:0", "28:1", "28:0", "105:1", "105:0", "111:1", "111:0"]);
    assert_eq!(o.rc, 0);
    let mut want = vec![];
    want.extend(tap(0x1E, false));
    want.extend(tap(0x1C, false));
    want.extend(tap(0x4B, true));
    want.extend(tap(0x53, true));
    assert_eq!(keys(&o), want);
    // shift wrapping order, hex, code 0 and unknown emit nothing, extended enter
    let o = run(&["key", "-d1", "42:1", "0x1e:1", "0x1e:0", "42:0", "0", "500:1", "96:1", "96:0", "183:1", "183:0"]);
    let k = keys(&o);
    assert_eq!(&k[..4], &[(0x2A, false, true), (0x1E, false, true), (0x1E, false, false), (0x2A, false, false)]);
    assert_eq!(&k[4..6], &tap(0x1C, true));
    assert!(o.ev.iter().any(|e| matches!(e.kind, Kind::Key { vk: 0x7C, .. })));
    assert_eq!(k.len(), 8);
    assert!(o.stderr.contains("unknown key code 500"));
    // option forms
    for a in [vec!["key", "--key-delay=1", "30:1"], vec!["key", "--key-delay", "1", "30:1"], vec!["key", "30:1", "-d", "1"]] {
        assert_eq!(keys(&run(&a)), vec![(0x1E, false, true)]);
    }
    // delay honoured: 3 events at 30 ms
    let o = run(&["key", "-d", "30", "30:1", "30:0", "0"]);
    assert!(o.wall_ms > 85.0, "{}", o.wall_ms);
    // release up what a test leaves "down" (swallowed, so nothing is really held)
    assert_eq!(run(&["release"]).rc, 0);
}

#[test]
#[ignore]
fn click_buttons() {
    let _g = setup();
    let o = run(&["click", "0xC0"]);
    assert_eq!(o.rc, 0);
    assert_eq!(btns(&o), vec![(0, true), (0, false)]);
    assert_eq!(btns(&run(&["click", "C1", "41", "82", "0x00"])), vec![(1, true), (1, false), (1, true), (2, false)]);
    assert_eq!(btns(&run(&["click", "-D", "1", "C2", "C3", "C4", "C5", "C6", "C7"])), vec![(2, true), (2, false), (3, true), (3, false), (4, true), (4, false), (4, true), (4, false), (3, true), (3, false)]);
    // -P: press+release regardless of flags, then delay
    assert_eq!(btns(&run(&["click", "-P", "-D", "1", "0", "01"])), vec![(0, true), (0, false), (1, true), (1, false)]);
    assert_eq!(btns(&run(&["click", "-r", "3", "-d", "1", "0xC0"])).len(), 6);
    assert_eq!(btns(&run(&["click", "-r3", "-D1", "-P", "0"])).len(), 6);
    // default delay is randomised, 18-75 ms
    let o = run(&["click", "--seed", "5", "0x40", "0x80"]);
    let (d, u) = (o.ev[0].t, o.ev[1].t);
    let gap = (u - d) as f64 / 1000.0;
    println!("MEASURE default click delay {gap:.1}ms");
    assert!((15.0..120.0).contains(&gap));
    // fixed delay
    let o = run(&["click", "-D", "100", "0x40", "0x80"]);
    let gap = (o.ev[1].t - o.ev[0].t) as f64 / 1000.0;
    assert!((95.0..140.0).contains(&gap), "{gap}");
}

fn type_expect_us(s: &str) -> Vec<(u32, bool, bool)> {
    let caps = caps();
    let shifted = "~!@#$%^&*()_+{}|:\"<>?";
    let mut v = vec![];
    for c in s.chars() {
        let (scan, mut sh) = match c {
            'a'..='z' | 'A'..='Z' => ([0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C][(c.to_ascii_lowercase() as u8 - b'a') as usize], c.is_ascii_uppercase() ^ caps),
            ' ' => (0x39, false),
            ',' => (0x33, false),
            '.' => (0x34, false),
            '!' => (0x02, true),
            '\n' => (0x1C, false),
            '\t' => (0x0F, false),
            _ => panic!("expectation table"),
        };
        sh |= shifted.contains(c);
        if sh {
            v.push((0x2A, false, true));
        }
        v.extend(tap(scan, false));
        if sh {
            v.push((0x2A, false, false));
        }
    }
    v
}

fn shift_balanced(k: &[(u32, bool, bool)]) {
    let mut held = false;
    for &(s, _, d) in k {
        if s == 0x2A {
            assert_ne!(held, d, "shift pairing broken");
            held = d;
        } else {
            let _ = d;
        }
    }
    assert!(!held, "shift left down");
}

#[test]
#[ignore]
fn type_text() {
    let _g = setup();
    let us = us_layout();
    println!("MEASURE layout US={us} caps={}", caps());
    let o = run(&["type", "-d", "1", "-H", "1", "Hello, World!\\n\\tx\\x41\\q"]);
    assert_eq!(o.rc, 0);
    shift_balanced(&keys(&o));
    if us {
        assert_eq!(keys(&o), type_expect_us("Hello, World!\n\txA"));
    }
    // escapes off, multiple strings and -D
    let o = run(&["type", "-d1", "-H1", "-D", "40", "-e", "0", "a\\n", "b"]);
    shift_balanced(&keys(&o));
    if us {
        assert_eq!(keys(&o).len(), 8); // a \ n b: backslash and n are real keys
        assert!(o.wall_ms > 40.0);
    }
    // real newline and CRLF are one Enter
    let o = run(&["type", "-d1", "-H1", "-e", "0", "a\r\nb\rc"]);
    let k = keys(&o);
    assert_eq!(k.iter().filter(|x| x.0 == 0x1C && x.2).count(), 2);
    // file: BOM stripped, UTF-8, escapes off by default, CRLF
    let p = std::env::temp_dir().join("ydotool_live_type.txt");
    std::fs::write(&p, b"\xEF\xBB\xBFab\\n\r\ncd").unwrap();
    let o = run(&["type", "-d1", "-H1", "-f", p.to_str().unwrap()]);
    assert_eq!(o.rc, 0);
    if us {
        assert_eq!(keys(&o).iter().filter(|x| x.2).count(), 7); // a b \ n Enter c d
        assert!(!o.ev.iter().any(|e| matches!(e.kind, Kind::Key { vk: 0xE7, .. })), "BOM leaked");
    }
    let o = run(&["type", "-d1", "-H1", "-e", "1", "-f", p.to_str().unwrap()]);
    if us {
        assert_eq!(keys(&o).iter().filter(|x| x.2).count(), 6);
    }
    let _ = std::fs::remove_file(&p);
    // Unicode: BMP + surrogate pair go out as VK_PACKET units
    let o = run(&["type", "-d1", "-H1", "\u{1F600}\u{4E2D}"]);
    assert_eq!(o.rc, 0);
    let packets: Vec<_> = o.ev.iter().filter_map(|e| if let Kind::Key { vk: 0xE7, scan, down: true, .. } = e.kind { Some(scan) } else { None }).collect();
    assert_eq!(packets, vec![0xD83D, 0xDE00, 0x4E2D]);
    if us {
        let o = run(&["type", "-d1", "-H1", "\u{e9}a"]);
        shift_balanced(&keys(&o));
        assert!(o.ev.iter().any(|e| matches!(e.kind, Kind::Key { vk: 0xE7, scan: 0xE9, down: true, .. })));
    }
    // delays honoured
    let o = run(&["type", "-d", "30", "-H", "10", "abc"]);
    assert!(o.wall_ms > 90.0, "{}", o.wall_ms);
}

#[test]
#[ignore]
fn type_human_timing() {
    let _g = setup();
    let text = "the quick brown fox jumps over the lazy dog again and again ok";
    let o = run(&["type", "--human", "--wpm", "300", "--seed", "7", text]);
    assert_eq!(o.rc, 0);
    shift_balanced(&keys(&o));
    let downs: Vec<u64> = o.ev.iter().filter(|e| matches!(e.kind, Kind::Key { down: true, .. })).map(|e| e.t).collect();
    let mut gaps: Vec<f64> = downs.windows(2).map(|w| (w[1] - w[0]) as f64 / 1000.0).collect();
    let holds: Vec<f64> = o
        .ev
        .windows(2)
        .filter(|w| matches!(w[0].kind, Kind::Key { down: true, .. }) && matches!(w[1].kind, Kind::Key { down: false, .. }))
        .map(|w| (w[1].t - w[0].t) as f64 / 1000.0)
        .collect();
    let mean = gaps.iter().sum::<f64>() / gaps.len() as f64;
    let var = gaps.iter().map(|g| (g - mean).powi(2)).sum::<f64>() / gaps.len() as f64;
    let m = median(&mut gaps);
    println!("MEASURE human type @300wpm: key gap median={m:.1}ms mean={mean:.1} sd={:.1} (target base 40ms); holds {}..{}", var.sqrt(), holds.iter().cloned().fold(1e9, f64::min), holds.iter().cloned().fold(0.0, f64::max));
    assert!(var.sqrt() > 3.0, "gaps not varied");
    assert!((30.0..60.0).contains(&mean), "{mean}");
    assert!(holds.iter().all(|h| (10.0..90.0).contains(h)));
}

#[test]
#[ignore]
fn abs_grid_exact() {
    let _g = setup();
    let _r = Restore(cursor());
    let (mut n, mut direct, mut bad) = (0, 0, 0);
    let mons = monitors();
    for (mi, m) in mons.iter().enumerate() {
        let (w, h) = (m.right - m.left, m.bottom - m.top);
        let (mut mn, mut md) = (0, 0);
        for i in 0..=8 {
            for j in 0..=5 {
                let (x, y) = (m.left + (w - 1) * i / 8, m.top + (h - 1) * j / 5);
                set_cursor((m.left + (w / 2 + 37) % w, m.top + (h / 2 + 91) % h));
                let o = run(&["mousemove", "-a", "--instant", "--", &x.to_string(), &y.to_string()]);
                n += 1;
                mn += 1;
                if o.rc != 0 || cursor() != (x, y) {
                    bad += 1;
                    println!("MISS monitor {mi} want {x},{y} got {:?} rc {}", cursor(), o.rc);
                }
                if stat(&o, "fallbacks") == 0 {
                    direct += 1;
                    md += 1;
                }
            }
        }
        println!("MEASURE monitor {mi} rect {},{} {w}x{h}: direct SendInput hit {md}/{mn}", m.left, m.top);
    }
    println!("MEASURE abs grid: {n} points over {} monitors, exact {}/{n}, direct (no SetCursorPos fix) {direct}/{n}", mons.len(), n - bad);
    assert_eq!(bad, 0);
}

#[test]
#[ignore]
fn relative_and_clamp() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    set_cursor((p.left + 400, p.top + 300));
    assert_eq!(run(&["mousemove", "--instant", "-x", "25", "-y", "-10"]).rc, 0);
    assert_eq!(cursor(), (p.left + 425, p.top + 290));
    assert_eq!(run(&["mousemove", "--instant", "--", "-5", "3"]).rc, 0);
    assert_eq!(cursor(), (p.left + 420, p.top + 293));
    // human relative lands exact, and off-screen targets clamp to the desktop
    assert_eq!(run(&["mousemove", "--seed", "2", "-x", "-120", "-y", "40"]).rc, 0);
    assert_eq!(cursor(), (p.left + 300, p.top + 333));
    assert_eq!(run(&["mousemove", "-a", "--instant", "--", "99999", "99999"]).rc, 0);
    let c = cursor();
    let r = (monitors().iter().map(|m| m.right).max().unwrap() - 1, monitors().iter().map(|m| m.bottom).max().unwrap() - 1);
    assert!(c.0 <= r.0 && c.1 <= r.1 && c.0 > p.left);
}

#[test]
#[ignore]
fn wheel_events() {
    let _g = setup();
    let o = run(&["mousemove", "-w", "--", "0", "3"]);
    assert_eq!(wheels(&o).iter().map(|w| w.0).sum::<i32>(), 360);
    assert!(wheels(&o).iter().all(|w| !w.1));
    let o = run(&["mousemove", "-w", "-x", "-2", "-y", "0"]);
    assert_eq!(wheels(&o), vec![(-240, true)]);
    let o = run(&["mousemove", "-w", "--", "1", "-1"]);
    assert_eq!(wheels(&o).len(), 2);
}

// Unequal monitors leave dead zones; a straight path through one must not read as user interference.
#[test]
#[ignore]
fn human_moves_cross_monitor_gaps() {
    let _g = setup();
    let _r = Restore(cursor());
    let m = monitors();
    let corners = |r: &RECT| [(r.left + 40, r.top + 40), (r.right - 40, r.top + 40), (r.left + 40, r.bottom - 40), (r.right - 40, r.bottom - 40)];
    let mut n = 0;
    for a in &m {
        for b in &m {
            if a.left == b.left && a.top == b.top {
                continue;
            }
            // same-index pairs run outside the shared edge, so they really cross the dead zones
            for (i, (from, to)) in corners(a).into_iter().zip(corners(b)).chain(corners(a).into_iter().zip(corners(b).into_iter().rev())).enumerate() {
                set_cursor(from);
                let o = run(&["mousemove", "-a", "--seed", &i.to_string(), "--", &to.0.to_string(), &to.1.to_string()]);
                assert_eq!(o.rc, 0, "{from:?} -> {to:?}: {}", o.stderr);
                assert_eq!(cursor(), to);
                n += 1;
            }
        }
    }
    println!("MEASURE gap crossings: {n} moves across {} monitors", m.len());
}

// Curve shape measured from what the OS actually delivered, not from the planner.
#[test]
#[ignore]
fn human_move_shape_from_hook() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let (from, to) = ((p.left + 200, p.top + 200), (p.left + 1400, p.top + 900));
    let (mut peaks, mut devs, mut durs, mut counts) = (vec![], vec![], vec![], vec![]);
    for seed in 0..20 {
        set_cursor(from);
        let o = run(&["mousemove", "-a", "--seed", &seed.to_string(), "--", &to.0.to_string(), &to.1.to_string()]);
        assert_eq!(o.rc, 0, "{}", o.stderr);
        let pts: Vec<(f64, f64, f64)> = o.ev.iter().filter(|e| matches!(e.kind, Kind::Move)).map(|e| (e.t as f64 / 1000.0, e.pos.0 as f64, e.pos.1 as f64)).collect();
        assert!(pts.len() > 20, "too few events: {}", pts.len());
        let (t0, t1) = (pts[0].0, pts[pts.len() - 1].0);
        let (dx, dy) = ((to.0 - from.0) as f64, (to.1 - from.1) as f64);
        let d = dx.hypot(dy);
        let dev = pts.iter().map(|q| ((q.1 - from.0 as f64) * dy - (q.2 - from.1 as f64) * dx).abs() / d).fold(0.0, f64::max);
        let (mut best, mut at) = (0.0, 0.0);
        for w in pts.windows(6) {
            let v = (w[5].1 - w[0].1).hypot(w[5].2 - w[0].2) / (w[5].0 - w[0].0).max(0.1);
            if v > best {
                best = v;
                at = (w[2].0 - t0) / (t1 - t0);
            }
        }
        peaks.push(at);
        devs.push(dev);
        durs.push(t1 - t0);
        counts.push(pts.len() as f64);
    }
    let (pk, dv, du, ct) = (median(&mut peaks), median(&mut devs), median(&mut durs), median(&mut counts));
    println!("MEASURE shape over 1389px: duration {du:.0}ms, {ct:.0} events, peak speed at {:.0}% of time, max path bow {dv:.1}px", pk * 100.0);
    assert!(pk > 0.2 && pk < 0.6, "peak at {pk}");
    assert!(dv > 5.0, "path is a straight line");
    assert!(du > 150.0 && du < 660.0, "duration {du}");
}

#[test]
#[ignore]
fn human_moves_land_exact() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let (w, h) = (p.right - p.left, p.bottom - p.top);
    let pts = [(0.05, 0.1), (0.9, 0.85), (0.5, 0.5), (0.52, 0.5), (0.5, 0.52), (0.1, 0.9), (0.95, 0.05), (0.33, 0.66), (0.34, 0.66), (0.7, 0.2)];
    let (mut late_med, mut late_max, mut fb) = (vec![], 0i64, 0);
    let (mut runs, mut interference) = (0, 0);
    for seed in 0..30 {
        let (a, b) = (pts[seed % 10], pts[(seed + 3) % 10]);
        set_cursor((p.left + (w as f64 * a.0) as i32, p.top + (h as f64 * a.1) as i32));
        let to = (p.left + (w as f64 * b.0) as i32 + seed as i32 % 7, p.top + (h as f64 * b.1) as i32);
        let o = run(&["mousemove", "-a", "--seed", &seed.to_string(), "--", &to.0.to_string(), &to.1.to_string()]);
        runs += 1;
        if o.rc == 5 {
            interference += 1;
        }
        assert_eq!(o.rc, 0, "seed {seed}: {}", o.stderr);
        assert_eq!(cursor(), to, "seed {seed}");
        assert_eq!(o.ev.last().map(|e| e.pos), Some(to));
        assert!(btns(&o).is_empty());
        late_med.push(stat(&o, "late_us_median") as f64);
        late_max = late_max.max(stat(&o, "late_us_max"));
        fb += stat(&o, "fallbacks");
    }
    println!("MEASURE follow(): {runs} human moves, interference false-fires {interference}, tick lateness median-of-medians {:.0}us, max {late_max}us, SetCursorPos fixes {fb}", median(&mut late_med));
}

#[test]
#[ignore]
fn human_move_duration() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let a = (p.left + 100, p.top + 100);
    let b = (p.left + 900.min(p.right - p.left - 50), p.top + 500.min(p.bottom - p.top - 50));
    for d in [150.0, 400.0, 900.0] {
        set_cursor(a);
        let o = run(&["mousemove", "-a", "--seed", "3", "--duration", &d.to_string(), "--", &b.0.to_string(), &b.1.to_string()]);
        assert_eq!(o.rc, 0);
        let mv: Vec<&Ev> = o.ev.iter().filter(|e| e.kind == Kind::Move).collect();
        let span = (mv.last().unwrap().t - mv[0].t) as f64 / 1000.0;
        println!("MEASURE duration want {d}ms, hook span {span:.1}ms ({} moves)", mv.len());
        assert!((span - d).abs() < 25.0 + d * 0.03, "{span} vs {d}");
        assert_eq!(cursor(), b);
    }
    // speed: 2x is about twice as fast
    set_cursor(a);
    let slow = run(&["mousemove", "-a", "--seed", "4", "--speed", "1", "--", &b.0.to_string(), &b.1.to_string()]);
    set_cursor(a);
    let fast = run(&["mousemove", "-a", "--seed", "4", "--speed", "2", "--", &b.0.to_string(), &b.1.to_string()]);
    let span = |o: &Out| {
        let mv: Vec<&Ev> = o.ev.iter().filter(|e| e.kind == Kind::Move).collect();
        (mv.last().unwrap().t - mv[0].t) as f64 / 1000.0
    };
    println!("MEASURE speed 1.0 {:.0}ms, 2.0 {:.0}ms", span(&slow), span(&fast));
    assert!(span(&fast) < span(&slow) * 0.7);
}

#[test]
#[ignore]
fn interference_aborts_without_click() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let (a, b) = ((p.left + 20, p.bottom - 60), (p.right - 20, p.bottom - 60));
    set_cursor(a);
    let t0 = Instant::now();
    let c = spawn(&["click-at", "--speed", "0.5", "--", &b.0.to_string(), &b.1.to_string()]);
    std::thread::sleep(Duration::from_millis(150));
    set_cursor((p.left + (p.right - p.left) / 2, p.top + 40)); // the "user" grabs the mouse
    let o = finish(c, t0);
    println!("MEASURE interference: rc {} after {:.0}ms, stderr: {}", o.rc, o.wall_ms, o.stderr.lines().next().unwrap_or(""));
    assert_eq!(o.rc, 5);
    assert!(btns(&o).is_empty(), "clicked after interference");

    // drag: grabbed mid-move, the button is still released
    set_cursor(a);
    let t0 = Instant::now();
    let c = spawn(&["drag", "--speed", "0.5", &(a.0).to_string(), &a.1.to_string(), &b.0.to_string(), &b.1.to_string()]);
    let start = Instant::now();
    while !EVENTS.lock().unwrap().iter().any(|e| matches!(e.kind, Kind::Btn { down: true, .. })) {
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2));
    }
    std::thread::sleep(Duration::from_millis(220));
    set_cursor((p.left + (p.right - p.left) / 2, p.top + 40));
    let o = finish(c, t0);
    assert_eq!(o.rc, 5, "{}", o.stderr);
    assert_eq!(btns(&o), vec![(0, true), (0, false)]);
}

#[test]
#[ignore]
fn click_at_and_double() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let to = (p.left + 777, p.top + 333);
    set_cursor((p.left + 100, p.top + 100));
    let o = run(&["click-at", "--seed", "1", &to.0.to_string(), &to.1.to_string()]);
    assert_eq!(o.rc, 0);
    assert_eq!(btns(&o), vec![(0, true), (0, false)]);
    assert_eq!(cursor(), to);
    let down = o.ev.iter().find(|e| matches!(e.kind, Kind::Btn { down: true, .. })).unwrap();
    assert_eq!(down.pos, to, "button went down away from the target");
    let dct = unsafe { GetDoubleClickTime() } as f64;
    let (mut gaps, mut d2d) = (vec![], vec![]);
    for seed in 0..8 {
        let o = run(&["click-at", "--seed", &seed.to_string(), &to.0.to_string(), &to.1.to_string(), "2"]);
        assert_eq!(o.rc, 0);
        assert_eq!(btns(&o), vec![(0, true), (0, false), (0, true), (0, false)]);
        let t: Vec<u64> = o.ev.iter().filter(|e| matches!(e.kind, Kind::Btn { .. })).map(|e| e.t).collect();
        gaps.push((t[2] - t[1]) as f64 / 1000.0);
        d2d.push((t[2] - t[0]) as f64 / 1000.0);
        assert!(o.ev.iter().filter(|e| e.kind == Kind::Move).all(|e| e.t < t[0]), "moved between clicks");
        assert!(d2d.last().unwrap() < &dct, "slower than double-click time");
    }
    println!("MEASURE double click up->down gaps {:?} (want 55-105), down->down max {:.0}ms < dct {dct}ms", gaps.iter().map(|g| g.round()).collect::<Vec<_>>(), d2d.iter().cloned().fold(0.0, f64::max));
    assert!(gaps.iter().all(|g| (50.0..115.0).contains(g)));
    assert_eq!(run(&["click-at", "1"]).rc, 1);
}

#[test]
#[ignore]
fn drag_sequence() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let (a, b) = ((p.left + 300, p.top + 300), (p.left + 800, p.top + 450));
    set_cursor((p.left + 50, p.top + 50));
    let o = run(&["drag", "--seed", "9", &a.0.to_string(), &a.1.to_string(), &b.0.to_string(), &b.1.to_string()]);
    assert_eq!(o.rc, 0, "{}", o.stderr);
    assert_eq!(btns(&o), vec![(0, true), (0, false)]);
    let btn: Vec<&Ev> = o.ev.iter().filter(|e| matches!(e.kind, Kind::Btn { .. })).collect();
    assert_eq!(btn[0].pos, a);
    assert_eq!(btn[1].pos, b);
    let moves_between = o.ev.iter().filter(|e| e.kind == Kind::Move && e.t > btn[0].t && e.t < btn[1].t).count();
    assert!(moves_between > 10);
    assert_eq!(cursor(), b);
    println!("MEASURE drag: {moves_between} moves while held, down->up {:.0}ms", (btn[1].t - btn[0].t) as f64 / 1000.0);
}

#[test]
#[ignore]
fn scroll_notches() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let o = run(&["scroll", "--seed", "3", &(p.left + 500).to_string(), &(p.top + 400).to_string(), "5"]);
    assert_eq!(o.rc, 0);
    assert_eq!(wheels(&o), vec![(-120, false); 5]);
    let t: Vec<u64> = o.ev.iter().filter(|e| matches!(e.kind, Kind::Wheel { .. })).map(|e| e.t).collect();
    let gaps: Vec<f64> = t.windows(2).map(|w| (w[1] - w[0]) as f64 / 1000.0).collect();
    println!("MEASURE scroll gaps {:?}", gaps.iter().map(|g| g.round()).collect::<Vec<_>>());
    assert!(gaps.iter().all(|g| (8.0..90.0).contains(g)));
    assert_eq!(cursor(), (p.left + 500, p.top + 400));
    let o = run(&["scroll", &(p.left + 500).to_string(), &(p.top + 400).to_string(), "-2"]);
    assert_eq!(wheels(&o), vec![(120, false); 2]);
    assert!(wheels(&run(&["scroll", &(p.left + 500).to_string(), &(p.top + 400).to_string(), "0"])).is_empty());
}

#[test]
#[ignore]
fn nudge_restores_origin() {
    let _g = setup();
    let _r = Restore(cursor());
    let p = primary();
    let o0 = (p.left + 640, p.top + 360);
    set_cursor(o0);
    let o = run(&["nudge"]);
    assert_eq!(o.rc, 0);
    assert_eq!(cursor(), o0);
    let m: Vec<(i32, i32)> = o.ev.iter().filter(|e| e.kind == Kind::Move).map(|e| e.pos).collect();
    assert_eq!(m, vec![(o0.0 + 3, o0.1 + 3), o0]);
    let gap = (o.ev.last().unwrap().t - o.ev[0].t) as f64 / 1000.0;
    assert!((55.0..90.0).contains(&gap), "{gap}");
}

#[test]
#[ignore]
fn clear_keys() {
    let _g = setup();
    let o = run(&["clear"]);
    assert_eq!(o.rc, 0);
    assert_eq!(
        keys(&o),
        vec![(0x1D, false, true), (0x1E, false, true), (0x1E, false, false), (0x1D, false, false), (0x0E, false, true), (0x0E, false, false)]
    );
    assert!(btns(&o).is_empty());
}

#[test]
#[ignore]
fn fg_and_activate() {
    let _g = setup();
    let o = run(&["fg"]);
    assert_eq!(o.rc, 0);
    assert!(o.stdout.starts_with("{\"handle\":") && o.stdout.contains("\"left\":") && o.stdout.ends_with('}'), "{}", o.stdout);
    let fgw = unsafe { GetForegroundWindow() };
    let num = |k: &str| -> i64 {
        let s = &o.stdout[o.stdout.find(&format!("\"{k}\":")).unwrap() + k.len() + 3..];
        s[..s.find(|c: char| c != '-' && !c.is_ascii_digit()).unwrap()].parse().unwrap()
    };
    let h = num("handle");
    if h == fgw as i64 {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(fgw, &mut r) };
        assert_eq!((num("left"), num("top"), num("right"), num("bottom")), (r.left as i64, r.top as i64, r.right as i64, r.bottom as i64));
    }
    // skipping the foreground's own pid yields another window (or none), never that pid
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(fgw, &mut pid) };
    let o2 = run(&["fg", &format!("{pid},99999999")]);
    assert_eq!(o2.rc, 0);
    let h2 = {
        let s = &o2.stdout[10..];
        s[..s.find(',').unwrap()].parse::<i64>().unwrap()
    };
    if h2 != 0 {
        let mut p2 = 0u32;
        unsafe { GetWindowThreadProcessId(h2 as HWND, &mut p2) };
        assert_ne!(p2, pid);
    }
    assert_eq!(run(&["activate", "0"]).rc, 0);
    assert_eq!(run(&["activate", &fgw.addr().to_string()]).rc, 0);
    assert!(o.ev.is_empty());
}

#[test]
#[ignore]
fn release_with_nothing_held() {
    let _g = setup();
    let o = run(&["release"]);
    assert_eq!(o.rc, 0);
    assert!(o.ev.is_empty());
}
