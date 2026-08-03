(function (global) {
  "use strict";
  const drawing = (global.LOW = global.LOW || {}).drawing = global.LOW.drawing || {};
  const defaults = [
    ["animation-pencil", "Lápiz de animación", { size: 3, opacity: .72, pressureSize: .55, smoothing: .28, texture: "graphite" }],
    ["blue-pencil", "Lápiz azul", { size: 3, opacity: .6, color: "#4b8de8", pressureSize: .5, smoothing: .3 }],
    ["red-pencil", "Lápiz rojo", { size: 3, opacity: .6, color: "#df5d57", pressureSize: .5, smoothing: .3 }],
    ["clean-ink", "Tinta limpia", { size: 7, opacity: 1, pressureSize: .82, smoothing: .45 }],
    ["technical-ink", "Tinta técnica", { size: 3, opacity: 1, pressureSize: .08, smoothing: .25 }],
    ["dry-brush", "Pincel seco", { size: 20, opacity: .8, pressureSize: .55, spacing: .12, texture: "dry" }],
    ["charcoal", "Carboncillo", { size: 24, opacity: .5, pressureSize: .65, spacing: .08, texture: "charcoal" }],
    ["airbrush", "Aerógrafo", { size: 48, opacity: .18, pressureOpacity: .75, hardness: .05 }],
    ["marker", "Marcador", { size: 18, opacity: .62, pressureSize: .12, hardness: .7 }],
    ["soft-eraser", "Borrador suave", { size: 40, opacity: .45, eraser: true, hardness: .08 }]
  ];
  class BrushLibrary {
    constructor(storage = global.localStorage) { this.storage = storage; this.presets = new Map(defaults.map(([id, name, settings]) => [id, { id, name, ...settings }])); this.load(); }
    get(id) { return this.presets.get(id); }
    all() { return [...this.presets.values()]; }
    save(preset) { if (!preset || !preset.id) throw Error("El pincel necesita id"); this.presets.set(preset.id, { ...preset }); this.persist(); }
    remove(id) { if (defaults.some(x => x[0] === id)) return false; const ok = this.presets.delete(id); this.persist(); return ok; }
    persist() { try { this.storage?.setItem("low.brushes.v1", JSON.stringify(this.all().filter(x => !defaults.some(d => d[0] === x.id)))); } catch (_) {} }
    load() { try { (JSON.parse(this.storage?.getItem("low.brushes.v1") || "[]") || []).forEach(x => this.presets.set(x.id, x)); } catch (_) {} }
  }
  drawing.BrushLibrary = BrushLibrary; drawing.brushes = new BrushLibrary();
})(window);
