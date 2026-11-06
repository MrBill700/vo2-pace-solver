// Startup regression test for web/widget.js (issue #4): a missing or stale vdot.js must
// show the startup fallback, never throw out of the script or leave a blank calculator.
// Runs widget.js in a VM against a minimal fake DOM.  Usage: node tools/widget-startup-test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web");
const WIDGET = fs.readFileSync(path.join(WEB, "widget.js"), "utf8");
const REAL = require(path.join(WEB, "vdot.js"));
const FALLBACK = /could not start/;

function fakeDocument() {
  const byId = {};
  function make(tag) {
    const node = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, className: "", hidden: false, value: "",
      _text: "",
      get textContent() { return this._text + this.children.map(c => c.textContent).join(""); },
      set textContent(t) { this._text = String(t); this.children = []; },
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") byId[v] = this; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      addEventListener() {}, focus() {}, querySelector() { return null; }
    };
    return node;
  }
  const doc = {
    createElement: make,
    createTextNode: t => ({ textContent: String(t), children: [] }),
    getElementById: id => byId[id] || null
  };
  make("div").setAttribute("id", "pace-widget");
  make("div").setAttribute("id", "pw-caveats");
  return doc;
}

function start(vdot) {
  const document = fakeDocument();
  const window = vdot === undefined ? {} : { VDOT: vdot };
  vm.runInNewContext(WIDGET, { window, document }, { filename: "widget.js" });  // throws = test failure
  return document.getElementById("pace-widget");
}

function without(names) {
  const copy = Object.assign({}, REAL);
  names.forEach(n => delete copy[n]);
  return copy;
}

// True when some node under `node` has exactly this class string.
const has = (node, cls) => node.className === cls || (node.children || []).some(c => has(c, cls));

let failed = 0;
function check(name, fn) {
  let ok = false, why = "";
  try { ok = fn(); } catch (e) { why = " (threw: " + e.message + ")"; }
  console.log("  [" + (ok ? "PASS" : "FAIL") + "] " + name + why);
  if (!ok) failed += 1;
}

check("normal vdot.js: form builds with youth and plan rows, no fallback", () => {
  const root = start(REAL);
  return root.children.length > 0 && !FALLBACK.test(root.textContent) &&
    has(root, "pw-youth-row") && has(root, "pw-grid pw-plan-row");
});
check("window.VDOT absent: fallback shown, no throw", () => FALLBACK.test(start(undefined).textContent));
check("vdot.js without pyFixed: fallback shown, no throw", () => FALLBACK.test(start(without(["pyFixed"])).textContent));
check("vdot.js without checkRenderable: fallback shown", () =>
  FALLBACK.test(start(without(["checkRenderable"])).textContent));
check("vdot.js without youthNextLevel: starts, youth toggle hidden", () => {
  const root = start(without(["youthNextLevel"]));
  return !FALLBACK.test(root.textContent) && !has(root, "pw-youth-row") && has(root, "pw-grid pw-plan-row");
});
check("vdot.js without whitePhaseForWeek: starts, plan picker hidden", () => {
  const root = start(without(["whitePhaseForWeek"]));
  return !FALLBACK.test(root.textContent) && has(root, "pw-youth-row") && !has(root, "pw-grid pw-plan-row");
});

// Issue #7: the distance select is built from V.DISTANCES, so each option's column and
// meters must match DISTANCES, in order, with only "custom" added at the end.
const find = (node, pred) => pred(node) ? node : (node.children || []).reduce((hit, c) => hit || find(c, pred), null);
check("distance options match V.DISTANCES column by column", () => {
  const select = find(start(REAL), n => n.attrs && n.attrs.id === "pw-dist");
  const opts = select.children.filter(o => o.attrs.value !== "custom");
  return opts.length === REAL.DISTANCES.length && select.children[select.children.length - 1].attrs.value === "custom" &&
    opts.every((o, i) => o.attrs["data-column"] === String(i) &&
      Math.abs(REAL.parseDist(o.attrs.value) - REAL.DISTANCES[i][1]) < 1e-9);
});
check("a DISTANCES entry with no label shows the fallback", () => {
  const v = Object.assign({}, REAL, { DISTANCES: REAL.DISTANCES.concat([["50k", 50000.0]]) });
  return FALLBACK.test(start(v).textContent);
});

console.log(failed ? failed + " startup check(s) FAILED" : "all startup checks passed");
process.exit(failed ? 1 : 0);
