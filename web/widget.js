/* widget.js -- DOM layer for the pace widget. All math lives in vdot.js (window.VDOT).
 * Nothing the visitor types is stored or sent anywhere; errors render inline, never
 * to the console. */
(function () {
  "use strict";

  const V = window.VDOT;
  const EM_DASH = String.fromCharCode(0x2014);

  // Select rows, in DISTANCES order so the option index is the column index.
  const NAMED = [
    ["1500m", "1500 m"], ["mile", "Mile"], ["3000m", "3000 m"], ["2mi", "2 miles"],
    ["5k", "5k"], ["10k", "10k"], ["15k", "15k"], ["10mi", "10 miles"],
    ["half", "Half marathon"], ["marathon", "Marathon"]
  ];
  const E_EXTRAPOLATION_LABEL = "extrapolation " + EM_DASH + " Daniels publishes no easy pace below VDOT " +
    V.pyFixed(V.E_PACE_MIN_VDOT, 0);
  const PREDICTION_EXTRAPOLATION_LABEL = "extrapolation (assumes training at that distance)";
  const VDOT_MODE_NOTE = "No reference race " + EM_DASH + " every prediction assumes training at that distance.";
  // Youth mode lists the distances school runners actually race: 1,500/1,600/mile and
  // 2k-2 miles in middle school, 5k in high school. Nothing longer: Daniels' youth table
  // is built on 1,600 m and the book rates no child at road distances. Each row carries
  // the column of its nearest named distance for the extrapolation flag.
  const YOUTH_DISTANCES = [
    ["1500 m", 1500.0], ["1600 m", 1600.0], ["Mile", V.MILE_M], ["2000 m", 2000.0],
    ["3000 m", 3000.0], ["2 miles", 2 * V.MILE_M], ["5k", 5000.0]
  ];
  const YOUTH_PREDICTION_NOTE = "Youth mode lists school race distances only (2k through 2 miles in middle school, 5k in high school): " +
    "Daniels' Table 5.5 is built on 1,600 m times and the book gives no youth values for longer races.";

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(c => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return node;
  }

  function buildForm(root) {
    const form = el("form", { id: "pw-form", novalidate: "", autocomplete: "off" });
    const mode = el("fieldset", { class: "pw-mode" }, [
      el("legend", { text: "Start from" }),
      el("label", null, [el("input", { type: "radio", name: "pw-mode", value: "race", checked: "" }), " a race"]),
      el("label", null, [el("input", { type: "radio", name: "pw-mode", value: "vdot" }), " a VDOT"])
    ]);
    const select = el("select", { id: "pw-dist" });
    NAMED.forEach(([value, label], i) => select.appendChild(el("option", { value: value, text: label, "data-column": String(i) })));
    select.appendChild(el("option", { value: "custom", text: "Custom..." }));
    // No inputmode on these two: iOS's numeric/decimal keypads have no colon and no
    // letters, so "6:30" and "8k" could not be typed on a phone. Bare digits are also
    // accepted for the time (630 = 6:30, 2230 = 22:30, 11000 = 1:10:00), see normalizeTime.
    const custom = el("input", { id: "pw-custom", type: "text", placeholder: "8k, 4mi, 5000", spellcheck: "false", autocapitalize: "off" });
    const time = el("input", { id: "pw-time", type: "text", placeholder: "6:30, 22:30 or 1:45:00 (or 630)", spellcheck: "false", autocapitalize: "off" });
    const vdotIn = el("input", { id: "pw-vdot-in", type: "text", inputmode: "decimal", placeholder: "25 to 85, e.g. 53.5", spellcheck: "false" });

    const raceGrid = el("div", { class: "pw-grid", id: "pw-race" }, [
      el("label", null, ["Race distance", select]),
      el("label", { id: "pw-custom-wrap", hidden: "" }, ["Custom distance (m, km or mi)", custom]),
      el("label", null, ["Race time", time])
    ]);
    const vdotGrid = el("div", { class: "pw-grid", id: "pw-vdot", hidden: "" }, [
      el("label", null, ["VDOT", vdotIn])
    ]);
    // Youth toggle: age-grades the result against Daniels' Table 5.5 (ages 6-17).
    const youthToggle = el("input", { type: "checkbox", id: "pw-youth", name: "pw-youth" });
    const youthLabel = el("label", { class: "pw-toggle", for: "pw-youth" }, [
      youthToggle, el("span", { class: "pw-switch", "aria-hidden": "true" }),
      el("span", { text: "Youth mode (ages " + V.YOUTH_AGE_MIN + "-" + V.YOUTH_AGE_MAX + "): age-grade against Daniels' Table 5.5" })
    ]);
    const age = el("select", { id: "pw-age" });
    for (let a = V.YOUTH_AGE_MIN; a <= V.YOUTH_AGE_MAX; a++) age.appendChild(el("option", { value: String(a), text: String(a) }));
    age.value = "12";
    const sex = el("select", { id: "pw-sex" }, [
      el("option", { value: "M", text: "Boy" }), el("option", { value: "F", text: "Girl" })
    ]);
    const youthGrid = el("div", { class: "pw-grid", id: "pw-youth-grid", hidden: "" }, [
      el("label", null, ["Age (years)", age]),
      el("label", null, ["Boy / girl (the table has separate columns)", sex])
    ]);
    const actions = el("div", { class: "pw-actions" }, [
      el("button", { type: "submit", text: "Calculate" }),
      el("span", { class: "pw-error", id: "pw-error", role: "alert" })
    ]);
    form.appendChild(mode);
    form.appendChild(raceGrid);
    form.appendChild(vdotGrid);
    // A stale cached vdot.js without the youth API would leave the age list empty; hide
    // the toggle instead of offering a form that cannot compute.
    if (typeof V.youthLevel === "function" && Number.isInteger(V.YOUTH_AGE_MIN)) {
      form.appendChild(el("div", { class: "pw-youth-row" }, [youthLabel]));
      form.appendChild(youthGrid);
    }
    form.appendChild(actions);
    root.appendChild(form);
    root.appendChild(el("div", { id: "pw-results", "aria-live": "polite" }));
    return { form, select, custom, time, vdotIn, raceGrid, vdotGrid, youthToggle, youthGrid, age, sex };
  }

  function readYouth(ui) {
    if (!ui.youthToggle.checked) return null;
    const age = parseInt(ui.age.value, 10);
    const sex = ui.sex.value;
    V.youthRow(age, sex);  // validates; throws ValueError on a tampered form
    return { age: age, sex: sex };
  }

  function youthWho(youth) {
    return youth.age + "-year-old " + (youth.sex === "F" ? "girl" : "boy");
  }

  function fmt1600(vdot) { return V.fmtPace(V.timeFor(V.YOUTH_1600_M, vdot) * 60); }

  // The youth card: level on Table 5.5, the adult equivalent, and the next published level.
  function renderYouth(vdot, youth) {
    const r = V.youthLevel(vdot, youth.age, youth.sex);
    const card = el("div", { class: "card youth" });
    card.appendChild(el("h2", { text: "Youth level (Daniels' Table 5.5)" }));
    if (r.status === "within") {
      const lvl = Math.floor(r.level) === r.level ? String(r.level) : V.pyFixed(r.level, 1);
      card.appendChild(el("div", { class: "pw-level", text: "Level " + lvl + " of 10 " + EM_DASH + " " + r.category }));
      card.appendChild(el("p", { class: "pw-sub", text: "for a " + youthWho(youth) + ", on a 10-level scale where age " +
        V.YOUTH_ADULT_ROW + "-38 is the reference band. Whole levels are the published rows; the decimal is interpolated." }));
      const adultF = V.youthAdultEquivalent(r.level, "F"), adultM = V.youthAdultEquivalent(r.level, "M");
      card.appendChild(el("p", { class: "pw-foot", text: "Same level as an adult (18-38) woman at VDOT " + V.pyFixed(adultF, 1) +
        " (1,600 m in " + fmt1600(adultF) + ") or man at VDOT " + V.pyFixed(adultM, 1) + " (" + fmt1600(adultM) + ")." }));
      const next = V.youthNextLevel(r.level, youth.age, youth.sex);
      if (next) {
        card.appendChild(el("p", { class: "pw-foot", text: "Next published level for this age, " + next.level + " (" + next.category +
          "): VDOT " + V.pyFixed(next.vdot, 1) + ", 1,600 m in " + fmt1600(next.vdot) + "." }));
      } else {
        card.appendChild(el("p", { class: "pw-foot", text: "This is the top level Daniels publishes at age " + youth.age +
          " (level " + r.maxLevel + "). He stops the younger rows early on purpose: \"" + V.YOUTH_QUOTE + "\"" }));
      }
    } else if (r.status === "above") {
      card.appendChild(el("div", { class: "pw-level", text: "Above level " + r.maxLevel + " " + EM_DASH + " the top Daniels publishes at age " + youth.age }));
      card.appendChild(el("p", { class: "pw-sub", text: "Level " + r.maxLevel + " for a " + youthWho(youth) + " is VDOT " + V.pyFixed(r.maxVdot, 1) +
        " (1,600 m in " + fmt1600(r.maxVdot) + "). The book prints no higher level at this age, and this tool does not extrapolate one: \"" +
        V.YOUTH_QUOTE + "\"" }));
    } else {
      card.appendChild(el("div", { class: "pw-level", text: "Below level 1 for age " + youth.age }));
      card.appendChild(el("p", { class: "pw-sub", text: "Level 1 for a " + youthWho(youth) + " starts at VDOT " + V.pyFixed(r.minVdot, 1) +
        " (1,600 m in " + fmt1600(r.minVdot) + "). Nothing is wrong with a slower time; the table simply starts there." }));
    }
    card.appendChild(el("p", { class: "pw-foot", text: "Daniels' Running Formula, 4th ed., ch. 5, Table 5.5; the under-18 values are partly extrapolated by the author from the ages he tested. Levels: Novice 1-2, Intermediate 3-5, Good 6-8, Elite 9-10. The 1,600 m times here are solved from the 1979 equations and can sit a second or two from the book's printed times." }));
    return card;
  }

  function currentMode(form) {
    return form.querySelector("input[name=pw-mode]:checked").value;
  }

  function showError(msg) {
    document.getElementById("pw-error").textContent = msg;
    document.getElementById("pw-results").textContent = "";
  }

  function clearError() {
    document.getElementById("pw-error").textContent = "";
  }

  function readRace(ui) {
    const choice = ui.select.value;
    if (choice === "custom") {
      const raw = ui.custom.value;
      if (V.pyStrip(raw) === "") throw new V.ValueError("Enter a custom distance such as 8k, 4mi or 5000.");
      const meters = V.parseDist(raw);
      return { meters: meters, column: V.nearestColumn(meters), label: V.pyStrip(raw) };
    }
    const option = ui.select.options[ui.select.selectedIndex];
    return { meters: V.parseDist(choice), column: Number(option.getAttribute("data-column")), label: option.textContent };
  }

  // Widget-only convenience (the CLI's parseTime is unchanged): a run of 3-6 bare ASCII
  // digits is read as MMSS / HMMSS / HHMMSS, since a phone keypad may offer no colon.
  // One or two digits, or anything with punctuation, pass through to parseTime as is.
  function normalizeTime(raw) {
    const s = V.pyStrip(raw);
    if (!/^[0-9]{3,6}$/.test(s)) return raw;
    const ss = s.slice(-2), mm = s.slice(-4, -2), hh = s.slice(0, -4);
    return (hh ? hh + ":" : "") + mm + ":" + ss;
  }

  function readVdot(ui) {
    const raw = ui.vdotIn.value;
    if (!V.isAscii(raw)) throw new V.ValueError("VDOT must use ASCII digits, got " + V.pyAscii(raw));
    const s = V.pyStrip(raw);
    const vd = s === "" ? null : V.pyFloat(s);
    if (vd === null || Number.isNaN(vd)) throw new V.ValueError("VDOT must be a number between 25 and 85, got " + V.pyAscii(raw));
    V.checkRenderable(vd);
    return vd;
  }

  function paceCell(pair) {
    const a = V.fmtPace(pair[0]), b = V.fmtPace(pair[1]);
    return el("td", { class: "num", text: V.isPointValue(pair) ? a : a + "-" + b });
  }

  // Treadmill belt speed in mph from seconds per mile; one decimal, the usual belt
  // increment. Presentation only: the per-mile value is still the source.
  function fmtMph(secsPerMile) { return V.pyFixed(3600.0 / secsPerMile, 1); }

  function mphCell(miPair) {
    const a = fmtMph(miPair[0]), b = fmtMph(miPair[1]);
    return el("td", { class: "num", text: V.isPointValue(miPair) || a === b ? a : a + "-" + b });
  }

  function renderResults(vdot, race, youth) {
    const results = document.getElementById("pw-results");
    results.textContent = "";

    // Headline
    const head = el("div", { class: "card accent pw-head" });
    head.appendChild(el("div", { class: "pw-vdot", text: "VDOT " + V.pyFixed(vdot, 1) }));
    if (race) {
      head.appendChild(el("div", { class: "pw-sub", text: race.label + " (" + V.pyFixed(race.meters, 0) + " m) in " + V.fmtRace(race.tMin) +
        (youth ? ", " + youthWho(youth) : "") }));
    } else {
      head.appendChild(el("div", { class: "pw-sub", text: "entered directly " + EM_DASH + " see the caveats below on what a valid input is" +
        (youth ? " (" + youthWho(youth) + ")" : "") }));
    }
    results.appendChild(head);

    // Youth level (Table 5.5) sits right under the headline so a coach sees it first
    if (youth) results.appendChild(renderYouth(vdot, youth));

    // Training paces
    const paces = el("div", { class: "card" });
    paces.appendChild(el("h2", { text: "Training paces" }));
    if (youth) paces.appendChild(el("p", { class: "pw-youth-note" }, [el("span", { class: "flag", text: "youth" }), " " + V.YOUTH_PACE_NOTE]));
    const ptable = el("table");
    ptable.appendChild(el("thead", null, [el("tr", null, [
      el("th", { text: "Band" }), el("th", { text: "per mile" }), el("th", { text: "per km" }), el("th", { text: "mph" })
    ])]));
    const pbody = el("tbody");
    for (const [label, mi, km] of V.trainingPaces(vdot)) {
      pbody.appendChild(el("tr", { class: "band" }, [el("td", { text: label }), paceCell(mi), paceCell(km), mphCell(mi)]));
      const note = el("td", { colspan: "4" });
      if (label.startsWith("E") && V.eRowExtrapolated(vdot)) {
        note.appendChild(el("span", { class: "flag", text: E_EXTRAPOLATION_LABEL }));
      }
      note.appendChild(el("span", { class: "note", text: V.BAND_NOTES[label] }));
      pbody.appendChild(el("tr", { class: "band-note" }, [note]));
    }
    ptable.appendChild(pbody);
    paces.appendChild(ptable);
    paces.appendChild(el("p", { class: "pw-foot", text: "Ranges run slow to fast. mph is treadmill belt speed at 0% grade (Daniels, ch. 7: each 1% of grade is worth roughly 10-15 s/mi). %VO2max bands per Daniels' Running Formula, 4th ed., ch. 4; R has no published %VO2max and is derived as 6 s/400 m faster than I." }));
    results.appendChild(paces);

    // Equivalent race times
    const eq = el("div", { class: "card" });
    eq.appendChild(el("h2", { text: "Equivalent race times" }));
    const etable = el("table");
    etable.appendChild(el("thead", null, [el("tr", null, [
      el("th", { text: "Distance" }), el("th", { text: "Time" })
    ])]));
    const ebody = el("tbody");
    const column = race ? race.column : null;
    const rows = youth
      ? YOUTH_DISTANCES.map(([label, d]) => ({
          label: label, text: V.fmtRace(V.timeFor(d, vdot)),
          extrapolated: column === null ? false : V.isExtrapolated(column, V.nearestColumn(d))
        }))
      : V.predictions(vdot, column).map(p => ({ label: NAMED[p.column][1], text: p.text, extrapolated: p.extrapolated }));
    for (const p of rows) {
      const time = el("td", { class: "num" }, [el("span", { text: p.text })]);
      if (p.extrapolated) time.appendChild(el("span", { class: "flag", text: PREDICTION_EXTRAPOLATION_LABEL }));
      ebody.appendChild(el("tr", { class: p.extrapolated ? "extrap" : "" }, [el("td", { text: p.label }), time]));
    }
    etable.appendChild(ebody);
    eq.appendChild(etable);
    if (!race) eq.appendChild(el("p", { class: "pw-foot", text: VDOT_MODE_NOTE }));
    if (youth) eq.appendChild(el("p", { class: "pw-foot", text: YOUTH_PREDICTION_NOTE }));
    results.appendChild(eq);
  }

  function calculate(ui) {
    clearError();
    const youth = readYouth(ui);
    if (currentMode(ui.form) === "vdot") {
      const vd = readVdot(ui);
      renderResults(vd, null, youth);
      return;
    }
    const race = readRace(ui);
    if (V.pyStrip(ui.time.value) === "") throw new V.ValueError("Enter the race time as H:MM:SS or MM:SS (or bare digits such as 630 for 6:30).");
    const tMin = V.parseTime(normalizeTime(ui.time.value));
    const vdot = V.vdotFromRace(race.meters, tMin);
    V.checkRenderable(vdot);
    race.tMin = tMin;
    renderResults(vdot, race, youth);
  }

  function renderCaveats() {
    const box = document.getElementById("pw-caveats");
    if (!box) return;
    const chunks = V.CAVEATS.split("\n\n");
    const summary = el("summary", { text: chunks[0].replace(/:$/, "") });
    const list = el("ol");
    for (const item of chunks.slice(1, -1)) list.appendChild(el("li", { text: item.replace(/^\d+\.\s*/, "") }));
    box.appendChild(summary);
    box.appendChild(list);
    box.appendChild(el("p", { text: chunks[chunks.length - 1] }));
  }

  function init() {
    const root = document.getElementById("pace-widget");
    if (!root || !V) return;
    const ui = buildForm(root);
    ui.form.addEventListener("change", function (ev) {
      if (ev.target.name === "pw-mode") {
        const race = ev.target.value === "race";
        ui.raceGrid.hidden = !race;
        ui.vdotGrid.hidden = race;
        clearError();
      }
      if (ev.target === ui.select) {
        document.getElementById("pw-custom-wrap").hidden = ui.select.value !== "custom";
        if (ui.select.value === "custom") ui.custom.focus();
      }
      if (ev.target === ui.youthToggle) {
        ui.youthGrid.hidden = !ui.youthToggle.checked;
        clearError();
        if (ui.youthToggle.checked) ui.age.focus();
      }
    });
    ui.form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      try {
        calculate(ui);
      } catch (e) {
        showError(e instanceof V.ValueError ? e.message : "Could not compute from those inputs; check the distance and time.");
      }
    });
    renderCaveats();
  }

  try { init(); } catch (e) {
    const root = document.getElementById("pace-widget");
    if (root) root.textContent = "The calculator could not start in this browser.";
  }
})();
