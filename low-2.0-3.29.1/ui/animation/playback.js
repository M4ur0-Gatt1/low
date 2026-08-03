(function (global) {
  "use strict";
  const animation = (global.LOW = global.LOW || {}).animation = global.LOW.animation || {};
  class PlaybackController {
    constructor(onFrame) { this.onFrame = onFrame || (() => {}); this.timer = null; this.index = 0; }
    play({ from = 0, to = 0, fps = 12, loop = true, index = from } = {}) {
      this.stop(); this.index = Math.max(from, Math.min(to, index));
      this.timer = setInterval(() => { this.index += 1; if (this.index > to) {
        if (!loop) return this.stop(); this.index = from; } this.onFrame(this.index); }, 1000 / Math.max(1, fps));
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
    get playing() { return this.timer != null; }
  }
  animation.PlaybackController = PlaybackController;
})(window);
