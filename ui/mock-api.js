/* ══ ARNÉS DE PRUEBAS — mock del puente pywebview ══
   Permite abrir la UI completa de LOW en un navegador común para probar y
   verificar (a mano o automatizado) sin la app Python:

     cd low && python -m http.server 8791
     → http://localhost:8791/ui/index.html?mock=1

   SOLO se activa con ?mock=1 en la URL: la app real (pywebview) jamás pasa
   query params, así que este archivo es inerte en producción.
   Cualquier método no listado devuelve una promesa vacía ({}). */
(function () {
  if (!new URLSearchParams(location.search).has("mock")) return;
  if (window.pywebview) return;

  // diseño de muestra: dos capas <g> con profundidad + una capa SUELTA
  // (el <path> superior) para poder probar el flujo "capa suelta" del 3D
  const SAMPLE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">' +
    '<g data-low="plano"><circle cx="540" cy="620" r="150" fill="#F0450E"/>' +
    '<rect x="300" y="760" width="480" height="40" fill="#171716"/></g>' +
    '<g data-low="plano" data-z="140"><rect x="330" y="330" width="420" height="260" fill="#33B5E8" opacity="0.85"/></g>' +
    '<path d="M 200 200 L 400 260 L 340 380 Z" fill="#F0A030"/>' +
    '</svg>';

  const STATE = {
    version: "mock", zoom: 1.0, theme: "dark",
    ws: "C:\\mock\\proyecto", branch: "", session_id: "mock",
    providers: [{ name: "mock", has_key: true }], provider: "mock",
    model: "mock-1", models: ["mock-1"], langs: ["python"], apis: 1,
    tree: [], routines: [], agent: {}, ssh_hosts: [], chain: [],
  };

  const impl = {
    log_js: m => console.log("[js→py]", m),
    get_state: async () => STATE,
    history: async () => [],
    ollama_models: async () => [],
    refresh_tree: async () => ({ tree: [] }),
    image_data: async path => ({ svg: SAMPLE_SVG, name: path || "mock.svg" }),
  };
  const noop = async () => ({});
  window.pywebview = { api: new Proxy(impl, {
    get: (t, k) => (k in t ? t[k] : noop),
  }) };
  window.__MOCK__ = true;
  // app.js registra su listener al parsear; disparar recién con la página cargada
  const fire = () => window.dispatchEvent(new Event("pywebviewready"));
  if (document.readyState === "complete") setTimeout(fire, 0);
  else window.addEventListener("load", () => setTimeout(fire, 0));
})();
