"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const memory = new Map();
const context = { console, setInterval, clearInterval, performance: { now: () => Date.now() },
  localStorage: { getItem: k => memory.get(k) || null, setItem: (k, v) => memory.set(k, v) } };
context.window = context;
vm.createContext(context);
[
  "ui/core/history.js",
  "ui/animation/scene-model.js", "ui/animation/exposures.js", "ui/animation/timeline.js",
  "ui/animation/xsheet.js", "ui/animation/playback.js", "ui/animation/camera.js",
  "ui/drawing/stabilization.js", "ui/drawing/pointer-input.js", "ui/drawing/brushes.js",
  "ui/drawing/stroke-engine.js", "ui/workspace/panels.js", "ui/workspace/windows.js",
  "ui/workspace/layouts.js", "ui/workspace/recovery.js", "ui/ai/commands.js", "ui/ai/task-runner.js", "ui/ai/recovery.js"
].forEach(file => vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file }));

const { core, animation, drawing, workspace, ai } = context.LOW;
let documentValue = "b";
const history = new core.HistoryManager();
history.push({ label: "trazo", before: "a", after: null, capture: () => documentValue,
  apply: (_direction, value) => { documentValue = value; } });
assert(history.undo()); assert.equal(documentValue, "a");
assert(history.redo()); assert.equal(documentValue, "b");
let scene = new animation.SceneModel({ fps: 24, levels: [{ id: "ink", name: "Tinta" }] });
assert.equal(scene.fps, 24);
assert(animation.exposures.set(scene, "ink", 1, "drawing-a"));
animation.exposures.insert(scene, 1, 2);
assert.equal(scene.levels[0].exposures[0].frame, 3);
animation.exposures.remove(scene, 1, 1);
assert.equal(scene.levels[0].exposures[0].frame, 2);

const state = animation.timeline.buildPanelState({ frames: ["a.svg", "b.svg"], levels: ["ink"],
  current: 1, perFrame: [new Set(["ink"]), new Set(["ink"])], displayCount: 4 });
assert.equal(state.frames.length, 4); assert.equal(state.frames[2].exists, false);
assert.equal(animation.xsheet.rows(state).length, 2);
assert.equal(Math.round(animation.camera.sample({ 1: { x: 0 }, 3: { x: 10 } }, 2).x), 5);

const brush = drawing.brushes.get("animation-pencil");
const penSample = drawing.pointerSample({ clientX: 4, clientY: 7, pointerType: "pen", pressure: .6,
  tiltX: 20, tiltY: -10, twist: 45, buttons: 1, timeStamp: 3 });
assert.equal(penSample.pressure, .6); assert.equal(penSample.tiltX, 20); assert.equal(penSample.twist, 45);
const stroke = new drawing.StrokeEngine(brush); stroke.start({ x: 0, y: 0, pressure: .2 });
stroke.add({ x: 10, y: 10, pressure: .8 }); assert(stroke.points.length >= 2);
assert(drawing.brushes.all().length >= 10);

workspace.panels.register("timeline", { dock: "bottom" }); workspace.panels.detach("timeline");
assert.equal(workspace.panels.panels.get("timeline").detached, true);
workspace.panels.dock("timeline"); assert.equal(workspace.panels.panels.get("timeline").detached, false);

let calls = 0; ai.commands.define("test", { required: ["value"] }, async p => { calls++; return p.value; });
const runner = new ai.TaskRunner({ repeatLimit: 1, maxRetries: 0 });
runner.run([{ name: "test", payload: { value: 1 } }]).then(result => {
  assert.equal(result.status, "complete"); assert.equal(calls, 1);
  return runner.run([{ name: "test", payload: { value: 1 } }, { name: "test", payload: { value: 1 } }]);
}).then(result => { assert.equal(result.status, "blocked-loop"); console.log("LOW modular cores: OK"); })
  .catch(error => { console.error(error); process.exitCode = 1; });
