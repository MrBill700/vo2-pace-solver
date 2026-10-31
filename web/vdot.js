/* vdot.js -- race -> VDOT -> training paces + equivalent race times.
 *
 * Line-for-line port of vo2_pace_solver.py (https://github.com/MrBill700/vo2-pace-solver,
 * MIT). That file is the source of truth for the math, the gold anchors and the caveat
 * wording; keep the two in step. Pure: no DOM, no network, no storage.
 *
 * Browser:  <script src="vdot.js"></script> defines window.VDOT.
 * Node:     node vdot.js --self-test
 *           node vdot.js --dist 5k --time 22:30     (same text as the Python CLI)
 *           node vdot.js --vdot 53.5
 *
 * Equations (Daniels & Gilbert 1979, Appendix A), v in m/min, t in minutes:
 *   (1) VO2(v) = -4.60 + 0.182258*v + 0.000104*v^2
 *   (2) v(VO2) = 29.54 + 5.000663*VO2 - 0.007546*VO2^2
 *   (3) pct(t) = 0.8 + 0.1894393*exp(-0.012778*t) + 0.2989558*exp(-0.1932605*t)
 *   VDOT from a race of d m in t min: VO2(d/t) / pct(t)
 *   Equivalent time at d2: solve VO2(d2/t2)/pct(t2) = VDOT for t2 (bisection on [0.5, 1000]).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.VDOT = factory(); }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MILE_KM = 1.609344;
  const MILE_M = 1609.344;
  const HALF_M = 21097.5;       // half marathon = 21097.5 m
  const MARATHON_M = 42195.0;   // marathon = 42195 m

  // Supported named distances for equivalent-time predictions, in the published order.
  const DISTANCES = [
    ["1500m", 1500.0],
    ["mile", MILE_M],
    ["3000m", 3000.0],
    ["2mi", 2 * MILE_M],
    ["5000m", 5000.0],
    ["10000m", 10000.0],
    ["15k", 15000.0],
    ["10mi", 10 * MILE_M],
    ["half", HALF_M],
    ["marathon", MARATHON_M]
  ];

  const DIST_ALIASES = {
    "1500": 1500.0, "1500m": 1500.0,
    "mile": MILE_M, "1mi": MILE_M, "1600": 1600.0, "1600m": 1600.0,
    "3000": 3000.0, "3000m": 3000.0, "3k": 3000.0,
    "2mi": 2 * MILE_M, "2mile": 2 * MILE_M, "2miles": 2 * MILE_M,
    "5k": 5000.0, "5km": 5000.0, "5000": 5000.0, "5000m": 5000.0,
    "10k": 10000.0, "10km": 10000.0, "10000": 10000.0, "10000m": 10000.0,
    "15k": 15000.0, "15km": 15000.0, "15000": 15000.0, "15000m": 15000.0,
    "10mi": 10 * MILE_M, "10mile": 10 * MILE_M, "10miles": 10 * MILE_M,
    "half": HALF_M, "halfmarathon": HALF_M, "hm": HALF_M,
    "marathon": MARATHON_M, "mar": MARATHON_M, "full": MARATHON_M
  };
  // Canonical race distances are reserved for the NAMES above; a numeric input such
  // as "21.1k" is taken literally (21100 m), the same as "21.1km".

  // Daniels' main pace table (Table 5.2) starts at VDOT 30; the novice table
  // (5.3, VDOT 20-30) has no E column. Below this the E row is an extrapolation
  // of the 59-74% band, and is labelled as such.
  const E_PACE_MIN_VDOT = 30.0;

  // %VO2max bands per Daniels' Running Formula, 4th ed., ch.4.
  // [label, low fraction, high fraction]. I is a point at 1.00 (qualitative
  // "at or very close to VO2max"); R has NO %VO2max -- derived from I below.
  const PCT_BANDS = [
    ["E (Easy)", 0.59, 0.74],
    ["M (Marathon-pace)", 0.75, 0.84],
    ["T (Threshold)", 0.85, 0.88],
    ["I (Interval)", 1.00, 1.00]
  ];

  const BAND_NOTES = {
    "E (Easy)": "59-74% VO2max; 30-min minimum per run; L run capped (see docstring)",
    "M (Marathon-pace)": "75-84% VO2max; no duration cap stated in ch.4",
    "T (Threshold)": "85-88% VO2max WELL-TRAINED; lesser-trained more like 80-86% (ch.4)",
    "I (Interval)": "no numeric % in ch.4: 'at or very close to' VO2max; bouts <= 5 min",
    "R (Repetition)": "no %VO2max given: 6 s/400 faster than I (p.79 rule); bouts <= 2 min"
  };

  // Verbatim from the Python CAVEATS block.
  const CAVEATS = [
    "Sourced caveats (Daniels' Running Formula, 4th ed., ch. 4-5, unless noted):",
    "",
    "1. VDOT entry requires a RECENT MAXIMAL race: Table 5.1's precondition is a race run \"at 100% intensity\"; a held-back or mid-injury race sets only a floor, not a measurement. Daniels' escape hatch is a time trial (\"you're really just trying to get in the right ballpark\"), itself still a maximal effort.",
    "",
    "2. Training VDOT = honest CURRENT fitness, not the best race on record (\"Daniels asks for a *recent* race\"); adjusted between sessions, never mid-workout.",
    "",
    "3. The method assumes ADEQUATE TRAINING at the target distance: do not read predictions more than 2-3 distances across Table 5.1 from the input race (a 5k time predicts a marathon only for a runner actually trained for the marathon distance). Note: this phrasing is a widely used practitioners' convention around the tables, not wording from the book itself.",
    "",
    "4. Novices / low performers: main Table 5.2 starts at VDOT 30; Table 5.3 (p.84, \"Training Intensities for Novice Runners\", VDOT 20-30) issues R/I/T/M ONLY -- NO E column at all, so Daniels declines to prescribe an easy pace in that range.",
    "",
    "5. Masters: Table 5.6 (\"VDOT Levels for ... Runners Aged 18-80\", pp. 90-91) age-grades 1,600 m times -- but the beyond-tested-age values are, \"by the author's own admission\", EXTRAPOLATION not measurement (\"to go a little beyond the ages at which I have done tests, I have extrapolated\").",
    "",
    "6. Threshold %s themselves are training-status-dependent: 85-88% VO2max applies to well-trained athletes, 80-86% to lesser-trained (ch.4) -- the one place ch.4 itself conditions a band on training status.",
    "",
    "Adult runners only. Not calibrated for children/adolescents: Daniels & Gilbert (1979, Appendix A) state a child's computed value underestimates true VO2max and improvement during growth is largely running economy."
  ].join("\n");

  // Widget rule (not in the Python): a prediction more than this many columns from the
  // input race in DISTANCES order is flagged as an extrapolation.
  const EXTRAPOLATION_COLUMNS = 3;

  // ---- Youth levels (widget-only; no Python counterpart) ----------------------------
  // Daniels' Running Formula, 4th ed., ch. 5, Table 5.5 "VDOT Levels for Male and Female
  // Runners Aged 6-18 for 1,600-Meter Times" (table credited to the Run SMART Project
  // calculator). Ten performance levels: Novice 1-2, Intermediate 3-5, Good 6-8, Elite
  // 9-10. The age-18 row is the 18-38 reference band of Table 5.6. Each entry is the VDOT
  // at that level, index 0 = level 1; null where the book prints a dash ("no time
  // needed"): Daniels stops each young age's row early on purpose -- "I want to avoid
  // encouraging very young runners to work too hard" -- and this port keeps the cut-off.
  // He also states the under-18 values are partly extrapolated from the ages he tested.
  // Transcribed 2026-10-30 from the epub; every value solves back to the printed 1,600 m
  // time within 1.5 s at VDOT >= 24 (the calculator and eq (1)-(3) diverge smoothly
  // below that, up to 10 s at VDOT 16).
  const YOUTH_LEVELS = {
    18: { M: [35.0, 40.3, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0],
          F: [31.4, 35.8, 40.2, 44.7, 49.1, 53.6, 58.1, 62.5, 67.0, 71.4] },
    17: { M: [33.5, 38.4, 43.3, 48.2, 53.1, 58.0, 62.9, 67.7, 72.5, 77.3],
          F: [30.2, 34.6, 38.9, 43.2, 47.5, 51.8, 56.1, 60.4, 64.7, 69.0] },
    16: { M: [32.0, 36.8, 41.5, 46.2, 50.9, 55.6, 60.3, 65.0, 69.7, 74.4],
          F: [29.0, 33.3, 37.5, 41.7, 45.9, 50.1, 54.3, 58.5, 62.7, 66.9] },
    15: { M: [30.5, 35.1, 39.7, 44.3, 48.9, 53.4, 57.9, 62.4, 66.9, 71.4],
          F: [27.8, 31.9, 36.0, 40.1, 44.2, 48.3, 52.4, 56.5, 60.6, 64.7] },
    14: { M: [28.9, 33.3, 37.7, 42.1, 46.5, 50.9, 55.3, 59.7, 64.0, 68.3],
          F: [26.5, 30.5, 34.5, 38.5, 42.5, 46.5, 50.5, 54.5, 58.5, 62.4] },
    13: { M: [27.3, 31.5, 35.7, 39.9, 44.1, 48.3, 52.5, 56.7, 60.9, null],
          F: [25.2, 29.1, 33.0, 36.9, 40.8, 44.7, 48.6, 52.4, 56.2, null] },
    12: { M: [25.7, 29.8, 33.8, 37.8, 41.8, 45.8, 49.8, 53.8, null, null],
          F: [23.9, 27.7, 31.5, 35.3, 39.0, 42.7, 46.4, 50.1, null, null] },
    11: { M: [24.1, 28.0, 31.8, 35.6, 39.4, 43.2, 47.0, null, null, null],
          F: [22.6, 26.2, 29.8, 33.4, 37.0, 40.6, 44.2, null, null, null] },
    10: { M: [22.5, 26.2, 29.8, 33.4, 37.0, 40.6, null, null, null, null],
          F: [21.3, 24.8, 28.3, 31.8, 35.2, 38.6, null, null, null, null] },
    9:  { M: [20.9, 24.3, 27.7, 31.1, 34.5, null, null, null, null, null],
          F: [20.0, 23.3, 26.6, 29.9, 33.2, null, null, null, null, null] },
    8:  { M: [19.3, 22.5, 25.7, 28.9, null, null, null, null, null, null],
          F: [18.7, 21.8, 24.9, 28.0, null, null, null, null, null, null] },
    7:  { M: [17.7, 20.7, 23.6, null, null, null, null, null, null, null],
          F: [17.4, 20.3, 23.2, null, null, null, null, null, null, null] },
    6:  { M: [16.1, 18.8, null, null, null, null, null, null, null, null],
          F: [16.1, 18.8, null, null, null, null, null, null, null, null] }
  };
  const YOUTH_AGE_MIN = 6;
  const YOUTH_AGE_MAX = 17;     // 18 and up is the adult reference row
  const YOUTH_ADULT_ROW = 18;
  const YOUTH_1600_M = 1600.0;
  const YOUTH_CATEGORIES = [[1, "Novice"], [3, "Intermediate"], [6, "Good"], [9, "Elite"]];
  const YOUTH_QUOTE = "I want to avoid encouraging very young runners to work too hard.";
  const YOUTH_PACE_NOTE = "Daniels publishes no training-pace table for ages 6-17; these rows are the adult " +
    "ch. 4 bands applied to this race, and Daniels & Gilbert (1979) warn that a child's computed value " +
    "underestimates true VO2max. Practice targets for a coach's judgment, not prescriptions.";

  // ---- Season plans (widget only; the Python CLI has none) ------------------------
  // Two Daniels plans a youth coach uses outside the racing season, kept in the minutes
  // Daniels wrote them in. The only per-athlete arithmetic is the E pace from VDOT, which
  // turns each session's running minutes into an expected distance.
  //
  // Daniels' Running Formula 4th ed., ch. 14 "Cross Country", Table 14.1 -- Phase I
  // Training Plan for Cross Country (print p. 217). Daniels: complete phases I and II
  // "during the summer, before the start of school in the fall"; Table 14.1 "can be
  // shortened if 6 weeks are not available, but for relative beginners should be used
  // for at least 3 or 4 weeks." Runners "who haven't been doing much running lately, or
  // who are relative beginners" take white Phase IV (below) as their phase I instead.
  const XC_PRESEASON_WEEKS = 6;
  const XC_PRESEASON = [
    { weeks: [1, 3], days: [
      ["Sunday", "L run of the lesser of 60 min and 30% of week's total mileage", 60],
      ["Mon, Tue, Thu, Fri", "E day of about 30 min", 30],
      ["Wed, Sat", "30-40 min E + 6 ST", 35]
    ] },
    { weeks: [4, 6], days: [
      ["Sunday", "L run of the lesser of 60 min and 30% of week's total mileage", 60],
      ["Mon, Tue, Fri", "E day of about 30-40 min", 35],
      ["Wed, Thu, Sat", "20 min E + 8 ST + 10 min E", 30]
    ] }
  ];
  // Running minutes in a full seven-day Table 14.1 week (L counted at its 60-min cap;
  // "30-40 min" counted at 35). Used only for the weekly-distance estimate.
  const XC_PRESEASON_WEEK_MIN = [60 + 4 * 30 + 2 * 35, 60 + 3 * 35 + 3 * 30];
  const XC_L_RULE = "L run: the lesser of 60 min and 30% of the week's total mileage; no single day over 25% of the week; " +
    "at least 30 min of E running on the other days (Daniels ch. 14, Phase I).";

  // Ch. 8 "Fitness Training", Table 8.1 -- the White starting plan (print pp. 125-126).
  // Walk/run in minutes, no quality work, strides from Phase IV. Rows are Daniels' seven
  // days; the bold "minimum participation" days are 1, 3 and 5 (p. 124). runMin excludes
  // walking; totalMin is the whole session. Phase IV minutes are the book's "about" values.
  const WHITE_PLAN = [
    { phase: 1, weeks: [1, 4], days: [
      [1, "5 min W + 10 x 1 min E w/1 min W recoveries + 5 min W", 10, 30, true],
      [2, "If you train today, repeat day 1 workout", 10, 30, false],
      [3, "5 min W + 7 x 2 min E w/1 min W recoveries + 4 min W", 14, 30, true],
      [4, "If you train today, repeat day 3 workout", 14, 30, false],
      [5, "5 min W + 6 x 1 min E w/30 sec W + 8 x 30 sec E w/1 min W + 4 min W", 10, 30, true],
      [6, "If you train today, repeat day 5 workout", 10, 30, false],
      [7, "If you train today, repeat day 1 workout", 10, 30, false]
    ] },
    { phase: 2, weeks: [5, 8], days: [
      [1, "3 min E + 3 min W + 10 x 2 min E w/1 min W recoveries + 4 min W", 23, 40, true],
      [2, "If you train today, repeat day 1 workout", 23, 40, false],
      [3, "3 min E + 3 min W + 6 x 3 min E w/2 min W recoveries + 4 min W", 21, 40, true],
      [4, "If you train today, repeat day 3 workout", 21, 40, false],
      [5, "3 min E + 3 min W + 20 x 1 min E w/30 sec W recoveries + 4 min W", 23, 40, true],
      [6, "If you train today, repeat day 5 workout", 23, 40, false],
      [7, "If you train today, repeat day 1 workout", 23, 40, false]
    ] },
    { phase: 3, weeks: [9, 12], days: [
      [1, "10 min E + 3 min W + 10 min E + 3 min W + 10 min E + 4 min W", 30, 40, true],
      [2, "If you train today, repeat day 1 workout", 30, 40, false],
      [3, "2 min W + 4 x 8 min E w/1 min W recoveries + 2 min W", 32, 40, true],
      [4, "If you train today, repeat day 3 workout", 32, 40, false],
      [5, "5 min W + 20 min E + 5 min W + 10 min E + 5 min W", 30, 45, true],
      [6, "Day 5 session can be done on either day 5, day 6, or both", 30, 45, false],
      [7, "If you train today, make it a 30 min W", 0, 30, false]
    ] },
    { phase: 4, weeks: [13, 16], days: [
      [1, "30 min E + 6 ST + 6 min E", 38, 44, true],
      [2, "If you train today, repeat day 1 workout", 38, 44, false],
      [3, "10 min E + 5 ST + 10 min E + 5 ST + 10 min E", 33, 43, true],
      [4, "If you train today, repeat day 3 workout", 33, 43, false],
      [5, "Repeat day 1 workout", 38, 44, true],
      [6, "Day 5 session can be done on either day 5, day 6, or both", 38, 44, false],
      [7, "If you train today, make it a 30 min W", 0, 30, false]
    ] }
  ];
  const WHITE_PLAN_WEEKS = 16;
  const WHITE_PLAN_NOTE = "Daniels' white plan (ch. 8, Table 8.1): 16 weeks of walk/run in minutes, no quality work, " +
    "strides from Phase IV. Days 1, 3 and 5 are the minimum; a 30-min walk is a fine day 7. Hold each phase four weeks.";
  const STRIDES_DEF = "ST = strides: light, quick 15- to 20-second runs (not sprints) with 45 to 60 seconds of rest " +
    "between each (Daniels, ch. 8).";
  const PLAN_SCOPE_NOTE = "Both plans are written for high school and older; Daniels addresses no one younger. The minutes " +
    "are his, the distances are this runner's E pace applied to them. A coach's judgment decides how much of a week a child runs.";

  class ValueError extends Error {
    constructor(message) { super(message); this.name = "ValueError"; }
  }

  // ---- Python-compatible helpers --------------------------------------------------

  function isAscii(s) {
    for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) > 127) return false; }
    return true;
  }

  function hex(n, width) { return n.toString(16).padStart(width, "0"); }

  // Python ascii(s): repr with every non-ASCII character escaped.
  function pyAscii(s) {
    const q = (s.includes("'") && !s.includes("\"")) ? "\"" : "'";
    let out = q;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === "\\") out += "\\\\";
      else if (ch === q) out += "\\" + q;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (c < 0x20 || c === 0x7f) out += "\\x" + hex(c, 2);
      else if (c < 0x7f) out += ch;
      else if (c < 0x100) out += "\\x" + hex(c, 2);
      else if (c < 0x10000) out += "\\u" + hex(c, 4);
      else out += "\\U" + hex(c, 8);
    }
    return out + q;
  }

  // What str.strip() removes from ASCII text (space, \t \n \r \v \f, \x1c-\x1f).
  const PY_WS = " \t\n\r" + String.fromCharCode(11, 12, 28, 29, 30, 31);
  function pyStrip(s) {
    let a = 0, b = s.length;
    while (a < b && PY_WS.includes(s[a])) a++;
    while (b > a && PY_WS.includes(s[b - 1])) b--;
    return s.slice(a, b);
  }

  // Python float(s) on an already-stripped ASCII string; null where Python raises.
  function pyFloat(s) {
    if (/^[+-]?(inf|infinity|nan)$/i.test(s)) {
      if (/nan$/i.test(s)) return NaN;
      return s[0] === "-" ? -Infinity : Infinity;
    }
    if (!/^[+-]?(\d(_?\d)*)?(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?$/.test(s)) return null;
    if (!/\d/.test(s.split(/[eE]/)[0])) return null;
    return Number(s.replace(/_/g, ""));
  }

  // Python's f"{x:.nf}" / round(x, n): correctly rounded from the exact binary value,
  // ties to even. An exact tie at n decimals exists iff x * 2^(n+1) is an odd integer;
  // everywhere else toFixed (also exact) agrees.
  function pyFixed(x, n) {
    const q = x * Math.pow(2, n + 1);
    if (Number.isInteger(q) && Math.abs(q % 2) === 1) {
      const scale = Math.pow(10, n);
      const m = Math.floor(x * scale);
      const keep = (m % 2 === 0) ? m : m + 1;
      return (keep / scale).toFixed(n);
    }
    return x.toFixed(n);
  }
  function pyRound(x, n) { return Number(pyFixed(x, n)); }

  // Python str() of a float for the self-test labels (210.0 stays "210.0").
  function pyFloatStr(x) {
    if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
    return String(x);
  }

  // ---- The solver -------------------------------------------------------------------

  function vo2At(v) {
    // Oxygen cost (ml/kg/min) of running at v m/min. Daniels & Gilbert 1979, eq (1).
    return -4.60 + 0.182258 * v + 0.000104 * v * v;
  }

  function velAt(vo2) {
    // Velocity (m/min) at a given VO2. Daniels & Gilbert 1979, eq (2), fitted inverse.
    return 29.54 + 5.000663 * vo2 - 0.007546 * vo2 * vo2;
  }

  function pctMax(t) {
    // Fraction of VO2max sustainable for t minutes. Daniels & Gilbert 1979, eq (3).
    return 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
  }

  function vdotRaw(distM, tMin) {
    return vo2At(distM / tMin) / pctMax(tMin);
  }

  function vdotFromRace(distM, tMin) {
    // VDOT from a race: VO2(d/t) / pct(t). Daniels & Gilbert 1979, Appendix A.
    if (!(0.5 <= tMin && tMin <= 1000)) {
      throw new ValueError("race time " + String(tMin) + " min is outside 0.5-1000 minutes; check the input");
    }
    const v = vdotRaw(distM, tMin);
    if (!(20 <= v && v <= 90)) {
      throw new ValueError("computed VDOT " + pyFixed(v, 1) + " is outside 20-90; check distance/time (" +
        pyFixed(distM, 0) + " m in " + pyFixed(tMin, 2) + " min)");
    }
    return v;
  }

  function timeFor(distM, vdot) {
    // Race time (min) at distM for a VDOT: solves VO2(d/t)/pct(t) = VDOT by bisection;
    // vdotRaw(d, t) is monotone decreasing in t over [0.5, 1000] for every supported distance.
    let lo = 0.5, hi = 1000.0;
    if (!(vdotRaw(distM, lo) > vdot && vdot > vdotRaw(distM, hi))) {
      throw new ValueError("VDOT " + String(vdot) + " is outside the solvable bracket at " + pyFixed(distM, 0) + " m");
    }
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (vdotRaw(distM, mid) > vdot) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function parseTime(s) {
    // Race time -> minutes. Accepts H:MM:SS, MM:SS, or decimal minutes.
    if (!isAscii(s)) throw new ValueError("time must use ASCII digits, got " + pyAscii(s));
    s = pyStrip(s);
    if (s.includes(":")) {
      const parts = s.split(":");
      if (!(parts.length === 2 || parts.length === 3) || !parts.every(p => /^[0-9]+$/.test(p))) {
        throw new ValueError("time must be H:MM:SS, MM:SS, or decimal minutes, got " + pyAscii(s));
      }
      if (parts.some(p => p.length > 4)) {
        throw new ValueError("time field too long in " + pyAscii(s) + "; the largest valid race time is well under 1000 minutes");
      }
      if (parseInt(parts[parts.length - 1], 10) >= 60 || (parts.length === 3 && parseInt(parts[1], 10) >= 60)) {
        throw new ValueError("minutes/seconds fields must be < 60 in " + pyAscii(s));
      }
      let secs = 0;
      for (const p of parts) secs = secs * 60 + parseInt(p, 10);
      return secs / 60.0;
    }
    const t = pyFloat(s);
    if (t === null) throw new ValueError("time must be H:MM:SS, MM:SS, or decimal minutes, got " + pyAscii(s));
    if (t <= 0) throw new ValueError("decimal-minutes time must be positive, got " + pyAscii(s));
    return t;
  }

  function parseDist(s) {
    // Race distance -> meters. Named distances, or a number with m/km/k/mi suffix (bare = meters).
    if (!isAscii(s)) throw new ValueError("distance must use ASCII characters, got " + pyAscii(s));
    const key = pyStrip(s).toLowerCase().split(" ").join("");
    if (key.startsWith("-")) throw new ValueError("distance " + pyAscii(s) + " is negative; distances must be positive");
    // Hyphens are a lookup convenience for purely textual names ('half-marathon')
    // and are never stripped from anything containing a digit.
    const dehyphenated = key.split("-").join("");
    const alias = /^[a-z]+$/.test(dehyphenated) ? dehyphenated : key;
    if (Object.prototype.hasOwnProperty.call(DIST_ALIASES, alias)) return DIST_ALIASES[alias];
    let num = key, unit = "m";
    const suffixes = [["miles", "mi"], ["mile", "mi"], ["mi", "mi"], ["km", "km"], ["k", "km"], ["m", "m"]];
    for (const [suffix, u] of suffixes) {
      if (key.endsWith(suffix)) { num = key.slice(0, key.length - suffix.length); unit = u; break; }
    }
    const val = pyFloat(num);
    if (val === null) {
      throw new ValueError("distance " + pyAscii(s) + " not understood; use meters, km ('8k'), miles ('4mi'), " +
        "or a name (mile, 5k, 10k, 15k, half, marathon)");
    }
    const meters = val * { m: 1.0, km: 1000.0, mi: MILE_M }[unit];
    if (!(800 <= meters && meters <= 100000)) {
      throw new ValueError("distance " + pyAscii(s) + " = " + pyFixed(meters, 0) + " m is outside 800-100000 m; check the input");
    }
    return meters;
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function fmtPace(secs) {
    // M:SS with zero-padded seconds.
    const s = pyRound(secs, 0);
    return Math.floor(s / 60) + ":" + pad2(s % 60);
  }

  function fmtRace(tMin) {
    // Race time: H:MM:SS over an hour, else M:SS.s with tenths.
    const secs = tMin * 60.0;
    if (pyRound(secs, 1) >= 3600) {
      const total = pyRound(secs, 0);  // one rounding, from the raw value, at whole-second precision
      return Math.floor(total / 3600) + ":" + pad2(Math.floor((total % 3600) / 60)) + ":" + pad2(total % 60);
    }
    const total = pyRound(secs, 1);
    let frac = pyFixed(total % 60, 1);
    if (frac.length < 4) frac = "0" + frac;
    return Math.floor(total / 60) + ":" + frac;
  }

  function paceSecs(vdot, frac) {
    // Seconds per mile and per km at frac * VDOT, via eq (2).
    const v = velAt(frac * vdot);  // m/min
    const perMile = MILE_M / v * 60.0;
    return [perMile, perMile / MILE_KM];
  }

  function trainingPaces(vdot) {
    // Rows: [label, [mi_slow, mi_fast], [km_slow, km_fast]]; I and R are point values.
    const rows = [];
    for (const [label, lo, hi] of PCT_BANDS) {
      const [miSlow, kmSlow] = paceSecs(vdot, lo);
      const [miFast, kmFast] = paceSecs(vdot, hi);
      rows.push([label, [miSlow, miFast], [kmSlow, kmFast]]);
    }
    // R: no %VO2max in ch.4; 6 s/400 FASTER than I (6-second rule, p.79).
    const iMi = rows[rows.length - 1][1][0];
    const rMi = iMi - 6.0 * (MILE_M / 400.0);   // 24.14 s/mi faster
    rows.push(["R (Repetition)", [rMi, rMi], [rMi / MILE_KM, rMi / MILE_KM]]);
    return rows;
  }

  function isPointValue(pair) { return Math.abs(pair[0] - pair[1]) < 0.5; }

  function eRowExtrapolated(vdot) { return vdot < E_PACE_MIN_VDOT; }

  function checkRenderable(vdot) {
    if (!(25 <= vdot && vdot <= 85)) {
      throw new ValueError("VDOT " + String(vdot) + " is outside 25-85; this tool's solver is only verified in that range");
    }
  }

  // Column of the named distance nearest to `meters` (by ratio), for the extrapolation flag.
  function nearestColumn(meters) {
    let best = 0, bestErr = Infinity;
    DISTANCES.forEach(([, d], i) => {
      const err = Math.abs(Math.log(meters / d));
      if (err < bestErr) { bestErr = err; best = i; }
    });
    return best;
  }

  function isExtrapolated(inputColumn, column) {
    return Math.abs(inputColumn - column) > EXTRAPOLATION_COLUMNS;
  }

  function predictions(vdot, inputColumn) {
    // inputColumn: index into DISTANCES, or null in VDOT mode (nothing is flagged).
    return DISTANCES.map(([name, d], i) => {
      const t = timeFor(d, vdot);
      return {
        name: name, meters: d, column: i, tMin: t, text: fmtRace(t),
        extrapolated: inputColumn === null ? false : isExtrapolated(inputColumn, i)
      };
    });
  }

  // ---- Youth levels: where a VDOT sits on Table 5.5 for an age and sex -------------

  function youthRow(age, sex) {
    if (!(Number.isInteger(age) && YOUTH_AGE_MIN <= age && age <= YOUTH_ADULT_ROW)) {
      throw new ValueError("age must be a whole number from " + YOUTH_AGE_MIN + " to " + YOUTH_AGE_MAX + ", got " + String(age));
    }
    if (sex !== "M" && sex !== "F") throw new ValueError("sex must be M or F, got " + pyAscii(String(sex)));
    return YOUTH_LEVELS[age][sex];
  }

  function youthCategory(level) {
    let name = YOUTH_CATEGORIES[0][1];
    for (const [from, label] of YOUTH_CATEGORIES) if (level >= from) name = label;
    return name;
  }

  // Published top level for this age/sex (the last non-null entry).
  function youthMaxLevel(age, sex) {
    const row = youthRow(age, sex);
    let n = 0;
    row.forEach(v => { if (v !== null) n += 1; });
    return n;
  }

  // Fractional level by linear interpolation between the published level VDOTs.
  // status: "within" (level set), "below" (slower than level 1; level = null),
  // "above" (faster than the top level Daniels prints at this age; level = null).
  function youthLevel(vdot, age, sex) {
    const row = youthRow(age, sex);
    const max = youthMaxLevel(age, sex);
    const base = { age: age, sex: sex, vdot: vdot, maxLevel: max, minVdot: row[0], maxVdot: row[max - 1] };
    if (vdot < row[0]) return Object.assign(base, { status: "below", level: null });
    if (vdot > row[max - 1]) return Object.assign(base, { status: "above", level: null });
    let level = max;
    for (let i = 0; i < max - 1; i++) {
      if (vdot <= row[i + 1]) { level = (i + 1) + (vdot - row[i]) / (row[i + 1] - row[i]); break; }
    }
    // Snap to the whole level when within display rounding (a 7:18 solves to VDOT 38.59,
    // a hair under the printed 38.6, and must read as level 6, not 5.9996).
    const whole = Math.round(level);
    if (Math.abs(level - whole) < 0.005) level = whole;
    return Object.assign(base, { status: "within", level: level, category: youthCategory(level) });
  }

  // The VDOT an adult (18-38) of the given sex needs for the same (fractional) level.
  function youthAdultEquivalent(level, sex) {
    const row = youthRow(YOUTH_ADULT_ROW, sex);
    if (!(1 <= level && level <= 10)) throw new ValueError("level must be 1-10, got " + String(level));
    const i = Math.min(Math.floor(level), 9);
    if (i === 10 || level === i) return row[i - 1];
    return row[i - 1] + (level - i) * (row[i] - row[i - 1]);
  }

  // The next whole level above `level` that Daniels publishes for this age/sex, with
  // its VDOT and 1,600 m time; null when the runner is already at the published top.
  function youthNextLevel(level, age, sex) {
    const row = youthRow(age, sex);
    const max = youthMaxLevel(age, sex);
    const next = Math.floor(level) + 1;
    if (next > max) return null;
    const vd = row[next - 1];
    return { level: next, vdot: vd, time1600: timeFor(YOUTH_1600_M, vd), category: youthCategory(next) };
  }

  // ---- Season-plan helpers (pure; dates are ISO "YYYY-MM-DD" strings, UTC math) ----
  function eDistanceMiles(vdot, minutes) {
    // [slow, fast] miles covered in `minutes` of E running at this VDOT's E band.
    const [, mi] = trainingPaces(vdot)[0];       // E row: [miSlow, miFast] seconds per mile
    return [minutes * 60.0 / mi[0], minutes * 60.0 / mi[1]];
  }

  function parseISODate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === "string" ? s.trim() : "");
    if (!m) throw new ValueError("Start date must be YYYY-MM-DD, got " + pyAscii(String(s)));
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      throw new ValueError("Start date is not a real calendar date: " + s);
    }
    return d;
  }

  function isoDate(d) {
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  function addDays(iso, n) {
    const d = parseISODate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return isoDate(d);
  }

  function weekRange(startISO, week) {
    // Week `week` (1-based) of a plan that starts on startISO: [first day, last day].
    if (!Number.isInteger(week) || week < 1) throw new ValueError("week must be a positive integer");
    const first = addDays(startISO, 7 * (week - 1));
    return [first, addDays(first, 6)];
  }

  function defaultPreseasonStart(todayISO) {
    // XC_PRESEASON_WEEKS weeks before the next September 1 that has not yet passed.
    // From September 1 on, that is next year's season.
    const d = parseISODate(todayISO);
    let year = d.getUTCFullYear();
    if (d.getUTCMonth() >= 8) year += 1;   // month 8 = September
    return addDays(year + "-09-01", -7 * XC_PRESEASON_WEEKS);
  }

  function whitePhaseForWeek(week) {
    if (!Number.isInteger(week) || week < 1 || week > WHITE_PLAN_WEEKS) {
      throw new ValueError("white plan week must be 1-" + WHITE_PLAN_WEEKS);
    }
    return WHITE_PLAN[Math.floor((week - 1) / 4)];
  }

  function renderText(vdot, race) {
    // Same text as the Python render(); race = [dist_m, t_min, dist_label] or null.
    checkRenderable(vdot);
    const out = [];
    if (race) {
      const [d, t, label] = race;
      out.push("Race " + label + " (" + pyFixed(d, 0) + " m) in " + fmtRace(t) + "  ->  VDOT " + pyFixed(vdot, 1));
    } else {
      out.push("VDOT " + pyFixed(vdot, 1) + " (entered directly -- see caveats 1-2 on what a valid input is)");
    }
    out.push("");
    out.push("Training paces (Daniels & Gilbert 1979 eqs; %VO2max bands per Daniels' Running Formula 4th ed. ch.4)");
    for (const [label, mi, km] of trainingPaces(vdot)) {
      if (isPointValue(mi)) {
        out.push("  " + label.padEnd(19) + " " + fmtPace(mi[0]) + "/mi          " + fmtPace(km[0]) + "/km");
      } else {
        out.push("  " + label.padEnd(19) + " " + fmtPace(mi[0]) + "-" + fmtPace(mi[1]) + "/mi     " +
          fmtPace(km[0]) + "-" + fmtPace(km[1]) + "/km");
      }
      if (label.startsWith("E") && eRowExtrapolated(vdot)) {
        out.push("  " + "".padEnd(19) + " EXTRAPOLATION: Daniels prescribes NO easy pace below VDOT " +
          pyFixed(E_PACE_MIN_VDOT, 0) + " (Table 5.3 has no E column; see caveat 4) -- " +
          "this row is the 59-74% band extended by this tool, not a published value");
      }
      out.push("  " + "".padEnd(19) + " " + BAND_NOTES[label]);
    }
    out.push("");
    out.push("Equivalent race times at this VDOT (Appendix B identity, bisection solver)");
    for (const [name, d] of DISTANCES) {
      out.push("  " + name.padEnd(10) + " " + fmtRace(timeFor(d, vdot)).padStart(10));
    }
    out.push("");
    out.push(CAVEATS);
    return out.join("\n");
  }

  // ---- Self-test: mirrors the Python --self-test check for check ---------------------

  function selfTest(log) {
    log = log || function (line) { console.log(line); };
    let fails = 0;
    function check(label, ok, detail) {
      if (!ok) fails += 1;
      log("  [" + (ok ? "PASS" : "FAIL") + "] " + label + (detail || ""));
    }
    function rejects(fn, value) {
      try { fn(value); return false; } catch (e) { return e instanceof ValueError; }
    }

    // Gold anchors, Daniels & Gilbert 1979 p.3, reference VDOT 80.5 (tol 0.5%)
    const anchors = [
      ["mile", MILE_M, 3 + 49.9 / 60],
      ["2mi", 2 * MILE_M, 8 + 11.5 / 60],
      ["10mi", 10 * MILE_M, 45 + 26.7 / 60],
      ["1500m", 1500.0, 3 + 33.0 / 60],
      ["3000m", 3000.0, 7 + 35.0 / 60],
      ["5000m", 5000.0, 13 + 13.5 / 60],
      ["10000m", 10000.0, 27 + 32.5 / 60],
      ["marathon", MARATHON_M, 126 + 57.5 / 60]
    ];
    for (const [name, d, want] of anchors) {
      const got = timeFor(d, 80.5);
      const err = Math.abs(got - want) / want;
      check("VDOT 80.5 " + name + ": " + fmtRace(got) + " vs " + fmtRace(want), err < 0.005,
        " (err " + pyFixed(err * 100, 3) + "%)");
    }
    // Appendix B: VDOT 60.5 -> mile 4:55.0; 60.4 -> 4:55.4 (tol 0.5%)
    for (const [vd, want] of [[60.5, 4 + 55.0 / 60], [60.4, 4 + 55.4 / 60]]) {
      const got = timeFor(MILE_M, vd);
      const err = Math.abs(got - want) / want;
      check("VDOT " + pyFloatStr(vd) + " mile: " + fmtRace(got) + " vs " + fmtRace(want), err < 0.005,
        " (err " + pyFixed(err * 100, 3) + "%)");
    }
    // Appendix A worked example: 10000 m in 38:46 -> VDOT 53.9 (tol 0.15)
    const got539 = vdotFromRace(10000.0, 38 + 46 / 60);
    check("10000m 38:46 -> VDOT " + pyFixed(got539, 2) + " vs 53.9", Math.abs(got539 - 53.9) < 0.15);
    // Round-trip: race -> VDOT -> predicted time at same distance, within 0.1%
    for (const [d, t] of [[5000.0, 22.5], [MARATHON_M, 210.0], [MILE_M, 5.5], [10000.0, 55.0]]) {
      const back = timeFor(d, vdotFromRace(d, t));
      const err = Math.abs(back - t) / t;
      check("round-trip " + pyFixed(d, 0) + " m @ " + pyFloatStr(t) + " min", err < 0.001,
        " (err " + pyFixed(err * 100, 4) + "%)");
    }
    // Solver convergence across the required envelope: VDOT 25-85, every distance
    let conv = true;
    for (let vd = 25; vd <= 85; vd += 5) {
      for (const [, d] of DISTANCES) {
        const t = timeFor(d, vd);
        if (Math.abs(vdotRaw(d, t) - vd) > 0.001) conv = false;
      }
    }
    check("solver converges, VDOT 25-85 x all 10 distances", conv);
    // Parsers
    check("parse_time 1:45:00 = 105 min", parseTime("1:45:00") === 105.0);
    check("parse_time 22:30 = 22.5 min", parseTime("22:30") === 22.5);
    check("parse_time 38.77 decimal", Math.abs(parseTime("38.77") - 38.77) < 1e-9);
    check("parse_dist half = 21097.5", parseDist("half") === 21097.5);
    check("parse_dist marathon = 42195", parseDist("marathon") === 42195.0);
    check("parse_dist 8k = 8000", parseDist("8k") === 8000.0);
    check("parse_dist 4mi", Math.abs(parseDist("4mi") - 4 * MILE_M) < 1e-9);
    check("parse_dist 5000 bare meters", parseDist("5000") === 5000.0);
    check("parse_dist 21.1k literal = 21100 (not the half alias)", parseDist("21.1k") === 21100.0);
    check("parse_dist 21.1k == 21.1km", parseDist("21.1k") === parseDist("21.1km"));
    check("parse_dist half-marathon hyphen alias", parseDist("half-marathon") === HALF_M);
    const fullwidth5 = String.fromCharCode(0xFF15);
    for (const bad of ["5:xx", "0", "-3", "4:75", "9".repeat(400) + ":00", "1:5:3:0", fullwidth5 + ":00"]) {
      check("reject time " + pyAscii(bad).slice(0, 24), rejects(parseTime, bad));
    }
    for (const bad of ["500", "200000", "fast", "-5k", "-5000", "1-0k", "1-500", fullwidth5 + "k"]) {
      check("reject dist " + pyAscii(bad), rejects(parseDist, bad));
    }
    // Formatting: the sub-hour/over-hour switch happens after rounding
    check("fmt_race 59:59.96 -> 1:00:00", fmtRace(59.99933) === "1:00:00");
    check("fmt_race 59:59.9 stays M:SS.s", fmtRace(59 + 59.9 / 60) === "59:59.9");
    check("fmt_race over-hour rounds once (3659.49 s -> 1:00:59)", fmtRace(3659.49 / 60) === "1:00:59");
    check("fmt_race over-hour rounds once (3658.51 s -> 1:00:59)", fmtRace(3658.51 / 60) === "1:00:59");
    for (const ws of [String.fromCharCode(0xA0) + "22.5", "22.5" + String.fromCharCode(0x2003)]) {
      check("reject time with unicode whitespace " + pyAscii(ws), rejects(parseTime, ws));
    }
    // Output sanity: caveats present, R has no invented %VO2max, E labelled below VDOT 30
    const txt = renderText(53.5, null);
    check("caveats footer printed", txt.includes("Sourced caveats"));
    check("adult-runners line printed", txt.includes("Adult runners only"));
    check("R carries no %VO2max claim", txt.includes("no %VO2max given"));
    const eLabel = "EXTRAPOLATION: Daniels prescribes NO easy pace";
    check("E row unlabelled at VDOT 53.5", !txt.includes(eLabel));
    check("E row labelled EXTRAPOLATION at VDOT 27", renderText(27.0, null).includes(eLabel));
    check("render output is ASCII", isAscii(renderText(27.0, null)) && isAscii(txt));
    // Widget-only rules (no Python counterpart)
    check("extrapolation flag: > 3 columns from the input", isExtrapolated(4, 8) && !isExtrapolated(4, 7) && isExtrapolated(4, 0));
    check("nearest column: 1600 m -> mile, 8000 m -> 10000m, 21100 m -> half",
      nearestColumn(1600) === 1 && nearestColumn(8000) === 5 && nearestColumn(21100) === 8);
    check("VDOT mode flags nothing", predictions(50, null).every(p => !p.extrapolated));
    check("race mode flags 1500/half/marathon from a 5k",
      predictions(50, 4).filter(p => p.extrapolated).map(p => p.name).join(",") === "1500m,half,marathon");
    // Youth levels (Table 5.5): Daniels' own worked example, then the published cut-offs
    const girl10 = youthLevel(vdotFromRace(YOUTH_1600_M, 7 + 18 / 60), 10, "F");
    check("Table 5.5: 10-year-old girl, 1600 in 7:18 -> level " + pyFixed(girl10.level || 0, 2) + " (book: level 6)",
      girl10.status === "within" && girl10.level === 6 && girl10.category === "Good" && youthNextLevel(girl10.level, 10, "F") === null);
    const secs = (vd) => timeFor(YOUTH_1600_M, vd) * 60;
    check("level 6 = an 18-38 woman at 5:26 / man at 4:55 (book's example)",
      Math.abs(secs(youthAdultEquivalent(6, "F")) - 326) < 2 && Math.abs(secs(youthAdultEquivalent(6, "M")) - 295) < 2);
    check("adult equivalent interpolates (level 6.5 F between 53.6 and 58.1)",
      Math.abs(youthAdultEquivalent(6.5, "F") - 55.85) < 1e-9 && youthAdultEquivalent(10, "M") === 80.0);
    let exact = true, mono = true;
    const ages = Object.keys(YOUTH_LEVELS).map(Number).sort((a, b) => a - b);
    for (const age of ages) {
      for (const sex of ["M", "F"]) {
        const row = YOUTH_LEVELS[age][sex];
        row.forEach((vd, i) => {
          if (vd === null) return;
          if (Math.abs(youthLevel(vd, age, sex).level - (i + 1)) > 1e-9) exact = false;
          if (i > 0 && row[i - 1] !== null && vd <= row[i - 1]) mono = false;
          const younger = YOUTH_LEVELS[age - 1];
          if (younger && younger[sex][i] !== null && younger[sex][i] >= vd) mono = false;
        });
      }
    }
    check("every Table 5.5 cell maps back to its own whole level", exact);
    check("Table 5.5 VDOTs rise with level and with age", mono);
    check("published tops: age 6 -> 2, 10 -> 6, 13 -> 9, 14 -> 10",
      youthMaxLevel(6, "M") === 2 && youthMaxLevel(10, "F") === 6 && youthMaxLevel(13, "M") === 9 && youthMaxLevel(14, "F") === 10);
    check("above the published top is reported, never extrapolated",
      youthLevel(30, 6, "M").status === "above" && youthLevel(30, 6, "M").level === null && youthLevel(30, 6, "M").maxVdot === 18.8);
    check("below level 1 is reported", youthLevel(25, 14, "M").status === "below" && youthLevel(25, 14, "M").minVdot === 28.9);
    check("next level: a level-6 10-year-old girl is at the published top", youthNextLevel(6, 10, "F") === null);
    const nx = youthNextLevel(5.4, 12, "M");
    check("next level: 12-year-old boy at 5.4 -> level 6, VDOT 45.8, 1600 ~6:16",
      nx.level === 6 && nx.vdot === 45.8 && Math.abs(nx.time1600 * 60 - 376) < 2 && nx.category === "Good");
    check("youth categories: 1 Novice, 3 Intermediate, 6 Good, 9 Elite",
      youthCategory(1) === "Novice" && youthCategory(2.9) === "Novice" && youthCategory(3) === "Intermediate" &&
      youthCategory(5.99) === "Intermediate" && youthCategory(6) === "Good" && youthCategory(9) === "Elite");
    check("youth rejects age 5, age 19, sex X; accepts the age-18 reference row",
      rejects(a => youthRow(a, "M"), 5) && rejects(a => youthRow(a, "M"), 19) && rejects(s => youthRow(12, s), "X") &&
      youthRow(18, "F")[5] === 53.6);
    check("youth notes are ASCII", isAscii(YOUTH_QUOTE) && isAscii(YOUTH_PACE_NOTE));

    // Season plans (ch. 14 Table 14.1; ch. 8 Table 8.1)
    check("preseason: two blocks covering weeks 1-3 and 4-6, three rows each",
      XC_PRESEASON.length === 2 && XC_PRESEASON[0].weeks[0] === 1 && XC_PRESEASON[0].weeks[1] === 3 &&
      XC_PRESEASON[1].weeks[0] === 4 && XC_PRESEASON[1].weeks[1] === XC_PRESEASON_WEEKS &&
      XC_PRESEASON.every(b => b.days.length === 3 && b.days[0][0] === "Sunday" && b.days[0][2] === 60));
    check("preseason: weekly running minutes 250 then 255 (L at its 60-min cap)",
      XC_PRESEASON_WEEK_MIN[0] === 250 && XC_PRESEASON_WEEK_MIN[1] === 255);
    check("white plan: 4 phases x 7 days, weeks 1-16, phases hold 4 weeks each",
      WHITE_PLAN.length === 4 && WHITE_PLAN.every((p, i) => p.phase === i + 1 && p.days.length === 7 &&
        p.weeks[0] === 4 * i + 1 && p.weeks[1] === 4 * i + 4) && WHITE_PLAN[3].weeks[1] === WHITE_PLAN_WEEKS);
    check("white plan: minimum days are 1, 3, 5 in every phase",
      WHITE_PLAN.every(p => p.days.filter(d => d[4]).map(d => d[0]).join(",") === "1,3,5"));
    check("white plan: running minutes never exceed total, and no session over 45 min",
      WHITE_PLAN.every(p => p.days.every(d => d[2] <= d[3] && d[3] <= 45)));
    check("white plan: Phase I day 1 is 10 running min of 30; Phase IV day 1 is ~38 of ~44 with strides",
      WHITE_PLAN[0].days[0][2] === 10 && WHITE_PLAN[0].days[0][3] === 30 &&
      WHITE_PLAN[3].days[0][2] === 38 && WHITE_PLAN[3].days[0][3] === 44 && WHITE_PLAN[3].days[0][1].indexOf("6 ST") > 0);
    check("white plan: week 1 -> phase 1, week 4 -> 1, week 5 -> 2, week 16 -> 4; weeks 0 and 17 rejected",
      whitePhaseForWeek(1).phase === 1 && whitePhaseForWeek(4).phase === 1 && whitePhaseForWeek(5).phase === 2 &&
      whitePhaseForWeek(16).phase === 4 && rejects(whitePhaseForWeek, 0) && rejects(whitePhaseForWeek, 17));
    const ed = eDistanceMiles(40.0, 30);
    check("E distance: VDOT 40, 30 min -> about 2.6-3.2 mi, slow < fast",
      ed[0] < ed[1] && ed[0] > 2.5 && ed[0] < 2.8 && ed[1] > 3.0 && ed[1] < 3.3);
    check("dates: 6 weeks before Sep 1 is Jul 21; from Sep 1 on it rolls to next year",
      defaultPreseasonStart("2026-10-30") === "2027-07-21" && defaultPreseasonStart("2027-07-01") === "2027-07-21" &&
      defaultPreseasonStart("2027-08-31") === "2027-07-21" && defaultPreseasonStart("2027-09-01") === "2028-07-21");
    check("dates: week ranges and leap-day arithmetic",
      weekRange("2027-07-21", 1).join(" ") === "2027-07-21 2027-07-27" &&
      weekRange("2027-07-21", 6).join(" ") === "2027-08-25 2027-08-31" &&
      addDays("2028-02-28", 1) === "2028-02-29" && addDays("2026-12-31", 1) === "2027-01-01");
    check("dates: bad input rejected", rejects(parseISODate, "2027-02-30") && rejects(parseISODate, "7/21/2027") &&
      rejects(parseISODate, "") && rejects(w => weekRange("2027-07-21", w), 0));
    check("plan notes are ASCII", isAscii(XC_L_RULE) && isAscii(WHITE_PLAN_NOTE) && isAscii(STRIDES_DEF) && isAscii(PLAN_SCOPE_NOTE) &&
      WHITE_PLAN.every(p => p.days.every(d => isAscii(d[1]))) && XC_PRESEASON.every(b => b.days.every(d => isAscii(d[1]))));
    log(fails === 0 ? "GREEN" : "RED -- " + fails + " failure(s)");
    return fails ? 1 : 0;
  }

  return {
    MILE_KM, MILE_M, HALF_M, MARATHON_M, DISTANCES, DIST_ALIASES, E_PACE_MIN_VDOT, PCT_BANDS,
    BAND_NOTES, CAVEATS, EXTRAPOLATION_COLUMNS, ValueError,
    isAscii, pyAscii, pyStrip, pyFloat, pyFixed, pyRound,
    vo2At, velAt, pctMax, vdotRaw, vdotFromRace, timeFor, parseTime, parseDist,
    fmtPace, fmtRace, paceSecs, trainingPaces, isPointValue, eRowExtrapolated, checkRenderable,
    nearestColumn, isExtrapolated, predictions, renderText, selfTest,
    YOUTH_LEVELS, YOUTH_AGE_MIN, YOUTH_AGE_MAX, YOUTH_ADULT_ROW, YOUTH_1600_M, YOUTH_CATEGORIES, YOUTH_QUOTE, YOUTH_PACE_NOTE,
    youthRow, youthCategory, youthMaxLevel, youthLevel, youthAdultEquivalent, youthNextLevel,
    XC_PRESEASON, XC_PRESEASON_WEEKS, XC_PRESEASON_WEEK_MIN, XC_L_RULE,
    WHITE_PLAN, WHITE_PLAN_WEEKS, WHITE_PLAN_NOTE, STRIDES_DEF, PLAN_SCOPE_NOTE,
    eDistanceMiles, parseISODate, isoDate, addDays, weekRange, defaultPreseasonStart, whitePhaseForWeek
  };
}));

// Node CLI, mirroring the Python's argparse surface closely enough to diff outputs.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  const V = module.exports;
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--self-test") opt.selfTest = true;
    else if ((args[i] === "--dist" || args[i] === "--time" || args[i] === "--vdot") && i + 1 < args.length) {
      opt[args[i].slice(2)] = args[++i];
    } else { console.error("usage: node vdot.js --self-test | --dist D --time T | --vdot N"); process.exit(2); }
  }
  try {
    if (opt.selfTest) {
      process.exit(V.selfTest());
    } else if (opt.vdot !== undefined) {
      if (opt.dist || opt.time) throw new V.ValueError("give either --vdot or --dist/--time, not both");
      const vd = V.pyFloat(opt.vdot);
      if (vd === null) throw new V.ValueError("argument --vdot: invalid float value: " + V.pyAscii(opt.vdot));
      console.log(V.renderText(vd, null));
    } else if (opt.dist && opt.time) {
      const d = V.parseDist(opt.dist);
      const t = V.parseTime(opt.time);
      console.log(V.renderText(V.vdotFromRace(d, t), [d, t, opt.dist]));
    } else {
      throw new V.ValueError("--dist and --time are required together (or --vdot, or --self-test)");
    }
  } catch (e) {
    if (e instanceof V.ValueError) { console.error("error: " + e.message); process.exit(2); }
    throw e;
  }
}
