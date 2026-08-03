(function (global) {
  "use strict";
  const LOW = global.LOW = global.LOW || {};
  const animation = LOW.animation = LOW.animation || {};

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

  class SceneModel {
    constructor(data = {}) {
      this.version = 1;
      this.id = data.id || uid("scene");
      this.name = data.name || "Escena";
      this.fps = Math.max(1, Math.min(120, Number(data.fps) || 12));
      this.range = { in: 1, out: 0, ...(data.range || {}) };
      this.drawings = clone(data.drawings || {});
      this.levels = (data.levels || []).map((level, index) => this._level(level, index));
      this.camera = clone(data.camera || { keys: {} });
      this.audio = clone(data.audio || []);
      this.metadata = clone(data.metadata || {});
      this.revision = Number(data.revision) || 0;
    }

    _level(level, index) {
      return {
        id: level.id || uid("level"), name: level.name || `Nivel ${index + 1}`,
        visible: level.visible !== false, locked: !!level.locked,
        color: level.color || "#67aeb6", exposures: clone(level.exposures || [])
      };
    }

    touch() { this.revision += 1; return this; }
    snapshot() { return clone(this.toJSON()); }
    toJSON() {
      return { version: this.version, id: this.id, name: this.name, fps: this.fps,
        range: this.range, drawings: this.drawings, levels: this.levels,
        camera: this.camera, audio: this.audio, metadata: this.metadata,
        revision: this.revision };
    }

    static fromLegacy({ frames = [], levels = [], fps = 12, scene = {} } = {}) {
      const model = new SceneModel({ name: scene.name, fps, camera: { keys: scene.cam || {} } });
      model.metadata.legacyFrames = true;
      const names = levels.length ? levels : ["Dibujo"];
      model.levels = names.map((name, li) => model._level({ name, exposures: frames.map((path, i) => ({
        frame: i + 1, drawingId: path ? `${li}:${path}` : null, hold: false, path: path || null
      })) }, li));
      return model;
    }
  }

  class History {
    constructor(limit = 150) { this.limit = limit; this.undoStack = []; this.redoStack = []; }
    commit(label, before, after) {
      this.undoStack.push({ label, before: clone(before), after: clone(after) });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    undo(model) { const e = this.undoStack.pop(); if (!e) return model; this.redoStack.push(e); return new SceneModel(e.before); }
    redo(model) { const e = this.redoStack.pop(); if (!e) return model; this.undoStack.push(e); return new SceneModel(e.after); }
  }

  animation.SceneModel = SceneModel;
  animation.History = History;
  animation.clone = clone;
})(window);
