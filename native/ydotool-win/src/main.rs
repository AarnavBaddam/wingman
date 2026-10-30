mod keys;
mod motion;
mod sys;

use keys::{Escaper, Plan, K};
use motion::{MotionOpts, Rng};
use std::io::{Read, Write};
use std::process::ExitCode;
use sys::{Fail, R};

// ---- option parser (getopt_long semantics: permutes, clusters, `--`, unique long prefixes)

struct Opt {
    long: &'static str,
    key: char,
    arg: bool,
    short: bool,
}

const fn o(long: &'static str, key: char, arg: bool) -> Opt {
    Opt { long, key, arg, short: true }
}
const fn lo(long: &'static str, key: char, arg: bool) -> Opt {
    Opt { long, key, arg, short: false }
}

const HELP: Opt = o("help", 'h', false);
const SPEED: Opt = lo("speed", 'S', true);
const SEED: Opt = lo("seed", 'E', true);

#[derive(Default)]
struct Parsed {
    vals: Vec<(char, String)>,
    rest: Vec<String>,
}

impl Parsed {
    fn has(&self, k: char) -> bool {
        self.vals.iter().any(|v| v.0 == k)
    }
    fn get(&self, k: char) -> Option<&str> {
        self.vals.iter().rev().find(|v| v.0 == k).map(|v| v.1.as_str())
    }
    fn int(&self, k: char, d: i64) -> i64 {
        self.get(k).map_or(d, |v| keys::strtol(v, 10))
    }
    fn float(&self, k: char) -> Option<f64> {
        self.get(k).and_then(|v| v.trim().parse().ok())
    }
}

fn is_neg_num(a: &str) -> bool {
    a.len() > 1 && a.starts_with('-') && a[1..].bytes().all(|b| b.is_ascii_digit())
}

fn parse(args: &[String], opts: &[Opt]) -> Parsed {
    let mut p = Parsed::default();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if a == "--" {
            p.rest.extend(args[i..].iter().cloned());
            break;
        }
        if let Some(l) = a.strip_prefix("--") {
            let (name, val) = match l.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (l, None),
            };
            let mut m: Vec<&Opt> = opts.iter().filter(|o| o.long == name).collect();
            if m.is_empty() {
                m = opts.iter().filter(|o| o.long.starts_with(name)).collect();
            }
            let [op] = m.as_slice() else {
                eprintln!("ydotool: unrecognized or ambiguous option '--{name}'");
                continue;
            };
            if op.arg {
                match val.or_else(|| {
                    i += 1;
                    args.get(i - 1).cloned()
                }) {
                    Some(v) => p.vals.push((op.key, v)),
                    None => eprintln!("ydotool: option '--{}' requires an argument", op.long),
                }
            } else if val.is_some() {
                eprintln!("ydotool: option '--{}' doesn't allow an argument", op.long);
            } else {
                p.vals.push((op.key, String::new()));
            }
        } else if a.len() > 1 && a.starts_with('-') && !is_neg_num(a) {
            let cs: Vec<char> = a[1..].chars().collect();
            let mut j = 0;
            while j < cs.len() {
                let c = cs[j];
                j += 1;
                let Some(op) = opts.iter().find(|o| o.short && o.key == c) else {
                    eprintln!("ydotool: invalid option -- '{c}'");
                    continue;
                };
                if !op.arg {
                    p.vals.push((c, String::new()));
                    continue;
                }
                let tail: String = cs[j..].iter().collect();
                j = cs.len();
                if !tail.is_empty() {
                    p.vals.push((c, tail));
                } else if i < args.len() {
                    p.vals.push((c, args[i].clone()));
                    i += 1;
                } else {
                    eprintln!("ydotool: option requires an argument -- '{c}'");
                }
            }
        } else {
            p.rest.push(a.clone());
        }
    }
    p
}

// ---- help

const USAGE: &str = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  bakers\n  stdin\n  click-at\n  drag\n  scroll\n  fg\n  nudge\n  activate\n  clear\n  release\n\nGlobal options: --speed F (motion speed, 1.0 default), --seed N (reproducible motion).";

fn help(cmd: &str) -> &'static str {
    match cmd {
        "click" => "Usage: click [OPTION]... [BUTTONS]...\nClick mouse buttons.\n\nOptions:\n  -r, --repeat=N          Repeat the whole sequence N times\n  -D, -d, --next-delay=N  Delay N ms between input events (default: random 18-75 ms)\n  -P, --press-release     Press and release each button, then delay\n  -h, --help              Show this help\n\nButtons are hex, '0x' optional: low nibble is the button, 0x40 = down, 0x80 = up.\n  0x00 LEFT  0x01 RIGHT  0x02 MIDDLE  0x03 SIDE  0x04 EXTRA  0x05 FORWARD  0x06 BACK  0x07 TASK (ignored)\n  0xC0 left click, 0x41 right down, 0x82 middle up, 0x00 only delays.",
        "key" => "Usage: key [OPTION]... [KEYCODES]...\nEmit key events.\n\nOptions:\n  -d, --key-delay=N  Delay N ms after each event (default: 12)\n  -h, --help         Show this help\n\nSyntax: <keycode>:<state>, Linux KEY_* codes; state 1 = down, 0 = up.\ne.g. 28:1 28:0 presses Enter. Codes containing 'x' are hex. Code 0 only delays.",
        "type" => "Usage: type [OPTION]... [STRINGS]...\nType strings (full Unicode).\n\nOptions:\n  -d, --key-delay=N    Delay N ms between keys (default: 20)\n  -H, --key-hold=N     Hold each key N ms (default: 20)\n  -D, --next-delay=N   Delay N ms between strings (default: 0)\n  -f, --file=PATH      Type the contents of PATH ('-' = stdin)\n  -e, --escape=0|1     Backslash escapes (\\n \\t \\\\ \\xHH); on for arguments, off for files\n      --human          Human-like timing\n      --wpm=N          Words per minute for --human (default: 180)\n  -h, --help           Show this help",
        "mousemove" => "Usage: mousemove [OPTION]... [-x <xpos> -y <ypos>] [-- <xpos> <ypos>]\nMove the pointer or the wheel.\n\nOptions:\n  -a, --absolute    Absolute position (not for wheel)\n  -w, --wheel       Scroll: x horizontal, y vertical, positive = up/right\n  -x, --xpos=N      X value\n  -y, --ypos=N      Y value\n      --instant     Jump instead of a human-like path\n      --speed=F     Motion speed multiplier (default 1.0)\n      --duration=MS Fixed move duration\n      --seed=N      Reproducible motion\n  -h, --help        Show this help",
        "click-at" => "Usage: click-at X Y [COUNT]\nMove like a human, then left-click COUNT times (default 1; 2 is a double click).",
        "drag" => "Usage: drag X1 Y1 X2 Y2\nMove to X1,Y1, hold the left button, move to X2,Y2, release.",
        "scroll" => "Usage: scroll X Y AMOUNT\nMove to X,Y, then scroll AMOUNT notches (positive = down).",
        "fg" => "Usage: fg [PID,PID...]\nPrint the foreground window, or the first normal window below it not owned by the listed pids, as JSON.",
        "activate" => "Usage: activate HWND\nBring a window to the foreground.",
        _ => USAGE,
    }
}

fn show(cmd: &str) {
    println!("{}", help(cmd));
}

// ---- helpers

fn new_rng(p: &Parsed) -> Rng {
    Rng::new(p.get('E').map_or_else(|| sys::now_us() ^ ((std::process::id() as u64) << 32), |v| keys::strtol(v, 10) as u64))
}

fn speed(p: &Parsed) -> f64 {
    p.float('S').filter(|s| *s > 0.0).unwrap_or(1.0).max(0.05)
}

fn clamp_pt(x: i32, y: i32) -> (i32, i32) {
    let (l, t, r, b) = sys::bounds();
    (x.clamp(l, r), y.clamp(t, b))
}

fn move_human(to: (i32, i32), speed: f64, duration: Option<f64>, rng: &mut Rng) -> R {
    let to = clamp_pt(to.0, to.1);
    let o = MotionOpts { target_w: 18.0, speed, duration_ms: duration, bounds: sys::bounds() };
    sys::follow(&motion::plan(sys::cursor(), to, &o, rng))?;
    sys::settle_exact(to.0, to.1)
}

fn jump(to: (i32, i32)) -> R {
    let to = clamp_pt(to.0, to.1);
    sys::send_mouse_abs(to.0, to.1)?;
    sys::settle_exact(to.0, to.1)
}

fn ms(rng: &mut Rng, lo: f64, hi: f64) -> f64 {
    lo + rng.f64() * (hi - lo)
}

struct Held(u8, bool);

impl Held {
    fn down(b: u8) -> Result<Held, Fail> {
        sys::button(b, true)?;
        Ok(Held(b, true))
    }
    fn up(&mut self) -> R {
        if std::mem::replace(&mut self.1, false) { sys::button(self.0, false) } else { Ok(()) }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.up();
    }
}

// ---- typing

struct Typer {
    hold: f64,
    gap: f64,
    human: Option<f64>,
    rng: Rng,
}

impl Typer {
    fn tap(down: impl Fn(bool) -> R, shift: bool, hold: f64) -> R {
        if shift {
            sys::key_scan(0x2A, false, true)?;
        }
        let r = down(true).and_then(|_| {
            sys::sleep_ms(hold);
            down(false)
        });
        // shift is released on every path
        let s = if shift { sys::key_scan(0x2A, false, false) } else { Ok(()) };
        r.and(s)
    }

    fn ch(&mut self, c: char, last: bool) -> R {
        let hold = if self.human.is_some() { self.rng.lognormal_ms(28.0, 0.3, 12.0, 70.0) } else { self.hold };
        let sc = |s: u16| move |d| sys::key_scan(s, false, d);
        match c {
            '\n' | '\r' => Self::tap(sc(0x1C), false, hold)?,
            '\t' => Self::tap(sc(0x0F), false, hold)?,
            _ => {
                let mut buf = [0u16; 2];
                let units = c.encode_utf16(&mut buf);
                let info = if units.len() == 1 { Some(sys::char_info(units[0], sys::fg_layout())) } else { None };
                let plan = info.map_or(Plan::Unicode, |i| keys::plan(i.vks, i.scan_ex, i.dead, sys::caps_on(), c.is_alphabetic()));
                match plan {
                    Plan::Scan { scan, ext, shift } => Self::tap(|d| sys::key_scan(scan, ext, d), shift, hold)?,
                    Plan::Unicode => {
                        for &u in units.iter() {
                            Self::tap(|d| sys::key_unicode(u, d), false, hold)?;
                        }
                    }
                }
            }
        }
        if !last {
            let gap = match self.human {
                Some(base) => {
                    let g = self.rng.lognormal_ms(base, 0.35, base * 0.4, base * 3.5);
                    // base is the key-to-key period, so the hold counts against it
                    (if c.is_whitespace() || c.is_ascii_punctuation() { g * 1.4 } else { g } - hold).max(2.0)
                }
                None => self.gap,
            };
            sys::sleep_ms(gap);
        }
        Ok(())
    }

    fn text(&mut self, s: &str, esc: Option<&mut Escaper>) -> R {
        let chars: Vec<char> = match esc {
            Some(e) => s.chars().filter_map(|c| e.feed(c)).collect(),
            None => s.chars().collect(),
        };
        for (i, &c) in chars.iter().enumerate() {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                continue;
            }
            self.ch(c, i + 1 == chars.len())?;
        }
        Ok(())
    }
}

fn cmd_type(a: &[String]) -> Result<u8, Fail> {
    let p = parse(
        a,
        &[o("key-delay", 'd', true), o("key-hold", 'H', true), o("next-delay", 'D', true), o("file", 'f', true), o("escape", 'e', true), HELP, lo("human", 'M', false), lo("wpm", 'W', true), SEED],
    );
    if p.has('h') || (p.rest.is_empty() && !p.has('f')) {
        show("type");
        return Ok(0);
    }
    let wpm = p.int('W', 180).max(1) as f64;
    let mut t = Typer {
        hold: p.int('H', 20) as f64,
        gap: p.int('d', 20) as f64,
        // lognormal mean (+6%) and word/punctuation pauses (+8%) would otherwise undershoot --wpm
        human: p.has('M').then(|| 60000.0 / (wpm * 5.0) / 1.14),
        rng: new_rng(&p),
    };
    let user_esc = p.get('e').map(|v| keys::strtol(v, 10) != 0);
    if let Some(path) = p.get('f') {
        let mut buf = Vec::new();
        let ok = if path == "-" { std::io::stdin().read_to_end(&mut buf).is_ok() } else { std::fs::read(path).map(|b| buf = b).is_ok() };
        if !ok {
            eprintln!("ydotool: cannot read file: {path}");
            return Ok(3);
        }
        let s = String::from_utf8_lossy(buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf)).into_owned();
        let mut e = Escaper::default();
        t.text(&s, user_esc.unwrap_or(false).then_some(&mut e))?;
    }
    let mut e = Escaper::default();
    let n = p.rest.len();
    for (i, s) in p.rest.iter().enumerate() {
        t.text(s, user_esc.unwrap_or(true).then_some(&mut e))?;
        if i + 1 < n {
            sys::sleep_ms(p.int('D', 0) as f64);
        }
    }
    Ok(0)
}

// ---- upstream-parity commands

fn cmd_click(a: &[String]) -> Result<u8, Fail> {
    let p = parse(a, &[o("repeat", 'r', true), o("next-delay", 'D', true), o("delay", 'd', true), o("press-release", 'P', false), HELP, SEED]);
    if p.has('h') || p.rest.is_empty() {
        show("click");
        return Ok(0);
    }
    let fixed = p.get('D').or(p.get('d')).map(|v| keys::strtol(v, 10) as f64);
    let mut rng = new_rng(&p);
    let delay = |r: &mut Rng| sys::sleep_ms(fixed.unwrap_or_else(|| r.lognormal_ms(32.0, 0.3, 18.0, 75.0)));
    for _ in 0..p.int('r', 1) {
        for t in &p.rest {
            let b = keys::strtol(t, 16);
            let id = (b & 0xf) as u8;
            if p.has('P') {
                sys::button(id, true)?;
                sys::button(id, false)?;
                delay(&mut rng);
                continue;
            }
            if b & 0x40 != 0 {
                sys::button(id, true)?;
                delay(&mut rng);
            }
            if b & 0x80 != 0 {
                sys::button(id, false)?;
                delay(&mut rng);
            }
            if b & 0xc0 == 0 {
                delay(&mut rng);
            }
        }
    }
    Ok(0)
}

fn cmd_key(a: &[String]) -> Result<u8, Fail> {
    let p = parse(a, &[o("key-delay", 'd', true), o("next-delay", 'D', true), HELP]);
    if p.has('h') || p.rest.is_empty() {
        show("key");
        return Ok(0);
    }
    let delay = p.get('d').or(p.get('D')).map_or(12, |v| keys::strtol(v, 10)) as f64;
    for t in &p.rest {
        if let Some((code, down)) = keys::key_token(t) {
            match keys::linux(code) {
                Some(K::Scan(s, e)) => sys::key_scan(s, e, down)?,
                Some(K::Vk(v)) => sys::key_vk(v, down)?,
                None if code == 0 => {}
                None => eprintln!("ydotool: unknown key code {code}"),
            }
        }
        sys::sleep_ms(delay);
    }
    Ok(0)
}

fn cmd_mousemove(a: &[String]) -> Result<u8, Fail> {
    let p = parse(a, &[o("absolute", 'a', false), o("wheel", 'w', false), o("xpos", 'x', true), o("ypos", 'y', true), HELP, lo("instant", 'I', false), lo("duration", 'U', true), SPEED, SEED]);
    if p.has('h') {
        show("mousemove");
        return Ok(0);
    }
    if a.is_empty() {
        show("mousemove");
        return Ok(0);
    }
    let mut pos = [0i64; 2];
    let mut n = 0;
    for (k, v) in &p.vals {
        if *k == 'x' || *k == 'y' {
            if n >= 2 {
                show("mousemove");
                return Ok(1);
            }
            pos[(*k == 'y') as usize] = keys::strtol(v, 10);
            n += 1;
        }
    }
    for v in &p.rest {
        if n >= 2 {
            show("mousemove");
            return Ok(1);
        }
        pos[n] = keys::strtol(v, 10);
        n += 1;
    }
    if n != 2 {
        show("mousemove");
        return Ok(1);
    }
    let (x, y) = (pos[0].clamp(-1 << 20, 1 << 20) as i32, pos[1].clamp(-1 << 20, 1 << 20) as i32);
    if p.has('w') {
        if p.has('a') {
            println!("Mouse wheel moves should not be absolute values");
            return Ok(1);
        }
        sys::wheel(y, x)?;
        return Ok(0);
    }
    let to = if p.has('a') {
        (x, y)
    } else {
        let c = sys::cursor();
        (c.0.saturating_add(x), c.1.saturating_add(y))
    };
    if p.has('I') {
        jump(to)?;
    } else {
        move_human(to, speed(&p), p.float('U'), &mut new_rng(&p))?;
    }
    Ok(0)
}

fn cmd_stdin() -> Result<u8, Fail> {
    use windows_sys::Win32::System::Console::*;
    let mut t = Typer { hold: 20.0, gap: 20.0, human: None, rng: Rng::new(1) };
    unsafe {
        let h = GetStdHandle(STD_INPUT_HANDLE);
        let mut mode = 0u32;
        if GetConsoleMode(h, &mut mode) == 0 {
            let mut s = String::new();
            let _ = std::io::stdin().read_to_string(&mut s);
            t.text(&s, None)?;
            return Ok(0);
        }
        SetConsoleMode(h, mode & !(ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT));
        println!("Type anything (Ctrl+C to exit):");
        let rc = (|| -> R {
            loop {
                let mut rec: INPUT_RECORD = std::mem::zeroed();
                let mut n = 0u32;
                if ReadConsoleInputW(h, &mut rec, 1, &mut n) == 0 {
                    return Ok(());
                }
                if rec.EventType != KEY_EVENT as u16 || rec.Event.KeyEvent.bKeyDown == 0 {
                    continue;
                }
                let k = rec.Event.KeyEvent;
                let u = k.uChar.UnicodeChar;
                if u == 3 {
                    return Ok(());
                }
                let code = match k.wVirtualKeyCode {
                    0x26 => 103,
                    0x28 => 108,
                    0x25 => 105,
                    0x27 => 106,
                    0x21 => 104,
                    0x22 => 109,
                    0x24 => 102,
                    0x23 => 107,
                    0x2D => 110,
                    0x2E => 111,
                    _ => 0,
                };
                if let Some(K::Scan(s, e)) = keys::linux(code) {
                    Typer::tap(|d| sys::key_scan(s, e, d), false, t.hold)?;
                } else if u == 8 {
                    Typer::tap(|d| sys::key_scan(0x0E, false, d), false, t.hold)?;
                } else if u == 27 {
                    Typer::tap(|d| sys::key_scan(0x01, false, d), false, t.hold)?;
                } else if let Some(c) = char::from_u32(u as u32).filter(|c| *c != '\0') {
                    t.ch(c, false)?;
                }
            }
        })();
        SetConsoleMode(h, mode);
        rc?;
    }
    Ok(0)
}

// ---- Aether commands

fn ints(p: &Parsed, n: usize) -> Option<Vec<i32>> {
    let v: Vec<i32> = p.rest.iter().map(|s| keys::strtol(s, 10).clamp(-1 << 20, 1 << 20) as i32).collect();
    (v.len() == n).then_some(v)
}

fn usage(cmd: &str) -> Result<u8, Fail> {
    show(cmd);
    Ok(1)
}

fn cmd_click_at(a: &[String]) -> Result<u8, Fail> {
    let p = parse(a, &[HELP, SPEED, SEED]);
    if p.has('h') || a.is_empty() {
        show("click-at");
        return Ok(0);
    }
    let count = if p.rest.len() == 3 { keys::strtol(&p.rest[2], 10).max(1) } else { 1 };
    let Some(v) = ints(&Parsed { rest: p.rest.iter().take(2).cloned().collect(), ..Default::default() }, 2).filter(|_| (2..=3).contains(&p.rest.len())) else {
        return usage("click-at");
    };
    let mut rng = new_rng(&p);
    let to = clamp_pt(v[0], v[1]);
    move_human(to, speed(&p), None, &mut rng)?;
    sys::sleep_ms(ms(&mut rng, 15.0, 40.0));
    // settle_exact would drag the pointer back from the user; a moved pointer must just abort
    if sys::cursor() != to {
        return Err(Fail::Interference);
    }
    let dct = sys::dct() as f64;
    for i in 0..count {
        let hold = rng.lognormal_ms(48.0, 0.25, 30.0, 90.0);
        if i > 0 {
            let gap = rng.lognormal_ms(75.0, 0.2, 55.0, 105.0).min(dct - 10.0 - hold).max(1.0);
            sys::sleep_ms(gap);
        }
        let mut h = Held::down(0)?;
        sys::sleep_ms(hold);
        h.up()?;
    }
    Ok(0)
}

fn cmd_drag(a: &[String]) -> Result<u8, Fail> {
    let p = parse(a, &[HELP, SPEED, SEED]);
    if p.has('h') || a.is_empty() {
        show("drag");
        return Ok(0);
    }
    let Some(v) = ints(&p, 4) else { return usage("drag") };
    let mut rng = new_rng(&p);
    let s = speed(&p);
    move_human((v[0], v[1]), s, None, &mut rng)?;
    let mut h = Held::down(0)?;
    sys::sleep_ms(ms(&mut rng, 35.0, 70.0));
    move_human((v[2], v[3]), s * 0.6, None, &mut rng)?;
    sys::sleep_ms(ms(&mut rng, 25.0, 50.0));
    h.up()?;
    Ok(0)
}

fn cmd_scroll(a: &[String]) -> Result<u8, Fail> {
    let p = parse(a, &[HELP, SPEED, SEED]);
    if p.has('h') || a.is_empty() {
        show("scroll");
        return Ok(0);
    }
    let Some(v) = ints(&p, 3) else { return usage("scroll") };
    let mut rng = new_rng(&p);
    move_human((v[0], v[1]), speed(&p), None, &mut rng)?;
    for i in 0..v[2].unsigned_abs() {
        if i > 0 {
            sys::sleep_ms(rng.lognormal_ms(28.0, 0.35, 12.0, 70.0));
        }
        sys::wheel(if v[2] > 0 { -1 } else { 1 }, 0)?;
    }
    Ok(0)
}

fn cmd_fg(a: &[String]) -> Result<u8, Fail> {
    let skip: Vec<u32> = a.first().map(|s| s.split(',').filter(|t| !t.is_empty()).map(|t| keys::strtol(t, 10) as u32).collect()).unwrap_or_default();
    let (h, r) = sys::fg(&skip);
    print!("{{\"handle\":{h},\"left\":{},\"top\":{},\"right\":{},\"bottom\":{}}}", r.left, r.top, r.right, r.bottom);
    let _ = std::io::stdout().flush();
    Ok(0)
}

fn cmd_nudge() -> Result<u8, Fail> {
    let o = sys::cursor();
    let n = clamp_pt(o.0 + 3, o.1 + 3);
    sys::send_mouse_abs(n.0, n.1)?;
    sys::sleep_ms(60.0);
    sys::send_mouse_abs(o.0, o.1)?;
    sys::settle_exact(o.0, o.1)?;
    Ok(0)
}

fn cmd_clear() -> Result<u8, Fail> {
    let mut rng = Rng::new(sys::now_us());
    // Ctrl+A by character: scan 0x1E is Q on AZERTY, and Ctrl+Q can close the target app.
    let i = sys::char_info('a' as u16, sys::fg_layout());
    let a = if i.vks == -1 || i.scan_ex == 0 { 0x1E } else { (i.scan_ex & 0xFF) as u16 };
    let (ctrl, bs) = (0x1D, 0x0E);
    sys::key_scan(ctrl, false, true)?;
    sys::sleep_ms(ms(&mut rng, 12.0, 25.0));
    let r = sys::key_scan(a, false, true).and_then(|_| {
        sys::sleep_ms(ms(&mut rng, 15.0, 30.0));
        sys::key_scan(a, false, false)
    });
    let u = sys::key_scan(ctrl, false, false);
    r.and(u)?;
    sys::sleep_ms(ms(&mut rng, 20.0, 40.0));
    sys::key_scan(bs, false, true)?;
    sys::sleep_ms(ms(&mut rng, 15.0, 30.0));
    sys::key_scan(bs, false, false)?;
    Ok(0)
}

fn cmd_release() -> Result<u8, Fail> {
    for (vk, b) in [(0x01u16, 0u8), (0x02, 1), (0x04, 2)] {
        if sys::held(vk) {
            sys::button_raw(b, false)?;
        }
    }
    for vk in [0xA0u16, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C] {
        if sys::held(vk) {
            sys::key_vk(vk, false)?;
        }
    }
    Ok(0)
}

fn run(a: &[String]) -> Result<u8, Fail> {
    let Some(cmd) = a.first() else {
        println!("{USAGE}");
        return Ok(0);
    };
    let rest = &a[1..];
    match cmd.as_str() {
        "help" | "-h" => println!("{USAGE}"),
        c if c.starts_with("--h") => println!("{USAGE}"),
        "click" => return cmd_click(rest),
        "key" => return cmd_key(rest),
        "type" => return cmd_type(rest),
        "mousemove" => return cmd_mousemove(rest),
        "stdin" => return cmd_stdin(),
        "click-at" => return cmd_click_at(rest),
        "drag" => return cmd_drag(rest),
        "scroll" => return cmd_scroll(rest),
        "fg" => return cmd_fg(rest),
        "nudge" => return cmd_nudge(),
        "clear" => return cmd_clear(),
        "release" => return cmd_release(),
        "activate" => match rest.first() {
            Some(h) => {
                let h = h.trim();
                let v = match h.strip_prefix("0x") {
                    Some(x) => keys::strtol(x, 16),
                    None => keys::strtol(h, 10),
                };
                sys::activate(v as isize);
            }
            None => show("activate"),
        },
        "debug" => println!("ydotool {} (windows)\nno daemon required on Windows", env!("CARGO_PKG_VERSION")),
        "bakers" => println!("These are our honorable bakers:\n\nDustin Van Tate Testa\nElliot Wolk\ntofik\n"),
        c => {
            eprintln!("ydotool: Unknown command: {c}\nRun 'ydotool help' if you want a command list");
            return Ok(1);
        }
    }
    Ok(0)
}

fn main() -> ExitCode {
    sys::init();
    let args: Vec<String> = std::env::args_os().skip(1).map(|s| s.to_string_lossy().into_owned()).collect();
    let rc = match run(&args) {
        Ok(rc) => rc,
        Err(f) => {
            eprintln!(
                "ydotool: {}",
                match f {
                    Fail::Send => "SendInput failed (blocked by a higher-integrity window?)",
                    Fail::Unreached => "pointer did not reach the target position",
                    Fail::Interference => "pointer moved by the user, aborting",
                }
            );
            f.code()
        }
    };
    if std::env::var_os("YDOTOOL_STATS").is_some() {
        let mut l = sys::LATE.lock().map(|l| l.clone()).unwrap_or_default();
        l.sort_unstable();
        eprintln!(
            "stats late_us_median={} late_us_max={} ticks={} fallbacks={}",
            l.get(l.len() / 2).copied().unwrap_or(0),
            l.last().copied().unwrap_or(0),
            l.len(),
            sys::FALLBACKS.load(std::sync::atomic::Ordering::Relaxed)
        );
    }
    ExitCode::from(rc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|s| s.to_string()).collect()
    }
    const OPTS: [Opt; 4] = [o("key-delay", 'd', true), o("press-release", 'P', false), o("repeat", 'r', true), lo("instant", 'I', false)];

    #[test]
    fn option_forms() {
        for f in [&["-d5"][..], &["-d", "5"], &["--key-delay=5"], &["--key-delay", "5"], &["--key-d", "5"]] {
            let p = parse(&v(f), &OPTS);
            assert_eq!(p.get('d'), Some("5"), "{f:?}");
            assert!(p.rest.is_empty());
        }
    }

    #[test]
    fn permutes_and_double_dash() {
        let p = parse(&v(&["a", "-P", "b", "--", "-5", "-P"]), &OPTS);
        assert!(p.has('P'));
        assert_eq!(p.rest, v(&["a", "b", "-5", "-P"]));
        assert_eq!(p.vals.len(), 1);
    }

    #[test]
    fn clusters_and_negatives() {
        let p = parse(&v(&["-Pr3", "-12", "-"]), &OPTS);
        assert!(p.has('P'));
        assert_eq!(p.int('r', 0), 3);
        assert_eq!(p.rest, v(&["-12", "-"]));
        assert!(parse(&v(&["--instant"]), &OPTS).has('I'));
        assert!(!parse(&v(&["-I"]), &OPTS).has('I'));
        assert!(parse(&v(&["-d"]), &OPTS).vals.is_empty());
    }

    #[test]
    fn abs_normalise_roundtrips() {
        // Windows maps n back to floor(n * extent / 65536)
        for (origin, w) in [(0, 1920), (-1920, 3840), (0, 2560), (0, 3440), (-1366, 1366 + 2560), (0, 7680), (0, 1), (100, 1000)] {
            for p in origin..origin + w {
                let n = sys::norm(p, origin, w);
                assert!((0..=65535).contains(&n));
                assert_eq!(origin + (n as i64 * w as i64 / 65536) as i32, p, "w={w} p={p}");
            }
        }
    }
}
