use crate::motion::Sample;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::{Mutex, Once};
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows_sys::Win32::Media::timeBeginPeriod;
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

#[derive(Debug)]
pub enum Fail {
    Send,
    Unreached,
    Interference,
}

impl Fail {
    pub fn code(&self) -> u8 {
        match self {
            Fail::Send => 2,
            _ => 5,
        }
    }
}

pub type R<T = ()> = Result<T, Fail>;

pub fn init() {
    // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    unsafe { SetProcessDpiAwarenessContext(-4isize as _) };
}

// Clock

static FREQ: AtomicU64 = AtomicU64::new(0);
static TIMER: AtomicIsize = AtomicIsize::new(0);
static TIMER_INIT: Once = Once::new();

pub fn now_us() -> u64 {
    let mut f = FREQ.load(Relaxed);
    if f == 0 {
        let mut v = 0i64;
        unsafe { QueryPerformanceFrequency(&mut v) };
        f = v as u64;
        FREQ.store(f, Relaxed);
    }
    let mut c = 0i64;
    unsafe { QueryPerformanceCounter(&mut c) };
    (c as u128 * 1_000_000 / f as u128) as u64
}

pub fn sleep_until(deadline_us: u64) {
    TIMER_INIT.call_once(|| unsafe {
        timeBeginPeriod(1);
        let h = CreateWaitableTimerExW(null(), null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, 0x1F0003);
        TIMER.store(h as isize, Relaxed);
    });
    let h = TIMER.load(Relaxed) as *mut core::ffi::c_void;
    loop {
        let n = now_us();
        if n >= deadline_us {
            return;
        }
        let rem = deadline_us - n;
        if rem > 400 {
            if h.is_null() {
                std::thread::sleep(std::time::Duration::from_micros(rem - 300));
            } else {
                let due = -(((rem - 300) * 10) as i64);
                unsafe {
                    SetWaitableTimer(h, &due, 0, None, null(), 0);
                    WaitForSingleObject(h, INFINITE);
                }
            }
        } else {
            std::hint::spin_loop();
        }
    }
}

pub fn sleep_ms(ms: f64) {
    if ms > 0.0 {
        sleep_until(now_us() + (ms * 1000.0) as u64);
    }
}

// Input

fn send(v: &[INPUT]) -> R {
    let n = unsafe { SendInput(v.len() as u32, v.as_ptr(), size_of::<INPUT>() as i32) };
    if n as usize == v.len() { Ok(()) } else { Err(Fail::Send) }
}

fn mouse(dx: i32, dy: i32, data: i32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn kbd(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

pub fn cursor() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

/// (left, top, width, height) of the virtual desktop.
pub fn vscreen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

pub fn bounds() -> (i32, i32, i32, i32) {
    let (x, y, w, h) = vscreen();
    (x, y, x + w - 1, y + h - 1)
}

/// Normalised 0..65535 coordinate whose floor-mapping back lands on pixel `p`.
pub fn norm(p: i32, origin: i32, extent: i32) -> i32 {
    let n = ((p - origin) as i64 * 65536 + extent as i64 - 1) / extent as i64;
    n.clamp(0, 65535) as i32
}

pub fn send_mouse_abs(x: i32, y: i32) -> R {
    let (vx, vy, vw, vh) = vscreen();
    send(&[mouse(
        norm(x, vx, vw),
        norm(y, vy, vh),
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE_NOCOALESCE,
    )])
}

/// How many times SendInput missed the pixel and SetCursorPos had to fix it.
pub static FALLBACKS: AtomicU32 = AtomicU32::new(0);

pub fn settle_exact(x: i32, y: i32) -> R {
    let end = now_us() + 20_000;
    while now_us() < end {
        if cursor() == (x, y) {
            return Ok(());
        }
        sleep_until(now_us() + 500);
    }
    FALLBACKS.fetch_add(1, Relaxed);
    unsafe { SetCursorPos(x, y) };
    let end = now_us() + 5_000;
    while now_us() < end {
        if cursor() == (x, y) {
            return Ok(());
        }
        sleep_until(now_us() + 500);
    }
    Err(Fail::Unreached)
}

fn swapped() -> bool {
    unsafe { GetSystemMetrics(SM_SWAPBUTTON) != 0 }
}

/// Upstream ids, logical: honours SM_SWAPBUTTON (SendInput is physical).
pub fn button(btn: u8, down: bool) -> R {
    let btn = match btn {
        0 | 1 if swapped() => 1 - btn,
        b => b,
    };
    button_raw(btn, down)
}

pub fn button_raw(btn: u8, down: bool) -> R {
    let (f, data) = match (btn, down) {
        (0, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (0, false) => (MOUSEEVENTF_LEFTUP, 0),
        (1, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (1, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (2, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (2, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (3 | 6, d) => (if d { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP }, 1),
        (4 | 5, d) => (if d { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP }, 2),
        _ => {
            eprintln!("ydotool: button {btn} (TASK) is not supported on Windows");
            return Ok(());
        }
    };
    send(&[mouse(0, 0, data, f)])
}

/// Positive up / right, in notches.
pub fn wheel(dy: i32, dx: i32) -> R {
    if dx != 0 {
        send(&[mouse(0, 0, dx * 120, MOUSEEVENTF_HWHEEL)])?;
    }
    if dy != 0 {
        send(&[mouse(0, 0, dy * 120, MOUSEEVENTF_WHEEL)])?;
    }
    Ok(())
}

pub fn key_scan(scan: u16, ext: bool, down: bool) -> R {
    let f = KEYEVENTF_SCANCODE | if ext { KEYEVENTF_EXTENDEDKEY } else { 0 } | if down { 0 } else { KEYEVENTF_KEYUP };
    send(&[kbd(0, scan, f)])
}

pub fn key_unicode(u: u16, down: bool) -> R {
    send(&[kbd(0, u, KEYEVENTF_UNICODE | if down { 0 } else { KEYEVENTF_KEYUP })])
}

pub fn key_vk(vk: u16, down: bool) -> R {
    send(&[kbd(vk, 0, if down { 0 } else { KEYEVENTF_KEYUP })])
}

pub struct CharInfo {
    pub vks: i16,
    pub scan_ex: u32,
    pub dead: bool,
}

pub fn fg_layout() -> HKL {
    unsafe {
        let tid = GetWindowThreadProcessId(GetForegroundWindow(), null_mut());
        GetKeyboardLayout(tid)
    }
}

pub fn char_info(c: u16, hkl: HKL) -> CharInfo {
    unsafe {
        let vks = VkKeyScanExW(c, hkl);
        let vk = (vks & 0xFF) as u32;
        CharInfo {
            vks,
            scan_ex: if vks == -1 { 0 } else { MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC_EX, hkl) },
            dead: vks != -1 && MapVirtualKeyExW(vk, MAPVK_VK_TO_CHAR, hkl) & 0x8000_0000 != 0,
        }
    }
}

pub fn caps_on() -> bool {
    unsafe { GetKeyState(VK_CAPITAL as i32) & 1 != 0 }
}

// Motion playback

pub static LATE: Mutex<Vec<i64>> = Mutex::new(Vec::new());

const GRAB_PX: i32 = 6;

// Monitors of different sizes leave dead zones in the virtual desktop; Windows would clamp the
// cursor there, so send the clamped point ourselves and the interference check stays truthful.
fn on_monitor(x: i32, y: i32) -> (i32, i32) {
    unsafe {
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST), &mut mi) == 0 {
            return (x, y);
        }
        let r = mi.rcMonitor;
        (x.clamp(r.left, r.right - 1), y.clamp(r.top, r.bottom - 1))
    }
}

pub fn follow(samples: &[Sample]) -> R {
    let mut recent = [cursor(); 4];
    let mut k = 0;
    let t0 = now_us();
    for s in samples {
        let due = t0 + s.t_us;
        sleep_until(due);
        let now = now_us();
        let c = cursor();
        if recent.iter().all(|r| (r.0 - c.0).abs() > GRAB_PX || (r.1 - c.1).abs() > GRAB_PX) {
            return Err(Fail::Interference);
        }
        if let Ok(mut l) = LATE.lock() {
            l.push(now as i64 - due as i64);
        }
        let p = on_monitor(s.x, s.y);
        send_mouse_abs(p.0, p.1)?;
        recent[k & 3] = p;
        k += 1;
    }
    Ok(())
}

// Windows

pub fn fg(skip: &[u32]) -> (isize, RECT) {
    unsafe {
        let mut hwnd: HWND = GetForegroundWindow();
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        for _ in 0..80 {
            if hwnd.is_null() {
                break;
            }
            GetWindowRect(hwnd, &mut r);
            if skip.is_empty() {
                break;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != 0
                && !skip.contains(&pid)
                && IsWindowVisible(hwnd) != 0
                && IsIconic(hwnd) == 0
                && GetWindowTextLengthW(hwnd) > 0
                && r.right - r.left > 200
            {
                break;
            }
            hwnd = GetWindow(hwnd, GW_HWNDNEXT);
        }
        (hwnd as isize, r)
    }
}

pub fn activate(h: isize) {
    unsafe {
        let hwnd = h as HWND;
        if IsWindow(hwnd) == 0 {
            return;
        }
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
        if GetForegroundWindow() != hwnd {
            let fgt = GetWindowThreadProcessId(GetForegroundWindow(), null_mut());
            let me = GetCurrentThreadId();
            let attached = fgt != 0 && fgt != me && AttachThreadInput(me, fgt, 1) != 0;
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
            if attached {
                AttachThreadInput(me, fgt, 0);
            }
        }
        let end = now_us() + 2_000_000;
        while GetForegroundWindow() != hwnd && now_us() < end {
            sleep_ms(10.0);
        }
    }
}

pub fn held(vk: u16) -> bool {
    unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
}

pub fn dct() -> u32 {
    unsafe { GetDoubleClickTime() }
}
