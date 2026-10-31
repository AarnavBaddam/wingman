pub enum K {
    Scan(u16, bool),
    Vk(u16),
}

pub fn linux(code: u32) -> Option<K> {
    use K::*;
    Some(match code {
        1..=88 => Scan(code as u16, false),
        96 => Scan(0x1C, true),
        97 => Scan(0x1D, true),
        98 => Scan(0x35, true),
        99 => Scan(0x37, true),
        100 => Scan(0x38, true),
        102 => Scan(0x47, true),
        103 => Scan(0x48, true),
        104 => Scan(0x49, true),
        105 => Scan(0x4B, true),
        106 => Scan(0x4D, true),
        107 => Scan(0x4F, true),
        108 => Scan(0x50, true),
        109 => Scan(0x51, true),
        110 => Scan(0x52, true),
        111 => Scan(0x53, true),
        119 => Vk(0x13),
        125 => Scan(0x5B, true),
        126 => Scan(0x5C, true),
        127 => Scan(0x5D, true),
        183..=194 => Vk(0x7C + (code - 183) as u16),
        _ => return None,
    })
}

/// C strtol: optional space/sign, optional 0x for base 16, leading valid digits, else 0.
pub fn strtol(s: &str, base: u32) -> i64 {
    let s = s.trim_start();
    let (neg, s) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let s = if base == 16 { s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s) } else { s };
    let mut v: i64 = 0;
    for c in s.chars() {
        match c.to_digit(base) {
            Some(d) => v = v.saturating_mul(base as i64).saturating_add(d as i64),
            None => break,
        }
    }
    if neg { -v } else { v }
}

/// `key` token: hex if it contains 'x', last char '0' means up.
pub fn key_token(t: &str) -> Option<(u32, bool)> {
    let last = t.chars().last()?;
    let code = strtol(t, if t.contains('x') { 16 } else { 10 }) as u16 as u32;
    Some((code, last != '0'))
}

pub enum Plan {
    Scan { scan: u16, ext: bool, shift: bool },
    Unicode,
}

/// `vks` is VkKeyScanExW; `scan_ex` is MapVirtualKeyEx(VK_TO_VSC_EX), 0xE0xx when extended.
pub fn plan(vks: i16, scan_ex: u32, dead: bool, caps: bool, alpha: bool) -> Plan {
    if vks == -1 || dead || scan_ex == 0 || (vks >> 8) & !1 != 0 {
        return Plan::Unicode;
    }
    let shift = ((vks >> 8) & 1 != 0) ^ (caps && alpha);
    Plan::Scan { scan: (scan_ex & 0xFF) as u16, ext: scan_ex >> 8 == 0xE0, shift }
}

/// Upstream escape machine: `\n \t \\ \xHH`; any other `\c` is dropped.
#[derive(Default)]
pub struct Escaper {
    state: u8,
    hex: [char; 2],
}

impl Escaper {
    pub fn feed(&mut self, c: char) -> Option<char> {
        match self.state {
            0 => {
                if c == '\\' {
                    self.state = 1;
                    None
                } else {
                    Some(c)
                }
            }
            1 => {
                self.state = 0;
                match c {
                    'n' => Some('\n'),
                    't' => Some('\t'),
                    '\\' => Some('\\'),
                    'x' => {
                        self.state = 2;
                        None
                    }
                    _ => None,
                }
            }
            2 => {
                self.state = 3;
                self.hex[0] = c;
                None
            }
            _ => {
                self.state = 0;
                self.hex[1] = c;
                let s: String = self.hex.iter().collect();
                char::from_u32(strtol(&s, 16) as u32).filter(|&c| c != '\0')
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn esc(s: &str) -> String {
        let mut e = Escaper::default();
        s.chars().filter_map(|c| e.feed(c)).collect()
    }

    #[test]
    fn escapes() {
        assert_eq!(esc(r"a\nb\tc\\d"), "a\nb\tc\\d");
        assert_eq!(esc(r"\x41\x7a"), "Az");
        assert_eq!(esc(r"a\qb"), "ab");
        assert_eq!(esc(r"\x00z"), "z");
        assert_eq!(esc(r"\xZZ!"), "!");
        assert_eq!(esc("héllo"), "héllo");
    }

    #[test]
    fn escape_state_persists_across_strings() {
        let mut e = Escaper::default();
        assert_eq!(e.feed('\\'), None);
        assert_eq!(e.feed('n'), Some('\n'));
    }

    #[test]
    fn key_table() {
        assert!(matches!(linux(28), Some(K::Scan(0x1C, false))));
        assert!(matches!(linux(96), Some(K::Scan(0x1C, true))));
        assert!(matches!(linux(105), Some(K::Scan(0x4B, true))));
        assert!(matches!(linux(111), Some(K::Scan(0x53, true))));
        assert!(matches!(linux(119), Some(K::Vk(0x13))));
        assert!(matches!(linux(183), Some(K::Vk(0x7C))));
        assert!(matches!(linux(194), Some(K::Vk(0x87))));
        assert!(linux(0).is_none() && linux(89).is_none() && linux(500).is_none());
        for c in 1..=88 {
            assert!(matches!(linux(c), Some(K::Scan(s, false)) if s as u32 == c));
        }
        for c in [97, 98, 99, 100, 102, 103, 104, 106, 107, 108, 109, 110, 125, 126, 127] {
            assert!(matches!(linux(c), Some(K::Scan(_, true))), "{c}");
        }
    }

    #[test]
    fn tokens() {
        assert_eq!(key_token("28:1"), Some((28, true)));
        assert_eq!(key_token("28:0"), Some((28, false)));
        assert_eq!(key_token("0x1c:1"), Some((0x1c, true)));
        assert_eq!(key_token("0x1c:0"), Some((0x1c, false)));
        assert_eq!(key_token("0"), Some((0, false)));
        assert_eq!(key_token("aaa"), Some((0, true)));
        assert_eq!(key_token(""), None);
        assert_eq!(strtol("-12x", 10), -12);
        assert_eq!(strtol("0xC0", 16), 0xC0);
        assert_eq!(strtol("c0", 16), 0xC0);
    }

    #[test]
    fn char_plan() {
        // 'a' on US: vk 0x41, no shift
        assert!(matches!(plan(0x41, 0x1E, false, false, true), Plan::Scan { scan: 0x1E, ext: false, shift: false }));
        // 'A'
        assert!(matches!(plan(0x141, 0x1E, false, false, true), Plan::Scan { shift: true, .. }));
        // caps on inverts letters only
        assert!(matches!(plan(0x41, 0x1E, false, true, true), Plan::Scan { shift: true, .. }));
        assert!(matches!(plan(0x141, 0x1E, false, true, true), Plan::Scan { shift: false, .. }));
        assert!(matches!(plan(0x131, 0x02, false, true, false), Plan::Scan { shift: true, .. }));
        // ctrl/alt combos (AltGr), unmapped, dead, no scan => unicode
        assert!(matches!(plan(0x0641, 0x1E, false, false, true), Plan::Unicode));
        assert!(matches!(plan(-1, 0, false, false, false), Plan::Unicode));
        assert!(matches!(plan(0x41, 0x1E, true, false, false), Plan::Unicode));
        assert!(matches!(plan(0x41, 0, false, false, false), Plan::Unicode));
        assert!(matches!(plan(0x25, 0xE04B, false, false, false), Plan::Scan { scan: 0x4B, ext: true, .. }));
    }
}
