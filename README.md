# vo2-pace-solver

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A single-file, stdlib-only Python tool that computes a VDOT-style fitness
value from a real race result, derives the five Daniels training paces
(E/M/T/I/R), and predicts equivalent race times at 10 distances by solving
the Daniels-Gilbert identity numerically.

- **Input:** one race result (distance + time), or a fitness value directly.
- **Output:** training pace bands per mile and per km, plus equivalent race
  times from 1500 m to the marathon.
- **Method:** the three published Daniels & Gilbert (1979) equations; the
  equivalent-time prediction is a bracketing bisection solver on the same
  identity their Appendix B solves with Newton-Raphson.

## Install

None. Python 3 standard library only (tested on 3.12).

```
python vo2_pace_solver.py --self-test
```

## Usage

```
python vo2_pace_solver.py --dist 5k --time 22:30
python vo2_pace_solver.py --dist 10mi --time 1:10:00
python vo2_pace_solver.py --vdot 53.5
```

Distances: meters (bare number or `8000m`), km (`8k` / `8km`), miles
(`4mi`), or a name: `1500`, `mile`, `3000`, `2mi`, `5k`, `10k`, `15k`,
`10mi`, `half`, `marathon`. Times: `H:MM:SS`, `MM:SS`, or decimal minutes.

### Example 1: a 22:30 5k

```
$ python vo2_pace_solver.py --dist 5k --time 22:30
Race 5k (5000 m) in 22:30.0  ->  VDOT 43.4

Training paces (Daniels & Gilbert 1979 eqs; %VO2max bands per Daniels' Running Formula 4th ed. ch.4)
  E (Easy)            10:33-8:50/mi     6:33-5:29/km
  M (Marathon-pace)   8:44-7:59/mi     5:26-4:57/km
  T (Threshold)       7:54-7:41/mi     4:55-4:46/km
  I (Interval)        6:56/mi          4:18/km
  R (Repetition)      6:32/mi          4:03/km

Equivalent race times at this VDOT (Appendix B identity, bisection solver)
  1500m          6:07.5
  mile           6:37.1
  3000m         13:04.5
  2mi           14:06.1
  5000m         22:30.0
  10000m        46:39.8
  15k           1:11:51
  10mi          1:17:27
  half          1:43:27
  marathon      3:34:43
```

(Per-band notes and a sourced-caveats footer are printed too; trimmed here.)

### Example 2: a 1:10:00 10-miler

```
$ python vo2_pace_solver.py --dist 10mi --time 1:10:00
Race 10mi (16093 m) in 1:10:00  ->  VDOT 48.8
...
  E (Easy)            9:38-8:02/mi     5:59-5:00/km
  M (Marathon-pace)   7:57-7:15/mi     4:56-4:31/km
  T (Threshold)       7:11-6:59/mi     4:28-4:21/km
  I (Interval)        6:18/mi          3:55/km
  R (Repetition)      5:54/mi          3:40/km
...
  half          1:33:30
  marathon      3:14:40
```

### Example 3: enter a fitness value directly

```
$ python vo2_pace_solver.py --vdot 53.5
VDOT 53.5 (entered directly -- see caveats 1-2 on what a valid input is)
...
  T (Threshold)       6:40-6:29/mi     4:09-4:02/km
...
  5000m         18:48.7
  10000m        39:00.2
  half          1:26:19
  marathon      3:00:05
```

## Accuracy

`--self-test` checks the solver against 11 gold anchors published in
Daniels & Gilbert (1979): the p.3 reference times for a fitness value of
80.5, the two Appendix B worked mile examples, and the Appendix A worked
VDOT example. All pass within 0.11%:

| Anchor | Published | Computed | Error |
|---|---|---|---|
| VDOT 80.5, mile | 3:49.9 | 3:49.7 | 0.096% |
| VDOT 80.5, 2 mi | 8:11.5 | 8:11.5 | 0.007% |
| VDOT 80.5, 10 mi | 45:26.7 | 45:28.3 | 0.058% |
| VDOT 80.5, 1500 m | 3:33.0 | 3:32.8 | 0.108% |
| VDOT 80.5, 3000 m | 7:35.0 | 7:34.9 | 0.022% |
| VDOT 80.5, 5000 m | 13:13.5 | 13:13.7 | 0.028% |
| VDOT 80.5, 10000 m | 27:32.5 | 27:33.3 | 0.048% |
| VDOT 80.5, marathon | 2:06:58 | 2:07:02 | 0.064% |
| VDOT 60.5, mile | 4:55.0 | 4:55.2 | 0.058% |
| VDOT 60.4, mile | 4:55.4 | 4:55.6 | 0.069% |
| 10000 m in 38:46 -> VDOT | 53.9 | 53.88 | 0.02 (abs) |

The suite also verifies round-trips (race -> VDOT -> predicted time, within
0.1%), solver convergence across VDOT 25-85 at all 10 distances, and the
input parsers.

## Browser widget

`web/` holds a dependency-free, client-side port of the solver for dropping
into a web page: `vdot.js` (the math, parsers, formatters and self-test; no
DOM) and `widget.js` (the form and results), with `index.html` as a host page
that already carries the required attribution and caveat text.

- Try it: `python -m http.server --directory web 8000`, then open
  http://localhost:8000/.
- Test it: `node web/vdot.js --self-test` mirrors the Python self-test, and
  `node web/vdot.js --dist 5k --time 22:30` prints the same text as the Python
  CLI, so the two can be diffed (CI does exactly that).
- Embed it: give a page a `<div id="pace-widget"></div>`, then load `vdot.js`
  and `widget.js` in that order. Keep the two disclaimer paragraphs and the
  repo link from `index.html` next to it.
- Nothing the visitor types leaves the page: no storage, no network use.

The widget adds two presentation rules the CLI does not have: an equivalent
time more than three columns from the input race (in the table order above)
is flagged as an extrapolation, and a custom distance is flagged relative to
its nearest named distance. Live example: https://track.collumus.com/paces/

## Method

Velocity v in meters/minute, time t in minutes:

```
(1) VO2(v) = -4.60 + 0.182258*v + 0.000104*v^2      oxygen cost of running at v
(2) v(VO2) = 29.54 + 5.000663*VO2 - 0.007546*VO2^2  fitted inverse of (1)
(3) pct(t) = 0.8 + 0.1894393*exp(-0.012778*t)
           + 0.2989558*exp(-0.1932605*t)            fraction of VO2max sustainable for t min
```

The fitness value from a race of d meters in t minutes is
`VO2(d/t) / pct(t)`. An equivalent time at another distance d2 solves
`VO2(d2/t2) / pct(t2) = VDOT` for t2; this tool uses a bracketing bisection
(the function is monotone decreasing in t over the supported range) where
the original Appendix B uses Newton-Raphson.

Training paces apply the %VO2max bands from the book to equation (2):
E 59-74%, M 75-84%, T 85-88% (well-trained), I at ~100% ("at or very close
to" VO2max; the book gives no numeric range), and R derived as 6 s/400
faster than I (the book's 6-second rule; no %VO2max is published for R).

**Sources:**

- Daniels, J. & Gilbert, J. (1979), "Oxygen Power: Performance Tables for
  Distance Runners" (privately published), Appendices A-B -- the three
  equations, the identity, and the gold anchors.
- Jack Daniels, "Daniels' Running Formula", 4th ed. (Human Kinetics, 2021),
  chapter 4 -- the E/M/T/I/R intensity definitions and %VO2max bands.

## Disclaimers

- VDOT is a trademark of The Run SMART Project / V.O2; this project is not
  affiliated with or endorsed by Jack Daniels, V.O2, or Human Kinetics. The
  term is used descriptively to identify the published method.
- Adult runners only. Not calibrated for children/adolescents: Daniels &
  Gilbert (1979, Appendix A) state a child's computed value underestimates
  true VO2max and improvement during growth is largely running economy. The
  method also assumes adequate training at the target distance -- do not
  read predictions far across distances from the input race.
- These are training-guidance numbers, not medical advice.

## License

MIT -- see [LICENSE](LICENSE).
