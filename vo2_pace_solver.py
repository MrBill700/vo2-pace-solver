#!/usr/bin/env python3
"""vo2_pace_solver.py -- VDOT-style calculator: race -> fitness value -> training paces + equivalent times.

Computes a Daniels-style fitness value (commonly called VDOT) from a real race
result, then derives E/M/T/I/R training paces and equivalent race times at ten
distances.

EQUATIONS: Daniels, J. & Gilbert, J. (1979), "Oxygen Power: Performance Tables
for Distance Runners" (privately published), Appendices A-B. Velocity v in
meters/minute, time t in minutes:

  (1) VO2(v) = -4.60 + 0.182258*v + 0.000104*v^2          [Appendix A: oxygen cost of running at v]
  (2) v(VO2) = 29.54 + 5.000663*VO2 - 0.007546*VO2^2      [Appendix A: fitted inverse of (1)]
  (3) pct(t) = 0.8 + 0.1894393*exp(-0.012778*t)
             + 0.2989558*exp(-0.1932605*t)                [Appendix A: fraction of VO2max sustainable for t min]

  VDOT from a race of d meters in t minutes: VDOT = VO2(d/t) / pct(t)
  Equivalent time at d2 for a VDOT: solve t2 with VO2(d2/t2)/pct(t2) = VDOT.
  Appendix B describes Newton-Raphson for this; here a bracketing bisection is
  used instead (robust over VDOT 25-85 at every supported distance; the identity
  solved is the same one Appendix B solves).

TRAINING INTENSITY DEFINITIONS: Jack Daniels, "Daniels' Running Formula",
4th ed. (Human Kinetics, 2021), chapter 4 (page references below are to that
edition):

  E (Easy): 59-74% VO2max; ~65-79% HRmax (ch.4: "typically an intensity
    about 59 to 74 percent of [VO2max] or about 65 to 79 percent of maximum
    heart rate"). Purpose (ch.4, Daniels' order): resistance to injury FIRST,
    then strengthening the heart muscle, vascularization, muscle-fibre
    adaptation. Duration: 30-min MINIMUM for any E run (ch.4).
    Long (L) run cap: <=30% of weekly mileage under 40 mi/wk; at 40+ mi/wk the
    lesser of 25% or 150 min (ch.4).
    E-pace rule of thumb ~2-3 min/mi slower than mile race pace (ch.4).

  M (Marathon-pace): 75-84% VO2max; ~80-89% HRmax (ch.4, citing figure 4.1).
    No duration cap stated in ch.4.

  T (Threshold): ~85-88% VO2max (88-92% HRmax) for well-trained athletes; "more
    like 80 to 86 percent values for lesser-trained runners" (ch.4).
    Checksum: T pace typically 6 s/400 slower than I pace -- the 6-second rule
    applies most accurately to better runners; the interval widens at VDOT
    40-50 (p.79). Ch.16 caps: T <= lesser of 10% weekly mileage and 15 mi,
    min 3 mi/session.

  I (Interval): NO numeric % range in ch.4; intensity stated qualitatively as
    "at or very close to [VO2max] (and maximum heart rate)" -- i.e. ~100%.
    This script therefore prints I pace at 100% of VDOT and labels it as the
    qualitative "at or very close to VO2max". Bout cap: individual work bouts
    no longer than 5 minutes; VDOT must be >=66 before I-pace MILES are
    appropriate (p.79). Table 5.2's I column is deliberately blank at low
    VDOT -- not missing data.

  R (Repetition): NOT given as a %VO2max in ch.4 -- only that R intensity
    "will always elicit maximum heart rate if you stay at that speed of
    running for a couple of minutes or longer". This script does NOT invent a
    %VO2max for R: it derives R pace as 6 s/400 FASTER than I pace (the
    6-second rule, same better-runners caveat as T). Bout cap: individual work
    bouts no longer than 2 minutes; VDOT ~77+ required before 800 m R bouts
    are appropriate (p.79).

GOLD ANCHORS (self-test) from Daniels & Gilbert (1979): p.3 reference VDOT 80.5
times (mile 3:49.9, 2 mi 8:11.5, 10 mi 45:26.7, 1500 m 3:33.0, 3000 m 7:35.0,
5000 m 13:13.5, 10000 m 27:32.5, marathon 2:06:57.5); Appendix B VDOT 60.5 ->
mile 4:55.0 and 60.4 -> 4:55.4; Appendix A worked example 10000 m in 38:46 ->
reference VO2 (VDOT) 53.9.

Usage:
    python vo2_pace_solver.py --dist 5k --time 22:30
    python vo2_pace_solver.py --dist 10mi --time 1:10:00
    python vo2_pace_solver.py --dist 1609.344 --time 4:55
    python vo2_pace_solver.py --vdot 53.5
    python vo2_pace_solver.py --self-test

--dist    race distance: meters (bare number or "8000m"), km ("8km" / "8k"),
          miles ("4mi" / "4miles"), or a name: 1500, mile, 3000, 2mi, 5k,
          10k, 15k, 10mi, half (21097.5 m), marathon (42195 m)
--time    race time: H:MM:SS, MM:SS, or decimal minutes (e.g. 38.77)
--vdot    skip the race input and use this VDOT directly (25-85)
--self-test  run built-in checks against the published gold anchors

Not calibrated for children/adolescents: Daniels & Gilbert (1979, Appendix A)
state a child's computed value underestimates true VO2max and improvement
during growth is largely running economy.
"""
import argparse
import math
import sys

MILE_KM = 1.609344
MILE_M = 1609.344
HALF_M = 21097.5       # half marathon = 21097.5 m
MARATHON_M = 42195.0   # marathon = 42195 m

# Supported named distances for equivalent-time predictions, in order.
DISTANCES = [
    ("1500m", 1500.0),
    ("mile", MILE_M),
    ("3000m", 3000.0),
    ("2mi", 2 * MILE_M),
    ("5000m", 5000.0),
    ("10000m", 10000.0),
    ("15k", 15000.0),
    ("10mi", 10 * MILE_M),
    ("half", HALF_M),
    ("marathon", MARATHON_M),
]

DIST_ALIASES = {
    "1500": 1500.0, "1500m": 1500.0,
    "mile": MILE_M, "1mi": MILE_M, "1600": 1600.0, "1600m": 1600.0,
    "3000": 3000.0, "3000m": 3000.0, "3k": 3000.0,
    "2mi": 2 * MILE_M, "2mile": 2 * MILE_M, "2miles": 2 * MILE_M,
    "5k": 5000.0, "5km": 5000.0, "5000": 5000.0, "5000m": 5000.0,
    "10k": 10000.0, "10km": 10000.0, "10000": 10000.0, "10000m": 10000.0,
    "15k": 15000.0, "15km": 15000.0, "15000": 15000.0, "15000m": 15000.0,
    "10mi": 10 * MILE_M, "10mile": 10 * MILE_M, "10miles": 10 * MILE_M,
    "half": HALF_M, "halfmarathon": HALF_M, "hm": HALF_M,
    "marathon": MARATHON_M, "mar": MARATHON_M, "full": MARATHON_M,
}
# Canonical race distances are reserved for the NAMES above; a numeric input such
# as "21.1k" is taken literally (21100 m), the same as "21.1km".

# Daniels' main pace table (Table 5.2) starts at VDOT 30; the novice table
# (5.3, VDOT 20-30) has no E column. Below this the E row is an extrapolation
# of the 59-74% band, and is labelled as such.
E_PACE_MIN_VDOT = 30.0

# %VO2max bands per Daniels' Running Formula, 4th ed., ch.4 (see docstring).
# (label, low fraction, high fraction). I is a point at 1.00 (qualitative
# "at or very close to VO2max"); R has NO %VO2max -- derived from I below.
PCT_BANDS = [
    ("E (Easy)", 0.59, 0.74),       # 59-74% VO2max (ch.4)
    ("M (Marathon-pace)", 0.75, 0.84),  # 75-84% VO2max (ch.4)
    ("T (Threshold)", 0.85, 0.88),  # 85-88% VO2max, well-trained (ch.4)
    ("I (Interval)", 1.00, 1.00),   # qualitative ~100% (ch.4: "at or very close to")
]

# Printed verbatim at the end of every pace/prediction run (not --self-test).
CAVEATS = """Sourced caveats (Daniels' Running Formula, 4th ed., ch. 4-5, unless noted):

1. VDOT entry requires a RECENT MAXIMAL race: Table 5.1's precondition is a race run "at 100% intensity"; a held-back or mid-injury race sets only a floor, not a measurement. Daniels' escape hatch is a time trial ("you're really just trying to get in the right ballpark"), itself still a maximal effort.

2. Training VDOT = honest CURRENT fitness, not the best race on record ("Daniels asks for a *recent* race"); adjusted between sessions, never mid-workout.

3. The method assumes ADEQUATE TRAINING at the target distance: do not read predictions more than 2-3 distances across Table 5.1 from the input race (a 5k time predicts a marathon only for a runner actually trained for the marathon distance). Note: this phrasing is a widely used practitioners' convention around the tables, not wording from the book itself.

4. Novices / low performers: main Table 5.2 starts at VDOT 30; Table 5.3 (p.84, "Training Intensities for Novice Runners", VDOT 20-30) issues R/I/T/M ONLY -- NO E column at all, so Daniels declines to prescribe an easy pace in that range.

5. Masters: Table 5.6 ("VDOT Levels for ... Runners Aged 18-80", pp. 90-91) age-grades 1,600 m times -- but the beyond-tested-age values are, "by the author's own admission", EXTRAPOLATION not measurement ("to go a little beyond the ages at which I have done tests, I have extrapolated").

6. Threshold %s themselves are training-status-dependent: 85-88% VO2max applies to well-trained athletes, 80-86% to lesser-trained (ch.4) -- the one place ch.4 itself conditions a band on training status.

Adult runners only. Not calibrated for children/adolescents: Daniels & Gilbert (1979, Appendix A) state a child's computed value underestimates true VO2max and improvement during growth is largely running economy."""


def vo2_at(v):
    """Oxygen cost (ml/kg/min) of running at v m/min. Daniels & Gilbert 1979, eq (1)."""
    return -4.60 + 0.182258 * v + 0.000104 * v * v


def vel_at(vo2):
    """Velocity (m/min) at a given VO2. Daniels & Gilbert 1979, eq (2), fitted inverse."""
    return 29.54 + 5.000663 * vo2 - 0.007546 * vo2 * vo2


def pct_max(t):
    """Fraction of VO2max sustainable for t minutes. Daniels & Gilbert 1979, eq (3)."""
    return 0.8 + 0.1894393 * math.exp(-0.012778 * t) + 0.2989558 * math.exp(-0.1932605 * t)


def vdot_from_race(dist_m, t_min):
    """VDOT from a race: VO2(d/t) / pct(t). Daniels & Gilbert 1979, Appendix A."""
    if not 0.5 <= t_min <= 1000:
        raise ValueError(f"race time {t_min!r} min is outside 0.5-1000 minutes; check the input")
    v = vdot_raw(dist_m, t_min)
    if not 20 <= v <= 90:
        raise ValueError(f"computed VDOT {v:.1f} is outside 20-90; check distance/time "
                         f"({dist_m:.0f} m in {t_min:.2f} min)")
    return v


def vdot_raw(dist_m, t_min):
    return vo2_at(dist_m / t_min) / pct_max(t_min)


def time_for(dist_m, vdot):
    """Race time (min) at dist_m for a VDOT: solves VO2(d/t)/pct(t) = VDOT.

    Appendix B of Daniels & Gilbert 1979 uses Newton-Raphson on this identity;
    here a bracketing bisection is used -- vdot_raw(d, t) is monotone
    decreasing in t over [0.5, 1000] for every supported distance, so the
    bracket is safe for VDOT 25-85 at all of them.
    """
    lo, hi = 0.5, 1000.0
    if not (vdot_raw(dist_m, lo) > vdot > vdot_raw(dist_m, hi)):
        raise ValueError(f"VDOT {vdot!r} is outside the solvable bracket at {dist_m:.0f} m")
    for _ in range(100):
        mid = (lo + hi) / 2
        if vdot_raw(dist_m, mid) > vdot:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def parse_time(s):
    """Race time -> minutes (float). Accepts H:MM:SS, MM:SS, or decimal minutes."""
    if not s.isascii():
        raise ValueError(f"time must use ASCII digits, got {ascii(s)}")
    s = s.strip()
    if ":" in s:
        parts = s.split(":")
        if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts):
            raise ValueError(f"time must be H:MM:SS, MM:SS, or decimal minutes, got {s!r}")
        if any(len(p) > 4 for p in parts):
            raise ValueError(f"time field too long in {s!r}; the largest valid race time is well under 1000 minutes")
        if int(parts[-1]) >= 60 or (len(parts) == 3 and int(parts[1]) >= 60):
            raise ValueError(f"minutes/seconds fields must be < 60 in {s!r}")
        secs = 0
        for p in parts:
            secs = secs * 60 + int(p)
        return secs / 60.0
    try:
        t = float(s)
    except ValueError:
        raise ValueError(f"time must be H:MM:SS, MM:SS, or decimal minutes, got {s!r}")
    if t <= 0:
        raise ValueError(f"decimal-minutes time must be positive, got {s!r}")
    return t


def parse_dist(s):
    """Race distance -> meters. Named distances, or a number with m/km/k/mi suffix (bare = meters)."""
    if not s.isascii():
        raise ValueError(f"distance must use ASCII characters, got {ascii(s)}")
    key = s.strip().lower().replace(" ", "")
    if key.startswith("-"):
        raise ValueError(f"distance {s!r} is negative; distances must be positive")
    # Hyphens are a lookup convenience for purely textual names ('half-marathon')
    # and are never stripped from anything containing a digit, so a leading minus
    # or a malformed number ('1-0k') is rejected rather than silently repaired.
    alias = key.replace("-", "") if key.replace("-", "").isalpha() else key
    if alias in DIST_ALIASES:
        return DIST_ALIASES[alias]
    num, unit = key, "m"
    for suffix, u in (("miles", "mi"), ("mile", "mi"), ("mi", "mi"), ("km", "km"),
                      ("k", "km"), ("m", "m")):
        if key.endswith(suffix):
            num, unit = key[: -len(suffix)], u
            break
    try:
        val = float(num)
    except ValueError:
        raise ValueError(f"distance {s!r} not understood; use meters, km ('8k'), miles ('4mi'), "
                         f"or a name (mile, 5k, 10k, 15k, half, marathon)")
    meters = val * {"m": 1.0, "km": 1000.0, "mi": MILE_M}[unit]
    if not 800 <= meters <= 100000:
        raise ValueError(f"distance {s!r} = {meters:.0f} m is outside 800-100000 m; check the input")
    return meters


def fmt_pace(secs):
    """M:SS with zero-padded seconds."""
    secs = round(secs)
    return f"{secs // 60}:{secs % 60:02d}"


def fmt_race(t_min):
    """Race time: H:MM:SS over an hour, else M:SS.s with tenths (matching the primary's style)."""
    secs = t_min * 60.0
    if round(secs, 1) >= 3600:
        total = round(secs)  # one rounding, from the raw value, at whole-second precision
        return f"{total // 3600}:{(total % 3600) // 60:02d}:{total % 60:02d}"
    total = round(secs, 1)
    return f"{int(total // 60)}:{total % 60:04.1f}"


def pace_secs(vdot, frac):
    """Seconds per mile and per km at frac * VDOT, via eq (2)."""
    v = vel_at(frac * vdot)  # m/min
    per_mile = MILE_M / v * 60.0
    return per_mile, per_mile / MILE_KM


def training_paces(vdot):
    """Rows: (label, (mi_slow, mi_fast) or point, (km_slow, km_fast) or point)."""
    rows = []
    for label, lo, hi in PCT_BANDS:
        mi_slow, km_slow = pace_secs(vdot, lo)
        mi_fast, km_fast = pace_secs(vdot, hi)
        rows.append((label, (mi_slow, mi_fast), (km_slow, km_fast)))
    # R: no %VO2max in ch.4; 6 s/400 FASTER than I (6-second rule, p.79).
    i_mi = rows[-1][1][0]
    r_mi = i_mi - 6.0 * (MILE_M / 400.0)   # 24.14 s/mi faster
    rows.append(("R (Repetition)", (r_mi, r_mi), (r_mi / MILE_KM, r_mi / MILE_KM)))
    return rows


def render(vdot, race=None):
    """race = (dist_m, t_min, dist_label) when VDOT came from a race input."""
    if not 25 <= vdot <= 85:
        raise ValueError(f"VDOT {vdot!r} is outside 25-85; this tool's solver is only "
                         f"verified in that range")
    out = []
    if race:
        d, t, label = race
        out.append(f"Race {label} ({d:.0f} m) in {fmt_race(t)}  ->  VDOT {vdot:.1f}")
    else:
        out.append(f"VDOT {vdot:.1f} (entered directly -- see caveats 1-2 on what a valid input is)")
    out.append("")
    out.append("Training paces (Daniels & Gilbert 1979 eqs; %VO2max bands per Daniels' Running Formula 4th ed. ch.4)")
    notes = {
        "E (Easy)": "59-74% VO2max; 30-min minimum per run; L run capped (see docstring)",
        "M (Marathon-pace)": "75-84% VO2max; no duration cap stated in ch.4",
        "T (Threshold)": "85-88% VO2max WELL-TRAINED; lesser-trained more like 80-86% (ch.4)",
        "I (Interval)": "no numeric % in ch.4: 'at or very close to' VO2max; bouts <= 5 min",
        "R (Repetition)": "no %VO2max given: 6 s/400 faster than I (p.79 rule); bouts <= 2 min",
    }
    for label, mi, km in training_paces(vdot):
        if abs(mi[0] - mi[1]) < 0.5:  # point value (I, R)
            out.append(f"  {label:<19} {fmt_pace(mi[0])}/mi          {fmt_pace(km[0])}/km")
        else:
            out.append(f"  {label:<19} {fmt_pace(mi[0])}-{fmt_pace(mi[1])}/mi     "
                       f"{fmt_pace(km[0])}-{fmt_pace(km[1])}/km")
        if label.startswith("E") and vdot < E_PACE_MIN_VDOT:
            out.append(f"  {'':<19} EXTRAPOLATION: Daniels prescribes NO easy pace below VDOT "
                       f"{E_PACE_MIN_VDOT:.0f} (Table 5.3 has no E column; see caveat 4) -- "
                       f"this row is the 59-74% band extended by this tool, not a published value")
        out.append(f"  {'':<19} {notes[label]}")
    out.append("")
    out.append("Equivalent race times at this VDOT (Appendix B identity, bisection solver)")
    for name, d in DISTANCES:
        out.append(f"  {name:<10} {fmt_race(time_for(d, vdot)):>10}")
    out.append("")
    out.append(CAVEATS)
    return "\n".join(out)


def self_test():
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        fails += not ok
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}{detail}")

    # Gold anchors, Daniels & Gilbert 1979 p.3, reference VDOT 80.5 (tol 0.5%)
    anchors = [
        ("mile", MILE_M, 3 + 49.9 / 60),
        ("2mi", 2 * MILE_M, 8 + 11.5 / 60),
        ("10mi", 10 * MILE_M, 45 + 26.7 / 60),
        ("1500m", 1500.0, 3 + 33.0 / 60),
        ("3000m", 3000.0, 7 + 35.0 / 60),
        ("5000m", 5000.0, 13 + 13.5 / 60),
        ("10000m", 10000.0, 27 + 32.5 / 60),
        ("marathon", MARATHON_M, 126 + 57.5 / 60),
    ]
    for name, d, want in anchors:
        got = time_for(d, 80.5)
        err = abs(got - want) / want
        check(f"VDOT 80.5 {name}: {fmt_race(got)} vs {fmt_race(want)}",
              err < 0.005, f" (err {err * 100:.3f}%)")
    # Appendix B: VDOT 60.5 -> mile 4:55.0; 60.4 -> 4:55.4 (tol 0.5%)
    for vd, want in ((60.5, 4 + 55.0 / 60), (60.4, 4 + 55.4 / 60)):
        got = time_for(MILE_M, vd)
        err = abs(got - want) / want
        check(f"VDOT {vd} mile: {fmt_race(got)} vs {fmt_race(want)}",
              err < 0.005, f" (err {err * 100:.3f}%)")
    # Appendix A worked example: 10000 m in 38:46 -> VDOT 53.9 (tol 0.15)
    got = vdot_from_race(10000.0, 38 + 46 / 60)
    check(f"10000m 38:46 -> VDOT {got:.2f} vs 53.9", abs(got - 53.9) < 0.15)
    # Round-trip: race -> VDOT -> predicted time at same distance, within 0.1%
    for d, t in ((5000.0, 22.5), (MARATHON_M, 210.0), (MILE_M, 5.5), (10000.0, 55.0)):
        back = time_for(d, vdot_from_race(d, t))
        err = abs(back - t) / t
        check(f"round-trip {d:.0f} m @ {t} min", err < 0.001, f" (err {err * 100:.4f}%)")
    # Solver convergence across the required envelope: VDOT 25-85, every distance
    conv = True
    for vd in range(25, 86, 5):
        for _, d in DISTANCES:
            t = time_for(d, float(vd))
            if abs(vdot_raw(d, t) - vd) > 0.001:
                conv = False
    check("solver converges, VDOT 25-85 x all 10 distances", conv)
    # Parsers
    check("parse_time 1:45:00 = 105 min", parse_time("1:45:00") == 105.0)
    check("parse_time 22:30 = 22.5 min", parse_time("22:30") == 22.5)
    check("parse_time 38.77 decimal", abs(parse_time("38.77") - 38.77) < 1e-9)
    check("parse_dist half = 21097.5", parse_dist("half") == 21097.5)
    check("parse_dist marathon = 42195", parse_dist("marathon") == 42195.0)
    check("parse_dist 8k = 8000", parse_dist("8k") == 8000.0)
    check("parse_dist 4mi", abs(parse_dist("4mi") - 4 * MILE_M) < 1e-9)
    check("parse_dist 5000 bare meters", parse_dist("5000") == 5000.0)
    check("parse_dist 21.1k literal = 21100 (not the half alias)", parse_dist("21.1k") == 21100.0)
    check("parse_dist 21.1k == 21.1km", parse_dist("21.1k") == parse_dist("21.1km"))
    check("parse_dist half-marathon hyphen alias", parse_dist("half-marathon") == HALF_M)
    for bad in ["5:xx", "0", "-3", "4:75", "9" * 400 + ":00", "1:5:3:0", chr(0xFF15) + ":00"]:
        try:
            parse_time(bad)
            check(f"reject time {ascii(bad)[:24]}", False)
        except ValueError:
            check(f"reject time {ascii(bad)[:24]}", True)
    for bad in ["500", "200000", "fast", "-5k", "-5000", "1-0k", "1-500", chr(0xFF15) + "k"]:
        try:
            parse_dist(bad)
            check(f"reject dist {ascii(bad)}", False)
        except ValueError:
            check(f"reject dist {ascii(bad)}", True)
    # Formatting: the sub-hour/over-hour switch happens after rounding
    check("fmt_race 59:59.96 -> 1:00:00", fmt_race(59.99933) == "1:00:00")
    check("fmt_race 59:59.9 stays M:SS.s", fmt_race(59 + 59.9 / 60) == "59:59.9")
    check("fmt_race over-hour rounds once (3659.49 s -> 1:00:59)", fmt_race(3659.49 / 60) == "1:00:59")
    check("fmt_race over-hour rounds once (3658.51 s -> 1:00:59)", fmt_race(3658.51 / 60) == "1:00:59")
    for ws in (chr(0xA0) + "22.5", "22.5" + chr(0x2003)):
        try:
            parse_time(ws)
            check(f"reject time with unicode whitespace {ascii(ws)}", False)
        except ValueError:
            check(f"reject time with unicode whitespace {ascii(ws)}", True)
    # Output sanity: caveats present, R has no invented %VO2max, E labelled below VDOT 30
    txt = render(53.5)
    check("caveats footer printed", "Sourced caveats" in txt)
    check("adult-runners line printed", "Adult runners only" in txt)
    check("R carries no %VO2max claim", "no %VO2max given" in txt)
    e_label = "EXTRAPOLATION: Daniels prescribes NO easy pace"
    check("E row unlabelled at VDOT 53.5", e_label not in txt)
    check("E row labelled EXTRAPOLATION at VDOT 27", e_label in render(27.0))
    check("render output is ASCII", render(27.0).isascii() and txt.isascii())
    print("GREEN" if not fails else f"RED -- {fails} failure(s)")
    return 1 if fails else 0


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Jack Daniels VDOT from a race (Daniels & Gilbert 1979): "
                    "training paces + equivalent race times.")
    ap.add_argument("--dist", help="race distance: meters, km ('8k'), miles ('4mi'), "
                                   "or mile/5k/10k/15k/half/marathon")
    ap.add_argument("--time", help="race time: H:MM:SS, MM:SS, or decimal minutes")
    ap.add_argument("--vdot", type=float, help="use this VDOT directly (25-85), skipping the race input")
    ap.add_argument("--self-test", action="store_true", help="run built-in checks")
    a = ap.parse_args(argv)
    if a.self_test:
        return self_test()
    try:
        if a.vdot is not None:
            if a.dist or a.time:
                ap.error("give either --vdot or --dist/--time, not both")
            print(render(a.vdot))
        else:
            if not (a.dist and a.time):
                ap.error("--dist and --time are required together (or --vdot, or --self-test)")
            d = parse_dist(a.dist)
            t = parse_time(a.time)
            print(render(vdot_from_race(d, t), race=(d, t, a.dist)))
    except (ValueError, OverflowError) as e:
        ap.error(str(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
