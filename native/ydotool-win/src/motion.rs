// Pure human-motion planner: Fitts duration, curved min-jerk path, optional corrective submovement.
// No Win32 here so it compiles and tests alone.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub t_us: u64,
    pub x: i32,
    pub y: i32,
}

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        // splitmix64 scramble so adjacent seeds give unrelated streams
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        Rng(if z == 0 { 0x2545_F491_4F6C_DD1D } else { z })
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn f64(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn gauss(&mut self) -> f64 {
        let u1 = 1.0 - self.f64();
        let u2 = self.f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }

    pub fn lognormal_ms(&mut self, median: f64, sigma: f64, lo: f64, hi: f64) -> f64 {
        (median * (sigma * self.gauss()).exp()).clamp(lo, hi)
    }

    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f64()
    }
}

pub struct MotionOpts {
    pub target_w: f64,
    pub speed: f64,
    pub duration_ms: Option<f64>,
    pub bounds: (i32, i32, i32, i32),
}

impl Default for MotionOpts {
    fn default() -> Self {
        MotionOpts { target_w: 18.0, speed: 1.0, duration_ms: None, bounds: (i32::MIN, i32::MIN, i32::MAX, i32::MAX) }
    }
}

const TICK_US: f64 = 4000.0;
const TREMOR_PX: f64 = 0.5;
const TREMOR_A: f64 = 0.9;

fn min_jerk(w: f64) -> f64 {
    w * w * w * (10.0 - 15.0 * w + 6.0 * w * w)
}

// Position of the speed peak for warp exponent g (w = u^g).
pub(crate) fn peak_pos(g: f64) -> f64 {
    let (mut best, mut at) = (0.0, 0.5);
    for i in 1..200 {
        let u = i as f64 / 200.0;
        let w = u.powf(g);
        let v = 30.0 * w * w * (1.0 - w) * (1.0 - w) * g * u.powf(g - 1.0);
        if v > best {
            best = v;
            at = u;
        }
    }
    at
}

// Warp exponent putting the speed peak at fraction `p` of the phase (humans peak early).
fn warp_for(p: f64) -> f64 {
    let (mut lo, mut hi) = (0.4, 1.0);
    for _ in 0..12 {
        let mid = 0.5 * (lo + hi);
        if peak_pos(mid) < p {
            lo = mid
        } else {
            hi = mid
        }
    }
    0.5 * (lo + hi)
}

fn bezier(p: [(f64, f64); 4], s: f64) -> (f64, f64) {
    let m = 1.0 - s;
    let (a, b, c, d) = (m * m * m, 3.0 * m * m * s, 3.0 * m * s * s, s * s * s);
    (a * p[0].0 + b * p[1].0 + c * p[2].0 + d * p[3].0, a * p[0].1 + b * p[1].1 + c * p[2].1 + d * p[3].1)
}

pub fn plan(from: (i32, i32), to: (i32, i32), o: &MotionOpts, r: &mut Rng) -> Vec<Sample> {
    let (l, t, rt, b) = o.bounds;
    let to = (to.0.clamp(l, rt.max(l)), to.1.clamp(t, b.max(t)));
    let (p0, pe) = ((from.0 as f64, from.1 as f64), (to.0 as f64, to.1 as f64));
    let (dx, dy) = (pe.0 - p0.0, pe.1 - p0.1);
    let d = dx.hypot(dy);
    if d < 2.0 {
        return vec![Sample { t_us: 0, x: to.0, y: to.1 }];
    }
    let (ux, uy) = (dx / d, dy / d);
    let (nx, ny) = (-uy, ux);

    let speed = if o.speed > 0.0 { o.speed } else { 1.0 };
    let total_ms = match o.duration_ms {
        Some(ms) => ms.max(1.0),
        None => {
            let mt = 30.0 + 55.0 * (d / o.target_w.max(1.0) + 1.0).log2();
            (mt * r.range(0.9, 1.1) / speed).clamp(40.0, 650.0)
        }
    };
    let total_us = (total_ms * 1000.0).round().max(1.0) as u64;

    let two = d >= 150.0;
    let (aim, t1_us) = if two {
        let ratio = if r.f64() < 0.85 { r.range(0.92, 0.99) } else { r.range(1.0, 1.02) };
        let err = (r.gauss() * 0.01 * d).clamp(-0.02 * d, 0.02 * d);
        let a = (p0.0 + dx * ratio + nx * err, p0.1 + dy * ratio + ny * err);
        (a, (total_us as f64 * r.range(0.78, 0.85)).round())
    } else {
        (pe, total_us as f64)
    };

    // Arc, not S: both controls bow the same way with different depth.
    let (cx, cy) = (aim.0 - p0.0, aim.1 - p0.1);
    let chord = cx.hypot(cy);
    let (bx, by) = (-cy / chord, cx / chord);
    let bow = (chord * r.range(0.03, 0.07)).min(40.0) * if r.f64() < 0.5 { -1.0 } else { 1.0 };
    let (k1, k2) = (bow * r.range(0.8, 1.3), bow * r.range(0.6, 1.1));
    let ctrl = [
        p0,
        (p0.0 + cx * 0.30 + bx * k1, p0.1 + cy * 0.30 + by * k1),
        (p0.0 + cx * 0.72 + bx * k2, p0.1 + cy * 0.72 + by * k2),
        aim,
    ];
    let g1 = warp_for(r.range(0.38, 0.48));
    let g2 = warp_for(r.range(0.38, 0.48));

    let (mut tx, mut ty) = (0.0f64, 0.0f64);
    let b2 = TREMOR_PX * (1.0 - TREMOR_A * TREMOR_A).sqrt();
    let mut out: Vec<Sample> = Vec::new();
    let mut now = 0.0f64;
    let (mut last_x, mut last_y) = from;
    loop {
        now += TICK_US + r.range(-500.0, 500.0);
        if now + 1000.0 > total_us as f64 {
            break;
        }
        tx = TREMOR_A * tx + b2 * r.gauss();
        ty = TREMOR_A * ty + b2 * r.gauss();
        let fade = 1.0 - now / total_us as f64;
        let (px, py) = if now < t1_us {
            bezier(ctrl, min_jerk((now / t1_us).powf(g1)))
        } else {
            let u = ((now - t1_us) / (total_us as f64 - t1_us)).powf(g2);
            let s = min_jerk(u);
            (aim.0 + (pe.0 - aim.0) * s, aim.1 + (pe.1 - aim.1) * s)
        };
        let x = ((px + tx * fade).round() as i32).clamp(l, rt.max(l));
        let y = ((py + ty * fade).round() as i32).clamp(t, b.max(t));
        if (x, y) != (last_x, last_y) {
            out.push(Sample { t_us: now as u64, x, y });
            (last_x, last_y) = (x, y);
        }
    }
    out.push(Sample { t_us: total_us, x: to.0, y: to.1 });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISTS: [f64; 14] = [2.0, 3.0, 5.0, 12.0, 30.0, 80.0, 149.0, 150.0, 151.0, 300.0, 700.0, 1500.0, 4000.0, 20000.0];
    const BOUNDS: (i32, i32, i32, i32) = (-30000, -30000, 30000, 30000);

    fn case(seed: u64, d: f64) -> ((i32, i32), (i32, i32)) {
        let mut r = Rng::new(seed ^ 0xABCD);
        let a = r.f64() * std::f64::consts::TAU;
        let from = (100 + (r.f64() * 500.0) as i32, 100 + (r.f64() * 500.0) as i32);
        let to = ((from.0 as f64 + d * a.cos()).round() as i32, (from.1 as f64 + d * a.sin()).round() as i32);
        (from, to)
    }

    fn opts(speed: f64, dur: Option<f64>) -> MotionOpts {
        MotionOpts { target_w: 18.0, speed, duration_ms: dur, bounds: BOUNDS }
    }

    fn dist(a: (i32, i32), b: (i32, i32)) -> f64 {
        ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64)
    }

    fn run(seed: u64, d: f64, o: &MotionOpts) -> (Vec<Sample>, (i32, i32), (i32, i32)) {
        let (from, to) = case(seed, d);
        let s = plan(from, to, o, &mut Rng::new(seed));
        (s, from, to)
    }

    #[test]
    fn exact_landing_monotonic_and_in_bounds() {
        for seed in 0..1000u64 {
            for &d in &DISTS {
                let o = opts(1.0, None);
                let (s, from, to) = run(seed, d, &o);
                assert!(!s.is_empty());
                let last = s.last().unwrap();
                assert_eq!((last.x, last.y), to, "seed {seed} d {d} from {from:?}");
                for w in s.windows(2) {
                    assert!(w[1].t_us > w[0].t_us, "seed {seed} d {d}");
                }
                for p in &s {
                    assert!(p.x >= BOUNDS.0 && p.x <= BOUNDS.2 && p.y >= BOUNDS.1 && p.y <= BOUNDS.3);
                }
            }
        }
    }

    #[test]
    fn tiny_and_zero_distance() {
        for to in [(10, 10), (11, 10), (10, 11), (11, 11)] {
            let s = plan((10, 10), to, &opts(1.0, None), &mut Rng::new(1));
            assert_eq!(s, vec![Sample { t_us: 0, x: to.0, y: to.1 }]);
        }
    }

    #[test]
    fn huge_distance_ok() {
        let o = MotionOpts { bounds: (-1_000_000, -1_000_000, 1_000_000, 1_000_000), ..MotionOpts::default() };
        let s = plan((-900_000, -900_000), (900_000, 800_000), &o, &mut Rng::new(7));
        let last = s.last().unwrap();
        assert_eq!((last.x, last.y), (900_000, 800_000));
        assert!(last.t_us <= 650_000);
    }

    #[test]
    fn target_is_clamped_to_bounds() {
        let o = MotionOpts { bounds: (0, 0, 100, 100), ..MotionOpts::default() };
        let s = plan((50, 50), (500, -40), &o, &mut Rng::new(3));
        let last = s.last().unwrap();
        assert_eq!((last.x, last.y), (100, 0));
        assert!(s.iter().all(|p| p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100));
    }

    #[test]
    fn duration_follows_fitts_and_clamp() {
        for seed in 0..1000u64 {
            for &d in &DISTS {
                for speed in [1.0, 2.0] {
                    let (s, from, to) = run(seed, d, &opts(speed, None));
                    let d = dist(from, to);
                    if d < 2.0 { continue; }
                    let ms = s.last().unwrap().t_us as f64 / 1000.0;
                    let mt = (30.0 + 55.0 * (d / 18.0 + 1.0).log2()) / speed;
                    let (lo, hi) = ((mt * 0.9 - 0.01).clamp(40.0, 650.0), (mt * 1.1 + 0.01).clamp(40.0, 650.0));
                    assert!(ms >= lo && ms <= hi, "seed {seed} d {d} speed {speed}: {ms} not in {lo}..{hi}");
                }
            }
        }
    }

    #[test]
    fn faster_speed_is_shorter_on_average() {
        let total = |speed: f64| -> f64 { (0..200).map(|s| run(s, 600.0, &opts(speed, None)).0.last().unwrap().t_us as f64).sum() };
        assert!(total(2.0) < total(1.0) * 0.7);
    }

    #[test]
    fn explicit_duration_honoured() {
        for seed in 0..200u64 {
            for &d in &[5.0, 100.0, 800.0] {
                for ms in [90.0, 400.0, 1500.0] {
                    let (s, _, _) = run(seed, d, &opts(3.0, Some(ms)));
                    assert_eq!(s.last().unwrap().t_us, (ms * 1000.0) as u64);
                }
            }
        }
    }

    #[test]
    fn warp_peak_lands_in_window() {
        for i in 0..=10 {
            let p = 0.38 + 0.01 * i as f64;
            assert!((peak_pos(warp_for(p)) - p).abs() < 0.015, "p {p}");
        }
    }

    // Peak of smoothed speed as a fraction of total time.
    fn peak_fraction(s: &[Sample], from: (i32, i32)) -> f64 {
        let mut pts = vec![Sample { t_us: 0, x: from.0, y: from.1 }];
        pts.extend_from_slice(s);
        let k = 8;
        let (mut best, mut at) = (0.0, 0.0);
        for i in 0..pts.len().saturating_sub(k) {
            let v = dist((pts[i].x, pts[i].y), (pts[i + k].x, pts[i + k].y)) / (pts[i + k].t_us - pts[i].t_us) as f64;
            if v > best {
                best = v;
                at = (pts[i].t_us + pts[i + k].t_us) as f64 * 0.5;
            }
        }
        at / pts.last().unwrap().t_us as f64
    }

    #[test]
    fn peak_speed_is_early() {
        for seed in 0..300u64 {
            // single phase: peak at 38..48% of the whole movement (tolerance for noise and smoothing)
            let (s, from, _) = run(seed, 140.0, &opts(1.0, None));
            let f = peak_fraction(&s, from);
            assert!(f > 0.28 && f < 0.56, "seed {seed}: single-phase peak at {f}");
            // two phase: primary is ~80% of time, so peak lands near 0.45*0.82
            let (s, from, _) = run(seed, 600.0, &opts(1.0, None));
            let f = peak_fraction(&s, from);
            assert!(f > 0.25 && f < 0.5, "seed {seed}: primary peak at {f}");
        }
    }

    #[test]
    fn perpendicular_deviation_bounded() {
        for seed in 0..1000u64 {
            for &d in &DISTS {
                let (s, from, to) = run(seed, d, &opts(1.0, None));
                let dd = dist(from, to);
                let (ux, uy) = ((to.0 - from.0) as f64 / dd, (to.1 - from.1) as f64 / dd);
                for p in &s {
                    let dev = ((p.x - from.0) as f64 * uy - (p.y - from.1) as f64 * ux).abs();
                    assert!(dev <= 0.12 * dd + 3.0, "seed {seed} d {d}: dev {dev}");
                }
            }
        }
    }

    #[test]
    fn step_size_is_sane() {
        for seed in 0..1000u64 {
            for &d in &DISTS {
                let (s, from, to) = run(seed, d, &opts(1.0, None));
                let dd = dist(from, to);
                let total = s.last().unwrap().t_us as f64;
                let mut prev = (from.0, from.1, 0u64);
                for p in &s {
                    let step = dist((prev.0, prev.1), (p.x, p.y));
                    let gap = (p.t_us - prev.2).max(1) as f64;
                    // peak min-jerk speed is 1.875 D/T; allow skew, jitter, tremor, and dropped duplicates
                    let cap = 3.2 * dd * gap.max(TICK_US * 1.25) / total + 4.0;
                    assert!(step <= cap, "seed {seed} d {d}: step {step} > {cap}");
                    prev = (p.x, p.y, p.t_us);
                }
            }
        }
    }

    #[test]
    fn deterministic_per_seed_and_varied_across_seeds() {
        for &d in &[40.0, 300.0, 1200.0] {
            let (a, ..) = run(42, d, &opts(1.0, None));
            let (b, ..) = run(42, d, &opts(1.0, None));
            assert_eq!(a, b);
            let to = (200 + d as i32, 350);
            let distinct = (1..20u64)
                .filter(|&s| plan((200, 200), to, &opts(1.0, None), &mut Rng::new(s)) != plan((200, 200), to, &opts(1.0, None), &mut Rng::new(s + 100)))
                .count();
            assert_eq!(distinct, 19);
        }
    }

    #[test]
    fn ticks_are_about_4ms() {
        let (s, ..) = run(5, 800.0, &opts(1.0, None));
        let gaps: Vec<u64> = s.windows(2).map(|w| w[1].t_us - w[0].t_us).collect();
        assert!(s.len() > 50 && gaps.iter().all(|&g| g <= 12_000));
    }

    #[test]
    fn rng_basics() {
        let mut r = Rng::new(0);
        let v: Vec<f64> = (0..20000).map(|_| r.f64()).collect();
        assert!(v.iter().all(|&x| (0.0..1.0).contains(&x)));
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        assert!((mean - 0.5).abs() < 0.01);
        let g: Vec<f64> = (0..20000).map(|_| r.gauss()).collect();
        let m = g.iter().sum::<f64>() / g.len() as f64;
        let var = g.iter().map(|x| (x - m).powi(2)).sum::<f64>() / g.len() as f64;
        assert!(m.abs() < 0.03 && (var - 1.0).abs() < 0.05, "m {m} var {var}");
        let mut ls: Vec<f64> = (0..20001).map(|_| r.lognormal_ms(32.0, 0.3, 18.0, 75.0)).collect();
        assert!(ls.iter().all(|&x| (18.0..=75.0).contains(&x)));
        ls.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((ls[10000] - 32.0).abs() < 1.0, "median {}", ls[10000]);
    }
}
