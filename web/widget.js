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
    const custom = el("input", { id: "pw-custom", type: "text", inputmode: "decimal", placeholder: "8k, 4mi, 5000", spellcheck: "false" });
    const time = el("input", { id: "pw-time", type: "text", inputmode: "numeric", placeholder: "H:MM:SS or MM:SS", spellcheck: "false" });
    const vdotIn = el("input", { id: "pw-vdot-in", type: "text", inputmode: "decimal", placeholder: "25 to 85, e.g. 53.5", spellcheck: "false" });

    const raceGrid = el("div", { class: "pw-grid", id: "pw-race" }, [
      el("label", null, ["Race distance", select]),
      el("label", { id: "pw-custom-wrap", hidden: "" }, ["Custom distance (m, km or mi)", custom]),
      el("label", null, ["Race time", time])
    ]);
    const vdotGrid = el("div", { class: "pw-grid", id: "pw-vdot", hidden: "" }, [
      el("label", null, ["VDOT", vdotIn])
    ]);
    const actions = el("div", { class: "pw-actions" }, [
      el("button", { type: "submit", text: "Calculate" }),
      el("span", { class: "pw-error", id: "pw-error", role: "alert" })
    ]);
    form.appendChild(mode);
    form.appendChild(raceGrid);
    form.appendChild(vdotGrid);
    form.appendChild(actions);
    root.appendChild(form);
    root.appendChild(el("div", { id: "pw-results", "aria-live": "polite" }));
    return { form, select, custom, time, vdotIn, raceGrid, vdotGrid };
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

  function renderResults(vdot, race) {
    const results = document.getElementById("pw-results");
    results.textContent = "";

    // Headline
    const head = el("div", { class: "card accent pw-head" });
    head.appendChild(el("div", { class: "pw-vdot", text: "VDOT " + V.pyFixed(vdot, 1) }));
    if (race) {
      head.appendChild(el("div", { class: "pw-sub", text: race.label + " (" + V.pyFixed(race.meters, 0) + " m) in " + V.fmtRace(race.tMin) }));
    } else {
      head.appendChild(el("div", { class: "pw-sub", text: "entered directly " + EM_DASH + " see the caveats below on what a valid input is" }));
    }
    results.appendChild(head);

    // Training paces
    const paces = el("div", { class: "card" });
    paces.appendChild(el("h2", { text: "Training paces" }));
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
    for (const p of V.predictions(vdot, column)) {
      const time = el("td", { class: "num" }, [el("span", { text: p.text })]);
      if (p.extrapolated) time.appendChild(el("span", { class: "flag", text: PREDICTION_EXTRAPOLATION_LABEL }));
      ebody.appendChild(el("tr", { class: p.extrapolated ? "extrap" : "" }, [el("td", { text: NAMED[p.column][1] }), time]));
    }
    etable.appendChild(ebody);
    eq.appendChild(etable);
    if (!race) eq.appendChild(el("p", { class: "pw-foot", text: VDOT_MODE_NOTE }));
    results.appendChild(eq);
  }

  function calculate(ui) {
    clearError();
    if (currentMode(ui.form) === "vdot") {
      const vd = readVdot(ui);
      renderResults(vd, null);
      return;
    }
    const race = readRace(ui);
    if (V.pyStrip(ui.time.value) === "") throw new V.ValueError("Enter the race time as H:MM:SS or MM:SS.");
    const tMin = V.parseTime(ui.time.value);
    const vdot = V.vdotFromRace(race.meters, tMin);
    V.checkRenderable(vdot);
    race.tMin = tMin;
    renderResults(vdot, race);
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
