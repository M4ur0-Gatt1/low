(function (global) {
  "use strict";
  const animation = (global.LOW = global.LOW || {}).animation = global.LOW.animation || {};
  function buildPanelState({ frames = [], levels = [], current = 0, playing = false, fps = 12,
    perFrame = [], camera = {}, keys = [], displayCount = frames.length } = {}) {
    const cells = Array.from({ length: displayCount }, (_, i) => ({
      index: i, number: i + 1, exists: i < frames.length,
      name: frames[i] ? String(frames[i]).split(/[\\/]/).pop() : "",
      key: i < frames.length && keys.includes(i + 1), camera: !!camera[i + 1]
    }));
    return { frames: cells, levels: [...levels], current, playing: !!playing,
      fps: Math.max(1, +fps || 12), exposures: levels.map(level => cells.map((f, i) =>
        !!(f.exists && perFrame[i] && perFrame[i].has(level)))) };
  }
  function selection(anchor, index, extend) {
    if (!extend) return { anchor: index, from: index, to: index };
    const a = anchor == null ? index : anchor;
    return { anchor: a, from: Math.min(a, index), to: Math.max(a, index) };
  }
  animation.timeline = { buildPanelState, selection };
})(window);
