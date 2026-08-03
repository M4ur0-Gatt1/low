(function (global) {
  "use strict";
  const workspace = (global.LOW = global.LOW || {}).workspace = global.LOW.workspace || {};
  class DocumentRecovery {
    constructor(storage = global.localStorage) { this.storage = storage; this.prefix = "low.document.recovery."; this.timers = new Map(); }
    key(path) { let hash = 2166136261; for (const c of String(path)) { hash ^= c.charCodeAt(0); hash = Math.imul(hash, 16777619); }
      return this.prefix + (hash >>> 0).toString(36); }
    checkpoint(path, content, metadata = {}) { if (!path || !content || content.length > 2_500_000) return false;
      clearTimeout(this.timers.get(path)); this.timers.set(path, setTimeout(() => { try {
        this.storage?.setItem(this.key(path), JSON.stringify({ path, content, metadata, savedAt: Date.now() }));
      } catch (_) {} }, 450)); return true; }
    get(path) { try { const value = JSON.parse(this.storage?.getItem(this.key(path)) || "null"); return value?.path === path ? value : null; } catch (_) { return null; } }
    clear(path) { clearTimeout(this.timers.get(path)); this.timers.delete(path); try { this.storage?.removeItem(this.key(path)); } catch (_) {} }
  }
  workspace.recovery = new DocumentRecovery();
})(window);
