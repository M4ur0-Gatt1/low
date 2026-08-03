(function (global) {
  "use strict";
  const workspace = (global.LOW = global.LOW || {}).workspace = global.LOW.workspace || {};
  class PanelManager {
    constructor(storage = global.localStorage) { this.panels = new Map(); this.listeners = new Set(); this.storage = storage; this.key = "low.panels.v1"; }
    saved() { try { return JSON.parse(this.storage?.getItem(this.key) || "{}"); } catch (_) { return {}; } }
    register(id, config = {}) { const previous = this.saved()[id] || {}; const panel = { id, dock: config.dock || "right", visible: config.visible !== false,
      detached: false, size: config.size || null, element: config.element || null, ...config, ...previous };
      // Las ventanas nativas no sobreviven al cierre: se restauran acopladas.
      panel.detached = false; this.panels.set(id, panel); return panel; }
    update(id, patch) { const p = this.panels.get(id); if (!p) return null; Object.assign(p, patch); this.emit(id); return p; }
    detach(id) { return this.update(id, { detached: true, visible: true }); }
    dock(id, dock) { return this.update(id, { detached: false, dock: dock || this.panels.get(id)?.dock || "right", visible: true }); }
    hide(id) { return this.update(id, { visible: false }); }
    show(id) { return this.update(id, { visible: true }); }
    snapshot() { return [...this.panels.values()].map(({ element, ...p }) => ({ ...p })); }
    restore(list = []) { list.forEach(x => this.panels.has(x.id) && this.update(x.id, x)); }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(id) { const snapshot = this.snapshot(); const serial = Object.fromEntries(snapshot.map(p => [p.id, p]));
      try { this.storage?.setItem(this.key, JSON.stringify(serial)); } catch (_) {}
      this.listeners.forEach(fn => fn(this.panels.get(id), snapshot)); }
  }
  workspace.PanelManager = PanelManager; workspace.panels = new PanelManager();
})(window);
