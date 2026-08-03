(function (global) {
  "use strict";
  const animation = (global.LOW = global.LOW || {}).animation = global.LOW.animation || {};
  const clone = animation.clone || (v => JSON.parse(JSON.stringify(v)));

  function level(scene, id) { return scene.levels.find(x => x.id === id) || scene.levels[Number(id)]; }
  function normalize(exposures) {
    return (exposures || []).filter(Boolean).map(e => ({ frame: Math.max(1, +e.frame || 1),
      drawingId: e.drawingId || null, hold: !!e.hold, path: e.path || null }))
      .sort((a, b) => a.frame - b.frame);
  }
  function at(scene, levelId, frame) {
    const l = level(scene, levelId); if (!l) return null;
    const rows = normalize(l.exposures).filter(e => e.frame <= frame);
    return rows.length ? rows[rows.length - 1] : null;
  }
  function set(scene, levelId, frame, drawingId, options = {}) {
    const l = level(scene, levelId); if (!l || l.locked) return false;
    l.exposures = normalize(l.exposures).filter(e => e.frame !== frame);
    l.exposures.push({ frame, drawingId: drawingId || null, hold: !!options.hold, path: options.path || null });
    l.exposures = normalize(l.exposures); scene.touch(); return true;
  }
  function insert(scene, frame, count = 1) {
    count = Math.max(1, +count || 1);
    scene.levels.forEach(l => l.exposures.forEach(e => { if (e.frame >= frame) e.frame += count; }));
    scene.touch(); return scene;
  }
  function remove(scene, from, count = 1) {
    const to = from + Math.max(1, +count || 1) - 1;
    scene.levels.forEach(l => { l.exposures = normalize(l.exposures)
      .filter(e => e.frame < from || e.frame > to)
      .map(e => ({ ...e, frame: e.frame > to ? e.frame - count : e.frame })); });
    scene.touch(); return scene;
  }
  function moveBlock(scene, selection, deltaFrame, targetLevel) {
    const copy = clone(selection); const moved = [];
    copy.forEach(cell => { const src = level(scene, cell.levelId); if (!src || src.locked) return;
      const exposure = src.exposures.find(e => e.frame === cell.frame); if (!exposure) return;
      src.exposures = src.exposures.filter(e => e !== exposure);
      moved.push({ ...exposure, frame: Math.max(1, exposure.frame + deltaFrame),
        levelId: targetLevel == null ? cell.levelId : targetLevel }); });
    moved.forEach(e => { const dest = level(scene, e.levelId); if (dest && !dest.locked) {
      dest.exposures = dest.exposures.filter(x => x.frame !== e.frame); dest.exposures.push(e); dest.exposures = normalize(dest.exposures); } });
    scene.touch(); return moved;
  }
  animation.exposures = { normalize, at, set, insert, remove, moveBlock };
})(window);
