/* LOW — frontend. Toda la lógica pesada vive en Python (main.py, js_api). */
"use strict";

const $ = s => document.querySelector(s);
const CM_MODE = { python: "python", javascript: "javascript", bash: "shell", powershell: "powershell" };
// modo de resaltado por extensión (independiente del lenguaje del runner)
const MODE_BY_EXT = {
  ".py": "python", ".js": "javascript", ".ts": "javascript", ".jsx": "javascript",
  ".tsx": "javascript", ".json": "javascript", ".sh": "shell", ".ps1": "powershell",
  ".html": "htmlmixed", ".htm": "htmlmixed", ".css": "css", ".xml": "xml",
};
const extOf = p => { const m = /\.[^.\\/]+$/.exec(p || ""); return m ? m[0].toLowerCase() : ""; };
const esHtml = t => (t && t.path && /\.html?$/i.test(t.path)) ||
                    /^\s*(<!doctype html|<html)/i.test(cm ? cm.getValue() : "");
// lenguaje del RUNNER por extensión (para ▶ Ejecutar en modo "auto")
const RUN_LANG_BY_EXT = {
  ".py": "python", ".js": "javascript", ".mjs": "javascript", ".ts": "typescript",
  ".sh": "bash", ".bash": "bash", ".ps1": "powershell", ".go": "go", ".rb": "ruby",
  ".php": "php", ".pl": "perl", ".lua": "lua", ".r": "r",
};
// idioma efectivo: si el usuario forzó uno lo respeta; si está en "auto",
// lo deduce de la extensión del archivo abierto (default python)
function effectiveLang() {
  const sel = $("#selLang") ? $("#selLang").value : "auto";
  if (sel && sel !== "auto") return sel;
  const t = curTab();
  return RUN_LANG_BY_EXT[extOf(t && t.path)] || "python";
}
// modo de resaltado del editor según selección/archivo
function applyEditorMode() {
  const sel = $("#selLang") ? $("#selLang").value : "auto";
  const t = curTab();
  const mode = (sel && sel !== "auto")
    ? (CM_MODE[sel] || "python")
    : (MODE_BY_EXT[extOf(t && t.path)] || "python");
  cm && cm.setOption("mode", mode);
}

let api = null;
let cm = null;
const S = {
  theme: "dark", tabs: [], cur: null, untitled: 0,
  ws: null, providers: [], pending: null, plan: null, loading: false,
  expanded: new Set(), zoom: 1.0,
  chats: [], chatId: null, agent: {},
  attachedImage: null,   // {data, mime, name} pendiente de enviar (visión)
};
const icoUse = name => `<svg class="ico"><use href="#${name}"/></svg>`;

/* ── errores SIEMPRE visibles: en el chat y en %APPDATA%/LOW/low.log ── */
window.__errs = [];
function reportErr(msg) {
  window.__errs.push(msg);
  try { if (api) api.log_js(msg); } catch (e) { /* sin puente */ }
  try { sysMsg("❌ Error interno: " + msg); } catch (e) { /* UI no lista */ }
}
window.addEventListener("error", e =>
  reportErr(`${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", e => {
  const reason = e.reason && e.reason.message || e.reason;
  if (reason && reason.includes("No hay workspace abierto")) {
    showNoWorkspace();
  } else {
    reportErr("promesa rechazada: " + reason);
  }
});

/* ── eventos que empuja Python ── */
window.LOW = {
  onPy(m) {
    try {
      if (m.event === "propose") propose(m.data.code);
      if (m.event === "status") setStatus(m.data);
      if (m.event === "sys") { sysMsg(m.data); persist("system", m.data); }
      if (m.event === "ws") setWs(m.data);
      if (m.event === "wrote") onWrote(m.data.path, m.data.range);
      if (m.event === "think_start") { stopThinking(); setStatus("💭 Razonando…"); planDone(); S.thinkEl = thinkMsg(); }
      if (m.event === "think_delta" && S.thinkEl) { S.thinkEl.querySelector(".think-body").textContent += m.data; scrollMsgs(); }
      if (m.event === "think_end" && S.thinkEl) {
        S.thinkEl.classList.add("done", "collapsed");
        S.thinkEl.querySelector(".think-toggle").textContent = "mostrar";
        S.thinkEl.querySelector(".think-head").firstChild.textContent = "💭 Pensó unos instantes ";
        S.thinkEl = null;
      }
      if (m.event === "agent_start") { stopThinking(); setStatus("✍ Escribiendo…"); planDone(); S.streamEl = agentMsg("").querySelector(".m-txt"); }
      if (m.event === "agent_delta" && S.streamEl) { S.streamEl.textContent += m.data; scrollMsgs(); }
      if (m.event === "agent_end") S.streamEl = null;
      if (m.event === "tool") {
        stopThinking();
        // Mostrar detalles de la herramienta que se está usando
        const toolName = m.data.name;
        const toolRes = m.data.res;
        const fileName = m.data.file || "";
        let toolDesc = "";
        if (toolName === "read_file") toolDesc = `📖 Leyendo ${fileName}`;
        else if (toolName === "write_file") toolDesc = `✏️ Escribiendo ${fileName}`;
        else if (toolName === "edit_file") toolDesc = `✏️ Editando ${fileName}`;
        else if (toolName === "exec_cmd") toolDesc = "⚡ Ejecutando comando";
        else if (toolName === "run_code") toolDesc = "▶ Ejecutando código";
        else if (toolName === "list_files") toolDesc = "📁 Listando archivos";
        else if (toolName === "search_code") toolDesc = "🔍 Buscando código";
        else if (toolName === "generate_image") toolDesc = "🖼 Generando imagen";
        else if (toolName === "ask_model") toolDesc = "🤝 Consultando otro modelo";
        else if (toolName === "web_search") toolDesc = "🌐 Buscando en la web";
        else if (toolName === "git") toolDesc = "⎇ git";
        else toolDesc = `🔧 ${toolName}`;
        setStatus(toolDesc);
        // indicador persistente (heartbeat) + paso en la tarjeta de actividad
        // (persistente, ya no un mensaje que desaparece a los 3s)
        setWorkingOn(fileName ? `${toolDesc} ${fileName}` : toolDesc);
        toolStep(toolDesc, toolRes);
      }
    } catch (e) { reportErr("onPy(" + m.event + "): " + e.message); }
  },
};

/* ── rasterizar SVG → PNG dataURL (para que el modelo "vea" lo que dibujó) ──
   Lo llama Python por evaluate_js y sondea window.__raster hasta que esté listo.
   Sentinela: "PENDING" mientras carga, "data:..." si salió, "ERR:..." si falló.
   Es async (decodificar la imagen), por eso el patrón de polling. */
window.__raster = "IDLE";
window.rasterizeSVG = function (svg, maxPx) {
  window.__raster = "PENDING";
  try {
    // asegurar width/height (si solo hay viewBox, naturalWidth puede ser 0)
    let s = svg;
    if (!/<svg[^>]*\bwidth=/.test(s)) {
      const vb = /viewBox\s*=\s*["']([\d.\-\s]+)["']/.exec(s);
      if (vb) {
        const p = vb[1].trim().split(/\s+/);
        if (p.length === 4) s = s.replace(/<svg/, `<svg width="${p[2]}" height="${p[3]}"`);
      }
    }
    const blob = new Blob([s], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () {
      try {
        const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
        const cap = maxPx || 1024;
        const scale = Math.min(1, cap / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        const c = document.createElement("canvas"); c.width = cw; c.height = ch;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cw, ch);   // fondo blanco
        ctx.drawImage(img, 0, 0, cw, ch);
        window.__raster = c.toDataURL("image/png");
      } catch (e) { window.__raster = "ERR:" + e.message; }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { window.__raster = "ERR:no pude cargar el SVG"; URL.revokeObjectURL(url); };
    img.src = url;
  } catch (e) { window.__raster = "ERR:" + e.message; }
};

/* ── redimensionar/recortar imagen a un tamaño exacto (redes sociales) ──
   'cover': escala para llenar w×h y recorta centrado (lo estándar para feeds).
   Mismo patrón async+polling que rasterizeSVG. Convierte el dataURL a Blob
   para no ensuciar (taint) el canvas y poder exportarlo. */
window.__fit = "IDLE";
window.fitImage = function (dataUrl, w, h) {
  window.__fit = "PENDING";
  try {
    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(0, comma), b64 = dataUrl.slice(comma + 1);
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || "image/png";
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: mime }));
    const img = new Image();
    img.onload = function () {
      try {
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
        const iw = img.naturalWidth || w, ih = img.naturalHeight || h;
        const scale = Math.max(w / iw, h / ih);          // cover
        const dw = iw * scale, dh = ih * scale;
        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        window.__fit = c.toDataURL("image/png");
      } catch (e) { window.__fit = "ERR:" + e.message; }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { window.__fit = "ERR:no pude cargar la imagen"; URL.revokeObjectURL(url); };
    img.src = url;
  } catch (e) { window.__fit = "ERR:" + e.message; }
};

/* ── menú contextual del chat (copiar) ──
   pywebview apaga el menú nativo del navegador salvo --debug (para no exponer
   "Inspeccionar" a usuarios finales), y con eso también se llevó puesto el
   "Copiar" de toda la vida. Este es chiquito y solo vive dentro de #msgs. */
let ctxMenu = null;
function closeCtxMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("#msgs")) return;
  e.preventDefault();
  closeCtxMenu();
  const sel = window.getSelection().toString();
  const bubble = e.target.closest(".m-user, .m-txt, .m-sys, .step, .card-b, .think-body");
  const text = sel || (bubble ? bubble.textContent : "");
  if (!text) return;
  ctxMenu = document.createElement("div");
  ctxMenu.className = "ctx-menu";
  ctxMenu.innerHTML = '<div class="ctx-item">Copiar</div>';
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 150) + "px";
  ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 50) + "px";
  ctxMenu.querySelector(".ctx-item").onclick = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    closeCtxMenu();
  };
  document.body.appendChild(ctxMenu);
});
document.addEventListener("click", closeCtxMenu);
document.addEventListener("scroll", closeCtxMenu, true);
window.addEventListener("blur", closeCtxMenu);

window.addEventListener("pywebviewready", () =>
  init().catch(e => reportErr("init: " + (e.message || e))));

async function init() {
  api = window.pywebview.api;
  cm = CodeMirror($("#cmwrap"), {
    lineNumbers: true, mode: "python", indentUnit: 4, tabSize: 4,
    autoCloseBrackets: true, styleActiveLine: true, scrollbarStyle: "native",
  });
  cm.on("cursorActivity", updateLnCol);
  cm.on("change", () => {
    if (S.loading) return;
    const t = curTab();
    if (t && !t.modified) { t.modified = true; renderTabs(); renderTree(); }
  });

  const st = await api.get_state();
  applyState(st);
  newTab();
  await loadChatTabs().catch(() => {});
  // retomar SOLA la última conversación: al reabrir LOW seguís donde quedaste,
  // con el agente recordando el hilo (antes arrancaba con memoria vacía y decía
  // "no tengo contexto de una sesión previa")
  try {
    const last = (S.chats || []).find(c => c.n > 0);
    if (last) await resume(last.id);
  } catch (e) { /* sin historial: charla nueva */ }
  bind();
  restorePanelSizes();
  initSplitters();
  sysMsg("LOW v" + (S.version || "?") + " — listo.\n" +
         "⚙ API keys · 📁 proyecto · 🔎 junto al modelo: buscador entre todos los modelos de la API.\n" +
         "barra izquierda: ✒ Diseño (editor de vectores SVG), 🧊 Artefactos (vista previa en vivo), " +
         "⟳ Rutinas, 🔧 Herramientas, 🖧 Servidores SSH, ⟲ Historial, ▦ Ranking.\n" +
         "El agente sabe git, ssh y scp: pedile «subí esto a github» o «entrá al server X y…».\n" +
         "Aprende solo: /habilidades y /lecciones (global) y /memoria (de este proyecto).\n" +
         "Comandos: /commit /push /git /ssh /compare /ranking /undo /history /resume /run /files /search /preview /habilidades /lecciones /memoria · Zoom Ctrl +/−/0");
  api.log_js("init ok · zoom=" + S.zoom + " · figtree=" +
             document.fonts.check("12px Figtree") + " · jbmono=" +
             document.fonts.check("12px 'JetBrains Mono'"));
  // Ollama: si corre localmente, ofrecer sus modelos en el proveedor 'custom'
  api.ollama_models().then(ms => {
    if (ms && ms.length) {
      S.ollama = ms;
      sysMsg("🦙 Ollama detectado (" + ms.length + " modelos locales, sin límites ni filtros): " +
             "elegí el proveedor «custom» para usarlos — " + ms.slice(0, 4).join(", "));
    }
  }).catch(() => {});
}

function setWs(d) {
  S.ws = d.ws; S.tree = d.tree; S.expanded = new Set();
  $("#projName").textContent = d.ws.split(/[\\/]/).pop().toUpperCase();
  $("#branch").textContent = d.branch ? "⑂ " + d.branch : "";
  renderTree();
  sysMsg("📁 Workspace: " + d.ws);
  persist("system", "📁 Workspace: " + d.ws);
}

function showNoWorkspace() {
  sysMsg("⚠️ No hay workspace abierto. Abre una carpeta de proyecto para comenzar.");
  $("#projName").textContent = "SIN PROYECTO";
  $("#branch").textContent = "";
  S.ws = null;
  S.tree = [];
  renderTree();
}

const SVG_RE = /\.svg$/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const DOC_RE = /\.(docx|pdf|mp4|webm)$/i;   // se abren con su app (Word, PDF, reproductor)

async function onWrote(path, range) {
  const r = await api.refresh_tree();
  S.tree = r.tree;
  renderTree();
  if (SVG_RE.test(path)) {          // vectores → entorno de diseño interactivo
    await openDesign(path);
    return;
  }
  if (IMG_RE.test(path)) {          // raster → visor + miniatura en el chat
    await openImage(path, true);
    return;
  }
  if (DOC_RE.test(path)) return;    // .docx/.pdf: quedan en el árbol, clic los abre
  await openFile(path, range);   // mostrar lo que editó, resaltando el cambio en vivo
  // si el agente generó una página web, registrarla como artefacto y mostrarla en vivo
  if (/\.html?$/i.test(path)) {
    const a = await api.artifact_content(path);
    if (a && a.content) { addArtifact(a.name, a.content, path); showArtifacts(); }
  }
}

function applyZoom(z, quiet) {
  S.zoom = Math.min(2, Math.max(0.7, Math.round(z * 100) / 100));
  document.documentElement.style.zoom = S.zoom;
  // el zoom escala los px pero no el viewport: compensar la altura del layout
  // para que el pie y la caja del chat sigan entrando en pantalla
  $("#app").style.height = S.zoom === 1 ? "100vh" : `calc(100vh / ${S.zoom})`;
  if (!quiet) {
    api.set_zoom(S.zoom);
    setStatus("Zoom " + Math.round(S.zoom * 100) + "%");
  }
  cm && cm.refresh();
}

/* helper: limpia el sufijo " (media)" del nombre visible del provider */
function providerName(visible) {
  return (visible || "").replace(/ \(media\)$/, "");
}

function applyState(st) {
  S.theme = st.theme; S.ws = st.ws; S.providers = st.providers;
  S.sysPrompt = st.system_prompt || "";
  S.defaultSp = st.default_sp || "";
  S.agentTools = st.tools || [];
  S.routines = st.routines || [];
  S.agent = st.agent || {};
  S.sshHosts = st.ssh_hosts || [];
  if (st.session_id) S.chatId = st.session_id;
  S.version = st.version || "";
  S.chain = st.chain || [];
  if (st.version) $("#ver").textContent = "LOW v" + st.version;
  applyZoom(st.zoom || 1.0, true);
  document.body.classList.toggle("light", st.theme === "light");
  $("#btnTheme").innerHTML = icoUse(st.theme === "dark" ? "i-sun" : "i-moon");
  // mostrar TODOS los providers; los media-only llevan etiqueta "(media)" para distinguirlos
  const allNames = st.providers.map(p => p.media_only ? p.name + " (media)" : p.name);
  const curProv = (st.providers.find(p => p.name === st.provider) || {}).media_only
    ? st.provider + " (media)" : st.provider;
  fillSelect($("#selProv"), allNames, curProv);
  fillSelect($("#selModel"), st.models, st.model);
  fillSelect($("#selLang"), ["auto", ...(st.langs || [])], "auto");
  S.tree = st.tree || [];
  $("#projName").textContent = st.ws ? st.ws.split(/[\\/]/).pop().toUpperCase() : "SIN PROYECTO";
  $("#branch").textContent = st.branch ? "⑂ " + st.branch : "";
  updApis(st);
  updChainBadge();
  renderTree();
}

function updApis(st) {
  const n = st.apis;
  $("#apiTxt").textContent = `${n} API${n === 1 ? "" : "s"} conectada${n === 1 ? "" : "s"}`;
  $("#apiDot").classList.toggle("off", !n);
  const p = S.providers.find(x => x.name === providerName($("#selProv").value));
  const ok = p && (p.has_key || p.name === "custom");
  $("#agBadge").textContent = ok ? "activo" : "sin key";
  $("#agBadge").classList.toggle("off", !ok);
  $("#provDot").classList.toggle("off", !ok);
}

function updChainBadge() {
  const chain = S.chain || [];
  if (chain.length <= 1) {
    $("#provDot").title = "Sin failover — solo hay un proveedor con key";
    return;
  }
  const parts = chain.map((c, i) => 
    (i === 0 ? "⚡ " : "🔄 ") + c.provider + " · " + (c.model || "default"));
  $("#provDot").title = "Cadena de failover:\n" + parts.join("\n");
  // el dot parpadea en naranja si el activo NO es el primero de la cadena (failover ya ocurrió)
  const activeOk = chain.length > 0 && chain[0].provider === providerName($("#selProv").value);
  $("#provDot").classList.toggle("warn", !activeOk && chain.length > 0);
}

function updateChatHeader() {
  // Actualiza el encabezado de quién responde en la UI (barra superior)
  const prov = $("#selProv").value || "";
  const model = $("#selModel").value || "";
  $("#agBadge").textContent = prov && model ? prov + " · " + model : "sin key";
}

function fillSelect(sel, values, cur) {
  sel.innerHTML = "";
  if (!values || !Array.isArray(values)) {
    values = [];
  }
  for (const v of values) {
    const o = document.createElement("option");
    o.value = o.textContent = v;
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

/* ── bindings ── */
function bind() {
  $("#btnTheme").onclick = async () => {
    S.theme = S.theme === "dark" ? "light" : "dark";
    document.body.classList.toggle("light", S.theme === "light");
    $("#btnTheme").innerHTML = icoUse(S.theme === "dark" ? "i-sun" : "i-moon");
    await api.set_theme(S.theme);
  };
  $("#selProv").onchange = async () => {
    const name = providerName($("#selProv").value);
    const st = await api.set_provider(name);
    if (st) {
      fillSelect($("#selModel"), st.models || [], st.model);
      S.providers = st.providers || [];
      S.chain = st.chain || [];
      updApis(st);
      updChainBadge();
      // Reflejar el cambio en el encabezado del chat
      updateChatHeader();
    }
  };
  $("#selModel").onchange = () => {
    api.set_model($("#selModel").value);
    updateChatHeader();
  };
  $("#btnModelSearch").onclick = modalModelSearch;
  $("#abDesign").onclick = designEntry;
  $("#btnKeys").onclick = modalKeys;
  $("#btnCmp").onclick = modalCompare;
  $("#btnWs").onclick = pickWs;
  $("#btnOpen").onclick = openDialog;
  $("#btnSave").onclick = save;
  $("#btnRun").onclick = run;
  $("#btnSend").onclick = () => { if (S.busy) cancelRequest(); else send(); };
  $("#btnAttach").onclick = attachImageDialog;
  $("#imgPreviewClear").onclick = clearAttachedImage;
  $("#inp").addEventListener("paste", onPasteImage);
  $("#btnHist").onclick = history_;
  $("#btnNew").onclick = newChat;
  $("#termTog").onclick = () => {
    const t = $("#term");
    t.classList.toggle("closed");
    $("#splitTerm").hidden = t.classList.contains("closed");
    $("#termTog").innerHTML = icoUse(t.classList.contains("closed") ? "i-chev-r" : "i-chev-d");
  };
  $("#abExplorer").onclick = () => {
    const w = $("#treewrap");
    w.style.display = w.style.display === "none" ? "" : "none";
    $("#splitTree").hidden = w.style.display === "none";
    $("#abExplorer").classList.toggle("active", w.style.display !== "none");
  };
  $("#ctabLeft").onclick = () => { $("#chatTabs").scrollBy({ left: -160, behavior: "smooth" }); setTimeout(updateChatNav, 260); };
  $("#ctabRight").onclick = () => { $("#chatTabs").scrollBy({ left: 160, behavior: "smooth" }); setTimeout(updateChatNav, 260); };
  $("#chatTabs").addEventListener("scroll", updateChatNav);
  window.addEventListener("resize", updateChatNav);
  $("#abSearch").onclick = () => $("#q").focus();
  $("#abGit").onclick = () => {
    const b = $("#branch").textContent;
    sysMsg(b ? "rama: " + b : "⑂ El workspace no es un repo git");
  };
  $("#abAgent").onclick = () => {
    const a = $("#agentPanel");
    a.style.display = a.style.display === "none" ? "" : "none";
    $("#splitAgent").hidden = a.style.display === "none";
    $("#abAgent").classList.toggle("active", a.style.display !== "none");
  };
  $("#abArtifacts").onclick = showArtifacts;
  $("#abSocial").onclick = modalSocial;
  $("#abRoutines").onclick = modalRoutines;
  $("#abTools").onclick = modalTools;
  $("#abServers").onclick = modalServers;
  $("#abHistory").onclick = modalHistory;
  $("#abRanking").onclick = () => { showLeaderboard(); };
  // visor de artefactos
  $("#artClose").onclick = closeArtifacts;
  $("#artReload").onclick = paintArtifact;
  $("#artPrev").onclick = () => galleryNav(-1);
  $("#artNext").onclick = () => galleryNav(1);
  $("#imgSend").onclick = imgEdit;
  $("#imgPromptIn").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); imgEdit(); }
  });
  document.addEventListener("keydown", e => {
    if ($("#artView").hidden || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ""))) return;
    if (e.key === "ArrowLeft") galleryNav(-1);
    if (e.key === "ArrowRight") galleryNav(1);
  });
  $("#artSel").onchange = () => { S.artIdx = +$("#artSel").value; paintArtifact(); };
  $("#artExt").onclick = async () => {
    const a = (S.artifacts || [])[S.artIdx];
    if (a) await api.preview_html(a.path || "", a.html);
  };
  // entorno de diseño
  $("#dzClose").onclick = closeDesign;
  $("#dzSave").onclick = dzSave;
  $("#dzCanvas").addEventListener("mousedown", dzPointerDown);
  $("#dzHandle").addEventListener("mousedown", dzHandleDown);
  document.querySelectorAll("#dzSelBox .dz-sh").forEach(sh =>
    sh.addEventListener("mousedown", e =>
      dzBoxHandleDown(e, +sh.dataset.hx, +sh.dataset.hy)));
  $("#dzExt").onclick = () => { if (DZ.path) api.preview_html(DZ.path, $("#dzCanvas").innerHTML); };
  $("#dzZoomIn").onclick = () => dzZoom(0.15);
  $("#dzZoomOut").onclick = () => dzZoom(-0.15);
  $("#dzZoomFit").onclick = dzFitView;
  $("#dzDoc").onclick = dzDocModal;
  $("#dzRotL").onclick = () => dzRotView(-15);
$("#dzRotR").onclick = () => dzRotView(15);
$("#dzRotLbl").ondblclick = () => { DZ.viewRot = 0; dzApplyZoom(); };
$("#dzDiscBtn").onclick = () => dzDiscToggle();
  $("#dzMirror").onclick = dzMirrorToggle;
  $("#tlMove").onclick = dzMoveTween;
  $("#tlRec").onclick = dzRecToggle;
  $("#tlPuppet").onclick = dzPuppetToggle;
  $("#tlWalk").onclick = dzWalkCycleModal;
  // scrub del X-sheet: arrastrá sobre los cuadros para hojearlos (flipping)
  $("#tlFrames").addEventListener("mousedown", (e) => {
    if (!DZ.anim) return;
    let busy = false;
    const go = async (x, y) => {
      const chip = document.elementFromPoint(x, y);
      const c = chip && chip.closest && chip.closest(".tl-frame");
      if (!c || busy || !DZ.anim) return;
      const idx = [...$("#tlFrames").children].indexOf(c);
      if (idx >= 0 && idx !== DZ.anim.idx) { busy = true; try { await dzGoFrame(idx); } finally { busy = false; } }
    };
    const mm = (ev) => go(ev.clientX, ev.clientY);
    const mu = () => { document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); };
    document.addEventListener("mousemove", mm);
    document.addEventListener("mouseup", mu);
  });
  // herramientas de dibujo (lápiz/pincel/pluma) — pointer events para presión
  document.querySelectorAll(".dz-toolbtn").forEach(b =>
    b.onclick = () => dzSetTool(b.dataset.tool));
  // panel de estilo: color de relleno/trazo, grosor, opacidad, paleta
  $("#dzPFill").oninput = e => { DZ.fillColor = e.target.value; dzStyleApply("fill", e.target.value); };
  $("#dzPStroke").oninput = e => { DZ.drawColor = e.target.value; dzStyleApply("stroke", e.target.value); };
  $("#dzFillNone").onclick = () => dzStyleApply("fill", "none") || dzSetStatus("∅ Seleccioná un elemento para sacarle el relleno");
  $("#dzStrokeNone").onclick = () => dzStyleApply("stroke", "none") || dzSetStatus("∅ Seleccioná un elemento para sacarle el trazo");
  $("#dzDrawW").oninput = e => { DZ.drawW = +e.target.value || 6; dzStyleApply("stroke-width", DZ.drawW); };
  $("#dzOpacity").oninput = e => {
    $("#dzOpacityLbl").textContent = e.target.value + "%";
    dzStyleApply("opacity", (+e.target.value / 100).toFixed(2));
  };
  DZ.fillColor = $("#dzPFill").value; DZ.drawColor = $("#dzPStroke").value;
  dzPaletteRender();
  // preferencias del estudio: atajos configurables + suavizado persistente
  dzKeysLoad();
  DZ.smooth = +(localStorage.getItem("low.dzsmooth") || 40);
  $("#dzSmooth").value = DZ.smooth; $("#dzSmoothLbl").textContent = DZ.smooth;
  $("#dzSmooth").oninput = e => {
    DZ.smooth = +e.target.value;
    $("#dzSmoothLbl").textContent = e.target.value;
    try { localStorage.setItem("low.dzsmooth", String(DZ.smooth)); } catch (err) { /* */ }
  };
  // gamma de presión (OpenToonz V_BrushPressureSensitivity): <1 más sensible al inicio
  DZ.pressureGamma = +(localStorage.getItem("low.dzgamma") || 0.85);
  $("#dzPrefs").onclick = dzPrefsModal;
  $("#dzRotate").addEventListener("mousedown", dzRotateDown);
  $("#dzGroup").onclick = (e) => dzGroupSel(e.shiftKey);
  $("#dzImg").onclick = dzImportImage;
  $("#dzColor").onclick = dzColorize;
  $("#dzBg").onclick = dzGenBg;
  $("#dzVec").onclick = dzVectorize;
  $("#dzProps").addEventListener("focusin", () => dzSnapshot());
  $("#dzCanvas").addEventListener("pointerdown", dzDrawDown);
  $("#dzCanvas").addEventListener("pointermove", dzDrawMove);
  $("#dzCanvas").addEventListener("pointerup", dzDrawUp);
  // pointerrawupdate: eventos de alta frecuencia no coalescidos (como WinTab en OpenToonz).
  // Chrome 77+, Edge 79+. Si no existe, simplemente no se registra.
  try { $("#dzCanvas").addEventListener("pointerrawupdate", dzDrawRaw); } catch (e) { /* no soportado */ }
  // el lápiz saliendo de rango / pointer cancelado no debe dejar el trazo colgado
  $("#dzCanvas").addEventListener("pointercancel", dzDrawUp);

  $("#dzCanvas").addEventListener("dblclick", (e) => {
    if (PEN) { dzPenFinish(false); return; }
    // flecha negra: doble clic ENTRA al grupo (selección profunda, como Animate)
    const t = e.target;
    if ((DZ.tool || "select") === "select" && t && t !== $("#dzCanvas")
        && t.tagName && t.tagName.toLowerCase() !== "svg"
        && !(t.closest && t.closest("[data-locked]"))) {
      dzSelect(t);
      dzSetStatus("⤵ pieza dentro del grupo — la flecha blanca (D) siempre selecciona así");
    }
  });
  // zoom con la rueda del mouse (Alt+scroll = zoom hacia el cursor, pro).
  // Sin Alt la rueda no hace nada raro: dejamos el gesto para el zoom explícito.
  $("#dzCanvas").addEventListener("wheel", (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    dzZoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });
  // regla: clic derecho fija punto de fuga → prevenir menú contextual
  $("#dzCanvas").addEventListener("contextmenu", (e) => {
    if (DZ.tool === "ruler") e.preventDefault();
  });
  // animación
  $("#dzAnim").onclick = dzAnimToggle;
  $("#tlPlay").onclick = dzAnimPlay;
  $("#tlLoop").onclick = () => {
    if (!DZ.anim) return;
    DZ.anim.loop = !(DZ.anim.loop !== false);   // toggle (default true)
    $("#tlLoop").classList.toggle("active", DZ.anim.loop);
    dzSetStatus(DZ.anim.loop ? "🔁 Loop activado" : "▶ Reproducción única (sin loop)");
  };
  // modo dibujo (zen): pantalla limpia, solo lienzo + herramientas
  $("#dzZen").onclick = dzZenToggle;
  $("#tlAdd").onclick = dzFrameAdd;
  $("#tlFirst").onclick = () => { dzAnimStopIf(); dzGoFrame(0); };
  $("#tlPrev").onclick = () => { dzAnimStopIf(); dzGoFrame(Math.max(0, (DZ.anim ? DZ.anim.idx : 0) - 1)); };
  $("#tlNext").onclick = () => { dzAnimStopIf(); dzGoFrame(Math.min((DZ.anim ? DZ.anim.frames.length : 1) - 1, (DZ.anim ? DZ.anim.idx : 0) + 1)); };
  $("#tlLast").onclick = () => { dzAnimStopIf(); dzGoFrame((DZ.anim ? DZ.anim.frames.length : 1) - 1); };
  $("#tlDel").onclick = async () => {
    if (!DZ.anim) return;
    if (!confirm("¿Borrar este cuadro? (no se puede deshacer)")) return;
    const r = await api.del_frame(DZ.path);
    if (r && r.error) return sysMsg("❌ " + r.error);
    try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
    await openDesign(r.path);
    $("#dzTimeline").hidden = false;
    await dzTimelineRefresh();
    dzOnionUpdate();
  };
  $("#tlOnion").onclick = () => {
    if (!DZ.anim) return;
    DZ.anim.onion = !DZ.anim.onion;
    $("#tlOnion").classList.toggle("active", DZ.anim.onion);
    $("#dzOnionPanel").hidden = !DZ.anim.onion;
    dzOnionUpdate();
  };
  // panel 🧅 flotante: configuración en vivo + arrastrable por el encabezado
  const opCfg = dzOnionCfg();
  $("#opBefore").value = opCfg.before; $("#opAfter").value = opCfg.after;
  $("#opAlpha").value = opCfg.alpha;
  $("#opColorB").value = opCfg.colorB; $("#opColorA").value = opCfg.colorA;
  const opBind = (id, key, num) => {
    $("#" + id).oninput = (e) => {
      DZ.onionCfg[key] = num ? +e.target.value : e.target.value;
      dzOnionCfgSave(); dzOnionUpdate();
    };
  };
  opBind("opBefore", "before", true); opBind("opAfter", "after", true);
  opBind("opAlpha", "alpha", true);
  opBind("opColorB", "colorB", false); opBind("opColorA", "colorA", false);
  $("#dzOpClose").onclick = () => { $("#dzOnionPanel").hidden = true; };
  // chrome de estudio: menubar, splitter, opciones de herramienta, statusbar
  dzMenubarWire();
  dzSplitWire();
  dzToolOptsRender();
  dzSbTool();
  $("#dzCanvas").addEventListener("pointermove", (e) => {
    // coordenadas del cursor en unidades del documento (statusbar)
    if (DZ.sbTick) return;
    DZ.sbTick = true;
    requestAnimationFrame(() => {
      DZ.sbTick = false;
      const sb = $("#sbPos");
      if (!sb || !$("#dzCanvas").querySelector("svg")) return;
      try {
        const p = dzToUser(e.clientX, e.clientY);
        sb.textContent = Math.round(p.x) + ", " + Math.round(p.y);
      } catch (err) { /* sin svg todavía */ }
    });
  });
  // X-sheet: toggle, cerrar y arrastre del panel
  $("#tlXs").onclick = dzXsToggle;
  $("#dzXsClose").onclick = () => { $("#dzXsheet").hidden = true; $("#tlXs").classList.remove("active"); };
  $("#dzXsHead").addEventListener("mousedown", (e) => {
    if (e.target.id === "dzXsClose") return;
    e.preventDefault();
    const pnl = $("#dzXsheet");
    const r = pnl.getBoundingClientRect(), host = $("#designView").getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      pnl.style.left = Math.max(0, ev.clientX - host.left - dx) + "px";
      pnl.style.top = Math.max(0, ev.clientY - host.top - dy) + "px";
      pnl.style.right = "auto";
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  // 🎭 diorama: toggle, cerrar y arrastre del panel
  $("#dzZBtn").onclick = dzZPanelToggle;
  $("#dz3DBtn").onclick = dz3dToggle;
  $("#dzRulersBtn").onclick = dzRulersToggle;
  $("#dzGridBtn").onclick = dzGridToggle;
  $("#dzGuidesBtn").onclick = dzGuidesToggle;
  $("#dzRlTop").addEventListener("pointerdown", e => dzRulerPull(e, "h"));
  $("#dzRlBottom").addEventListener("pointerdown", e => dzRulerPull(e, "h"));
  $("#dzRlLeft").addEventListener("pointerdown", e => dzRulerPull(e, "v"));
  $("#dzRlRight").addEventListener("pointerdown", e => dzRulerPull(e, "v"));
  $("#dzZpClose").onclick = () => { $("#dzZPanel").hidden = true; $("#dzZBtn").classList.remove("active"); };
  $("#dzZpHead").addEventListener("mousedown", (e) => {
    if (e.target.id === "dzZpClose") return;
    e.preventDefault();
    const pnl = $("#dzZPanel");
    const r = pnl.getBoundingClientRect(), host = $("#designView").getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      pnl.style.left = Math.max(0, ev.clientX - host.left - dx) + "px";
      pnl.style.top = Math.max(0, ev.clientY - host.top - dy) + "px";
      pnl.style.right = "auto";
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  $("#dzOpHead").addEventListener("mousedown", (e) => {
    if (e.target.id === "dzOpClose") return;
    e.preventDefault();
    const pnl = $("#dzOnionPanel");
    const r = pnl.getBoundingClientRect(), host = $("#designView").getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      pnl.style.left = Math.max(0, ev.clientX - host.left - dx) + "px";
      pnl.style.top = Math.max(0, ev.clientY - host.top - dy) + "px";
      pnl.style.right = "auto";
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  // ── panel de rig ──
  $("#dzRigBtn").onclick = dzRigToggle;
  $("#dzRigClose").onclick = dzRigToggle;
  $("#dzRigHead").addEventListener("mousedown", (e) => {
    if (e.target.id === "dzRigClose") return;
    e.preventDefault();
    const pnl = $("#dzRigPanel");
    const r = pnl.getBoundingClientRect(), host = $("#designView").getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      pnl.style.left = Math.max(0, ev.clientX - host.left - dx) + "px";
      pnl.style.top = Math.max(0, ev.clientY - host.top - dy) + "px";
      pnl.style.right = "auto";
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  $("#rigId").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!DZ.sel) return dzSetStatus("◆ Seleccioná la pieza primero (flecha blanca D)");
    const id = $("#rigId").value.trim().replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]/g, "_");
    if (!id) return;
    dzSnapshot(); DZ.sel.id = id; dzBuildLayers(); dzRigPanelSync();
    dzSetStatus("◆ pieza «" + id + "» lista — posala y clavá con K");
  });
  ["rigX", "rigY", "rigR", "rigS"].forEach(id => {
    $("#" + id).addEventListener("input", () => {
      if (!DZ.sel || !DZ.sel.id) return;
      const k = dzRigReadPanel();
      dzRigApplyTo(DZ.sel, k); dzPositionHandle();      // preview en vivo
    });
    $("#" + id).addEventListener("change", () => {
      if (!DZ.sel || !DZ.sel.id) return dzSetStatus("◆ La pieza necesita nombre (id) — escribilo arriba y Enter");
      dzRigSetKey(DZ.sel.id, dzRigCur(), dzRigReadPanel());   // auto-clave AE-style
      dzSetStatus("◆ clave en el cuadro " + dzRigCur());
    });
  });
  $("#rigKey").onclick = () => {
    if (!DZ.sel || !DZ.sel.id) return dzSetStatus("◆ Seleccioná y nombrá la pieza primero");
    dzRigSetKey(DZ.sel.id, dzRigCur(), dzRigReadPanel());
    dzSetStatus("◆ pose clavada en el cuadro " + dzRigCur());
  };
  $("#rigDel").onclick = () => {
    if (DZ.sel && DZ.sel.id) dzRigDelKey(DZ.sel.id, dzRigCur());
  };
  $("#perfRec").onclick = dzPerfRec;
  $("#perfPlay").onclick = dzPerfPlay;
  $("#perfSmooth").onclick = dzPerfSmooth;
  $("#perfBake").onclick = dzPerfBake;
  $("#dzAddRect").onclick = () => dzAddShape("rect");
  $("#dzAddCircle").onclick = () => dzAddShape("circle");
  $("#dzAddEllipse").onclick = () => dzAddShape("ellipse");
  $("#dzAddPoly").onclick = () => dzAddShape("poly");
  $("#dzAddStar").onclick = () => dzAddShape("star");
  $("#dzAddText").onclick = () => dzAddShape("text");
  $("#dzAddLine").onclick = () => dzAddShape("line");
  $("#tlIns").onclick = (e) => dzFrameInsert(e.shiftKey);
  $("#tlTween").onclick = dzTweenModal;
  $("#tlExport").onclick = dzExportModal;
  $("#tlKey").onclick = dzKeyToggle;
  $("#tlAI").onclick = dzAIKeyModal;
  $("#tlCamKey").onclick = dzCamKeyToggle;
  // cámara: botón de la barra lateral + tiradores del encuadre
  $("#dzCamBtn").onclick = dzCamToggle;
  $("#dzCam").addEventListener("mousedown", dzCamDrag);
  $("#dzCamSize").addEventListener("mousedown", dzCamResize);
  $("#dzCamRot").addEventListener("mousedown", dzCamRotate);
  // espacio mantenido = mano (panear con arrastre)
  document.addEventListener("keydown", e => {
    if (e.code === "Space" && !$("#designView").hidden &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")) {
      if (!DZ.spaceDown) { DZ.spaceDown = true; $("#dzCanvas").style.cursor = "grab"; }
      e.preventDefault();
    }
  });
  document.addEventListener("keyup", e => {
    if (e.code === "Space" && DZ.spaceDown) {
      DZ.spaceDown = false;
      $("#dzCanvas").style.cursor = (DZ.tool || "select") in DZ_CURSORS ? DZ_CURSORS[DZ.tool || "select"] : "crosshair";
    }
  });
  $("#dzDup").onclick = dzDuplicate;
  $("#dzDel").onclick = dzDeleteSelected;
  $("#dzVar").onclick = dzVariations;
  $("#dzCodeBtn").onclick = dzToggleCode;
  $("#dzCodeApply").onclick = dzApplyCode;
  $("#dzSend").onclick = designPrompt;
  $("#dzPrompt").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); designPrompt(); }
  });
  // atajos del editor de diseño (si no estás escribiendo en un campo)
  document.addEventListener("keydown", e => {
    if ($("#designView").hidden || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ""))) return;
    if (e.key === "Tab") { e.preventDefault(); dzZenToggle(); return; }   // modo dibujo
    if (e.key === "F7") { e.preventDefault(); dzLayersToggle(); return; } // capas
    if (e.ctrlKey && e.key.toLowerCase() === "r") { e.preventDefault(); dzRulersToggle(); return; } // reglas 2D
    if ((e.key === "Delete" || e.key === "Backspace") && DZ.sel) {
      e.preventDefault(); dzDeleteSelected();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "d" && DZ.sel) {
      e.preventDefault(); dzDuplicate();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "g") {
      e.preventDefault(); dzGroupSel(e.shiftKey);
    }
    // Z = acercar · Alt+Z = alejar (zoom estilo OpenToonz, centrado en la mesa)
    if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      const c = $("#dzCanvas").getBoundingClientRect();
      dzZoomAt(e.altKey ? 1 / 1.2 : 1.2, c.left + c.width / 2, c.top + c.height / 2);
      return;
    }
    // atajos configurables (⚙ Preferencias): una tecla → una acción
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      if (!DZ.keyrev) dzKeysLoad();
      const k = e.key === "=" ? "+" : e.key.toLowerCase();   // = suma sin Shift
      const act = DZ.keyrev[k];
      if (act) { e.preventDefault(); dzRunAction(act); }
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); dzUndo(); }
    if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); dzRedo(); }
    if (e.key === "Enter" && PEN) { e.preventDefault(); dzPenFinish(false); }
    if (e.key === "Backspace" && PEN) { e.preventDefault(); dzPenBackspace(); }
    if (e.key === "Escape" && PEN) {
      // cancela la pluma SIN cerrar el editor (frena el Escape global)
      e.preventDefault(); e.stopImmediatePropagation(); dzPenFinish(true);
    }
    if (e.key === "Escape" && RULER) {
      e.preventDefault(); e.stopImmediatePropagation(); dzRulerClear();
    }
    if (e.key === "Escape" && DZ.pup) {
      // Esc corta/cancela la grabación de titiritero sin cerrar el editor
      e.preventDefault(); e.stopImmediatePropagation(); dzPuppetStop();
    }
  });
  document.querySelectorAll(".chip").forEach(c => {
    c.onclick = () => {
      const cmd = c.dataset.chip;
      if (cmd === "/compare") modalCompare();
      else if (cmd === "/run") run();
      else command(cmd);
    };
  });
  $("#inp").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $("#q").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const v = $("#q").value.trim();
      $("#q").value = "";
      if (v) { $("#inp").value = v; send(); }
    }
    if (e.key === "Escape") cm.focus();
  });
  $("#selLang").onchange = applyEditorMode;
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); $("#q").focus(); }
    if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    if (e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); newTab(); }
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); run(); }
    if (e.ctrlKey && (e.key === "+" || e.key === "=")) { e.preventDefault(); applyZoom(S.zoom + 0.1); }
    if (e.ctrlKey && e.key === "-") { e.preventDefault(); applyZoom(S.zoom - 0.1); }
    if (e.ctrlKey && e.key === "0") { e.preventDefault(); applyZoom(1.0); }
    if (e.key === "Escape") {
      if (!$("#overlay").hidden) closeModal();         // 1º cierra modal abierto
      else if (!$("#designView").hidden) closeDesign(); // 2º cierra el entorno de diseño
      else if (!$("#artView").hidden) closeArtifacts(); // 3º cierra el visor de artefactos
      else if (S.busy) cancelRequest();                // 4º detiene consulta en curso
    }
  });
  $("#overlay").onclick = e => { if (e.target === $("#overlay")) closeModal(); };
}

/* ── tabs ── */
function curTab() { return S.tabs.find(t => t.id === S.cur); }

function newTab() {
  S.untitled++;
  const name = S.untitled === 1 ? "sin título" : `sin título ${S.untitled}`;
  addTab("*untitled" + S.untitled, name, "// Nuevo archivo\n", "python");
}

function addTab(id, name, content, lang) {
  const ex = S.tabs.find(t => t.id === id);
  if (ex) return switchTab(id);
  const doc = CodeMirror.Doc(content, CM_MODE[lang] || "python");
  S.tabs.push({ id, name, doc, modified: false, path: id.startsWith("*") ? null : id, lang });
  switchTab(id);
}

function switchTab(id) {
  S.cur = id;
  const t = curTab();
  S.loading = true;
  cm.swapDoc(t.doc);
  S.loading = false;
  applyEditorMode();   // respeta el idioma forzado; en "auto" detecta por extensión
  document.title = "LOW — " + t.name;
  renderTabs(); renderTree(); updateLnCol();
  cm.focus();
}

function closeTab(id) {
  const t = S.tabs.find(x => x.id === id);
  if (!t) return;
  if (t.modified && !confirm(`${t.name} tiene cambios sin guardar. ¿Cerrar igual?`)) return;
  S.tabs = S.tabs.filter(x => x.id !== id);
  if (S.cur === id) {
    if (S.tabs.length) switchTab(S.tabs[S.tabs.length - 1].id);
    else { S.cur = null; newTab(); }
  } else renderTabs();
}

function renderTabs() {
  const bar = $("#tabs");
  bar.innerHTML = "";
  for (const t of S.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === S.cur ? " active" : "");
    const nm = document.createElement("span");
    nm.textContent = t.name;
    el.appendChild(nm);
    if (t.modified) { const d = document.createElement("span"); d.className = "mdot"; el.appendChild(d); }
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕"; x.title = "Cerrar";
    x.onclick = e => { e.stopPropagation(); closeTab(t.id); };
    el.appendChild(x);
    el.onclick = () => switchTab(t.id);
    el.onauxclick = e => { if (e.button === 1) closeTab(t.id); };
    bar.appendChild(el);
  }
  // ＋ archivo nuevo, siempre al final de las solapas
  const plus = document.createElement("div");
  plus.className = "tab tab-plus"; plus.title = "Archivo nuevo (Ctrl+N)";
  plus.textContent = "+";
  plus.onclick = () => newTab();
  bar.appendChild(plus);
}

/* ── árbol ── */
function renderTree() {
  const box = $("#tree");
  box.innerHTML = "";
  if (!S.tree || !S.tree.length) {
    box.innerHTML = '<div class="tree-empty">Abrí una carpeta con el ícono de carpeta del menú superior</div>';
    return;
  }
  const walk = (items, depth) => {
    for (const it of items) {
      const el = document.createElement("div");
      el.className = "titem";
      el.style.paddingLeft = (8 + depth * 14) + "px";
      if (it.dir) {
        const open = S.expanded.has(it.path);
        el.textContent = (open ? "▾ " : "▸ ") + it.name;
        el.onclick = () => {
          open ? S.expanded.delete(it.path) : S.expanded.add(it.path);
          renderTree();
        };
        box.appendChild(el);
        if (open && it.children) walk(it.children, depth + 1);
      } else {
        el.textContent = it.name;
        const tab = S.tabs.find(t => t.path === it.path);
        if (tab && t_active(tab)) el.classList.add("active");
        if (tab && tab.modified) { const d = document.createElement("span"); d.className = "mdot"; el.appendChild(d); }
        el.onclick = () => openFile(it.path);
        box.appendChild(el);
      }
    }
  };
  walk(S.tree, 0);
}
const t_active = t => t.id === S.cur;

async function pickWs() {
  const r = await api.pick_ws();
  if (!r) return;
  S.ws = r.ws; S.tree = r.tree;
  S.expanded = new Set();
  $("#projName").textContent = r.ws.split(/[\\/]/).pop().toUpperCase();
  $("#branch").textContent = r.branch ? "⑂ " + r.branch : "";
  renderTree();
  sysMsg("📁 Workspace: " + r.ws); persist("system", "📁 Workspace: " + r.ws);
}

async function openFile(path, range) {
  if (SVG_RE.test(path)) return openDesign(path);  // vectores → entorno de diseño
  if (IMG_RE.test(path)) return openImage(path);   // imágenes → visor, no al editor
  if (DOC_RE.test(path)) {                          // .docx/.pdf → su app (Word…)
    const r = await api.open_external(path);
    if (r && r.error) sysMsg("❌ No pude abrirlo: " + r.error);
    return;
  }
  const r = await api.open_file(path);
  if (r.error) return sysMsg("❌ " + r.error);
  const existed = S.tabs.find(t => t.id === r.path);
  addTab(r.path, r.name, r.content, r.lang);
  // si el tab ya existía, su doc quedó desactualizado: refrescar con lo nuevo
  if (existed && existed.doc.getValue() !== r.content) {
    S.loading = true; existed.doc.setValue(r.content); S.loading = false;
  }
  if (range) highlightRange(range[0], range[1]);
}

/* resalta en vivo el rango de líneas que acaba de tocar el agente y hace scroll */
function highlightRange(start, end) {
  try {
    cm.operation(() => {
      for (let ln = start; ln <= end && ln < cm.lineCount(); ln++)
        cm.addLineClass(ln, "background", "cm-edited");
    });
    cm.scrollIntoView({ line: start, ch: 0 }, 120);
    cm.setCursor({ line: start, ch: 0 });
    setTimeout(() => cm.operation(() => {
      for (let ln = start; ln <= end && ln < cm.lineCount(); ln++)
        cm.removeLineClass(ln, "background", "cm-edited");
    }), 2200);
  } catch (e) { /* fuera de rango: sin drama */ }
}

/* ── visor de imágenes / SVG dentro de LOW (reusa el panel de artefactos) ── */
async function openImage(path, alsoChat) {
  const r = await api.image_data(path);
  if (!r || r.error) return sysMsg("❌ No pude abrir la imagen: " + ((r && r.error) || path));
  const name = r.name || path.split(/[\\/]/).pop();
  // renderizar centrada sobre fondo tipo lienzo, con la imagen escalada al panel
  const html = '<body style="margin:0;height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:#141416;background-image:' +
    'linear-gradient(45deg,#1c1c1f 25%,transparent 25%),linear-gradient(-45deg,#1c1c1f 25%,transparent 25%),' +
    'linear-gradient(45deg,transparent 75%,#1c1c1f 75%),linear-gradient(-45deg,transparent 75%,#1c1c1f 75%);' +
    'background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0">' +
    '<img src="' + r.data_url + '" style="max-width:100%;max-height:100vh;object-fit:contain;' +
    'box-shadow:0 4px 30px rgba(0,0,0,.5)"></body>';
  addArtifact(name, html, path);
  showArtifacts();
  if (alsoChat) chatImage(r.data_url, name);
}

/* ── galería: navegar con ‹ › entre todas las imágenes del proyecto ── */
function treeImages() {
  const out = [];
  const walk = (items) => (items || []).forEach(it => {
    if (it.dir) walk(it.children);
    else if (IMG_RE.test(it.name) || SVG_RE.test(it.name)) out.push(it.path);
  });
  walk(S.tree);
  return out;
}
async function galleryNav(dir) {
  const imgs = treeImages();
  if (!imgs.length) return setStatus("(no hay imágenes en el proyecto)");
  const cur = (S.artifacts || [])[S.artIdx];
  let i = cur ? imgs.indexOf(cur.path) : -1;
  i = i === -1 ? 0 : (i + dir + imgs.length) % imgs.length;
  const p = imgs[i];
  setStatus(`🖼 ${i + 1}/${imgs.length}`);
  if (SVG_RE.test(p)) { closeArtifacts(); await openDesign(p); }
  else await openImage(p);
}

async function openDialog() {
  const r = await api.open_dialog();
  if (r && !r.error) addTab(r.path, r.name, r.content, r.lang);
}

async function save() {
  const t = curTab();
  if (!t) return;
  const r = await api.save_file(t.path, cm.getValue());
  if (!r) return;
  t.path = r.path; t.name = r.name; t.id = t.id.startsWith("*") ? r.path : t.id;
  if (S.cur.startsWith("*")) S.cur = t.id;
  t.modified = false;
  document.title = "LOW — " + t.name;
  renderTabs(); renderTree();
  setStatus("💾 " + r.name);
}

/* ── ejecutar ── */
async function run() {
  const code = cm.getValue().trim();
  $("#term").classList.remove("closed");
  $("#termTog").innerHTML = icoUse("i-chev-d");
  if (!code || code === "// Nuevo archivo") {
    termLine("(no hay código para ejecutar en el editor)");
    return;
  }
  const t = curTab();
  try {
    if (esHtml(t)) {
      // HTML no se "ejecuta": se renderiza EN VIVO adentro de LOW (artefacto)
      const name = t && t.name ? t.name : "vista previa.html";
      addArtifact(name, cm.getValue(), t && t.path ? t.path : "");
      showArtifacts();
      termLine("🎨 Artefacto renderizado dentro de LOW (botón ⧉ para el navegador)", "t-ok");
      setStatus("🎨 Vista previa en vivo");
      return;
    }
    const lang = effectiveLang();
    termLine("➜ run " + lang, "t-ok");
    setStatus("⚡ Ejecutando…");
    const t0 = performance.now();
    const r = await api.run_code(code, lang);
    const seg = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.error) termLine("❌ " + r.error, "t-err");
    else {
      if (r.stdout) termLine(r.stdout.replace(/\n$/, ""));
      if (r.stderr) termLine(r.stderr.replace(/\n$/, ""), "t-err");
      if (!r.stdout && !r.stderr) termLine("(sin salida)");
      termLine(`── exit ${r.returncode ?? "?"} · ${seg}s ──`,
               r.returncode === 0 ? "t-ok" : "t-err");
    }
    setStatus("Listo");
  } catch (e) {
    termLine("❌ Ejecutar falló: " + (e.message || e), "t-err");
    reportErr("run: " + (e.message || e));
    setStatus("Error");
  }
}

function termLine(txt, cls) {
  const out = $("#termOut");
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = txt;
  out.appendChild(d);
  out.scrollTop = out.scrollHeight;
}

/* ── chat ── */
function scrollMsgs() { const m = $("#msgs"); m.scrollTop = m.scrollHeight; }
function setStatus(t) { $("#status").textContent = t; }

/* contador en vivo mientras el modelo trabaja — así no parece congelado
   (los razonadores como glm-5.2 pueden pensar 30-60s antes del primer token) */
function startThinking() {
  S.thinkT0 = Date.now();
  clearInterval(S.thinkTimer);
  const tick = () => {
    const s = Math.round((Date.now() - S.thinkT0) / 1000);
    setStatus(`🧠 Pensando… ${s}s` + (s > 20 ? " (los modelos que razonan tardan más)" : ""));
  };
  tick();
  S.thinkTimer = setInterval(tick, 1000);
}
function stopThinking() { clearInterval(S.thinkTimer); S.thinkTimer = null; }
function persist(role, content, sid) { api && api.persist(role, content, sid || null); }

function userMsg(text, imgDataUrl) {
  const d = document.createElement("div");
  d.className = "m-user";
  if (imgDataUrl) {
    const img = document.createElement("img");
    img.className = "m-user-img"; img.src = imgDataUrl;
    d.appendChild(img);
  }
  if (text) {
    const t = document.createElement("div");
    t.textContent = text;
    d.appendChild(t);
  }
  $("#msgs").appendChild(d); scrollMsgs();
}

/* ── imagen adjunta (visión): diálogo, pegado desde portapapeles, preview ── */
async function attachImageDialog() {
  const img = await api.pick_image();
  if (!img) return;
  if (img.error) { sysMsg("❌ " + img.error); return; }
  setAttachedImage(img);
}

function onPasteImage(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      e.preventDefault();
      const file = it.getAsFile();
      const reader = new FileReader();
      reader.onload = () => {
        const [, mime, data] = /^data:(.+?);base64,(.+)$/.exec(reader.result) || [];
        if (data) setAttachedImage({ data, mime: mime || "image/png", name: "pegada.png" });
      };
      reader.readAsDataURL(file);
      return;
    }
  }
}

function setAttachedImage(img) {
  S.attachedImage = img;
  $("#imgPreviewThumb").src = `data:${img.mime};base64,${img.data}`;
  $("#imgPreviewName").textContent = img.name || "imagen";
  $("#imgPreview").hidden = false;
}

function clearAttachedImage() {
  S.attachedImage = null;
  $("#imgPreview").hidden = true;
  $("#imgPreviewThumb").src = "";
}

/* miniatura clickeable en el chat de una imagen que generó/abrió el agente */
function chatImage(dataUrl, name) {
  const d = document.createElement("div");
  d.className = "m-img";
  const img = document.createElement("img");
  img.src = dataUrl; img.title = name + " — clic para verla en grande";
  img.onclick = () => { addArtifact(name, imgHtml(dataUrl), name); showArtifacts(); };
  const cap = document.createElement("div");
  cap.className = "m-img-cap"; cap.textContent = "🖼 " + name;
  d.appendChild(img); d.appendChild(cap);
  $("#msgs").appendChild(d); scrollMsgs();
}
function imgHtml(dataUrl) {
  return '<body style="margin:0;height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:#141416"><img src="' + dataUrl +
    '" style="max-width:100%;max-height:100vh;object-fit:contain"></body>';
}

function agentMsg(text) {
  const w = document.createElement("div");
  w.className = "m-agent";
  const h = document.createElement("div");
  h.className = "m-head";
  h.innerHTML = '<div class="m-ava">★</div>';
  const who = document.createElement("span");
  who.className = "m-who";
  who.textContent = "LOW · " + ($("#selProv").value || "?") + " · " + ($("#selModel").value || "?");
  h.appendChild(who);
  const b = document.createElement("div");
  b.className = "m-txt"; b.textContent = text;
  w.appendChild(h); w.appendChild(b);
  $("#msgs").appendChild(w); scrollMsgs();
  return w;
}

function sysMsg(text) {
  const d = document.createElement("div");
  // sin prefijo fijo: los mensajes ya traen su propio marcador (✅❌⚠…) cuando
  // corresponde — duplicarlo con un icono genérico solo sumaba ruido visual
  d.className = "m-sys"; d.textContent = text;
  $("#msgs").appendChild(d); scrollMsgs();
  return d;
}

/* burbuja de "pensamiento" del modelo (reasoning_content en vivo, colapsable) */
function thinkMsg() {
  const w = document.createElement("div");
  w.className = "m-think";
  w.innerHTML = '<div class="think-head">💭 Pensando… <span class="think-toggle">ocultar</span></div>' +
                '<div class="think-body"></div>';
  const tog = w.querySelector(".think-toggle");
  tog.onclick = () => {
    w.classList.toggle("collapsed");
    tog.textContent = w.classList.contains("collapsed") ? "mostrar" : "ocultar";
  };
  $("#msgs").appendChild(w); scrollMsgs();
  return w;
}

/* tarjeta Plan: se crea con el primer tool call del turno */
function toolStep(desc, res) {
  if (!S.plan) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<div class="card-h">Actividad <span class="n">…</span>' +
      '<div class="prog"><div></div></div></div><div class="card-b"></div>';
    $("#msgs").appendChild(card);
    S.plan = { card, steps: 0 };
  }
  const body = S.plan.card.querySelector(".card-b");
  const d = document.createElement("div");
  d.className = "step";
  const short = (res || "").split("\n")[0].slice(0, 70);
  const ok = !/^\s*❌/.test(res || "");
  d.innerHTML = `<span class="ck"></span> <span class="fn"></span> <span></span>`;
  const ck = d.querySelector(".ck");
  ck.textContent = ok ? "✓" : "✗";
  if (!ok) ck.style.color = "var(--red)";
  d.children[1].textContent = desc;        // texto amigable (📖 Leyendo X, ✏️ …)
  d.children[2].textContent = short;
  body.appendChild(d);
  S.plan.steps++;
  S.plan.card.querySelector(".prog > div").style.width = Math.min(100, S.plan.steps * 12) + "%";
  scrollMsgs();
}

function planDone() {
  clearWorkingOn();
  if (!S.plan) return;
  S.plan.card.querySelector(".card-h .n").textContent = `✓ ${S.plan.steps} paso${S.plan.steps === 1 ? "" : "s"}`;
  S.plan.card.querySelector(".prog > div").style.width = "100%";
  S.plan = null;
}

/* indicador en vivo de en qué archivo/acción está el agente ahora mismo.
   El texto lo pinta el heartbeat (elapsed + esta acción); acá solo lo guardamos. */
function setWorkingOn(text) {
  S.lastAction = text;
  const el = $("#workingOn");
  if (el && S.busy) el.hidden = false;
}
function clearWorkingOn() {
  S.lastAction = "";
  const el = $("#workingOn");
  el.hidden = true;
  el.textContent = "";
}

async function send() {
  const inp = $("#inp");
  const msg = inp.value.trim();
  const img = S.attachedImage;
  if (!msg && !img) return;
  inp.value = "";
  if (msg.startsWith("/")) return command(msg);
  const sid = S.chatId;   // charla de ESTE turno: si cambiás de solapa mientras
                          // el agente trabaja, la respuesta se guarda en la suya
  userMsg(msg, img ? `data:${img.mime};base64,${img.data}` : null);
  persist("user", msg || "(imagen adjunta)", sid);
  clearAttachedImage();
  const p = S.providers.find(x => x.name === $("#selProv").value);
  if (!p || (!p.has_key && p.name !== "custom")) {
    agentMsg("Configura la API key (⚙) para empezar");
    return;
  }
  startThinking();
  setBusy(true);
  S.plan = null;
  try {
    const r = await api.send_chat(msg, cm.getValue(), effectiveLang(), img);
    stopThinking();
    planDone();
    // si vino por streaming, la burbuja ya se armó con los eventos agent_*
    if (r && r.streamed) { persist("LOW", r.full || "", sid); }
    else if (r && r.text) { agentMsg(r.text); persist("LOW", r.text, sid); }
    if (r && r.status) setStatus(r.status);
  } catch (e) {
    stopThinking();
    planDone();
    S.streamEl = null; S.thinkEl = null;
    agentMsg("❌ Falló la llamada: " + (e.message || e));
    reportErr("send_chat: " + (e.message || e));
    setStatus("Error");
  } finally {
    setBusy(false);
    loadChatTabs().catch(() => {});
  }
}

/* botón enviar ⇄ detener mientras el agente trabaja */
function setBusy(b) {
  S.busy = b;
  const btn = $("#btnSend");
  btn.innerHTML = icoUse(b ? "i-stop" : "i-arrow");
  btn.title = b ? "Detener" : "Enviar";
  if (b) startHeartbeat(); else stopHeartbeat();
}

/* ── heartbeat: latido en vivo durante TODO el turno, para que nunca parezca
   colgado (aunque el modelo esté pensando en silencio entre tool-calls) ── */
function startHeartbeat() {
  S.turnStart = Date.now(); S.lastAction = "";
  clearInterval(S.hbTimer);
  const tick = () => {
    const s = Math.round((Date.now() - S.turnStart) / 1000);
    const el = $("#workingOn");
    if (el) {
      el.hidden = false;
      el.textContent = `⏳ Trabajando ${s}s` + (S.lastAction ? " · " + S.lastAction : "…");
    }
    if (S.plan) {
      const n = S.plan.card.querySelector(".card-h .n");
      if (n) n.textContent = `${S.plan.steps} paso${S.plan.steps === 1 ? "" : "s"} · ${s}s`;
    }
  };
  tick();
  S.hbTimer = setInterval(tick, 1000);
}
function stopHeartbeat() {
  clearInterval(S.hbTimer); S.hbTimer = null;
  const el = $("#workingOn"); if (el) { el.hidden = true; el.textContent = ""; }
}
function cancelRequest() {
  api.cancel();
  stopThinking();
  setStatus("⏹ Deteniendo…");
}

/* ── comandos slash ── */
async function command(msg) {
  const c = msg.slice(1).trim();
  const [cmd, ...rest] = c.split(/\s+/);
  const arg = rest.join(" ");
  if (cmd === "run") return run();
  if (cmd === "compare" && !arg) return modalCompare();
  if (cmd === "compare") return compare(arg.split(/\s+/), "", "");
  if (cmd === "history") return history_();
  if (cmd === "resume" && arg) return resume(arg);
  if (cmd === "undo") {
    const r = await api.undo_turn();
    sysMsg(r.msg);
    if (r.tree) { S.tree = r.tree; renderTree(); }
    return;
  }
  if (cmd === "ranking" || cmd === "leaderboard") return showLeaderboard();
  const r = await api.command(cmd, arg, c);
  if (!r) return;
  if (r.open) addTab(r.open.path, r.open.name, r.open.content, r.open.lang);
  if (r.msgs) for (const m of r.msgs) { sysMsg(m.content); persist("system", m.content); }
}

async function history_() {
  const files = await api.history();
  if (!files.length) return sysMsg("Sin historial");
  for (const f of files) sysMsg(`📁 ${f.id}: ${f.first}`);
  sysMsg("💡 /resume <id> para restaurar");
}

async function resume(sid) {
  const msgs = await api.resume(sid);
  if (msgs.error) return sysMsg("❌ " + msgs.error);
  S.chatId = sid;
  $("#msgs").innerHTML = "";
  for (const m of msgs) {
    if (m.role === "user") userMsg(m.content);
    else if (m.role === "LOW") agentMsg(m.content);
    else sysMsg(m.content);
  }
  sysMsg(`📂 Restaurada (${msgs.length} msgs)`);
  renderChatTabs();
}

async function newChat() {
  const id = await api.new_session();
  if (id) S.chatId = id;
  $("#msgs").innerHTML = "";
  sysMsg("Nueva conversación");
  await loadChatTabs();
}

/* ── solapas de conversaciones: navegar entre chats como pestañas ── */
async function loadChatTabs() {
  try { S.chats = await api.history(); } catch (e) { S.chats = []; }
  renderChatTabs();
}

function renderChatTabs() {
  const bar = $("#chatTabs");
  if (!bar) return;
  // asegurar que la conversación activa aparezca aunque todavía no esté guardada
  const items = (S.chats || []).slice();
  if (S.chatId && !items.some(c => c.id === S.chatId))
    items.unshift({ id: S.chatId, first: "Nueva conversación", n: 0 });
  const wrap = $("#chatTabsWrap");
  if (wrap) wrap.hidden = items.length === 0;
  bar.innerHTML = "";
  let activeEl = null;
  for (const c of items) {
    const el = document.createElement("div");
    el.className = "ctab" + (c.id === S.chatId ? " active" : "");
    const label = (c.first && c.first !== "(vacía)") ? c.first : "Nueva conversación";
    el.title = label + (c.n ? `  ·  ${c.n} msgs` : "");
    const t = document.createElement("span");
    t.className = "ctab-t";
    t.textContent = label;   // el ancho lo maneja el CSS (se encoge + ellipsis)
    el.appendChild(t);
    el.onclick = () => switchChat(c.id);
    // botón cerrar (✕) — no dispara el switchChat del contenedor
    const cx = document.createElement("span");
    cx.className = "cx"; cx.textContent = "✕"; cx.title = "Cerrar conversación";
    cx.onclick = (e) => { e.stopPropagation(); closeChat(c.id, label); };
    el.appendChild(cx);
    bar.appendChild(el);
    if (c.id === S.chatId) activeEl = el;
  }
  if (activeEl) activeEl.scrollIntoView({ inline: "nearest", block: "nearest" });
  updateChatNav();
}

/* flechas ‹ ›: solo cuando las solapas no entran ni encogidas */
function updateChatNav() {
  const strip = $("#chatTabs"), l = $("#ctabLeft"), r = $("#ctabRight");
  if (!strip || !l || !r) return;
  const overflow = strip.scrollWidth > strip.clientWidth + 2;
  l.hidden = r.hidden = !overflow;
  if (overflow) {
    l.disabled = strip.scrollLeft <= 1;
    r.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
  }
}

async function switchChat(id) {
  if (!id || id === S.chatId) return;
  await resume(id);
}

async function closeChat(id, label) {
  if (!id) return;
  const r = await api.delete_session(id);
  if (r && r.error) return sysMsg("❌ No pude cerrar la conversación: " + r.error);
  S.chats = (r && r.chats) || [];
  // si cerré la que estaba abierta, el backend arrancó una nueva → limpiar chat
  if (r && r.was_active) {
    S.chatId = r.session_id;
    $("#msgs").innerHTML = "";
    sysMsg(`Cerré «${label || id}». Conversación nueva.`);
  }
  renderChatTabs();
}

/* ── manejadores de tamaño: arrastrar para agrandar/achicar paneles ── */
function makeColSplitter(el, target, side, key) {
  if (!el || !target) return;
  el.addEventListener("mousedown", e => {
    e.preventDefault();
    const x0 = e.clientX, w0 = target.getBoundingClientRect().width;
    el.classList.add("dragging"); document.body.style.cursor = "col-resize";
    const move = ev => {
      const w = side === "left" ? w0 + (ev.clientX - x0) : w0 - (ev.clientX - x0);
      target.style.width = Math.max(140, Math.min(760, w)) + "px";
      cm && cm.refresh();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.classList.remove("dragging"); document.body.style.cursor = "";
      try { localStorage.setItem(key, target.style.width); } catch (e) { /* */ }
      updateChatNav();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
function makeRowSplitter(el, target, key) {
  if (!el || !target) return;
  el.addEventListener("mousedown", e => {
    e.preventDefault();
    const y0 = e.clientY, h0 = target.getBoundingClientRect().height;
    el.classList.add("dragging"); document.body.style.cursor = "row-resize";
    const move = ev => {
      const h = h0 - (ev.clientY - y0);   // el terminal está abajo: arrastrar arriba agranda
      target.style.height = Math.max(40, Math.min(560, h)) + "px";
      cm && cm.refresh();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.classList.remove("dragging"); document.body.style.cursor = "";
      try { localStorage.setItem(key, target.style.height); } catch (e) { /* */ }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
function restorePanelSizes() {
  try {
    const tw = localStorage.getItem("low.tree.w"); if (tw) $("#treewrap").style.width = tw;
    const aw = localStorage.getItem("low.agent.w"); if (aw) $("#agentPanel").style.width = aw;
    const th = localStorage.getItem("low.term.h"); if (th) $("#termOut").style.height = th;
  } catch (e) { /* */ }
}
function initSplitters() {
  makeColSplitter($("#splitTree"), $("#treewrap"), "left", "low.tree.w");
  makeColSplitter($("#splitAgent"), $("#agentPanel"), "right", "low.agent.w");
  makeRowSplitter($("#splitTerm"), $("#termOut"), "low.term.h");
}

/* ── tabla de posiciones histórica de los desafíos ── */
async function showLeaderboard() {
  const r = await api.leaderboard();
  if (!r.n_desafios) return sysMsg("Todavía no hay desafíos guardados — corré uno con ⚖");
  let txt = `🏆 Tabla de posiciones (${r.n_desafios} desafíos)\n`;
  r.tabla.slice(0, 10).forEach((d, i) => {
    txt += `${i + 1}. ${d.model} — ${d.wins} victorias · ${d.tasa}% funciona · ${d.lat_prom}ms prom\n`;
  });
  sysMsg(txt.trimEnd());
}

/* ── propuesta de cambios ── */
async function propose(code) {
  const old = cm.getValue();
  if (code.trim() === old.trim()) return;
  const st = await api.diff_stats(old, code);
  S.loading = true;
  cm.setValue(code);
  S.loading = false;
  for (const [a, b] of st.ranges)
    for (let i = a; i < b && i < cm.lineCount(); i++)
      cm.addLineClass(i, "background", "agent-line");
  S.pending = { old, tid: S.cur };
  const t = curTab();
  if (t) { t.modified = true; renderTabs(); renderTree(); }

  const card = document.createElement("div");
  card.className = "card";
  const row = document.createElement("div");
  row.className = "chg-row";
  row.innerHTML = '<span class="pen">✎</span><span class="file"></span>' +
    `<span class="plus">+${st.adds}</span><span class="minus">−${st.dels}</span>` +
    '<span class="flex1"></span><span class="verdiff">Ver diff</span>';
  row.querySelector(".file").textContent = t ? t.name : "editor";
  row.querySelector(".verdiff").onclick = () => showDiff(old, code, t ? t.name : "editor");
  const btns = document.createElement("div");
  btns.className = "chg-btns";
  const ok = document.createElement("button");
  ok.className = "ok"; ok.textContent = "Aceptar";
  const no = document.createElement("button");
  no.className = "no"; no.textContent = "Rechazar";
  const done = msg => { ok.disabled = no.disabled = true; setStatus(msg); };
  ok.onclick = () => { clearAgentLines(); S.pending = null; done("✅ Cambios aceptados"); };
  no.onclick = () => {
    if (S.pending) {
      if (S.cur === S.pending.tid) { S.loading = true; cm.setValue(S.pending.old); S.loading = false; }
      else {
        const tt = S.tabs.find(x => x.id === S.pending.tid);
        if (tt) tt.doc.setValue(S.pending.old);
      }
      S.pending = null;
    }
    clearAgentLines(); done("↩ Cambios rechazados");
  };
  btns.appendChild(ok); btns.appendChild(no);
  card.appendChild(row); card.appendChild(btns);
  $("#msgs").appendChild(card); scrollMsgs();
}

function clearAgentLines() {
  for (let i = 0; i < cm.lineCount(); i++) cm.removeLineClass(i, "background", "agent-line");
}

/* ── diff lado a lado (antes / después) ── */
function esc(s) {
  // escapa también comillas: esc() se usa dentro de atributos title="…"
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function showDiff(oldTxt, newTxt, name) {
  // LCS por líneas para marcar agregados/borrados/iguales
  const a = oldTxt.split("\n"), b = newTxt.split("\n");
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push(["=", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(["-", a[i]]); i++; }
    else { rows.push(["+", b[j]]); j++; }
  }
  while (i < m) rows.push(["-", a[i++]]);
  while (j < n) rows.push(["+", b[j++]]);
  const body = rows.map(([k, ln]) =>
    `<div class="dl ${k === '+' ? 'dl-add' : k === '-' ? 'dl-del' : ''}">` +
    `<span class="dg">${k === '=' ? ' ' : k}</span>${esc(ln) || "&nbsp;"}</div>`).join("");
  openModal(`<h2>Diff · ${esc(name)}</h2>
    <div class="diffbox">${body}</div>
    <div class="m-actions"><button class="primary" id="mCancel">Cerrar</button></div>`);
  $("#mCancel").onclick = closeModal;
}

/* ── comparar modelos: desafío de código verificado ── */
const DEF_TASK = "Escribe un programa Python que imprima los primeros 10 numeros primos en una sola linea separados por coma.";
const DEF_EXP = "2, 3, 5, 7, 11, 13, 17, 19, 23, 29";

function modalCompare() {

  openModal(`
    <h2>Desafío de código</h2>
    <div class="sub">La misma consigna a cada modelo. LOW compila, ejecuta y verifica
    la salida: gana el código que funciona, no el más rápido.</div>
    <textarea id="cmpTask" class="cmp-field" rows="3" spellcheck="false"></textarea>
    <input id="cmpExp" class="cmp-field" spellcheck="false"
           placeholder="Salida esperada (opcional — si la dejás vacía solo se verifica que corra)">
    ${rows}
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="mGo">Competir</button>
    </div>`);
  $("#cmpTask").value = DEF_TASK;
  $("#cmpExp").value = DEF_EXP;
  $("#mCancel").onclick = closeModal;
  $("#mGo").onclick = () => {
    const sel = [...document.querySelectorAll('#modal input[type="checkbox"]:checked')].map(i => i.dataset.p);
    const task = $("#cmpTask").value.trim();
    const exp = $("#cmpExp").value.trim();
    closeModal();
    if (sel.length) compare(sel, task, exp);
  };
}

async function compare(models, task, expected) {
  await api.compare(task || "", expected || "", models);  // resultados via eventos 'sys'
}

/* ── config de APIs ── */
function modalKeys() {
  const rows = S.providers.map(p =>
    `<div class="krow"><label>${p.name}</label>` +
    `<input type="password" value="${(p.key || "").replace(/"/g, "&quot;")}" data-p="${p.name}" spellcheck="false"></div>`).join("");
  openModal(`
    <h2>API Keys</h2>
    <div class="sub" id="cfgPath"></div>
    ${rows}
    <h2 style="margin-top:16px">Instrucciones del agente</h2>
    <div class="sub">El system prompt completo que recibe el modelo — LOW no
    agrega nada más, ni filtros ni instrucciones ocultas. Vacío = usar el de fábrica.</div>
    <textarea id="sysP" class="cmp-field" rows="4" spellcheck="false"></textarea>
    <h2 style="margin-top:16px">Límites del agente</h2>
    <div class="sub">LOW no le pone techo al trabajo salvo lo que elijas acá (y el
    de la API). Subilos para tareas grandes; el único freno duro es que el agente
    deje de avanzar.</div>
    <div class="agrow"><label>Pasos por tramo</label>
      <input id="agSteps" type="number" min="1" spellcheck="false"></div>
    <div class="agrow"><label>Tramos automáticos</label>
      <input id="agConts" type="number" min="1" spellcheck="false"></div>
    <div class="agrow"><label>Turnos que recuerda</label>
      <input id="agMem" type="number" min="1" spellcheck="false"></div>
    <div class="agrow"><label>Verificar ejecución</label>
      <label class="agchk"><input id="agVerify" type="checkbox"> corre el código y, si falla en runtime, pide corrección (no solo que compile)</label></div>
    <div class="agrow"><label>Revisar diseño (SVG)</label>
      <label class="agchk"><input id="agDesign" type="checkbox"> rasteriza el SVG y lo revisa con visión para que no dibuje a ciegas</label></div>
    <h2 style="margin-top:16px">Redes Sociales</h2>
    <div class="sub">Conectá tus cuentas DESDE ACÁ: al tocar Conectar se abre tu
    navegador, autorizás en la plataforma y el permiso vuelve solo a LOW por un
    callback local — los tokens quedan cifrados en tu máquina. Necesitás una app
    propia en cada plataforma (Canva Developers, Meta for Developers, LinkedIn
    Developers, X Developer Portal, TikTok Developers) con esta Redirect URI
    registrada: <b id="socRedir">…</b></div>
    <div id="socRows" class="sub">Cargando…</div>
    <h2 style="margin-top:16px">Identidad de marca</h2>
    <div class="sub">Brand Profile compacto (JSON): tono, palabras prohibidas
    (banned), hashtags (tags), paleta, fuentes, CTAs. El agente valida TODO lo
    que publica contra esto — se guarda con el botón Guardar de abajo.</div>
    <textarea id="brandJson" class="cmp-field" rows="6" spellcheck="false"></textarea>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="mSave">Guardar</button>
    </div>`);
  api.config_path().then(p => { $("#cfgPath").textContent = "Se guardan en " + p; });
  renderSocialCfg(true);
  $("#sysP").value = S.sysPrompt || "";
  $("#sysP").placeholder = S.defaultSp || "";
  $("#agSteps").value = S.agent.max_steps ?? 40;
  $("#agConts").value = S.agent.max_continuations ?? 25;
  $("#agMem").value = S.agent.memory_turns ?? 24;
  $("#agVerify").checked = S.agent.verify_runtime !== false;   // default: activado
  $("#agDesign").checked = S.agent.verify_design === true;     // default: apagado (opt-in)
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const keys = {};
    document.querySelectorAll('#modal input[type="password"]').forEach(i => { keys[i.dataset.p] = i.value.trim(); });
    S.sysPrompt = $("#sysP").value.trim();
    await api.save_system_prompt(S.sysPrompt);
    const bj = $("#brandJson").value.trim();
    if (bj) {
      try {
        JSON.parse(bj);           // valida antes de mandar
        const rb = await api.social_save_brand(bj);
        if (rb && rb.error) sysMsg("⚠ Marca: " + rb.error);
      } catch (e) {
        sysMsg("⚠ El Brand Profile no es JSON válido — no se guardó (" + e.message + ")");
      }
    }
    S.agent = await api.save_agent_config($("#agSteps").value, $("#agConts").value, $("#agMem").value, $("#agVerify").checked, $("#agDesign").checked);
    const st = await api.save_keys(keys);
    S.providers = st.providers;
    // refrescar el dropdown con los nombres visibles (incluyendo media)
    const allNames = st.providers.map(p => p.media_only ? p.name + " (media)" : p.name);
    const curProv = (st.providers.find(p => p.name === st.provider) || {}).media_only
      ? st.provider + " (media)" : st.provider;
    fillSelect($("#selProv"), allNames, curProv);
    fillSelect($("#selModel"), st.models, st.model);
    updApis(st);
    closeModal();
    sysMsg("✅ Configuración guardada");
  };
}

/* ── ⚙ → Redes Sociales: conexiones OAuth desde LOW ── */
async function renderSocialCfg(firstLoad) {
  const st = await api.social_state();
  if (!$("#socRows")) return;                       // el modal ya se cerró
  if (st && st.error) { $("#socRows").textContent = "⚠ " + st.error; return; }
  $("#socRedir").textContent = st.redirect_uri || "";
  $("#socRows").innerHTML = (st.platforms || []).map(p => p.connected
    ? `<div class="krow soc-row" data-k="${p.key}"><label>${p.label}</label>
         <span class="soc-st" title="${esc(p.handle || "")}">● ${esc(p.handle || "conectado")}</span>
         <button class="ghost soc-off" data-k="${p.key}">Desconectar</button></div>`
    : `<div class="krow soc-row" data-k="${p.key}"><label>${p.label}</label>
         <input class="soc-id" placeholder="Client ID${p.has_app ? " (ya guardado)" : ""}" spellcheck="false">
         <input class="soc-sec" type="password" placeholder="Client Secret (si tu app usa)" spellcheck="false">
         <button class="primary soc-on" data-k="${p.key}">Conectar</button></div>`
  ).join("") || "Módulo social no disponible.";
  document.querySelectorAll("#socRows .soc-on").forEach(b => b.onclick = async () => {
    const row = b.closest(".soc-row");
    b.disabled = true; b.textContent = "Autorizá en el navegador…";
    const r = await api.social_connect(b.dataset.k,
      row.querySelector(".soc-id").value.trim(),
      row.querySelector(".soc-sec").value.trim());
    if (r && r.error) {
      sysMsg("❌ " + b.dataset.k + ": " + r.error);
      b.disabled = false; b.textContent = "Conectar";
    } else {
      sysMsg("✅ Cuenta conectada" + (r.handle ? ": " + r.handle : "") +
             (r.warning ? " · ⚠ " + r.warning : ""));
      renderSocialCfg(false);
    }
  });
  document.querySelectorAll("#socRows .soc-off").forEach(b => b.onclick = async () => {
    await api.social_disconnect(b.dataset.k);
    sysMsg("Cuenta de " + b.dataset.k + " desconectada (token eliminado)");
    renderSocialCfg(false);
  });
  // el brand solo se carga al abrir, para no pisar lo que el usuario esté editando
  if (firstLoad && $("#brandJson"))
    $("#brandJson").value = JSON.stringify(st.brand || {}, null, 2);
}

/* ── Redes sociales: panel del módulo (nuevo post, cola, templates) ── */
async function modalSocial() {
  openModal(`<h2>Redes sociales</h2><div class="sub">Cargando…</div>`);
  const st = await api.social_state();
  if ($("#overlay").hidden) return;                 // lo cerraron mientras cargaba
  if (st && st.error) {
    openModal(`<h2>Redes sociales</h2><div class="sub">${esc(st.error)}</div>
      <div class="m-actions"><button class="primary" id="mCancel">Cerrar</button></div>`);
    $("#mCancel").onclick = closeModal;
    return;
  }
  const nets = (st.platforms || []).filter(p => p.key !== "canva");
  const conn = nets.filter(p => p.connected);
  const canva = (st.platforms || []).find(p => p.key === "canva");
  const chips = (st.platforms || []).map(p =>
    `<span class="soc-chip${p.connected ? " on" : ""}" title="${esc(p.handle || (p.connected ? "conectada" : "sin conectar — Cuentas y marca"))}">${esc(p.label)}</span>`).join("");
  const tplOpts = ['<option value="">Sin template (solo texto)</option>']
    .concat((st.templates || []).map(t =>
      `<option value="${t.id}">${esc(t.name || t.canva_template_id)}${t.format ? " · " + esc(t.format) : ""}</option>`)).join("");
  const netOpts = conn.length
    ? conn.map(p => `<option value="${p.key}">${esc(p.label)}</option>`).join("")
    : '<option value="">Sin cuentas conectadas</option>';
  // estado → [ícono del set, etiqueta]
  const ST = { draft: ["i-pencil", "borrador"], validated: ["i-check", "validado"],
               rendering: ["i-image", "render"], ready: ["i-artifact", "listo"],
               scheduled: ["i-clock", "programado"], publishing: ["i-send", "publicando"],
               published: ["i-check", "publicado"], failed: ["i-x", "falló"] };
  const rows = (st.queue || []).map(q => {
    const [ico, lbl] = ST[q.status] || ["i-file", q.status];
    return `<div class="q-row st-${q.status}">
      <span class="q-st" title="${esc(q.error || lbl)}">${icoUse(ico)} ${lbl}</span>
      <span class="q-net">${esc(q.network)}</span>
      <span class="q-cap" title="${esc(q.caption)}">${esc(q.caption) || "(sin texto)"}</span>
      <span class="q-when">${esc((q.published_at || q.scheduled_at || "").replace("T", " ").slice(0, 16))}</span>
      ${q.status === "published" || q.status === "publishing" ? ""
        : `<button class="ibtn q-go" data-id="${q.id}" title="Validar contra la marca, renderizar y publicar ya">${icoUse("i-play")}</button>`}
      ${q.status === "publishing" ? ""
        : `<button class="ibtn q-del" data-id="${q.id}" title="Quitar de la cola">${icoUse("i-x")}</button>`}
    </div>`;
  }).join("") || '<div class="sub">La cola está vacía — creá tu primer post arriba.</div>';
  openModal(`
    <h2>Redes sociales</h2>
    <div class="sub">El autopiloto de LOW: encolás el post, el agente lo valida
    contra tu marca, lo renderiza con Canva (si elegís template) y lo publica
    solo — ya o a la hora programada.</div>
    <div class="soc-chips">${chips}
      <div class="flex1"></div>
      <button class="ghost soc-btn" id="socCfg" title="Conectar cuentas (OAuth) y editar la identidad de marca">${icoUse("i-gear")} Cuentas y marca</button>
      ${canva && canva.connected ? `<button class="ghost soc-btn" id="socSync" title="Traer los Brand Templates de tu Canva">${icoUse("i-routine")} Templates</button>` : ""}
    </div>
    <h2 style="margin-top:14px">Nuevo post</h2>
    <div class="krow"><label>Red</label><select id="socNet" class="langsel">${netOpts}</select>
      <label class="soc-l2">Template</label><select id="socTpl" class="langsel">${tplOpts}</select></div>
    <textarea id="socCopy" class="cmp-field" rows="3" spellcheck="false"
      placeholder="¿Qué querés publicar? El agente lo adapta al tono de tu marca y a los límites de la red."></textarea>
    <div class="krow"><label>Programar</label><input type="datetime-local" id="socWhen">
      <button class="ghost soc-btn" id="socQueue" title="Queda en la cola y sale solo a la hora elegida">${icoUse("i-clock")} Programar</button>
      <div class="flex1"></div>
      <button class="primary soc-btn" id="socNow" title="Validar, renderizar y publicar ahora mismo">${icoUse("i-send")} Publicar ya</button></div>
    <h2 style="margin-top:14px">Cola de contenido</h2>
    <div id="socQ">${rows}</div>
    <div class="m-actions">
      <button class="ghost soc-btn" id="socRefresh">${icoUse("i-routine")} Actualizar</button>
      <button class="primary" id="mCancel">Cerrar</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#socRefresh").onclick = modalSocial;
  $("#socCfg").onclick = () => { closeModal(); modalKeys(); };
  const sync = $("#socSync");
  if (sync) sync.onclick = async () => {
    sync.disabled = true; sync.textContent = "Sincronizando…";
    const r = await api.social_sync_templates();
    if (r && r.error) sysMsg("Templates: " + r.error);
    else sysMsg(`${(r.templates || []).length} template(s) de Canva sincronizados`);
    modalSocial();
  };
  const newPost = async (publishNow) => {
    const net = $("#socNet").value;
    const copy = $("#socCopy").value.trim();
    const tpl = $("#socTpl").value;
    const when = $("#socWhen").value;
    if (!net) return sysMsg("Conectá una cuenta primero (Cuentas y marca)");
    if (!copy) return sysMsg("Escribí el contenido del post");
    if (!publishNow && !when) return sysMsg("Elegí fecha y hora para programarlo");
    const btn = $(publishNow ? "#socNow" : "#socQueue");
    const prev = btn.innerHTML;
    btn.disabled = true; btn.textContent = publishNow ? "Publicando…" : "Encolando…";
    const r = await api.social_enqueue(net, copy, tpl,
      publishNow ? "" : new Date(when).toISOString());
    if (r && r.error) {
      sysMsg(r.error);
      btn.disabled = false; btn.innerHTML = prev;
      return;
    }
    if (publishNow) {
      const p = await api.social_publish_now(r.qid);
      if (p && p.error) sysMsg(p.error);
    } else {
      sysMsg(`Post #${r.qid} programado para ${when.replace("T", " ")} — sale solo`);
    }
    modalSocial();
  };
  $("#socNow").onclick = () => newPost(true);
  $("#socQueue").onclick = () => newPost(false);
  document.querySelectorAll("#socQ .q-go").forEach(b => b.onclick = async () => {
    b.disabled = true;
    const p = await api.social_publish_now(b.dataset.id);
    if (p && p.error) sysMsg(p.error);
    modalSocial();
  });
  document.querySelectorAll("#socQ .q-del").forEach(b => b.onclick = async () => {
    const r = await api.social_queue_delete(b.dataset.id);
    if (r && r.error) sysMsg(r.error);
    modalSocial();
  });
}

function openModal(html) { $("#modal").innerHTML = html; $("#overlay").hidden = false; }
function closeModal() { $("#overlay").hidden = true; }

/* ── buscador de modelos: filtra en vivo entre TODOS los del proveedor ── */
function modalModelSearch() {
  const opts = [...$("#selModel").options].map(o => o.value)
    .filter(v => v && v !== "(configura la key)");
  if (!opts.length) return sysMsg("No hay modelos para buscar — configurá la API key del proveedor (⚙).");
  const cur = $("#selModel").value;
  openModal(`<h2>Buscar modelo</h2>
    <div class="sub">Proveedor: <b>${$("#selProv").value}</b> · ${opts.length} modelos disponibles</div>
    <input id="mq" class="cmp-field" placeholder="Escribí para filtrar (ej: qwen, vl, deepseek, 32b)…" autocomplete="off" spellcheck="false">
    <div id="mlist" class="mlist"></div>
    <div class="m-actions"><button class="ghost" id="mCancel">Cerrar</button></div>`);
  const render = (q) => {
    q = (q || "").toLowerCase().trim();
    const terms = q.split(/\s+/).filter(Boolean);
    const list = $("#mlist"); list.innerHTML = "";
    const filtered = opts.filter(v => terms.every(t => v.toLowerCase().includes(t)));
    if (!filtered.length) { list.innerHTML = '<div class="sub">Sin coincidencias.</div>'; return; }
    for (const v of filtered.slice(0, 300)) {
      const el = document.createElement("div");
      el.className = "mrow" + (v === cur ? " cur" : "");
      el.textContent = v;
      el.title = v;
      el.onclick = () => {
        $("#selModel").value = v; api.set_model(v); closeModal();
        sysMsg("Modelo → " + v);
      };
      list.appendChild(el);
    }
    if (filtered.length > 300)
      list.insertAdjacentHTML("beforeend", `<div class="sub">…y ${filtered.length - 300} más — afiná el filtro.</div>`);
  };
  render("");
  const q = $("#mq"); q.oninput = () => render(q.value); q.focus();
  $("#mCancel").onclick = closeModal;
}

/* ══ Artefactos: vista previa en vivo del HTML/web generado, DENTRO de LOW ══ */
function addArtifact(name, html, path) {
  S.artifacts = S.artifacts || [];
  const ex = S.artifacts.find(a => a.path === path && path);
  if (ex) { ex.html = html; ex.name = name; S.artIdx = S.artifacts.indexOf(ex); }
  else { S.artifacts.push({ name, html, path: path || "" }); S.artIdx = S.artifacts.length - 1; }
}
function renderArtSelect() {
  const sel = $("#artSel");
  sel.innerHTML = "";
  (S.artifacts || []).forEach((a, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = a.name || ("artefacto " + (i + 1));
    sel.appendChild(o);
  });
  sel.value = S.artIdx;
}
function paintArtifact() {
  const a = (S.artifacts || [])[S.artIdx];
  if (!a) return;
  $("#artTitle").textContent = a.name || "Artefacto";
  $("#artFrame").srcdoc = a.html;
  // el dock de edición con IA solo aparece sobre imágenes reales del disco
  $("#imgDock").hidden = !(a.path && IMG_RE.test(a.path));
  renderArtSelect();
}

/* ── editar la imagen abierta con IA (img2img): versión nueva al lado ── */
function imgDockStatus(txt) {
  const el = $("#imgDockStatus");
  if (!txt) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false; el.textContent = txt;
}
async function imgEdit() {
  const a = (S.artifacts || [])[S.artIdx];
  const ta = $("#imgPromptIn");
  const prompt = ta.value.trim();
  if (!a || !a.path || !prompt || S.imgBusy) return;
  ta.value = "";
  S.imgBusy = true;
  imgDockStatus("🎨 Editando la imagen con IA (puede tardar ~medio minuto)…");
  try {
    const r = await api.edit_image(a.path, prompt);
    if (r && r.error) { imgDockStatus("❌ " + r.error); return; }
    imgDockStatus("✅ Versión nueva: " + (r.name || "") + " — la original queda intacta. ‹ › para comparar.");
    try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
    await openImage(r.path);
  } catch (e) {
    imgDockStatus("❌ " + (e.message || e));
  } finally {
    S.imgBusy = false;
  }
}
function showArtifacts() {
  if (!(S.artifacts || []).length) { sysMsg("Todavía no hay artefactos — pedile al agente una página o app web, o abrí un .html y tocá ▶"); return; }
  $("#artView").hidden = false;
  paintArtifact();
}
function closeArtifacts() { $("#artView").hidden = true; }

/* ══ Entorno de diseño: SVG vivo + inspector por elemento ══ */
const DZ = { path: null, sel: null, zoom: 1 };
const DZ_FONTS = ["Figtree", "Arial", "Helvetica", "Verdana", "Trebuchet MS",
  "Georgia", "Times New Roman", "Courier New", "JetBrains Mono", "Impact",
  "Comic Sans MS", "serif", "sans-serif", "monospace"];
// pares tipográficos sugeridos (título / cuerpo) — clic para aplicar al texto
const DZ_PAIRS = [
  ["Impact", "Helvetica"], ["Georgia", "Verdana"],
  ["Trebuchet MS", "Georgia"], ["Figtree", "JetBrains Mono"],
];

async function openDesign(path) {
  if (DZ.path && DZ.path !== path) await dzPersist();
  const r = await api.image_data(path);
  if (!r || r.error || !r.svg) return sysMsg("❌ No pude abrir el diseño: " + ((r && r.error) || path));
  DZ.path = path; DZ.sel = null;
  $("#dzTitle").textContent = r.name || path.split(/[\\/]/).pop();
  const cv = $("#dzCanvas");
  // NO usar innerHTML: adentro del lienzo viven #dzHandle y #dzPin — pisarlos
  // rompía todo el editor ("Cannot set properties of null"). Solo cambiar el svg.
  cv.querySelectorAll("svg").forEach(n => n.remove());
  const tmp = document.createElement("div"); tmp.innerHTML = r.svg;
  const svg = tmp.querySelector("svg");
  if (!svg) return sysMsg("❌ El archivo no tiene un <svg> válido: " + path);
  cv.insertBefore(svg, $("#dzHandle"));
  if (!svg.getAttribute("width")) svg.style.width = "min(80vw, 900px)";
  DZ.zoom = 1; DZ.panX = 0; DZ.panY = 0; dzApplyZoom();
  DZ.undo = []; DZ.redo = [];   // pilas de deshacer por archivo
  DZ.dirty = false;             // recién cargado = limpio (no arrastrar el flag)
  DZ.multi = []; dzNodesClear();
  dzPaletteRender();
  $("#dzProps").hidden = true; $("#dzEmpty").hidden = false;
  $("#dzHandle").hidden = true;
  $("#dzCode").hidden = true;
  dzBuildLayers();
  if (DZ.d3) dz3dBuild();       // en espacio 3D: reconstruir los planos del cuadro nuevo
  $("#designView").hidden = false;
}
function closeDesign() { dzPersist(); if (DZ.d3) dz3dExit(true); $("#designView").hidden = true; DZ.sel = null; if (RULER) dzRulerClear(); }

/* zoom del lienzo (no altera el SVG, solo la vista) */
function dzApplyZoom() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (svg) svg.style.transform =
    `translate(${DZ.panX || 0}px, ${DZ.panY || 0}px) rotate(${DZ.viewRot || 0}deg) scale(${DZ.zoom})`;
  const lbl = $("#dzZoomLbl"); if (lbl) lbl.textContent = Math.round(DZ.zoom * 100) + "%";
  const rl = $("#dzRotLbl"); if (rl) rl.textContent = Math.round(DZ.viewRot || 0) + "°";
  const sb = $("#sbZoom"); if (sb) sb.textContent = Math.round(DZ.zoom * 100) + "%" +
    (DZ.viewRot ? " · " + Math.round(DZ.viewRot) + "°" : "");
  dzPositionHandle();
  if (DZ.nodeEl && DZ.nodeEl.isConnected) dzNodesShow(DZ.nodeEl);   // reubicar nodos
  if (DZ.camMode) dzCamOverlay();                                    // y el encuadre
  if (DZ.rulers || DZ.grid || (DZ.guides && DZ.guides.length)) dzRulersRender();
  dzPivotMark();
}
/* modo dibujo (Tab): oculta menús, paneles, timeline y dock — solo lienzo +
   herramientas, para dibujar sin distracción (como el Tab de Photoshop). */
function dzZenToggle() {
  const dv = $("#designView");
  const on = dv.classList.toggle("dz-zen");
  $("#dzZen").classList.toggle("active", on);
  let exit = $("#dzZenExit");
  if (on && !exit) {
    exit = document.createElement("button");
    exit.id = "dzZenExit"; exit.className = "dz-zen-exit";
    exit.textContent = "✕ salir del modo dibujo (Tab)";
    exit.onclick = dzZenToggle;
    dv.appendChild(exit);
  }
  if (exit) exit.style.display = on ? "block" : "none";
  setTimeout(() => { try { dzFitView(); } catch (e) { /* */ } }, 60);
}
/* girar la VISTA (como girar la hoja para dibujar cómodo — Krita/OpenToonz):
   solo cambia cómo se ve; el dibujo y las coordenadas no se tocan */
function dzRotView(delta) {
  DZ.viewRot = ((DZ.viewRot || 0) + delta) % 360;
  dzApplyZoom();
}
/* ajustar a pantalla DE VERDAD: calcula el zoom para que el lienzo entre
   completo en la mesa de trabajo (antes solo reseteaba a 100%) */
function dzFitView() {
  const svg = $("#dzCanvas").querySelector("svg");
  const cont = $("#dzCanvas");
  if (!svg || !cont) return;
  DZ.viewRot = 0; DZ.panX = 0; DZ.panY = 0;
  svg.style.transform = "scale(1)";
  const r = svg.getBoundingClientRect(), c = cont.getBoundingClientRect();
  if (r.width > 2 && r.height > 2)
    DZ.zoom = Math.max(0.05, Math.min(4,
      Math.min((c.width - 48) / r.width, (c.height - 48) / r.height)));
  dzApplyZoom();
}
/* ── 📄 Documento: tamaño del lienzo, presets y color de fondo ── */
const DZ_DOC_PRESETS = [
  ["Cuadrado 1080×1080 (Instagram)", 1080, 1080],
  ["HD horizontal 1920×1080", 1920, 1080],
  ["Vertical 1080×1920 (Stories/TikTok)", 1080, 1920],
  ["Cine 2048×858 (2K scope)", 2048, 858],
  ["A4 impresión 2480×3508 (300dpi)", 2480, 3508],
  ["Carta 2550×3300", 2550, 3300],
];
function dzDocModal() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  const vb = dzVB();
  // el fondo es el rect que cubre (casi) todo el lienzo, si existe
  const bg = [...svg.querySelectorAll("rect")].find(rc =>
    ((+rc.getAttribute("width") || 0) * (+rc.getAttribute("height") || 0)) >= vb[2] * vb[3] * 0.9);
  const bgColor = bg ? dzHex(bg.getAttribute("fill")) || "#ffffff" : "#ffffff";
  openModal(`<h2>📄 Documento</h2>
    <div class="sub">El tamaño define el viewBox del lienzo. Los elementos no se mueven:
    si achicás el documento pueden quedar afuera (los ves igual y los podés reacomodar).</div>
    <div class="dz-style-row">
      <span class="dz-hint">Preset</span>
      <select id="docPreset" class="langsel" style="flex:1">
        <option value="">— personalizado —</option>
        ${DZ_DOC_PRESETS.map((p, i) => `<option value="${i}">${p[0]}</option>`).join("")}
      </select>
    </div>
    <div class="dz-style-row">
      <span class="dz-hint">Ancho</span><input type="number" id="docW" class="dz-win" style="width:76px" value="${vb[2]}" min="16" max="8000">
      <span class="dz-hint">Alto</span><input type="number" id="docH" class="dz-win" style="width:76px" value="${vb[3]}" min="16" max="8000">
      <span class="dz-hint">Fondo</span><input type="color" id="docBg" value="${bgColor}">
      <label class="dz-hint" style="display:flex;align-items:center;gap:4px">
        <input type="checkbox" id="docNoBg" ${bg ? "" : "checked"}> sin fondo (transparente)</label>
    </div>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="docGo">Aplicar</button>
    </div>`);
  $("#docPreset").onchange = (e) => {
    const p = DZ_DOC_PRESETS[+e.target.value];
    if (p) { $("#docW").value = p[1]; $("#docH").value = p[2]; }
  };
  $("#mCancel").onclick = closeModal;
  $("#docGo").onclick = () => {
    const W = Math.max(16, +$("#docW").value || vb[2]);
    const H = Math.max(16, +$("#docH").value || vb[3]);
    const color = $("#docBg").value, noBg = $("#docNoBg").checked;
    closeModal();
    dzSnapshot();
    svg.setAttribute("viewBox", `${vb[0]} ${vb[1]} ${W} ${H}`);
    if (svg.getAttribute("width")) svg.setAttribute("width", W);
    if (svg.getAttribute("height")) svg.setAttribute("height", H);
    if (noBg) {
      if (bg) bg.remove();
    } else if (bg) {
      bg.setAttribute("x", vb[0]); bg.setAttribute("y", vb[1]);
      bg.setAttribute("width", W); bg.setAttribute("height", H);
      bg.setAttribute("fill", color);
    } else {
      const rc = document.createElementNS(SVGNS, "rect");
      rc.setAttribute("x", vb[0]); rc.setAttribute("y", vb[1]);
      rc.setAttribute("width", W); rc.setAttribute("height", H);
      rc.setAttribute("fill", color);
      svg.insertBefore(rc, svg.firstChild);
    }
    dzMarkDirty(); dzBuildLayers(); dzFitView();
    dzSetStatus(`📄 Documento: ${W}×${H}` + (noBg ? " · fondo transparente" : ""));
  };
}
/* paneo del lienzo: espacio+arrastrar o botón del medio (mano de Toon Boom).
   Devuelve true si el evento era un paneo (los demás handlers lo ignoran). */
function dzPanMaybe(e, force) {
  if (!force && !DZ.spaceDown && e.button !== 1 && (DZ.tool || "select") !== "hand") return false;
  e.preventDefault(); e.stopPropagation();
  const x0 = e.clientX - (DZ.panX || 0), y0 = e.clientY - (DZ.panY || 0);
  const cv = $("#dzCanvas");
  cv.style.cursor = "grabbing";
  const move = (ev) => { DZ.panX = ev.clientX - x0; DZ.panY = ev.clientY - y0; dzApplyZoom(); };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    cv.style.cursor = DZ.spaceDown ? "grab" : ((DZ.tool || "select") in DZ_CURSORS ? DZ_CURSORS[DZ.tool || "select"] : "crosshair");
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
  return true;
}
function dzZoom(delta) { DZ.zoom = Math.min(4, Math.max(0.2, Math.round((DZ.zoom + delta) * 100) / 100)); dzApplyZoom(); }
/* zoom HACIA UN PUNTO de pantalla (cursor): el punto bajo el mouse queda fijo
   mientras el lienzo crece/achica — comportamiento pro (OpenToonz/Blender).
   Compensa el pan para que el ancla no se corra. factor >1 acerca, <1 aleja. */
function dzZoomAt(factor, clientX, clientY) {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) { dzZoom(factor > 1 ? 0.15 : -0.15); return; }
  const z0 = DZ.zoom;
  const z1 = Math.min(6, Math.max(0.1, Math.round(z0 * factor * 100) / 100));
  const k = z1 / z0;
  if (k === 1) return;
  // centro visual actual del lienzo en pantalla (incluye el pan ya aplicado)
  const r = svg.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  // el offset cursor→centro se escala por k; ajusto el pan para cancelar la deriva
  DZ.panX = (DZ.panX || 0) + (clientX - cx) * (1 - k);
  DZ.panY = (DZ.panY || 0) + (clientY - cy) * (1 - k);
  DZ.zoom = z1;
  dzApplyZoom();
}

function dzSelect(el) {
  if (DZ.sel) DZ.sel.classList.remove("dz-sel");
  DZ.sel = el; el.classList.add("dz-sel");
  dzBuildInspector(el);
  dzPositionHandle();
  dzBuildLayers();
  if (DZ.rigMode) dzRigPanelSync();
  dzStyleSync(el);
  dzPivotMark();
  // modo comentario: el dock ahora apunta SOLO a este elemento
  $("#dzPrompt").placeholder = `💬 Comentario sobre <${el.tagName.toLowerCase()}> — LOW edita SOLO ese elemento`;
}
function dzDeselect() {
  if (DZ.sel) { DZ.sel.classList.remove("dz-sel"); DZ.sel = null; }
  dzClearMulti();
  $("#dzProps").hidden = true; $("#dzEmpty").hidden = false;
  $("#dzHandle").hidden = true; $("#dzPin").hidden = true;
  const box = $("#dzSelBox"); if (box) box.hidden = true;
  const rot = $("#dzRotate"); if (rot) rot.hidden = true;
  const pv = $("#dzPivot"); if (pv) pv.hidden = true;
  dzBuildLayers();
  $("#dzPrompt").placeholder = "Pedile un cambio a LOW… ej: «hacé el título más grande y centralo»";
}
/* ubica el tirador de resize (esquina inferior-derecha) y el pin de comentario
   (esquina superior-izquierda) sobre el elemento seleccionado */
function dzPositionHandle() {
  const h = $("#dzHandle"), pin = $("#dzPin"), rot = $("#dzRotate"), box = $("#dzSelBox");
  h.hidden = true;                             // la caja PS reemplaza al tirador único
  if (!DZ.sel) { pin.hidden = true; if (rot) rot.hidden = true; if (box) box.hidden = true; return; }
  try {
    const cvRect = $("#dzCanvas").getBoundingClientRect();
    const b = DZ.sel.getBoundingClientRect();
    if (box) {
      box.style.left = (b.left - cvRect.left) + "px";
      box.style.top = (b.top - cvRect.top) + "px";
      box.style.width = Math.max(1, b.width) + "px";
      box.style.height = Math.max(1, b.height) + "px";
      box.hidden = false;
    }
    pin.style.left = (b.left - cvRect.left + 4) + "px";
    pin.style.top = (b.top - cvRect.top) + "px";
    pin.hidden = false;
    if (rot) {
      rot.style.left = ((b.left + b.right) / 2 - cvRect.left) + "px";
      rot.style.top = (b.top - cvRect.top - 22) + "px";
      rot.hidden = false;
    }
  } catch (e) { pin.hidden = true; if (rot) rot.hidden = true; if (box) box.hidden = true; }
}
/* resize desde cualquiera de los 8 tiradores, anclado al tirador OPUESTO
   (transformación libre de Photoshop). hx,hy ∈ {-1,0,1}. */
function dzBoxHandleDown(e, hx, hy) {
  if (!DZ.sel) return;
  e.preventDefault(); e.stopPropagation();
  dzSnapshot();
  const el = DZ.sel;
  const start = dzToUser(e.clientX, e.clientY);
  const bb = el.getBoundingClientRect();
  const p1 = dzToUser(bb.left, bb.top), p2 = dzToUser(bb.right, bb.bottom);
  const w0 = Math.max(1, p2.x - p1.x), h0 = Math.max(1, p2.y - p1.y);
  let lb = null; try { lb = el.getBBox(); } catch (err) { /* sin bbox */ }
  if (!lb) return;
  const tr0 = el.getAttribute("transform") || "";
  // ancla LOCAL = tirador opuesto (si agarro la derecha, fijo la izquierda)
  const axL = hx > 0 ? lb.x : hx < 0 ? lb.x + lb.width : lb.x + lb.width / 2;
  const ayL = hy > 0 ? lb.y : hy < 0 ? lb.y + lb.height : lb.y + lb.height / 2;
  const corner = hx !== 0 && hy !== 0;
  const move = (ev) => {
    const p = dzToUser(ev.clientX, ev.clientY);
    const dx = (p.x - start.x) * hx, dy = (p.y - start.y) * hy;
    let kx = hx ? Math.max(0.05, (w0 + dx) / w0) : 1;
    let ky = hy ? Math.max(0.05, (h0 + dy) / h0) : 1;
    // esquina: proporcional por defecto; Shift = deformar libre
    if (corner && !ev.shiftKey) { const k = Math.max(kx, ky); kx = ky = k; }
    const tsc = `translate(${(axL * (1 - kx)).toFixed(2)} ${(ayL * (1 - ky)).toFixed(2)}) scale(${kx.toFixed(4)} ${ky.toFixed(4)})`;
    el.setAttribute("transform", (tr0 ? tr0 + " " : "") + tsc);
    dzPositionHandle();
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    dzBuildInspector(el); dzMarkDirty();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

/* ══ rigging (pivotes 📌): fija el eje de rotación de un elemento/parte del
   cuerpo — el posado cutout de Toon Boom (peg pivots). El pivote se guarda
   en data-pivot y la rotación gira alrededor de él. ══ */
function dzPivotClick(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest || !el.closest("#dzCanvas svg") || el.closest("g.dz-onion")) return;
  let target = el;
  const grp = el.closest && el.closest('#dzCanvas svg > g:not(.dz-onion)');
  if (grp && !e.altKey) target = grp;            // en un rig, la parte suele ser un grupo
  if (target.tagName.toLowerCase() === "svg") return;
  dzSnapshot();
  if (e.altKey && target.hasAttribute("data-pivot")) {
    target.removeAttribute("data-pivot");
    dzSelect(target); dzMarkDirty();
    dzSetStatus("📌 Pivote quitado — la rotación vuelve al centro");
    return;
  }
  const p = dzToUser(e.clientX, e.clientY);
  target.setAttribute("data-pivot", `${Math.round(p.x)} ${Math.round(p.y)}`);
  dzSelect(target); dzMarkDirty();
  dzSetStatus("📌 Pivote fijado — rotá con la manija ⟳ y gira desde acá (hombro, codo, cadera…). Alt+clic lo quita.");
}
function dzPivotMark() {
  const m = $("#dzPivot");
  if (!m) return;
  const pv = DZ.sel && DZ.sel.getAttribute && DZ.sel.getAttribute("data-pivot");
  if (!pv || !$("#dzCanvas").querySelector("svg")) { m.hidden = true; return; }
  const [px, py] = pv.split(/[\s,]+/).map(Number);
  const sp = dzToScreen(px, py);
  m.style.left = sp.x + "px"; m.style.top = sp.y + "px";
  m.hidden = false;
}

/* rotación (manija ⟳ arriba de la selección): gira alrededor del PIVOTE si
   el elemento tiene uno (rig cutout) o del centro si no; Shift ajusta de a
   15°. Reemplaza SOLO el rotate() agregado por este mismo arrastre. */
function dzRotateDown(e) {
  if (!DZ.sel) return;
  e.preventDefault(); e.stopPropagation();
  dzSnapshot();
  const el = DZ.sel;
  const b = el.getBoundingClientRect();
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
  let c = dzToUser(cx, cy);                      // centro en coords de usuario
  const pv = el.getAttribute("data-pivot");
  if (pv) {
    const [px, py] = pv.split(/[\s,]+/).map(Number);
    if (!isNaN(px) && !isNaN(py)) c = { x: px, y: py };   // rig: gira desde el pivote
  }
  const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
  const base = el.getAttribute("transform") || "";
  const move = (ev) => {
    let deg = (Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0) * 180 / Math.PI;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    deg = Math.round(deg * 10) / 10;
    el.setAttribute("transform", (base ? base + " " : "") +
      `rotate(${deg} ${c.x.toFixed(1)} ${c.y.toFixed(1)})`);
    dzPositionHandle();
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    dzMarkDirty(); dzBuildInspector(el);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

/* botón "Diseño" de la barra: reabre el diseño actual, o crea un lienzo nuevo
   para que se vean las herramientas aunque no haya un SVG abierto todavía */
async function designEntry() {
  if (DZ.path) { $("#designView").hidden = false; return; }
  const r = await api.new_design();
  if (r && r.error) return sysMsg("❌ " + r.error);
  if (r && r.path) {
    try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
    await openDesign(r.path);
    try { dzFitView(); } catch (e) { /* */ }
    dzSetStatus("🎨 Página en blanco lista — dibujá con las herramientas de la izquierda o pedile un diseño a LOW abajo. 📄 cambia el tamaño del lienzo.");
  }
}

/* convierte coordenadas de pantalla a unidades de usuario del SVG (respeta
   viewBox y el zoom CSS, porque usa la matriz real de pantalla) */
function dzToUser(clientX, clientY) {
  const svg = $("#dzCanvas").querySelector("svg");
  const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

/* mousedown en el lienzo: selecciona el elemento y prepara arrastre para mover */
function dzPointerDown(e) {
  dzReleaseFocus();
  if (dzPanMaybe(e)) return;                           // espacio/botón medio: panear
  if (e.target.id === "dzHandle" || e.target.id === "dzRotate") return;   // tiradores propios
  if (e.target.closest && e.target.closest("#dzCam")) return;             // la cámara maneja lo suyo
  if (!["select", "direct"].includes(DZ.tool || "select")) return;   // otras: pointer events
  let el = e.target;
  if (!el || el === $("#dzCanvas") || el.tagName.toLowerCase() === "svg") { dzDeselect(); return; }
  if (el.closest && el.closest("g.dz-onion")) { dzDeselect(); return; }
  if (el.closest && el.closest("[data-locked]")) { dzDeselect(); return; }   // capa bloqueada 🔒
  // clic dentro de un grupo real (<g> guardado): seleccionar el GRUPO (como
  // Illustrator); doble clic entraría al hijo — acá con Shift+clic alcanza
  const grp = el.closest && el.closest('#dzCanvas svg > g:not(.dz-onion)');
  if (grp && !e.altKey && DZ.tool !== "direct") el = grp;   // flecha blanca: pieza directa
  e.preventDefault();
  // Shift+clic: sumar/sacar de la selección múltiple (para agrupar/alinear/mover juntos)
  DZ.multi = DZ.multi || [];
  if (e.shiftKey) {
    const i = DZ.multi.indexOf(el);
    if (i >= 0) { DZ.multi.splice(i, 1); el.classList.remove("dz-msel"); }
    else { DZ.multi.push(el); el.classList.add("dz-msel"); }
    if (DZ.sel && !DZ.multi.includes(DZ.sel)) { DZ.multi.push(DZ.sel); DZ.sel.classList.add("dz-msel"); }
    dzSelect(el);
    dzSetStatus(DZ.multi.length > 1 ? "⧉ " + DZ.multi.length + " elementos seleccionados — Ctrl+G agrupa, arrastrá para moverlos juntos" : "");
    return;
  }
  // clic normal sobre algo fuera de la multi → limpiarla
  if (DZ.multi.length && !DZ.multi.includes(el)) dzClearMulti();
  if (el !== DZ.sel) dzSelect(el);
  const start = dzToUser(e.clientX, e.clientY);
  const pack = (DZ.multi.length > 1 && DZ.multi.includes(el)) ? DZ.multi : [el];
  const bases = pack.map(n => ({ n, base: dzReadPos(n) }));
  let moved = false;
  // ◆ modo rig + pieza con nombre: el arrastre POSA (clave), no toca el dibujo.
  // Grabando (🎥): el arrastre ES la actuación — se muestrea con su tiempo real.
  let rigDrag = null;
  if (DZ.rigMode && pack.length === 1 && el.id) {
    const recNow = DZ.perf && DZ.perf.rec;
    const num = recNow ? 1 + (performance.now() - recNow.t0) / 1000 * recNow.fps : dzRigCur();
    const pv = dzRigPivotOf(el);
    rigDrag = { id: el.id, pv,
                k0: dzRigAt(el.id, num) || { x: 0, y: 0, r: 0, s: 1 },
                a0: Math.atan2(start.y - pv.y, start.x - pv.x) };
    if (recNow) { recNow.active = el.id; recNow.take[el.id] = recNow.take[el.id] || []; }
  }
  // ⏺ grabación armada: este arrastre ES la actuación — muestrear el gesto
  let rec = null;
  if (DZ.rec && DZ.rec.armed) {
    const path = dzElPath(el);
    if (path) {
      rec = { el, path, samples: [[0, 0, 0]], t0: performance.now(), last: [0, 0] };
      dzSetStatus("⏺ GRABANDO el movimiento… soltá para terminar");
    }
  }
  const move = (ev) => {
    const p = dzToUser(ev.clientX, ev.clientY);
    const dx = p.x - start.x, dy = p.y - start.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 1) return;
    if (!moved && !rigDrag) dzSnapshot();              // primer movimiento real
    moved = true;
    if (rigDrag) {
      let pose;
      if (ev.shiftKey) {                       // bastón del títere: rotar desde el pivote
        const a = Math.atan2(p.y - rigDrag.pv.y, p.x - rigDrag.pv.x);
        pose = { ...rigDrag.k0, r: (rigDrag.k0.r || 0) + (a - rigDrag.a0) * 180 / Math.PI };
      } else {
        pose = { ...rigDrag.k0, x: rigDrag.k0.x + dx, y: rigDrag.k0.y + dy };
      }
      dzRigApplyTo(el, pose);
      rigDrag.pose = pose;
      const rec = DZ.perf && DZ.perf.rec;
      if (rec) rec.take[rigDrag.id].push({ t: (performance.now() - rec.t0) / 1000,
                                           x: pose.x, y: pose.y, r: pose.r || 0, s: pose.s });
    } else {
      bases.forEach(b => dzWritePos(b.n, b.base, dx, dy));
    }
    if (rec) { rec.last = [dx, dy]; rec.samples.push([dx, dy, performance.now() - rec.t0]); }
    dzPositionHandle();
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    if (rigDrag && DZ.perf && DZ.perf.rec) {
      DZ.perf.rec.active = null;               // la pieza vuelve al replay de su pista
    } else if (moved && rigDrag && rigDrag.pose) {
      dzRigSetKey(rigDrag.id, dzRigCur(), rigDrag.pose);
      dzSetStatus("◆ pose clavada en el cuadro " + dzRigCur() + " (Shift al arrastrar = rotar)");
    }
    if (moved) { dzBuildInspector(el); if (!rigDrag) dzMarkDirty(); }
    if (rec && moved) dzRecFinish(rec);
    else if (rec) { DZ.rec = { armed: true }; }        // no arrastró: sigue armada
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}
function dzClearMulti() {
  (DZ.multi || []).forEach(n => n.classList && n.classList.remove("dz-msel"));
  DZ.multi = [];
}

/* posición base de un elemento según su tipo (para mover con el mouse) */
function dzReadPos(el) {
  const t = el.tagName.toLowerCase();
  if (el.hasAttribute("cx") || el.hasAttribute("cy"))
    return { mode: "c", cx: +el.getAttribute("cx") || 0, cy: +el.getAttribute("cy") || 0 };
  if (el.hasAttribute("x") || el.hasAttribute("y"))
    return { mode: "xy", x: +el.getAttribute("x") || 0, y: +el.getAttribute("y") || 0 };
  // resto (path, polygon, line, g…): translate acumulado
  const m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(el.getAttribute("transform") || "");
  return { mode: "t", tx: m ? +m[1] : 0, ty: m ? +m[2] : 0,
           rest: (el.getAttribute("transform") || "").replace(/translate\([^)]*\)/, "").trim() };
}
function dzWritePos(el, base, dx, dy) {
  if (base.mode === "c") {
    el.setAttribute("cx", Math.round(base.cx + dx)); el.setAttribute("cy", Math.round(base.cy + dy));
  } else if (base.mode === "xy") {
    el.setAttribute("x", Math.round(base.x + dx)); el.setAttribute("y", Math.round(base.y + dy));
  } else {
    const tr = `translate(${Math.round(base.tx + dx)} ${Math.round(base.ty + dy)})`;
    el.setAttribute("transform", (base.rest ? base.rest + " " : "") + tr);
  }
}

/* tirador de resize — funciona con CUALQUIER elemento (paths y grupos incluidos):
   arrastrar = agrandar/achicar PROPORCIONAL · con Shift = DEFORMAR (estirar).
   Formas con atributos nativos se escalan por atributo; el resto (path, polygon,
   g…) se escala con transform alrededor de su propio centro. */
function dzHandleDown(e) {
  if (!DZ.sel) return;
  e.preventDefault(); e.stopPropagation();
  dzSnapshot();
  const el = DZ.sel, t = el.tagName.toLowerCase();
  const start = dzToUser(e.clientX, e.clientY);
  // bbox del elemento en unidades de usuario (para factores de escala y centro)
  const bb = el.getBoundingClientRect();
  const p1 = dzToUser(bb.left, bb.top), p2 = dzToUser(bb.right, bb.bottom);
  const w0 = Math.max(1, p2.x - p1.x), h0 = Math.max(1, p2.y - p1.y);
  // ancla del escalado en coordenadas LOCALES del elemento (getBBox ignora su
  // propio transform) — si usáramos las del lienzo, escalar algo ya movido lo correría
  let lb = null; try { lb = el.getBBox(); } catch (err) { /* sin bbox: raro */ }
  const cx0 = lb ? lb.x + lb.width / 2 : (p1.x + p2.x) / 2;
  const cy0 = lb ? lb.y + lb.height / 2 : (p1.y + p2.y) / 2;
  const b = {
    w: +el.getAttribute("width") || 0, h: +el.getAttribute("height") || 0,
    r: +el.getAttribute("r") || 0, rx: +el.getAttribute("rx") || 0, ry: +el.getAttribute("ry") || 0,
    fs: parseFloat(dzGet(el, "font-size", "fontSize")) || 20,
    x1: +el.getAttribute("x1") || 0, y1: +el.getAttribute("y1") || 0,
    x2: +el.getAttribute("x2") || 0, y2: +el.getAttribute("y2") || 0,
    tr: el.getAttribute("transform") || "",
  };
  const move = (ev) => {
    const p = dzToUser(ev.clientX, ev.clientY);
    const dx = p.x - start.x, dy = p.y - start.y;
    const deform = ev.shiftKey;
    // factores: proporcional usa el mismo k en ambos ejes
    let kx = Math.max(0.05, 1 + dx / w0), ky = Math.max(0.05, 1 + dy / h0);
    if (!deform) { const k = Math.max(0.05, 1 + (dx + dy) / (w0 + h0)); kx = ky = k; }
    if (t === "rect" || t === "image") {
      el.setAttribute("width", Math.max(1, Math.round(b.w * kx)));
      el.setAttribute("height", Math.max(1, Math.round(b.h * ky)));
    } else if (t === "circle") {
      el.setAttribute("r", Math.max(1, Math.round(b.r * kx)));
    } else if (t === "ellipse") {
      el.setAttribute("rx", Math.max(1, Math.round(b.rx * kx)));
      el.setAttribute("ry", Math.max(1, Math.round(b.ry * ky)));
    } else if (t === "text" || t === "tspan") {
      el.setAttribute("font-size", Math.max(4, Math.round(b.fs * (deform ? ky : kx))));
    } else if (t === "line") {
      // escalar la punta alrededor del origen de la línea
      el.setAttribute("x2", Math.round(b.x1 + (b.x2 - b.x1) * kx));
      el.setAttribute("y2", Math.round(b.y1 + (b.y2 - b.y1) * ky));
    } else {
      // path/polygon/g/etc: escala real via transform, anclada al centro
      const scale = ` translate(${(cx0 * (1 - kx)).toFixed(2)} ${(cy0 * (1 - ky)).toFixed(2)}) scale(${kx.toFixed(4)} ${ky.toFixed(4)})`;
      el.setAttribute("transform", (b.tr ? b.tr + " " : "") + scale.trim());
    }
    dzPositionHandle();
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    dzBuildInspector(el); dzMarkDirty();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

/* agregar una forma nueva al centro del lienzo y seleccionarla */
function dzAddShape(kind) {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  dzSnapshot();
  const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const W = vb[2] || 1080, H = vb[3] || 1080, cx = W / 2, cy = H / 2;
  const NS = "http://www.w3.org/2000/svg";
  const FILL = DZ.fillColor || "#F0450E";
  const R = Math.min(W, H) * 0.15;
  // polígono regular / estrella: puntos alrededor del centro (editables con ⬦)
  const ring = (n, r1, r2) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const r = (r2 && i % 2) ? r2 : r1;
      const a = -Math.PI / 2 + i * Math.PI * 2 / n;
      pts.push(Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a)));
    }
    return pts.join(" ");
  };
  let el;
  if (kind === "rect") {
    el = document.createElementNS(NS, "rect");
    el.setAttribute("x", cx - W * 0.15); el.setAttribute("y", cy - H * 0.1);
    el.setAttribute("width", W * 0.3); el.setAttribute("height", H * 0.2);
    el.setAttribute("fill", FILL);
  } else if (kind === "circle") {
    el = document.createElementNS(NS, "circle");
    el.setAttribute("cx", cx); el.setAttribute("cy", cy); el.setAttribute("r", R);
    el.setAttribute("fill", FILL);
  } else if (kind === "ellipse") {
    el = document.createElementNS(NS, "ellipse");
    el.setAttribute("cx", cx); el.setAttribute("cy", cy);
    el.setAttribute("rx", R * 1.5); el.setAttribute("ry", R * 0.9);
    el.setAttribute("fill", FILL);
  } else if (kind === "poly") {
    el = document.createElementNS(NS, "polygon");
    el.setAttribute("points", ring(6, R * 1.2));
    el.setAttribute("fill", FILL);
  } else if (kind === "star") {
    el = document.createElementNS(NS, "polygon");
    el.setAttribute("points", ring(10, R * 1.4, R * 0.55));
    el.setAttribute("fill", FILL);
  } else if (kind === "line") {
    el = document.createElementNS(NS, "line");
    el.setAttribute("x1", cx - W * 0.15); el.setAttribute("y1", cy);
    el.setAttribute("x2", cx + W * 0.15); el.setAttribute("y2", cy);
    el.setAttribute("stroke", DZ.drawColor || "#F0450E"); el.setAttribute("stroke-width", Math.max(2, DZ.drawW || Math.round(H * 0.008)));
  } else {
    el = document.createElementNS(NS, "text");
    el.setAttribute("x", cx); el.setAttribute("y", cy); el.setAttribute("text-anchor", "middle");
    el.setAttribute("font-family", "Figtree"); el.setAttribute("font-size", Math.round(H * 0.06));
    el.setAttribute("fill", FILL); el.textContent = "Texto";
  }
  svg.appendChild(el);
  dzSelect(el); dzMarkDirty();
}
function dzDeleteSelected() {
  if (!DZ.sel && !(DZ.multi || []).length) return;
  dzSnapshot();
  if ((DZ.multi || []).length > 1) { DZ.multi.forEach(n => n.remove()); DZ.multi = []; DZ.sel = null; }
  else if (DZ.sel) { DZ.sel.remove(); DZ.sel = null; }
  $("#dzHandle").hidden = true; $("#dzPin").hidden = true;
  const rot = $("#dzRotate"); if (rot) rot.hidden = true;
  $("#dzProps").hidden = true; $("#dzEmpty").hidden = false;
  dzMarkDirty(); dzBuildLayers();
}

/* ══ agrupar (Ctrl+G) / desagrupar (Ctrl+Shift+G): como Illustrator ══ */
function dzGroupSel(unwrap) {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  if (unwrap) {
    const g = DZ.sel;
    if (!g || g.tagName.toLowerCase() !== "g") return dzSetStatus("⧉ Seleccioná un grupo para desagrupar");
    dzSnapshot();
    const parent = g.parentNode;
    // si el grupo tiene transform, los hijos lo heredan individualmente
    const tr = g.getAttribute("transform");
    [...g.children].forEach(ch => {
      if (tr) ch.setAttribute("transform", tr + " " + (ch.getAttribute("transform") || ""));
      parent.insertBefore(ch, g);
    });
    g.remove(); DZ.sel = null;
    dzDeselect(); dzMarkDirty(); dzBuildLayers();
    dzSetStatus("⧉ Desagrupado");
    return;
  }
  const pack = (DZ.multi || []).length > 1 ? DZ.multi.slice() : (DZ.sel ? [DZ.sel] : []);
  if (pack.length < 2) return dzSetStatus("⧉ Shift+clic para seleccionar varios elementos y agruparlos");
  dzSnapshot();
  const g = document.createElementNS(SVGNS, "g");
  // el grupo nace donde está el elemento más al frente (mantiene el orden z)
  const inDom = [...svg.children].filter(n => pack.includes(n));
  svg.insertBefore(g, inDom[inDom.length - 1].nextSibling);
  inDom.forEach(n => { n.classList.remove("dz-msel"); g.appendChild(n); });
  DZ.multi = [];
  dzSelect(g); dzMarkDirty(); dzBuildLayers();
  dzSetStatus("⧉ Grupo de " + inDom.length + " elementos (Ctrl+Shift+G desagrupa)");
}

/* ══ importar imagen como referencia/calco (nivel de imagen de OpenToonz) ══ */
async function dzImportImage() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  const r = await api.import_ref_image();
  if (!r || r.cancel) return;
  if (r.error) return sysMsg("❌ " + r.error);
  dzSnapshot();
  const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const el = document.createElementNS(SVGNS, "image");
  el.setAttribute("href", r.data);
  el.setAttribute("x", vb[0] + vb[2] * 0.1); el.setAttribute("y", vb[1] + vb[3] * 0.1);
  el.setAttribute("width", Math.round(vb[2] * 0.8));
  el.setAttribute("preserveAspectRatio", "xMidYMid meet");
  el.setAttribute("opacity", "0.5");                 // media transparencia: para calcar
  svg.appendChild(el);
  dzSelect(el); dzMarkDirty(); dzBuildLayers();
  dzSetStatus("📷 " + (r.name || "imagen") + " importada al 50% de opacidad para calcar — subile la opacidad en el panel si la querés sólida");
}

/* ── rasterizado (Promise sobre window.rasterizeSVG que usa __raster) ── */
function dzRasterize(svgText, maxPx) {
  return new Promise((resolve, reject) => {
    try { window.rasterizeSVG(svgText, maxPx || 1024); } catch (e) { return reject(e); }
    let n = 0;
    const t = setInterval(() => {
      const r = window.__raster;
      if (r && r !== "PENDING") {
        clearInterval(t);
        if (typeof r === "string" && r.startsWith("data:image")) resolve(r);
        else reject(new Error(typeof r === "string" ? r.replace(/^ERR:/, "") : "raster falló"));
      } else if (++n > 100) { clearInterval(t); reject(new Error("timeout rasterizando")); }
    }, 80);
  });
}

/* ── modal simple para pedir un texto dentro del estudio de diseño ── */
function dzPromptModal(title, ph, def) {
  return new Promise(resolve => {
    openModal(`<h2>${title}</h2>
      <textarea id="dzPrIn" class="cmp-field" rows="3" spellcheck="false" placeholder="${(ph || "").replace(/"/g, "&quot;")}">${def || ""}</textarea>
      <div class="m-actions"><button class="ghost" id="dzPrX">Cancelar</button>
      <button class="primary" id="dzPrOk">Aceptar</button></div>`);
    setTimeout(() => { const i = $("#dzPrIn"); if (i) i.focus(); }, 30);
    $("#dzPrX").onclick = () => { closeModal(); resolve(null); };
    $("#dzPrOk").onclick = () => { const v = $("#dzPrIn").value.trim(); closeModal(); resolve(v); };
  });
}

/* ── generar FONDO con IA y mandarlo al fondo del eje z ── */
async function dzGenBg() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return dzSetStatus("Abrí o creá un diseño primero");
  const prompt = await dzPromptModal("Generar fondo con IA",
    "describí el fondo (ej: cielo al atardecer con nubes suaves, estilo acuarela)");
  if (!prompt) return;
  dzSetStatus("🖼 Generando fondo con IA…");
  const r = await api.gen_background(prompt, "1024x1024");
  if (!r || r.error) return dzSetStatus("❌ " + ((r && r.error) || "no se pudo generar el fondo"));
  dzSnapshot();
  const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const el = document.createElementNS(SVGNS, "image");
  el.setAttribute("href", r.data);
  el.setAttribute("x", vb[0]); el.setAttribute("y", vb[1]);
  el.setAttribute("width", vb[2]); el.setAttribute("height", vb[3]);
  el.setAttribute("preserveAspectRatio", "xMidYMid slice");
  el.setAttribute("data-bg", "1");
  svg.insertBefore(el, svg.firstChild);        // AL FONDO del eje z (detrás de todo)
  dzMarkDirty(); dzBuildLayers();
  dzSetStatus("🖼 Fondo generado y enviado al fondo del lienzo (eje z)" +
              (r.used ? " · " + r.used : ""));
}

/* ── vectorizar: raster (imagen importada/generada) → trazos SVG editables ── */
async function dzVectorize() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return dzSetStatus("Abrí o creá un diseño primero");
  // usar la imagen seleccionada, o la primera <image> del lienzo
  let img = (DZ.sel && DZ.sel.tagName && DZ.sel.tagName.toLowerCase() === "image")
    ? DZ.sel : svg.querySelector("image");
  if (!img) return dzSetStatus("Importá o generá una imagen primero (🖼) y después vectorizá (✒)");
  const href = img.getAttribute("href") ||
    img.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  if (!href) return dzSetStatus("La imagen no tiene datos para vectorizar");
  openModal(`<h2>Calcar a vectores</h2>
    <div class="sub">Convierte la imagen en trazos SVG editables siguiendo sus
    líneas y colores. «Líneas» calca solo el trazo (tinta) — ideal para bocetos,
    line-art y dibujos complejos; «Color» arma formas planas por color, como un
    póster serigrafiado.</div>
    <div class="krow"><label>Modo</label>
      <select id="vzMode" class="langsel">
        <option value="contorno" selected>Contorno (animación) — trazos largos y unificados, sin puntitos</option>
        <option value="lineas">Líneas — sigue el trazo del dibujo (tinta)</option>
        <option value="color">Color — formas planas por color</option>
      </select>
      <label class="soc-l2">Detalle</label>
      <select id="vzDetail" class="langsel">
        <option value="low">Bajo (simple)</option>
        <option value="medium">Medio</option>
        <option value="high" selected>Alto (complejo)</option>
      </select></div>
    <div class="krow"><label>Fondo</label>
      <label class="agchk"><input type="checkbox" id="vzBg" checked>
        quitar el fondo antes de calcar (detecta el color de las esquinas,
        como la varita mágica de Photoshop)</label></div>
    <div class="krow"><label>Tolerancia</label>
      <input type="range" id="vzTol" min="4" max="96" value="32" style="flex:1"
        title="Cuánto puede variar el color del fondo para ser eliminado">
      <span class="dz-hint" id="vzTolLbl">32</span></div>
    <div class="krow"><label>Referencia</label>
      <label class="agchk"><input type="checkbox" id="vzKeep">
        conservar la imagen original debajo (semitransparente, para seguir
        calcando encima)</label></div>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="vzGo">Calcar</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#vzTol").oninput = e => { $("#vzTolLbl").textContent = e.target.value; };
  $("#vzGo").onclick = async () => {
    const mode = $("#vzMode").value, detail = $("#vzDetail").value;
    const rmBg = $("#vzBg").checked, tol = +$("#vzTol").value;
    const keep = $("#vzKeep").checked;
    closeModal();
    dzSetStatus(mode === "lineas"
      ? "✒ Calcando las líneas del dibujo…"
      : "✒ Calcando la imagen a formas de color…");
    const r = await api.vectorize_image(href, detail, mode, rmBg, tol);
    if (!r || r.error) return dzSetStatus("❌ " + ((r && r.error) || "no se pudo vectorizar"));
    let traced;
    try { traced = new DOMParser().parseFromString(r.svg, "image/svg+xml").querySelector("svg"); }
    catch (e) { return dzSetStatus("❌ el vectorizador devolvió SVG inválido"); }
    if (!traced) return dzSetStatus("❌ el vectorizador no devolvió SVG");
    const tw = parseFloat(traced.getAttribute("width")) || 512;
    const th = parseFloat(traced.getAttribute("height")) || 512;
    const ix = parseFloat(img.getAttribute("x")) || 0, iy = parseFloat(img.getAttribute("y")) || 0;
    const iw = parseFloat(img.getAttribute("width")) || tw;
    const ih = parseFloat(img.getAttribute("height")) || (iw * th / tw);
    dzSnapshot();
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("transform", `translate(${ix} ${iy}) scale(${iw / tw} ${ih / th})`);
    [...traced.childNodes].forEach(n => {
      if (n.nodeType === 1 && n.tagName.toLowerCase() !== "title")
        g.appendChild(document.importNode(n, true));
    });
    img.parentNode.insertBefore(g, img.nextSibling);
    if (keep) img.setAttribute("opacity", "0.35");   // queda de referencia para calcar
    else img.remove();
    dzSelect(g); dzMarkDirty(); dzBuildLayers();
    const n = g.querySelectorAll("path").length;
    dzSetStatus(`✒ Calco listo: ${n} trazo${n === 1 ? "" : "s"} editable${n === 1 ? "" : "s"}` +
      (keep ? " — la imagen quedó debajo como referencia" : " (reemplazó la imagen)"));
  };
}

/* ── coloreado inteligente / entintado con IA (FLUX Kontext / SiliconFlow) ── */
async function dzColorize() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return dzSetStatus("Abrí o creá un diseño primero");
  const style = await dzPromptModal("Coloreado inteligente (IA)",
    "estilo/paleta (opcional): ej 'colores planos estilo anime, piel cálida, sombreado suave'", "");
  if (style === null) return;
  dzSetStatus("🎨 Rasterizando el lienzo…");
  let png;
  try { png = await dzRasterize(svg.outerHTML, 1280); }
  catch (e) { return dzSetStatus("❌ No pude rasterizar el lienzo: " + (e.message || e)); }
  dzSetStatus("🎨 Coloreando con IA… (puede tardar)");
  const r = await api.ai_colorize(png, style);
  if (!r || r.error) return dzSetStatus("❌ " + ((r && r.error) || "no se pudo colorear"));
  dzSnapshot();
  const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const el = document.createElementNS(SVGNS, "image");
  el.setAttribute("href", r.data);
  el.setAttribute("x", vb[0]); el.setAttribute("y", vb[1]);
  el.setAttribute("width", vb[2]); el.setAttribute("height", vb[3]);
  el.setAttribute("preserveAspectRatio", "xMidYMid meet");
  el.setAttribute("data-colorized", "1");
  svg.appendChild(el);                          // capa nueva arriba (comparás/ajustás)
  dzSelect(el); dzMarkDirty(); dzBuildLayers();
  dzSetStatus("🎨 Coloreado con " + (r.used || "IA") +
              " — quedó como capa nueva arriba (movéla, bajale opacidad o borrala)");
}

/* ── paletas profesionales + armonías de color ── */
const DZ_PAL_PRESETS = {
  "Piel (skin tones)": ["#3B2219", "#6E4B3A", "#9C6B4E", "#C68A63", "#E3B18C", "#F3D3B5", "#FBE8D3"],
  "Flat UI": ["#1ABC9C", "#2ECC71", "#3498DB", "#9B59B6", "#34495E", "#F1C40F", "#E67E22", "#E74C3C"],
  "Pastel": ["#FFB5B5", "#FFD8A8", "#FFF3B0", "#C8E7C8", "#B5D8EB", "#D3C0EB", "#F5D0E8"],
  "Material": ["#F44336", "#E91E63", "#9C27B0", "#3F51B5", "#2196F3", "#009688", "#4CAF50", "#FFC107", "#FF9800"],
  "Cine (teal/orange)": ["#0B1A2A", "#123A4B", "#1E6F76", "#2AA198", "#E8A15A", "#D9722B", "#8C3B18"],
  "Tierra (earth)": ["#2E2A20", "#5B4636", "#8A6E4B", "#B49266", "#7A8B5A", "#4E6151", "#C9B79C"],
  "Neón": ["#0D0221", "#FF2A6D", "#FF6AC1", "#05D9E8", "#39FF14", "#F9F871", "#B967FF"],
  "Escala de grises": ["#111111", "#333333", "#555555", "#777777", "#999999", "#BBBBBB", "#DDDDDD", "#FFFFFF"],
};
function dzHexToHsl(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || "");
  if (!m) return null;
  let r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function dzHslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  const H = v => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + H(r) + H(g) + H(b);
}
function dzHarmonies(hex) {
  const hsl = dzHexToHsl(hex); if (!hsl) return [];
  const [h, s, l] = hsl;
  return [
    hex,
    dzHslToHex(h + 180, s, l),                        // complementario
    dzHslToHex(h + 30, s, l), dzHslToHex(h - 30, s, l), // análogos
    dzHslToHex(h + 120, s, l), dzHslToHex(h + 240, s, l), // tríada
    dzHslToHex(h, s, Math.min(0.92, l + 0.18)),        // tinte
    dzHslToHex(h, s, Math.max(0.08, l - 0.18)),        // sombra
  ];
}
function dzSwatchRow(colors) {
  return '<div class="dz-prow">' + colors.map(c =>
    `<span class="dz-psw" data-c="${c}" style="background:${c}" title="${c}"></span>`).join("") + "</div>";
}
function dzPalettePro() {
  const cur = ($("#dzPFill") && $("#dzPFill").value) || "#E5322D";
  let html = `<h2>Paletas profesionales</h2>
    <div class="sub">Clic en un color = agregarlo a la paleta del proyecto (y aplicarlo al relleno).</div>
    <h3 style="margin:10px 0 4px;font-size:12px">Armonías de tu relleno (${cur})</h3>
    ${dzSwatchRow(dzHarmonies(cur))}`;
  for (const [name, cols] of Object.entries(DZ_PAL_PRESETS)) {
    html += `<h3 style="margin:10px 0 4px;font-size:12px">${name}</h3>${dzSwatchRow(cols)}`;
  }
  html += `<div class="m-actions"><button class="ghost" id="dzPalX">Cerrar</button></div>`;
  openModal(html);
  document.querySelectorAll("#modal .dz-psw").forEach(sw => {
    sw.onclick = () => {
      const c = sw.dataset.c;
      const pal = dzPaletteLoad();
      if (!pal.includes(c)) { pal.push(c); dzPaletteSave(pal); dzPaletteRender(); }
      DZ.fillColor = c; if ($("#dzPFill")) $("#dzPFill").value = c;
      dzStyleApply("fill", c);
    };
  });
  $("#dzPalX").onclick = closeModal;
}

/* ══ panel de estilo (relleno/trazo/grosor/opacidad) + paleta del proyecto ══ */
function dzStyleApply(attr, val) {
  const pack = (DZ.multi || []).length > 1 ? DZ.multi : (DZ.sel ? [DZ.sel] : []);
  if (!pack.length) return false;
  dzSnapshot();
  pack.forEach(n => n.setAttribute(attr, val));
  dzMarkDirty(); dzBuildLayers();
  return true;
}
function dzStyleSync(el) {
  // reflejar el estilo del elemento seleccionado en el panel
  const f = $("#dzPFill"), st = $("#dzPStroke"), w = $("#dzDrawW"), op = $("#dzOpacity");
  if (!f) return;
  const cs = getComputedStyle(el);
  const fill = dzHex(el.getAttribute("fill") || cs.fill);
  const stroke = dzHex(el.getAttribute("stroke") || cs.stroke);
  if (fill) f.value = fill;
  if (stroke) st.value = stroke;
  const sw = parseFloat(el.getAttribute("stroke-width") || cs.strokeWidth);
  if (sw) w.value = Math.round(sw);
  const o = el.getAttribute("opacity");
  op.value = o === null ? 100 : Math.round(parseFloat(o) * 100);
  $("#dzOpacityLbl").textContent = op.value + "%";
}
function dzPaletteKey() { return "low.palette." + (S.ws || "global"); }
function dzPaletteLoad() {
  try { return JSON.parse(localStorage.getItem(dzPaletteKey()) || "[]"); }
  catch (e) { return []; }
}
function dzPaletteSave(p) {
  try { localStorage.setItem(dzPaletteKey(), JSON.stringify(p.slice(0, 24))); } catch (e) { /* */ }
}
function dzPaletteRender() {
  const box = $("#dzPalette");
  if (!box) return;
  const pal = dzPaletteLoad();
  box.innerHTML = "";
  pal.forEach((c, i) => {
    const s = document.createElement("span");
    s.className = "dz-sw"; s.style.background = c; s.title = c;
    s.onclick = (e) => {
      if (e.shiftKey) { DZ.drawColor = c; $("#dzPStroke").value = c; dzStyleApply("stroke", c); }
      else { DZ.fillColor = c; $("#dzPFill").value = c; dzStyleApply("fill", c); }
    };
    s.oncontextmenu = (e) => { e.preventDefault(); pal.splice(i, 1); dzPaletteSave(pal); dzPaletteRender(); };
    box.appendChild(s);
  });
  const add = document.createElement("span");
  add.className = "dz-sw dz-sw-add"; add.textContent = "+";
  add.title = "Guardar el relleno actual en la paleta del proyecto";
  add.onclick = () => {
    const c = $("#dzPFill").value;
    if (!pal.includes(c)) { pal.push(c); dzPaletteSave(pal); dzPaletteRender(); }
  };
  box.appendChild(add);
  // acceso a paletas profesionales + armonías de color
  const pro = document.createElement("span");
  pro.className = "dz-sw dz-sw-pro"; pro.textContent = "★";
  pro.title = "Paletas profesionales y armonías de color";
  pro.onclick = dzPalettePro;
  box.appendChild(pro);
}
function dzMarkDirty() { DZ.dirty = true; }

/* duplicar el elemento seleccionado (con un pequeño corrimiento para verlo) */
function dzDuplicate() {
  if (!DZ.sel) return;
  dzSnapshot();
  const c = DZ.sel.cloneNode(true);
  c.classList.remove("dz-sel");
  if (!c.getAttribute("class")) c.removeAttribute("class");
  DZ.sel.parentNode.insertBefore(c, DZ.sel.nextSibling);
  dzWritePos(c, dzReadPos(c), 20, 20);
  dzSelect(c); dzMarkDirty();
}

/* ══ herramientas de dibujo: lápiz ✏, pincel 🖌 (presión de tableta), pluma ✒ ══
   Usan Pointer Events: una tableta Huion (Windows Ink) manda pointerType "pen"
   con e.pressure real → el pincel modula el grosor con la presión. */
const SVGNS = "http://www.w3.org/2000/svg";
let DRAW = null;   // trazo a mano alzada en curso
let PEN = null;    // pluma vectorial en curso
let RULER = null;  // regla/hilo: {a:{x,y}, el:SVGLineElement|null, vp:[{x,y}]} puntos de fuga

// select/direct → "" para que gane el CSS (flecha negra / flecha blanca);
// nodes usa la flecha blanca también (edita puntos de vector)
const DZ_CURSORS = { select: "", direct: "", nodes: "", eraser: "cell",
                     dropper: "copy", bucket: "pointer", hand: "grab",
                     pivot: "crosshair", ruler: "crosshair",
                     inflator: "cell", handler: "ew-resize", iron: "default",
                     pliers: "crosshair", magnet: "cell" };
/* ══ 🩺 Diagnóstico de tableta: registra el flujo REAL de pointer events
   (tipo · pointerId · pointerType · botones · presión · Δpx · Δms) en un panel
   en vivo, para ver qué emite la Huion de verdad en vez de suponerlo. ══ */
function dzPenDebugToggle() {
  DZ.penDebug = !DZ.penDebug;
  let panel = $("#dzPenDbg");
  if (!DZ.penDebug) {
    if (DZ._penDbgFn) {
      document.removeEventListener("pointerdown", DZ._penDbgFn, true);
      document.removeEventListener("pointermove", DZ._penDbgFn, true);
      document.removeEventListener("pointerup", DZ._penDbgFn, true);
      document.removeEventListener("pointercancel", DZ._penDbgFn, true);
      DZ._penDbgFn = null;
    }
    if (DZ._penDbgRawFn) {
      $("#dzCanvas").removeEventListener("pointerrawupdate", DZ._penDbgRawFn);
      DZ._penDbgRawFn = null;
    }
    if (panel) panel.remove();
    dzSetStatus("🩺 Diagnóstico de tableta OFF");
    return;
  }
  panel = document.createElement("div");
  panel.id = "dzPenDbg"; panel.className = "dz-pendbg";
  panel.innerHTML = '<div class="dz-pendbg-h">🩺 tableta — hacé UNA línea y sacá captura <span style="cursor:pointer;float:right;opacity:.7" title="Abrir diagnóstico completo en navegador" onclick="try{api.open_tablet_diag()}catch(e){}">🔗 externo</span></div><div id="dzPenDbgLog"></div>';
  $("#dzCanvas").appendChild(panel);
  const log = $("#dzPenDbgLog");
  let lastT = 0, lastX = 0, lastY = 0, cnt = { down: 0, move: 0, up: 0, cancel: 0, raw: 0 }, buf = [];
  const addRow = (text, color) => {
    const row = document.createElement("div"); row.textContent = text;
    if (color) row.style.color = color;
    log.appendChild(row);
    while (log.childElementCount > 50) log.firstChild.remove();
    $(".dz-pendbg-h").textContent = `🩺 down:${cnt.down} move:${cnt.move} raw:${cnt.raw} up:${cnt.up} cancel:${cnt.cancel||0}`;
  };
  DZ._penDbgFn = (e) => {
    const cv = $("#dzCanvas");
    const onCanvas = cv.contains(e.target) || e.target === cv;
    const t = performance.now();
    const dt = lastT ? Math.round(t - lastT) : 0; lastT = t;
    const dx = Math.round(e.clientX - lastX), dy = Math.round(e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
    const k = e.type.replace("pointer", "");
    cnt[k] = (cnt[k] || 0) + 1;
    const co = (e.getCoalescedEvents && e.getCoalescedEvents().length) || 0;
    const pr = (e.pressure != null) ? e.pressure.toFixed(3) : "-";
    const onCv = onCanvas ? "🎨" : "🌐";
    const line = `${onCv} ${k.padEnd(5)} id${e.pointerId} ${e.pointerType[0]} btn:${e.button} btns:${e.buttons} pr:${pr} tw:${(e.tiltX||0).toFixed(1)} Δ${dx},${dy} ${dt}ms${co?(" c"+co):""}`;
    let color = null;
    if (k === "down") color = "#33B5E8";
    if (k === "up" || k === "cancel") { color = "#F0450E"; try { api.save_tablet_log && api.save_tablet_log(buf.join('\n')); } catch(e){} }
    if (!onCanvas) color = "#666";
    addRow(line, color);
    buf.push(line);
    if (buf.length % 50 === 0) { try { api.save_tablet_log && api.save_tablet_log(buf.join('\n')); } catch(e){} }
    try { api.log_js && api.log_js("[pen] " + line); } catch (err) { /* */ }
  };
  DZ._penDbgRawFn = (e) => {
    cnt.raw = (cnt.raw || 0) + 1;
    const pr = (e.pressure != null) ? e.pressure.toFixed(3) : "-";
    const line = `⚡ raw     id${e.pointerId} ${e.pointerType[0]} btns:${e.buttons} pr:${pr} tw:${(e.tiltX||0).toFixed(1)}`;
    buf.push(line);
    if (buf.length % 50 === 0) { try { api.save_tablet_log && api.save_tablet_log(buf.join('\n')); } catch(e){} }
    addRow(line, "#FFA000");
  };
  document.addEventListener("pointerdown", DZ._penDbgFn, true);
  document.addEventListener("pointermove", DZ._penDbgFn, true);
  document.addEventListener("pointerup", DZ._penDbgFn, true);
  document.addEventListener("pointercancel", DZ._penDbgFn, true);
  $("#dzCanvas").addEventListener("pointerrawupdate", DZ._penDbgRawFn);
  dzSetStatus("🩺 Diagnóstico ON — elegí Pincel, hacé UNA línea y mandame la captura del panel");
}

function dzSetTool(t) {
  if (DRAW_TRACK) _drawFinish();
  if (RULER && t !== "ruler") dzRulerClear();
  DZ.tool = t;
  document.querySelectorAll(".dz-toolbtn").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === t));
  const cv = $("#dzCanvas");
  cv.style.cursor = (t in DZ_CURSORS) ? DZ_CURSORS[t] : "crosshair";
  cv.dataset.tool = t;          // el CSS decide el cursor de los hijos del svg
  if (PEN && t !== "pen") dzPenFinish(true);
  if (t !== "nodes") dzNodesClear();
  // el gotero/balde/nodos trabajan SOBRE la selección o eligiendo elemento: no deseleccionar
  if (!["select", "direct", "nodes", "dropper", "bucket", "iron", "magnet"].includes(t)) dzDeselect();
  dzSbTool(); dzToolOptsRender();
}
/* los clics del lienzo hacen preventDefault (para dibujar/arrastrar), y eso
   BLOQUEA el cambio de foco: si venías de escribir en el chat del dock, el
   foco quedaba preso en el textarea y los atajos "no andaban" (tipeabas al
   chat). Soltarlo explícitamente al tocar el lienzo. */
function dzReleaseFocus() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(a.tagName)) a.blur();
}

/* ── presión suavizada: buffer circular de las últimas N muestras.
   OpenToonz usa un track continuo con presión por punto (TThickPoint);
   en la web la presión puede fluctuar frame a frame → media móvil.
   Aplica curva gamma de sensibilidad (OpenToonz V_BrushPressureSensitivity). ── */
function dzSmoothPressure(pr, track) {
  if (!track) return pr || 0.5;
  if (!track._pbuf) track._pbuf = [];
  const BUF = 5;
  const clamped = Math.max(0.03, pr || 0.03);
  track._pbuf.push(clamped);
  if (track._pbuf.length > BUF) track._pbuf.shift();
  let s = 0; for (let i = 0; i < track._pbuf.length; i++) s += track._pbuf[i];
  const avg = s / track._pbuf.length;
  const gamma = DZ.pressureGamma !== undefined ? DZ.pressureGamma : 0.85;
  return Math.pow(avg, gamma);
}

/* ═══════════════════════════════════════════════════════════════════════
   SISTEMA DE DIBUJO — v5 (v3.17.7)
   ═══════════════════════════════════════════════════════════════════════
   Un solo track activo. Sin máquinas de estado, sin stitching con timeout.
   Principio: acumular todos los puntos y renderizar. El post-procesado
   (Ramer-Douglas-Peucker + Catmull-Rom) limpia el ruido después.
   
   pointerdown con pointerType==="pen" → SIEMPRE inicia trazo.
   El navegador solo dispara pointerdown con contacto real (spec).
   La presión solo afecta el GROSOR del trazo, no si se dibuja o no.
   ═══════════════════════════════════════════════════════════════════════ */

function _dzDiag(msg, color) {
  const log = $("#dzPenDbgLog");
  if (log) {
    const row = document.createElement("div"); row.textContent = msg;
    if (color) row.style.color = color;
    log.appendChild(row);
    while (log.childElementCount > 60) log.firstChild.remove();
  }
  console.log("[LOW:draw]", msg);
}

let DRAW_TRACK = null;   // UN solo track: { pts, mode, el, pid, devType, _pbuf }

function _otDevType(e) {
  if (e.pointerType === "pen") return "pen";
  if (e.pointerType === "eraser") return "eraser";
  return "mouse";
}

function _otPressure(e) {
  if ((e.pointerType === "pen" || e.pointerType === "eraser") && e.pressure != null) return e.pressure;
  return 0.5;
}

function _drawAddPoint(track, x, y, pr) {
  const last = track.pts[track.pts.length - 1];
  const dx = x - last[0], dy = y - last[1];
  const d2 = dx * dx + dy * dy;
  // Solo descartar puntos idénticos (mismo pixel). Todo lo demás se dibuja.
  if (d2 < 0.01) return false;
  const smPr = dzSmoothPressure(pr, track);
  track.pts.push([x, y, smPr]);
  if (track.mode !== "pencil") {
    const seg = document.createElementNS(SVGNS, "path");
    seg.setAttribute("d", `M ${last[0].toFixed(1)} ${last[1].toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`);
    seg.setAttribute("stroke-width", Math.max(0.3, (DZ.drawW || 6) * 2 * smPr).toFixed(1));
    track.el.appendChild(seg);
  }
  if (track.mode === "pencil") track.el.setAttribute("d", dzSmoothPath(track.pts));
  return true;
}

function _drawBeginTrack(e, svg) {
  const p = dzToUser(e.clientX, e.clientY);
  const pr = _otPressure(e);
  const dev = _otDevType(e);
  const track = {
    pts: [[p.x, p.y, pr]], mode: DZ.tool, el: null,
    pid: e.pointerId, devType: dev,
    _pbuf: [pr, pr, pr, pr, pr]
  };
  if (DZ.tool === "pencil") {
    track.el = document.createElementNS(SVGNS, "path");
    track.el.setAttribute("fill", "none");
    track.el.setAttribute("stroke", DZ.drawColor || "#F0450E");
    track.el.setAttribute("stroke-width", DZ.drawW || 6);
    track.el.setAttribute("stroke-linecap", "round");
    track.el.setAttribute("stroke-linejoin", "round");
  } else {
    track.el = document.createElementNS(SVGNS, "g");
    track.el.setAttribute("data-low", "brush");
    track.el.setAttribute("stroke", DZ.drawColor || "#F0450E");
    track.el.setAttribute("fill", "none");
    track.el.setAttribute("stroke-linecap", "round");
  }
  svg.appendChild(track.el);
  return track;
}

function _drawFinish() {
  if (!DRAW_TRACK) return;
  const t = DRAW_TRACK; DRAW_TRACK = null;
  if (t.pts.length < 2) { if (t.el) t.el.remove(); return; }
  const pts = dzRefineStroke(t.pts);
  let finalEl = t.el;
  if (t.mode === "pencil") {
    t.el.setAttribute("d", dzSmoothPath(pts));
  } else {
    const ribbon = dzBrushRibbon(pts, DZ.drawW || 6, DZ.drawColor || "#F0450E");
    if (ribbon) { t.el.replaceWith(ribbon); finalEl = ribbon; }
    else { t.el.remove(); finalEl = null; }
  }
  if (finalEl) dzMirrorClone(finalEl);
  dzMarkDirty(); dzBuildLayers();
}

function dzDrawRaw(e) {
  if (!DRAW_TRACK || e.pointerId !== DRAW_TRACK.pid) return;
  // Si hay track activo, SIEMPRE procesar (la presión puede ser 0 en el primer frame)
  const pr = (e.pressure != null) ? e.pressure : _otPressure(e);
  e.preventDefault();
  const p = dzToUser(e.clientX, e.clientY);
  _drawAddPoint(DRAW_TRACK, p.x, p.y, pr);
}

function dzDrawDown(e) {
  dzReleaseFocus();
  const tool = DZ.tool || "select";
  if (DZ.spaceDown || e.button === 1 || tool === "hand") return;
  if (e.target.closest && e.target.closest("#dzCam")) return;
  if (tool === "select" || tool === "direct") return;
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;

  // ═══ pointerdown SIEMPRE inicia trazo si es pen ═══
  _dzDiag("▼ down " + e.pointerType + " pr:" + (e.pressure != null ? e.pressure.toFixed(4) : "null") +
    " btn:" + e.button + " btns:" + e.buttons + " tool:" + tool, "#33B5E8");

  e.preventDefault(); e.stopPropagation();
  if (tool === "pivot") { dzPivotClick(e); return; }
  if (tool === "nodes") { dzNodesClick(e); return; }
  if (tool === "dropper") { dzDropperPick(e); return; }
  if (tool === "bucket") { dzBucketApply(e); return; }
  if (tool === "eraser") { dzEraseStart(e); return; }
  if (tool === "ruler") { dzRulerDown(e); return; }
  if (tool === "inflator") { dzInflatorDown(e); return; }
  if (tool === "handler") { dzHandlerDown(e); return; }
  if (tool === "iron") { dzIronDown(e); return; }
  if (tool === "pliers") { dzPliersDown(e); return; }
  if (tool === "magnet") { dzMagnetDown(e); return; }
  const p = dzToUser(e.clientX, e.clientY);
  if (DZ.tool === "pen") { dzPenDown(p); return; }

  // Finalizar cualquier track previo colgado
  if (DRAW_TRACK) _drawFinish();

  dzSnapshot();
  DRAW_TRACK = _drawBeginTrack(e, svg);
}

function dzDrawMove(e) {
  if (PEN && PEN.dragging) { dzPenDrag(dzToUser(e.clientX, e.clientY)); return; }
  if (PEN && !DRAW_TRACK) { dzPenHover(dzToUser(e.clientX, e.clientY)); return; }
  if (DZ.tool === "ruler" && RULER && RULER.a) { dzRulerMove(e); return; }
  if (DZ.tool === "inflator" && INFLATOR && INFLATOR.el) { dzInflatorMove(e); return; }
  if (DZ.tool === "magnet" && MAGNET && MAGNET.active) { dzMagnetMove(e); return; }
  if (DZ.tool === "handler" && HANDLER && HANDLER.el) { dzHandlerGlobalMove(e); return; }
  if (!DRAW_TRACK) return;
  if (e.pointerId !== DRAW_TRACK.pid) return;

  // ═══ Si hay DRAW_TRACK activo y mismo pointerId, SIEMPRE dibujar ═══
  // (la presión solo afecta el grosor, no si se dibuja)
  e.preventDefault();

  // Procesar eventos coalescidos (alta precisión)
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length)
    ? e.getCoalescedEvents() : [e];
  for (const ev of evs) {
    const p = dzToUser(ev.clientX, ev.clientY);
    const pr = _otPressure(ev);
    _drawAddPoint(DRAW_TRACK, p.x, p.y, pr);
  }
}

function dzDrawUp(e) {
  if (PEN && PEN.dragging) { dzPenUp(); return; }
  if (INFLATOR && INFLATOR.el) { dzInflatorUp(e); return; }
  if (MAGNET && MAGNET.active) { dzMagnetUp(e); return; }
  if (HANDLER && HANDLER.el) { dzHandlerUp(e); return; }
  if (!DRAW_TRACK) return;
  if (e && e.pointerId != null && e.pointerId !== DRAW_TRACK.pid
      && e.type !== "pointercancel" && e.type !== "lostpointercapture") return;
  _dzDiag("▲ up   id" + (e ? e.pointerId : "?") + " pts:" + (DRAW_TRACK ? DRAW_TRACK.pts.length : 0), "#F0450E");
  _drawFinish();
}
/* ══ post-procesado del trazo (como OpenToonz al soltar el lápiz):
   1) media móvil → mata el temblor del pulso;
   2) Ramer-Douglas-Peucker → deja SOLO los puntos que definen la forma;
   3) Catmull-Rom → curva bezier limpia por esos puntos.
   La intensidad la controla el deslizador «Suavizado» (0-100). ══ */
function dzMovingAvg(pts, win) {
  if (win < 1 || pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    let sx = 0, sy = 0, sp = 0, n = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(pts.length - 1, i + win); j++) {
      sx += pts[j][0]; sy += pts[j][1]; sp += pts[j][2] || 0.5; n++;
    }
    out.push([sx / n, sy / n, sp / n]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function dzRDP(pts, eps) {
  if (pts.length < 3) return pts;
  const d2line = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    if (!L2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let imax = -1, dmax = 0;
    for (let i = a + 1; i < b; i++) {
      const d = d2line(pts[i], pts[a], pts[b]);
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > eps && imax > 0) { keep[imax] = true; stack.push([a, imax], [imax, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function dzRefineStroke(pts) {
  const amt = DZ.smooth === undefined ? 40 : DZ.smooth;   // 0-100
  if (amt <= 0 || pts.length < 4) return pts;
  const win = Math.round(1 + amt / 30);                    // 1..4
  const eps = (amt / 100) * 3.5 / (DZ.zoom || 1);          // en unidades de usuario
  return dzRDP(dzMovingAvg(pts, win), eps);
}
/* cinta de ancho variable para el pincel: UN solo path relleno cuyo contorno
   sigue la presión (como los outline strokes vectoriales de OpenToonz).
   Puntas redondeadas + taper progresivo en los extremos. */
function dzBrushRibbon(pts, baseW, color) {
  if (pts.length < 2) return null;
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
    let tx = p1[0] - p0[0], ty = p1[1] - p0[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    // taper: entra suave (5 pts) y sale suave, como OpenToonz capStyle
    const tIn = Math.min(1, i / 5);
    const tOut = Math.min(1, (pts.length - 1 - i) / 5);
    const tip = tIn * tOut;
    const w = Math.max(0.2, baseW * (pts[i][2] || 0.5) * tip);
    L.push([pts[i][0] - ty * w, pts[i][1] + tx * w]);
    R.push([pts[i][0] + ty * w, pts[i][1] - tx * w]);
  }
  R.reverse();
  const side = (arr) => dzSmoothPath(arr).replace(/^M [\d.-]+ [\d.-]+ /, "");
  const d = dzSmoothPath(L) +
    ` L ${R[0][0].toFixed(1)} ${R[0][1].toFixed(1)} ` + side(R) + " Z";
  const el = document.createElementNS(SVGNS, "path");
  el.setAttribute("d", d);
  el.setAttribute("fill", color);
  el.setAttribute("stroke", "none");
  el.setAttribute("data-low", "brush");
  return el;
}

/* suavizado Catmull-Rom convertido a bezier cúbicas: la curva pasa POR todos
   los puntos con continuidad C1 — trazos fieles y orgánicos */
function dzSmoothPath(pts) {
  const n = pts.length;
  if (n < 3)
    return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} L ${pts[n - 1][0].toFixed(1)} ${pts[n - 1][1].toFixed(1)}`;
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/* ══ pluma vectorial profesional (flecha blanca de Illustrator / pluma de
   OpenToonz): clic = esquina · clic y ARRASTRAR = curva con manijas visibles ·
   banda elástica de preview al mover el mouse · clic en el PRIMER punto
   cierra el trazado · Backspace borra el último punto · Enter termina ·
   Esc cancela. Las anclas y manijas se dibujan en una capa guía que jamás
   se guarda en el archivo. ══ */
function dzPenScale() {
  // tamaño de las guías en unidades de usuario, compensando el zoom
  const svg = $("#dzCanvas").querySelector("svg");
  try { return 1 / (svg.getScreenCTM().a || 1); } catch (e) { return 1; }
}
function dzPenDown(p) {
  const svg = $("#dzCanvas").querySelector("svg");
  if (PEN && PEN.anchors.length >= 2) {
    // clic sobre el PRIMER punto → cerrar el trazado (como Illustrator)
    const a0 = PEN.anchors[0], k = dzPenScale();
    if (Math.hypot(p.x - a0.x, p.y - a0.y) < 10 * k) {
      PEN.closed = true;
      dzPenFinish(false);
      return;
    }
  }
  if (!PEN) {
    dzSnapshot();                                      // Ctrl+Z deshace la pluma entera
    PEN = { anchors: [], el: document.createElementNS(SVGNS, "path"),
            guide: document.createElementNS(SVGNS, "g"), dragging: false, closed: false };
    PEN.el.setAttribute("fill", "none");
    PEN.el.setAttribute("stroke", DZ.drawColor || "#F0450E");
    PEN.el.setAttribute("stroke-width", DZ.drawW || 6);
    PEN.el.setAttribute("stroke-linecap", "round");
    PEN.el.setAttribute("stroke-linejoin", "round");
    PEN.guide.setAttribute("class", "dz-penui");       // capa guía: solo pantalla
    PEN.guide.setAttribute("pointer-events", "none");
    svg.appendChild(PEN.el);
    svg.appendChild(PEN.guide);
    dzSetStatus("✒ Pluma: clic = esquina · arrastrar = curva · clic en el 1er punto cierra · Backspace borra el último · Enter termina · Esc cancela");
  }
  PEN.anchors.push({ x: p.x, y: p.y, hx: p.x, hy: p.y });
  PEN.dragging = true;
  dzPenRender();
}
function dzPenDrag(p) {
  const a = PEN.anchors[PEN.anchors.length - 1];
  a.hx = p.x; a.hy = p.y;                              // la manija sigue el arrastre
  dzPenRender();
}
function dzPenUp() { if (PEN) { PEN.dragging = false; dzPenRender(); } }
function dzPenHover(p) {
  // banda elástica: preview del próximo segmento siguiendo el mouse
  if (!PEN || !PEN.anchors.length) return;
  PEN.hover = p;
  dzPenRender();
}
function dzPenBackspace() {
  if (!PEN) return;
  PEN.anchors.pop();
  if (!PEN.anchors.length) { dzPenFinish(true); return; }
  dzPenRender();
}
function dzPenPathD(A, closed) {
  let d = `M ${A[0].x.toFixed(1)} ${A[0].y.toFixed(1)}`;
  for (let i = 1; i < A.length; i++) {
    const prev = A[i - 1], cur = A[i];
    // manija de salida del anterior = su drag; de entrada de este = espejo del suyo
    const inx = 2 * cur.x - cur.hx, iny = 2 * cur.y - cur.hy;
    d += ` C ${prev.hx.toFixed(1)} ${prev.hy.toFixed(1)} ${inx.toFixed(1)} ${iny.toFixed(1)} ${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`;
  }
  if (closed && A.length >= 2) {
    const last = A[A.length - 1], a0 = A[0];
    const inx = 2 * a0.x - a0.hx, iny = 2 * a0.y - a0.hy;
    d += ` C ${last.hx.toFixed(1)} ${last.hy.toFixed(1)} ${inx.toFixed(1)} ${iny.toFixed(1)} ${a0.x.toFixed(1)} ${a0.y.toFixed(1)} Z`;
  }
  return d;
}
function dzPenRender() {
  if (!PEN || !PEN.anchors.length) return;
  const A = PEN.anchors;
  PEN.el.setAttribute("d", dzPenPathD(A, false));
  // ── capa guía: anclas ▪, manijas ─●, banda elástica ┈ ──
  const k = dzPenScale();
  const g = PEN.guide;
  g.innerHTML = "";
  const mk = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [key, v] of Object.entries(attrs)) n.setAttribute(key, v);
    g.appendChild(n); return n;
  };
  // banda elástica hacia el mouse (cuando no estás arrastrando una manija):
  // sale con la tangente de la última manija y aterriza recto en el cursor
  if (PEN.hover && !PEN.dragging) {
    const last = A[A.length - 1], h = PEN.hover;
    mk("path", { d: `M ${last.x} ${last.y} C ${last.hx} ${last.hy} ${h.x} ${h.y} ${h.x} ${h.y}`,
                 fill: "none", stroke: "#33B5E8", "stroke-width": 1.2 * k,
                 "stroke-dasharray": `${4 * k} ${4 * k}`, opacity: 0.8 });
  }
  A.forEach((a, i) => {
    const hasHandle = Math.hypot(a.hx - a.x, a.hy - a.y) > 0.5;
    if (hasHandle) {
      const inx = 2 * a.x - a.hx, iny = 2 * a.y - a.hy;
      mk("line", { x1: inx, y1: iny, x2: a.hx, y2: a.hy,
                   stroke: "#33B5E8", "stroke-width": 1 * k, opacity: 0.85 });
      mk("circle", { cx: a.hx, cy: a.hy, r: 3 * k, fill: "#33B5E8" });
      mk("circle", { cx: inx, cy: iny, r: 3 * k, fill: "#33B5E8", opacity: 0.7 });
    }
    // el primer punto se agranda cuando el mouse está cerca (se puede cerrar)
    const near0 = i === 0 && PEN.hover && A.length >= 2 &&
      Math.hypot(PEN.hover.x - a.x, PEN.hover.y - a.y) < 10 * k;
    const s = (near0 ? 8 : 5) * k;
    mk("rect", { x: a.x - s / 2, y: a.y - s / 2, width: s, height: s,
                 fill: near0 ? "#33B5E8" : "#fff", stroke: "#33B5E8",
                 "stroke-width": 1.4 * k });
  });
}
function dzPenFinish(cancel) {
  if (!PEN) return;
  PEN.guide.remove();
  if (cancel || PEN.anchors.length < 2) {
    PEN.el.remove();
    if (!cancel && DZ.undo && DZ.undo.length) DZ.undo.pop();   // no dibujó nada
  } else {
    PEN.el.setAttribute("d", dzPenPathD(PEN.anchors, PEN.closed));
    if (PEN.closed && DZ.fillColor) PEN.el.setAttribute("fill", DZ.fillColor);
    dzMirrorClone(PEN.el);                             // 🪞 modo espejo
    dzMarkDirty(); dzBuildLayers();
    dzSetStatus(PEN.closed ? "✒ Trazado cerrado (relleno con el color actual) — editalo con nodos (A)" :
                             "✒ Trazado listo — editalo con nodos (A)");
    PEN = null;
    return;
  }
  PEN = null;
  dzSetStatus("");
}

/* ══ atajos de teclado configurables (Preferencias ⚙ del estudio) ══ */
const DZ_KEY_DEFAULTS = {
  select: "v", direct: "d", hand: "h", nodes: "a", pencil: "n", brush: "b", pen: "p",
  eraser: "e", dropper: "i", bucket: "g", camera: "c", pivot: "j",
  rect: "r", ellipse: "o", text: "t", line: "l",
  zoomin: "+", zoomout: "-", zoom100: "0", zoomfit: "f",
  rotl: "[", rotr: "]", mirror: "m",
  prevframe: ",", nextframe: ".",
};
const DZ_KEY_LABELS = {
  select: "Seleccionar (flecha)", hand: "Mano (navegar)", nodes: "Nodos (flecha blanca)",
  pencil: "Lápiz", brush: "Pincel", pen: "Pluma vectorial", eraser: "Borrador",
  dropper: "Cuentagotas", bucket: "Balde de pintura", camera: "Cámara",
  pivot: "Pivote de rig", rect: "Rectángulo", ellipse: "Elipse",
  text: "Texto", line: "Línea", zoomin: "Acercar", zoomout: "Alejar",
  zoom100: "Zoom 100%", zoomfit: "Ajustar a pantalla", rotl: "Girar vista ⟲",
  rotr: "Girar vista ⟳", mirror: "Modo espejo", prevframe: "Cuadro anterior",
  nextframe: "Cuadro siguiente",
};
function dzKeysLoad() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("low.dzkeys") || "{}"); } catch (e) { /* */ }
  DZ.keymap = { ...DZ_KEY_DEFAULTS, ...saved };
  DZ.keyrev = {};
  for (const [act, k] of Object.entries(DZ.keymap)) if (k) DZ.keyrev[k] = act;
}
function dzKeysSave() {
  try { localStorage.setItem("low.dzkeys", JSON.stringify(DZ.keymap)); } catch (e) { /* */ }
  dzKeysLoad();
}
function dzRunAction(act) {
  const TOOLS = ["select", "direct", "hand", "nodes", "pencil", "brush", "pen", "eraser",
                 "dropper", "bucket", "pivot", "ruler", "inflator", "handler", "iron", "pliers", "magnet"];
  if (TOOLS.includes(act)) return dzSetTool(act);
  if (act === "camera") return dzCamToggle();
  if (["rect", "ellipse", "text", "line"].includes(act)) return dzAddShape(act);
  if (act === "zoomin") return dzZoom(0.15);
  if (act === "zoomout") return dzZoom(-0.15);
  if (act === "zoom100") { DZ.zoom = 1; DZ.panX = DZ.panY = 0; DZ.viewRot = 0; return dzApplyZoom(); }
  if (act === "zoomfit") return dzFitView();
  if (act === "rotl") return dzRotView(-15);
  if (act === "rotr") return dzRotView(15);
  if (act === "mirror") return dzMirrorToggle();
  if (act === "prevframe" && DZ.anim) { dzAnimStopIf(); return dzGoFrame(Math.max(0, DZ.anim.idx - 1)); }
  if (act === "nextframe" && DZ.anim) { dzAnimStopIf(); return dzGoFrame(Math.min(DZ.anim.frames.length - 1, DZ.anim.idx + 1)); }
}
/* ⚙ Preferencias del estudio: reasignar atajos (clic en el campo y apretá la
   tecla nueva) + suavizado por defecto */
function dzPrefsModal() {
  dzKeysLoad();
  const rows = Object.keys(DZ_KEY_DEFAULTS).map(act =>
    `<div class="krow"><label>${DZ_KEY_LABELS[act] || act}</label>` +
    `<input class="dz-keycap" data-act="${act}" value="${(DZ.keymap[act] || "").toUpperCase()}" readonly ` +
    `placeholder="(sin atajo)" title="Clic y apretá la tecla nueva · Supr la borra"></div>`).join("");
  openModal(`<h2>⚙ Preferencias del estudio</h2>
    <div class="sub">Clic en un campo y apretá la tecla nueva (una letra, número o símbolo).
    Supr/Retroceso deja la acción sin atajo. Los atajos funcionan cuando no estás escribiendo texto.</div>
    ${rows}
    <div class="dz-style-row" style="margin-top:12px">
      <span class="dz-hint">Suavizado del lápiz/pincel</span>
      <input type="range" id="prefSmooth" min="0" max="100" value="${DZ.smooth === undefined ? 40 : DZ.smooth}">
      <span class="dz-hint" id="prefSmoothLbl">${DZ.smooth === undefined ? 40 : DZ.smooth}</span>
    </div>
    <div class="dz-style-row">
      <span class="dz-hint">Sensibilidad de presión (gamma)</span>
      <input type="range" id="prefGamma" min="20" max="200" value="${Math.round((DZ.pressureGamma || 0.85) * 100)}">
      <span class="dz-hint" id="prefGammaLbl">${(DZ.pressureGamma || 0.85).toFixed(2)}</span>
    </div>
    <div class="m-actions">
      <button class="ghost" id="prefReset">Restaurar por defecto</button>
      <button class="primary" id="mCancel">Listo</button>
    </div>`);
  document.querySelectorAll(".dz-keycap").forEach(inp => {
    inp.onkeydown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const act = inp.dataset.act;
      if (e.key === "Delete" || e.key === "Backspace") {
        DZ.keymap[act] = ""; inp.value = "";
      } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        // si otra acción tenía esta tecla, se la saca (sin duplicados)
        for (const [a2, k2] of Object.entries(DZ.keymap))
          if (k2 === k && a2 !== act) {
            DZ.keymap[a2] = "";
            const otro = document.querySelector(`.dz-keycap[data-act="${a2}"]`);
            if (otro) otro.value = "";
          }
        DZ.keymap[act] = k; inp.value = k.toUpperCase();
      }
      dzKeysSave();
    };
    inp.onfocus = () => inp.select();
  });
  $("#prefSmooth").oninput = (e) => {
    DZ.smooth = +e.target.value;
    $("#prefSmoothLbl").textContent = e.target.value;
    const s = $("#dzSmooth"); if (s) { s.value = e.target.value; $("#dzSmoothLbl").textContent = e.target.value; }
    try { localStorage.setItem("low.dzsmooth", String(DZ.smooth)); } catch (err) { /* */ }
  };
  $("#prefGamma").oninput = (e) => {
    DZ.pressureGamma = +e.target.value / 100;
    $("#prefGammaLbl").textContent = DZ.pressureGamma.toFixed(2);
    try { localStorage.setItem("low.dzgamma", String(DZ.pressureGamma)); } catch (err) { /* */ }
  };
  $("#prefReset").onclick = () => {
    DZ.keymap = { ...DZ_KEY_DEFAULTS };
    dzKeysSave();
    document.querySelectorAll(".dz-keycap").forEach(i2 =>
      i2.value = (DZ.keymap[i2.dataset.act] || "").toUpperCase());
  };
  $("#mCancel").onclick = closeModal;
}

/* ══ nodos (A): editar los puntos de un trazado, como la flecha blanca
   de Illustrator. Normaliza el path a comandos ABSOLUTOS y muestra un
   tirador por ancla; arrastrar mueve el punto (las manijas C lo siguen). ══ */
function dzToScreen(x, y) {
  const svg = $("#dzCanvas").querySelector("svg");
  const cv = $("#dzCanvas").getBoundingClientRect();
  const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
  const sp = pt.matrixTransform(svg.getScreenCTM());
  return { x: sp.x - cv.left, y: sp.y - cv.top };
}

/* ══ REGLAS + GUÍAS + CUADRÍCULA (2D) ═══════════════════════════════════════
   Reglas en los 4 bordes (Ctrl+R) en unidades del lienzo, guías arrastrables
   desde las reglas (como Photoshop) y cuadrícula de referencia. Todo es ayuda
   de vista: NO se guarda en el .svg. ══ */
function dzNiceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, raw))));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function dzRulersToggle() {
  DZ.rulers = !DZ.rulers;
  $("#dzRulers").hidden = !DZ.rulers;
  $("#dzRulersBtn") && $("#dzRulersBtn").classList.toggle("active", DZ.rulers);
  if (DZ.rulers) dzRulersRender();
  dzSetStatus(DZ.rulers ? "Reglas activas — arrastrá desde una regla para crear una guía (Ctrl+R oculta)" : "");
}
function dzGridToggle() {
  DZ.grid = !DZ.grid;
  $("#dzGrid2d").hidden = !DZ.grid;
  $("#dzGridBtn") && $("#dzGridBtn").classList.toggle("active", DZ.grid);
  if (DZ.grid) dzRulersRender();
}
function dzGuidesToggle() {
  DZ.guidesOn = DZ.guidesOn === false ? true : (DZ.guidesOn === undefined ? true : !DZ.guidesOn);
  $("#dzGuides").hidden = !DZ.guidesOn;
  $("#dzGuidesBtn") && $("#dzGuidesBtn").classList.toggle("active", DZ.guidesOn);
}
function dzRulersRender() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  const cv = $("#dzCanvas").getBoundingClientRect();
  const o = dzToScreen(0, 0);
  const scale = Math.abs(dzToScreen(1, 0).x - o.x) || 1;   // px por unidad (rot=0)
  const step = dzNiceStep(64 / scale);
  if (DZ.rulers) {
    // eje X (arriba y abajo)
    const uL = dzToUser(cv.left, cv.top).x, uR = dzToUser(cv.right, cv.top).x;
    let a = Math.min(uL, uR), b = Math.max(uL, uR), hx = "";
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
      const sx = dzToScreen(t, 0).x;
      hx += `<span class="dz-tk" style="left:${sx.toFixed(1)}px"><i>${Math.round(t)}</i></span>`;
      const sxm = dzToScreen(t + step / 2, 0).x;
      hx += `<span class="dz-tk mn" style="left:${sxm.toFixed(1)}px"></span>`;
    }
    $("#dzRlTop").innerHTML = hx; $("#dzRlBottom").innerHTML = hx;
    // eje Y (izquierda y derecha)
    const uT = dzToUser(cv.left, cv.top).y, uB = dzToUser(cv.left, cv.bottom).y;
    let c = Math.min(uT, uB), d = Math.max(uT, uB), hy = "";
    for (let t = Math.ceil(c / step) * step; t <= d; t += step) {
      const sy = dzToScreen(0, t).y;
      hy += `<span class="dz-tk v" style="top:${sy.toFixed(1)}px"><i>${Math.round(t)}</i></span>`;
      const sym = dzToScreen(0, t + step / 2).y;
      hy += `<span class="dz-tk v mn" style="top:${sym.toFixed(1)}px"></span>`;
    }
    $("#dzRlLeft").innerHTML = hy; $("#dzRlRight").innerHTML = hy;
  }
  if (DZ.grid) {
    const g = $("#dzGrid2d");
    const cell = step * scale;
    g.style.backgroundSize = `${cell}px ${cell}px, ${cell}px ${cell}px, ${cell * 5}px ${cell * 5}px, ${cell * 5}px ${cell * 5}px`;
    g.style.backgroundPosition = `${o.x}px ${o.y}px`;
  }
  dzGuidesRender();
}
function dzGuidesRender() {
  const box = $("#dzGuides");
  if (!box) return;
  const guides = DZ.guides || [];
  box.innerHTML = "";
  guides.forEach((g, i) => {
    const line = document.createElement("div");
    if (g.axis === "h") {
      const y = dzToScreen(0, g.u).y;
      line.className = "dz-guide h"; line.style.top = y.toFixed(1) + "px";
    } else {
      const x = dzToScreen(g.u, 0).x;
      line.className = "dz-guide v"; line.style.left = x.toFixed(1) + "px";
    }
    line.dataset.i = i;
    line.onpointerdown = (e) => dzGuideDrag(e, i);
    box.appendChild(line);
  });
}
/* arrastrar una guía existente; soltarla sobre una regla la elimina */
function dzGuideDrag(e, i) {
  e.preventDefault(); e.stopPropagation();
  const g = DZ.guides[i];
  const move = (ev) => {
    const p = dzToUser(ev.clientX, ev.clientY);
    g.u = g.axis === "h" ? p.y : p.x;
    dzGuidesRender();
  };
  const up = (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const cv = $("#dzCanvas").getBoundingClientRect();
    const rx = ev.clientX - cv.left, ry = ev.clientY - cv.top;
    if (rx < 20 || ry < 20 || rx > cv.width - 20 || ry > cv.height - 20) {
      DZ.guides.splice(i, 1);   // soltada sobre una regla → borrar
    }
    dzGuidesRender();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}
/* crear una guía arrastrando desde una regla */
function dzRulerPull(e, axis) {
  e.preventDefault();
  if (DZ.guidesOn === false) dzGuidesToggle();
  DZ.guides = DZ.guides || [];
  const p0 = dzToUser(e.clientX, e.clientY);
  DZ.guides.push({ axis, u: axis === "h" ? p0.y : p0.x });
  const i = DZ.guides.length - 1;
  dzGuidesRender();
  dzGuideDrag(e, i);
}
/* parsea un atributo d a comandos absolutos: [{c:"M",n:[x,y]},{c:"C",n:[...]}] */
function dzPathParse(d) {
  const toks = d.match(/[a-zA-Z]|-?[\d.]+(?:e-?\d+)?/g);
  if (!toks) return null;
  const ARG = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const out = [];
  let cx = 0, cy = 0, sx = 0, sy = 0, i = 0, cmd = null;
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    if (!cmd) return null;
    const C = cmd.toUpperCase(), rel = cmd !== C;
    if (!(C in ARG)) return null;
    const na = ARG[C];
    if (C === "Z") { out.push({ c: "Z", n: [] }); cx = sx; cy = sy; if (i >= toks.length) break; continue; }
    const n = toks.slice(i, i + na).map(Number);
    if (n.length < na || n.some(isNaN)) return null;
    i += na;
    if (C === "H") { const x = rel ? cx + n[0] : n[0]; out.push({ c: "L", n: [x, cy] }); cx = x; }
    else if (C === "V") { const y = rel ? cy + n[0] : n[0]; out.push({ c: "L", n: [cx, y] }); cy = y; }
    else if (C === "A") {
      const x = rel ? cx + n[5] : n[5], y = rel ? cy + n[6] : n[6];
      out.push({ c: "A", n: [n[0], n[1], n[2], n[3], n[4], x, y] }); cx = x; cy = y;
    } else {
      const abs = n.slice();
      if (rel) for (let k = 0; k < abs.length; k += 2) { abs[k] += cx; abs[k + 1] += cy; }
      out.push({ c: C, n: abs });
      cx = abs[abs.length - 2]; cy = abs[abs.length - 1];
      if (C === "M") { sx = cx; sy = cy; cmd = rel ? "l" : "L"; }   // M implícito encadena L
    }
  }
  return out;
}
function dzPathBuild(cmds) {
  return cmds.map(s => s.c + " " + s.n.map(v => (Math.round(v * 100) / 100)).join(" ")).join(" ");
}
/* anclas editables del elemento seleccionado (según su tipo) */
function dzNodesFor(el) {
  const t = el.tagName.toLowerCase();
  if (t === "path") {
    const cmds = dzPathParse(el.getAttribute("d") || "");
    if (!cmds) return null;
    el.__dzCmds = cmds;
    const anchors = [];
    cmds.forEach((s, k) => {
      if (s.c !== "Z" && s.n.length >= 2)
        anchors.push({ x: s.n[s.n.length - 2], y: s.n[s.n.length - 1], k });
    });
    return { kind: "path", anchors };
  }
  if (t === "polygon" || t === "polyline") {
    const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
    const anchors = [];
    for (let k = 0; k + 1 < pts.length; k += 2) anchors.push({ x: pts[k], y: pts[k + 1], k: k / 2 });
    el.__dzPts = pts;
    return { kind: "poly", anchors };
  }
  if (t === "line")
    return { kind: "line", anchors: [
      { x: +el.getAttribute("x1") || 0, y: +el.getAttribute("y1") || 0, k: 1 },
      { x: +el.getAttribute("x2") || 0, y: +el.getAttribute("y2") || 0, k: 2 }] };
  return null;
}
function dzNodeMove(el, info, a, dx, dy) {
  if (info.kind === "path") {
    const cmds = el.__dzCmds, s = cmds[a.k];
    s.n[s.n.length - 2] = a.x + dx; s.n[s.n.length - 1] = a.y + dy;
    if (s.c === "C") { s.n[2] = (a.c2x !== undefined ? a.c2x : s.n[2]) + dx; s.n[3] = (a.c2y !== undefined ? a.c2y : s.n[3]) + dy; }
    const nx = cmds[a.k + 1];                     // la manija de salida acompaña
    if (nx && nx.c === "C") { nx.n[0] = (a.n1x !== undefined ? a.n1x : nx.n[0]) + dx; nx.n[1] = (a.n1y !== undefined ? a.n1y : nx.n[1]) + dy; }
    el.setAttribute("d", dzPathBuild(cmds));
  } else if (info.kind === "poly") {
    const pts = el.__dzPts;
    pts[a.k * 2] = a.x + dx; pts[a.k * 2 + 1] = a.y + dy;
    el.setAttribute("points", pts.map(v => Math.round(v * 100) / 100).join(" "));
  } else if (info.kind === "line") {
    el.setAttribute("x" + a.k, Math.round(a.x + dx));
    el.setAttribute("y" + a.k, Math.round(a.y + dy));
  }
}
function dzNodeDelete(el, info, a) {
  if (info.kind === "path") {
    const cmds = el.__dzCmds;
    if (cmds.filter(s => s.c !== "Z").length <= 2) return;   // no dejar un path degenerado
    if (cmds[a.k].c === "M" && cmds[a.k + 1] && cmds[a.k + 1].n.length >= 2) {
      const nx = cmds[a.k + 1];
      cmds[a.k + 1] = { c: "M", n: [nx.n[nx.n.length - 2], nx.n[nx.n.length - 1]] };
    }
    cmds.splice(a.k, 1);
    el.setAttribute("d", dzPathBuild(cmds));
  } else if (info.kind === "poly") {
    const pts = el.__dzPts;
    if (pts.length <= 6) return;
    pts.splice(a.k * 2, 2);
    el.setAttribute("points", pts.map(v => Math.round(v * 100) / 100).join(" "));
  } else return;                                 // línea: sus 2 puntos no se borran
  dzMarkDirty(); dzNodesShow(el);
}
function dzNodesClear() {
  document.querySelectorAll("#dzCanvas .dz-node").forEach(n => n.remove());
  DZ.nodeEl = null;
}
function dzNodesShow(el) {
  dzNodesClear();
  const info = dzNodesFor(el);
  if (!info) { dzSetStatus("⬦ Ese elemento no tiene nodos editables (probá con un trazado, polígono o línea)"); return; }
  DZ.nodeEl = el;
  const cv = $("#dzCanvas");
  info.anchors.forEach(a => {
    const n = document.createElement("div");
    n.className = "dz-node";
    const sp = dzToScreen(a.x, a.y);
    n.style.left = sp.x + "px"; n.style.top = sp.y + "px";
    n.title = "Arrastrá para mover el punto · doble clic: borrarlo";
    n.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      dzSnapshot();
      // congelar las manijas vecinas de ESTE arrastre (para sumar el delta una sola vez)
      if (info.kind === "path") {
        const s = el.__dzCmds[a.k], nx = el.__dzCmds[a.k + 1];
        if (s.c === "C") { a.c2x = s.n[2]; a.c2y = s.n[3]; }
        if (nx && nx.c === "C") { a.n1x = nx.n[0]; a.n1y = nx.n[1]; }
      }
      const start = dzToUser(e.clientX, e.clientY);
      const move = (ev) => {
        const p = dzToUser(ev.clientX, ev.clientY);
        dzNodeMove(el, info, a, p.x - start.x, p.y - start.y);
        const s2 = dzToScreen(a.x + (p.x - start.x), a.y + (p.y - start.y));
        n.style.left = s2.x + "px"; n.style.top = s2.y + "px";
      };
      const up = (ev) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const p = dzToUser(ev.clientX, ev.clientY);
        a.x += p.x - start.x; a.y += p.y - start.y;
        delete a.c2x; delete a.c2y; delete a.n1x; delete a.n1y;
        dzMarkDirty();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    n.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); dzSnapshot(); dzNodeDelete(el, info, a); };
    cv.appendChild(n);
  });
  dzSetStatus("⬦ " + info.anchors.length + " puntos — arrastralos · doble clic borra un punto");
}
function dzNodesClick(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest || !el.closest("#dzCanvas svg") || el.closest("g.dz-onion")) { dzNodesClear(); dzSetStatus(""); return; }
  const t = el.tagName.toLowerCase();
  if (["svg", "defs"].includes(t)) { dzNodesClear(); dzSetStatus(""); return; }
  dzNodesShow(el);
}

/* ══ borrador (E): arrastrá por encima y borra trazos/formas ENTEROS ══ */
function dzEraseStart(e) {
  const svg = $("#dzCanvas").querySelector("svg");
  dzSnapshot();
  let erased = 0;
  const eraseAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.closest || el.closest("g.dz-onion")) return;
    if (el.closest("[data-locked]")) return;           // capa bloqueada 🔒
    const inSvg = el.closest("#dzCanvas svg");
    if (!inSvg || el === svg) return;
    const t = el.tagName.toLowerCase();
    if (!["path", "line", "circle", "rect", "ellipse", "polygon", "polyline", "text", "tspan", "image"].includes(t)) return;
    // los trazos de pincel viven en un <g data-low=brush>: borrar el grupo entero
    let target = el.closest('g[data-low="brush"]') || (t === "tspan" ? el.closest("text") : el);
    // no borrar el rect de fondo (cubre casi todo el lienzo)
    if (t === "rect") {
      const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
      const area = (+el.getAttribute("width") || 0) * (+el.getAttribute("height") || 0);
      if (area >= (vb[2] || 1) * (vb[3] || 1) * 0.9) return;
    }
    if (target === DZ.sel) dzDeselect();
    target.remove(); erased++;
  };
  eraseAt(e.clientX, e.clientY);
  const move = (ev) => eraseAt(ev.clientX, ev.clientY);
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    if (erased) { dzMarkDirty(); dzBuildLayers(); dzSetStatus("◪ Borré " + erased + " elemento(s)"); }
    else if (DZ.undo && DZ.undo.length) DZ.undo.pop();   // no borró nada: snapshot de más
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

/* ══ cuentagotas (I) y balde (G) ══ */
function dzDropperPick(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest || !el.closest("#dzCanvas svg")) return;
  const cs = getComputedStyle(el);
  const fill = dzHex(el.getAttribute("fill") || cs.fill);
  const stroke = dzHex(el.getAttribute("stroke") || cs.stroke);
  if (fill) { DZ.fillColor = fill; const i = $("#dzPFill"); if (i) i.value = fill; }
  if (stroke) { DZ.drawColor = stroke; const i = $("#dzPStroke"); if (i) i.value = stroke; }
  const sw = parseFloat(el.getAttribute("stroke-width") || cs.strokeWidth);
  if (sw) { DZ.drawW = Math.round(sw); const i = $("#dzDrawW"); if (i) i.value = DZ.drawW; }
  dzSetStatus("💧 Tomé relleno " + (fill || "—") + " · trazo " + (stroke || "—"));
}
/* ══ Balde (G): busca el elemento PINTABLE bajo el cursor, bajando por
   grupos (<g>, <a>) hasta encontrar path/rect/circle/ellipse/polygon/
   polyline/line/text. Shift+clic pinta el trazo en vez el relleno. ══ */
const DZ_PAINTABLE = new Set(["path","rect","circle","ellipse","polygon","polyline","line","text"]);
function dzBucketApply(e) {
  let el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest || !el.closest("#dzCanvas svg") || el.closest("g.dz-onion")) return;
  if (el.closest("[data-locked]")) return;             // capa bloqueada 🔒
  // bajar por grupos: el balde pinta el primer elemento "pintable"
  while (el && !DZ_PAINTABLE.has(el.tagName.toLowerCase())) {
    const g = el.closest("g, a");
    if (!g) break;
    // buscar el primer hijo pintable dentro del grupo
    const child = g.querySelector("path,rect,circle,ellipse,polygon,polyline,line,text");
    if (child) { el = child; break; }
    // si no, subir al padre y probar de nuevo
    el = g.parentElement;
  }
  if (!el || el.tagName.toLowerCase() === "svg") return;
  dzSnapshot();
  if (e.shiftKey) el.setAttribute("stroke", DZ.drawColor || "#1a1a1a");
  else el.setAttribute("fill", DZ.fillColor || "#F0450E");
  dzMarkDirty(); dzBuildLayers();
}

/* ══ Regla / Hilo tensado (R): herramienta de línea recta interactiva.
   Clic = punto A → banda elástica hasta el cursor.
   Shift = snapping a 15° (múltiplos de 15°).
   Clic en punto B = crea la línea y reinicia desde B (trazado continuo).
   Escape = cancela la línea en curso.
   Clic derecho = fija un PUNTO DE FUGA (●). Si hay al menos uno, al hacer
   clic en A la línea se tensa automáticamente hacia el punto de fuga más
   cercano (como el hilo de OpenToonz). Doble clic en punto de fuga lo borra. ══ */
function dzRulerDown(e) {
  const p = dzToUser(e.clientX, e.clientY);

  // Clic derecho → punto de fuga
  if (e.button === 2) {
    e.preventDefault();
    if (!RULER) RULER = { a: null, el: null, vp: [] };
    // ¿doble clic sobre punto de fuga existente? → borrarlo
    const R = 12 / (DZ.zoom || 1); // radio en unidades de usuario
    for (let i = RULER.vp.length - 1; i >= 0; i--) {
      const v = RULER.vp[i];
      if (Math.hypot(p.x - v.x, p.y - v.y) < R) {
        RULER.vp.splice(i, 1);
        dzRulerRenderVP();
        if (RULER.vp.length === 0 && !RULER.a) { dzRulerClear(); }
        return;
      }
    }
    RULER.vp.push({ x: p.x, y: p.y });
    dzRulerRenderVP();
    return;
  }

  // Clic izquierdo normal
  if (!RULER || !RULER.a) {
    // Primer punto
    if (!RULER) RULER = { a: null, el: null, vp: [] };
    RULER.a = p;
    // preview elástico
    const svg = $("#dzCanvas").querySelector("svg");
    if (svg && !RULER.el) {
      RULER.el = document.createElementNS(SVGNS, "line");
      RULER.el.setAttribute("stroke", DZ.drawColor || "#F0450E");
      RULER.el.setAttribute("stroke-width", DZ.drawW || 4);
      RULER.el.setAttribute("stroke-linecap", "round");
      RULER.el.setAttribute("stroke-dasharray", "6 4");
      RULER.el.setAttribute("opacity", "0.7");
      RULER.el.setAttribute("data-low", "ruler-guide");
      svg.appendChild(RULER.el);
    }
    dzRulerUpdateElastic(p);
  } else {
    // Segundo punto → crear línea definitiva
    dzSnapshot();
    let bp = p;
    // snapping a punto de fuga si hay
    if (RULER.vp.length > 0 && !e.shiftKey) {
      bp = dzRulerSnapVP(p);
    }
    // snapping a 15° si Shift
    if (e.shiftKey) {
      bp = dzRulerSnapAngle(RULER.a, p);
    }
    const svg = $("#dzCanvas").querySelector("svg");
    if (svg) {
      const ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", RULER.a.x); ln.setAttribute("y1", RULER.a.y);
      ln.setAttribute("x2", bp.x); ln.setAttribute("y2", bp.y);
      ln.setAttribute("stroke", DZ.drawColor || "#F0450E");
      ln.setAttribute("stroke-width", DZ.drawW || 4);
      ln.setAttribute("stroke-linecap", "round");
      svg.appendChild(ln);
      dzMirrorClone(ln);
    }
    dzMarkDirty(); dzBuildLayers();
    // continuar desde B (trazado continuo como la pluma de OpenToonz)
    RULER.a = bp;
    dzRulerUpdateElastic(bp);
  }
}

function dzRulerMove(e) {
  const p = dzToUser(e.clientX, e.clientY);
  if (!RULER || !RULER.a) return;
  let bp = p;
  if (RULER.vp.length > 0 && !e.shiftKey) {
    bp = dzRulerSnapVP(p);
  }
  if (e.shiftKey) {
    bp = dzRulerSnapAngle(RULER.a, p);
  }
  dzRulerUpdateElastic(bp);
}

function dzRulerUpdateElastic(p) {
  if (!RULER || !RULER.el || !RULER.a) return;
  RULER.el.setAttribute("x1", RULER.a.x);
  RULER.el.setAttribute("y1", RULER.a.y);
  RULER.el.setAttribute("x2", p.x);
  RULER.el.setAttribute("y2", p.y);
}

function dzRulerSnapAngle(a, p) {
  const dx = p.x - a.x, dy = p.y - a.y;
  const ang = Math.atan2(dy, dx);
  const snap = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12); // 15° = π/12
  const dist = Math.hypot(dx, dy);
  return { x: a.x + dist * Math.cos(snap), y: a.y + dist * Math.sin(snap) };
}

function dzRulerSnapVP(p) {
  if (!RULER || !RULER.vp.length) return p;
  // snap al punto de fuga más cercano
  let best = RULER.vp[0], bestD = Math.hypot(p.x - best.x, p.y - best.y);
  for (let i = 1; i < RULER.vp.length; i++) {
    const d = Math.hypot(p.x - RULER.vp[i].x, p.y - RULER.vp[i].y);
    if (d < bestD) { bestD = d; best = RULER.vp[i]; }
  }
  return best;
}

/* dibuja los puntos de fuga como círculos semitransparentes */
function dzRulerRenderVP() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  // limpiar capa de guías de VP
  let g = svg.querySelector("g.dz-vp-guides");
  if (g) g.remove();
  if (!RULER || !RULER.vp.length) return;
  g = document.createElementNS(SVGNS, "g");
  g.setAttribute("class", "dz-vp-guides");
  g.setAttribute("data-low", "vp-guide");
  const R = 7 / (DZ.zoom || 1);
  RULER.vp.forEach(vp => {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", vp.x); c.setAttribute("cy", vp.y);
    c.setAttribute("r", R);
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "#FF6B6B");
    c.setAttribute("stroke-width", 2 / (DZ.zoom || 1));
    c.setAttribute("stroke-dasharray", "3 2");
    g.appendChild(c);
    // cruz
    const cr = R * 1.8;
    const l1 = document.createElementNS(SVGNS, "line");
    l1.setAttribute("x1", vp.x - cr); l1.setAttribute("y1", vp.y);
    l1.setAttribute("x2", vp.x + cr); l1.setAttribute("y2", vp.y);
    l1.setAttribute("stroke", "#FF6B6B");
    l1.setAttribute("stroke-width", 1.2 / (DZ.zoom || 1));
    l1.setAttribute("opacity", "0.6");
    g.appendChild(l1);
    const l2 = document.createElementNS(SVGNS, "line");
    l2.setAttribute("x1", vp.x); l2.setAttribute("y1", vp.y - cr);
    l2.setAttribute("x2", vp.x); l2.setAttribute("y2", vp.y + cr);
    l2.setAttribute("stroke", "#FF6B6B");
    l2.setAttribute("stroke-width", 1.2 / (DZ.zoom || 1));
    l2.setAttribute("opacity", "0.6");
    g.appendChild(l2);
  });
  svg.appendChild(g);
}

function dzRulerClear() {
  if (RULER && RULER.el) { RULER.el.remove(); }
  const svg = $("#dzCanvas").querySelector("svg");
  if (svg) { const g = svg.querySelector("g.dz-vp-guides"); if (g) g.remove(); }
  RULER = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   HERRAMIENTAS VECTORIALES estilo Toon Boom
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Inflador: seleccioná una forma y arrastrá para inflarla (expandir)
   o Shift+arrastrar para desinflarla (contraer). Escala alrededor del
   centro geométrico con un factor proporcional a la distancia arrastrada. ── */
let INFLATOR = null;   // { el, cx, cy, startR, startDist }

function dzInflatorDown(e) {
  e.preventDefault(); e.stopPropagation();
  const el = DZ.sel || DZ.multi?.[0];
  if (!el) return dzSetStatus("⚠ Seleccioná una forma primero para inflar/desinflar");
  const tag = el.tagName.toLowerCase();
  if (!["path", "rect", "circle", "ellipse", "polygon", "polyline"].includes(tag))
    return dzSetStatus("⚠ El inflador funciona sobre formas (path, rect, círculo…)");
  dzSnapshot();
  const bbox = el.getBBox({ stroke: true });
  INFLATOR = {
    el, cx: bbox.x + bbox.width / 2, cy: bbox.y + bbox.height / 2,
    startR: Math.max(bbox.width, bbox.height) / 2,
    startDist: 0, dir: e.shiftKey ? -1 : 1
  };
  dzSetStatus("🎈 Inflando — soltá para aplicar · Shift desinfla");
}

function dzInflatorMove(e) {
  if (!INFLATOR || !INFLATOR.el) return;
  const p = dzToUser(e.clientX, e.clientY);
  const dx = p.x - INFLATOR.cx, dy = p.y - INFLATOR.cy;
  const dist = Math.hypot(dx, dy);
  if (!INFLATOR.startDist) INFLATOR.startDist = dist || 1;
  // factor: 1.0 en startDist, crece/decrece al alejarse/acercarse
  const factor = INFLATOR.dir > 0
    ? Math.max(0.05, 1 + (dist - INFLATOR.startDist) / INFLATOR.startR)
    : Math.max(0.05, 1 - (INFLATOR.startDist - dist) / INFLATOR.startR);
  const el = INFLATOR.el, tag = el.tagName.toLowerCase();
  if (tag === "rect") {
    const x = +el.getAttribute("x"), y = +el.getAttribute("y"),
          w = +el.getAttribute("width"), h = +el.getAttribute("height");
    const nw = w * factor, nh = h * factor;
    el.setAttribute("x", INFLATOR.cx - nw / 2);
    el.setAttribute("y", INFLATOR.cy - nh / 2);
    el.setAttribute("width", nw); el.setAttribute("height", nh);
  } else if (tag === "circle") {
    el.setAttribute("r", Math.max(0.5, INFLATOR.startR * factor * (el.tagName === "ellipse" ? 1 : 1)));
    // circle solo r, ellipse usa rx/ry
  } else if (tag === "ellipse") {
    const rx = +el.getAttribute("rx"), ry = +el.getAttribute("ry");
    el.setAttribute("rx", Math.max(0.5, rx * factor));
    el.setAttribute("ry", Math.max(0.5, ry * factor));
  } else if (tag === "polygon" || tag === "polyline") {
    const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
    const out = [];
    for (let i = 0; i < pts.length; i += 2) {
      out.push(INFLATOR.cx + (pts[i] - INFLATOR.cx) * factor);
      out.push(INFLATOR.cy + (pts[i + 1] - INFLATOR.cy) * factor);
    }
    el.setAttribute("points", out.map(v => Math.round(v * 100) / 100).join(" "));
  } else if (tag === "path") {
    // escalar cada comando del path
    const cmds = dzPathParse(el.getAttribute("d") || "");
    if (cmds) {
      for (const s of cmds) {
        for (let i = 0; i + 1 < s.n.length; i += 2) {
          s.n[i] = INFLATOR.cx + (s.n[i] - INFLATOR.cx) * factor;
          s.n[i + 1] = INFLATOR.cy + (s.n[i + 1] - INFLATOR.cy) * factor;
        }
      }
      el.setAttribute("d", dzPathBuild(cmds));
    }
  }
  dzPositionHandle();
}

function dzInflatorUp(e) {
  if (INFLATOR && INFLATOR.el) { dzMarkDirty(); dzBuildLayers(); dzSetStatus("🎈 Inflado aplicado"); }
  INFLATOR = null;
}

/* ── Manejador de contorno: clic en una línea y arrastrá ↕ para cambiar
   el grosor del trazo (stroke-width) en tiempo real. ── */
let HANDLER = null;   // { el, startW }

function dzHandlerDown(e) {
  e.preventDefault(); e.stopPropagation();
  // buscar elemento de trazo debajo del cursor
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest || !el.closest("#dzCanvas svg") || el.closest("g.dz-onion")) return;
  const strokeEl = el.closest("path,line,rect,circle,ellipse,polygon,polyline,text");
  if (!strokeEl || strokeEl.tagName.toLowerCase() === "svg") return;
  dzSnapshot();
  const sw = parseFloat(strokeEl.getAttribute("stroke-width") || getComputedStyle(strokeEl).strokeWidth || "2");
  HANDLER = { el: strokeEl, startW: isNaN(sw) ? 2 : sw, startY: e.clientY };
  dzSetStatus("📏 Manejador — arrastrá ↕ para engrosar/afinar el trazo");
}

function dzHandlerMove(e) {
  // se llama desde el move global — lo manejamos en dzDrawMove
}

function dzHandlerUp(e) {
  if (HANDLER && HANDLER.el) { dzMarkDirty(); dzBuildLayers(); dzSetStatus("📏 Grosor ajustado"); }
  HANDLER = null;
}

/* handler se procesa en el mousemove global porque no usa DRAW_TRACK */
function dzHandlerGlobalMove(e) {
  if (!HANDLER || !HANDLER.el) return;
  const dy = HANDLER.startY - e.clientY;
  const newW = Math.max(0.5, Math.min(200, HANDLER.startW + dy / 4));
  HANDLER.el.setAttribute("stroke-width", newW.toFixed(1));
  dzSetStatus("📏 Grosor: " + newW.toFixed(1) + "px");
}

/* ── Plancha: pasá sobre un trazo para suavizarlo progresivamente.
   Cada pasada aplica media móvil → RDP → Catmull-Rom igual que el lápiz. ── */

function dzIronDown(e) {
  e.preventDefault(); e.stopPropagation();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest || !el.closest("#dzCanvas svg") || el.closest("g.dz-onion")) return;
  const pathEl = el.closest("path");
  if (!pathEl || pathEl.getAttribute("data-low") !== "brush") {
    // también funciona sobre paths con stroke
    const anyPath = el.closest("path,line,polyline");
    if (!anyPath) return;
    dzIronSmooth(anyPath);
    return;
  }
  dzIronSmooth(pathEl);
}

function dzIronSmooth(el) {
  dzSnapshot();
  const tag = el.tagName.toLowerCase();
  if (tag === "path") {
    const d = el.getAttribute("d") || "";
    const pts = dzPathToPoints(d);
    if (!pts || pts.length < 4) return;
    const refined = dzRefineStroke(pts);
    el.setAttribute("d", dzSmoothPath(refined));
  } else if (tag === "polyline") {
    const ptsRaw = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < ptsRaw.length; i += 2)
      pts.push([ptsRaw[i], ptsRaw[i + 1], 0.5]);
    const refined = dzRefineStroke(pts);
    el.setAttribute("points", refined.map(p => Math.round(p[0] * 10) / 10 + " " + Math.round(p[1] * 10) / 10).join(" "));
  }
  dzMarkDirty(); dzBuildLayers();
  dzSetStatus("🔥 Planchado — el trazo quedó más suave");
}

/* convierte el atributo d de un path a array de puntos [x,y,pr] */
function dzPathToPoints(d) {
  const cmds = dzPathParse(d);
  if (!cmds) return null;
  const pts = [];
  for (const s of cmds) {
    if (s.c === "Z") continue;
    pts.push([s.n[s.n.length - 2], s.n[s.n.length - 1], 0.5]);
  }
  return pts;
}

/* ── Pinza: clic en el borde de un trazado para cortarlo en dos.
   Encuentra el punto más cercano del path al clic y lo parte ahí. ── */

function dzPliersDown(e) {
  e.preventDefault(); e.stopPropagation();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest || !el.closest("#dzCanvas svg") || el.closest("g.dz-onion")) return;
  const pathEl = el.closest("path");
  if (!pathEl) return dzSetStatus("✂ Hacé clic sobre un trazado (path) para cortarlo");
  dzSnapshot();
  const p = dzToUser(e.clientX, e.clientY);
  const cmds = dzPathParse(pathEl.getAttribute("d") || "");
  if (!cmds || cmds.length < 2) return;
  // encontrar el segmento más cercano al clic
  let bestSeg = -1, bestDist = Infinity, bestT = 0.5;
  for (let i = 0; i < cmds.length - 1; i++) {
    const s1 = cmds[i], s2 = cmds[i + 1];
    if (s1.c === "Z" || s2.c === "Z") continue;
    const x1 = s1.n[s1.n.length - 2], y1 = s1.n[s1.n.length - 1];
    const x2 = s2.n[s2.n.length - 2], y2 = s2.n[s2.n.length - 1];
    // punto más cercano en segmento
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / L2)) : 0.5;
    const cx = x1 + t * dx, cy = y1 + t * dy;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bestDist) { bestDist = d; bestSeg = i; bestT = t; }
  }
  if (bestSeg < 0 || bestDist > 25 / (DZ.zoom || 1)) return dzSetStatus("✂ Muy lejos del trazo — acercate más al borde");
  // partir el path en bestSeg
  const s1 = cmds[bestSeg], s2 = cmds[bestSeg + 1];
  const x1 = s1.n[s1.n.length - 2], y1 = s1.n[s1.n.length - 1];
  const x2 = s2.n[s2.n.length - 2], y2 = s2.n[s2.n.length - 1];
  const mx = x1 + bestT * (x2 - x1), my = y1 + bestT * (y2 - y1);
  // primer path: desde 0 hasta bestSeg + punto de corte
  const cmds1 = cmds.slice(0, bestSeg + 1);
  const lastCmd = cmds1[cmds1.length - 1];
  lastCmd.n[lastCmd.n.length - 2] = mx;
  lastCmd.n[lastCmd.n.length - 1] = my;
  // segundo path: M al punto de corte + resto
  const cmds2 = [{ c: "M", n: [mx, my] }];
  // modificar el primer comando del resto para que empiece desde el corte
  const restStart = cmds[bestSeg + 1];
  restStart.n[restStart.n.length - 2] = x2;  // mantener el final igual
  restStart.n[restStart.n.length - 1] = y2;
  // arrancar el resto con M en el corte
  cmds2.push({ c: "L", n: [x2, y2] });
  for (let i = bestSeg + 2; i < cmds.length; i++) cmds2.push(cmds[i]);
  // crear los dos paths nuevos
  const svg = $("#dzCanvas").querySelector("svg");
  const NS = "http://www.w3.org/2000/svg";
  const el1 = document.createElementNS(NS, "path");
  el1.setAttribute("d", dzPathBuild(cmds1));
  copyStyle(pathEl, el1);
  const el2 = document.createElementNS(NS, "path");
  el2.setAttribute("d", dzPathBuild(cmds2));
  copyStyle(pathEl, el2);
  pathEl.parentNode.insertBefore(el1, pathEl);
  pathEl.parentNode.insertBefore(el2, pathEl);
  pathEl.remove();
  dzSelect(el1);
  dzMarkDirty(); dzBuildLayers();
  dzSetStatus("✂ Trazo cortado en dos — el primero queda seleccionado");
}

function copyStyle(src, dst) {
  for (const attr of ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "data-low"]) {
    const v = src.getAttribute(attr);
    if (v) dst.setAttribute(attr, v);
  }
}

/* ── Imán: deforma los vértices cercanos de TODOS los trazados visibles.
   Clic y arrastrá: los puntos dentro del radio son atraídos hacia el cursor.
   Como el magnet warp de Toon Boom. ── */
let MAGNET = null;   // { active, radius }

function dzMagnetDown(e) {
  e.preventDefault(); e.stopPropagation();
  dzSnapshot();
  MAGNET = { active: true, radius: 60 / (DZ.zoom || 1) };
  dzMagnetApply(e);
  dzSetStatus("🧲 Imán activo — arrastrá para deformar · soltá para terminar");
}

function dzMagnetMove(e) {
  if (!MAGNET || !MAGNET.active) return;
  dzMagnetApply(e);
}

function dzMagnetApply(e) {
  const p = dzToUser(e.clientX, e.clientY);
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  const r2 = MAGNET.radius * MAGNET.radius;
  const paths = svg.querySelectorAll("path,polygon,polyline,line");
  let moved = 0;
  for (const el of paths) {
    if (el.closest("g.dz-onion") || el.closest("[data-locked]")) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "path") {
      const cmds = dzPathParse(el.getAttribute("d") || "");
      if (!cmds) continue;
      let dirty = false;
      for (const s of cmds) {
        if (s.c === "Z") continue;
        const lx = s.n[s.n.length - 2], ly = s.n[s.n.length - 1];
        const dx = p.x - lx, dy = p.y - ly;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2) {
          const force = 1 - Math.sqrt(d2) / MAGNET.radius;
          s.n[s.n.length - 2] = lx + dx * force * 0.5;
          s.n[s.n.length - 1] = ly + dy * force * 0.5;
          dirty = true; moved++;
        }
      }
      if (dirty) el.setAttribute("d", dzPathBuild(cmds));
    } else if (tag === "polygon" || tag === "polyline") {
      const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
      let dirty = false;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const dx = p.x - pts[i], dy = p.y - pts[i + 1];
        if (dx * dx + dy * dy < r2) {
          const force = 1 - Math.hypot(dx, dy) / MAGNET.radius;
          pts[i] += dx * force * 0.5;
          pts[i + 1] += dy * force * 0.5;
          dirty = true; moved++;
        }
      }
      if (dirty) el.setAttribute("points", pts.map(v => Math.round(v * 100) / 100).join(" "));
    } else if (tag === "line") {
      for (const attr of ["x1", "y1", "x2", "y2"]) {
        const v = +el.getAttribute(attr);
        const isY = attr[0] === "y";
        const dx = p.x - (isY ? (+el.getAttribute(attr === "y1" ? "x1" : "x2")) : v);
        const dy = p.y - (isY ? v : (+el.getAttribute(attr === "x1" ? "y1" : "y2")));
        if (dx * dx + dy * dy < r2) {
          const force = 1 - Math.hypot(dx, dy) / MAGNET.radius;
          if (isY) el.setAttribute(attr, v + dy * force * 0.5);
          else el.setAttribute(attr, v + dx * force * 0.5);
          moved++;
        }
      }
    }
  }
  if (moved) dzSetStatus("🧲 Imán — " + moved + " puntos afectados");
}

function dzMagnetUp(e) {
  if (MAGNET && MAGNET.active) {
    dzMarkDirty(); dzBuildLayers();
    dzSetStatus("🧲 Deformación aplicada");
  }
  MAGNET = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   MESA GIRATORIA (disco de animación): dial en pantalla para rotar la
   vista como un animador tradicional. Se arrastra el disco para girar
   libremente la vista del lienzo.
   ═══════════════════════════════════════════════════════════════════════ */

function dzDiscToggle() {
  let disc = $("#dzDisc");
  if (disc) { disc.hidden = !disc.hidden; return; }
  disc = document.createElement("div");
  disc.id = "dzDisc"; disc.className = "dz-disc";
  disc.innerHTML = '<div class="dz-disc-notch" id="dzDiscNotch"></div>' +
    '<div class="dz-disc-inner"></div>' +
    '<div class="dz-disc-dial" id="dzDiscDial">0°</div>' +
    '<div class="dz-disc-peg"><div></div><div></div><div></div></div>';
  disc.title = "Mesa giratoria: arrastrá para rotar la vista · Shift: de a 15°";
  $("#dzCanvas").appendChild(disc);

  let startAngle = 0, startRot = 0;
  disc.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const rect = disc.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    startRot = DZ.viewRot || 0;
    const move = (ev) => {
      const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
      let delta = angle - startAngle;
      if (ev.shiftKey) delta = Math.round(delta / 15) * 15;
      DZ.viewRot = (startRot + delta) % 360;
      dzApplyZoom();
      // rotar la muesca visual
      const notch = $("#dzDiscNotch");
      if (notch) notch.style.transform = `rotate(${DZ.viewRot}deg)`;
      const dial = $("#dzDiscDial");
      if (dial) dial.textContent = Math.round(DZ.viewRot) + "°";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  // evitar que el mousedown en el disco inicie otras herramientas
  disc.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
  dzSetStatus("💿 Mesa giratoria activa — arrastrá el disco para girar la vista");
}

/* ══ animación: línea de tiempo + papel cebolla (cuadros _f001.svg…) ══ */
DZ.anim = null;   // {frames:[rutas], idx, playing, onion, cache:{}}

async function dzAnimToggle() {
  const bar = $("#dzTimeline");
  if (!bar.hidden) {
    dzAnimStop(); bar.hidden = true; DZ.anim = null; dzOnionClear();
    $("#dzOnionPanel").hidden = true;
    if (DZ.camMode) { DZ.camMode = false; $("#dzCamBtn").classList.remove("active"); $("#dzCam").hidden = true; $("#tlCamKey").hidden = true; }
    return;
  }
  if (!DZ.path) return sysMsg("Abrí un diseño primero (✒ o un .svg del árbol).");
  await dzPersist();
  let r = await api.make_frame(DZ.path);
  if (r && r.error) return sysMsg("❌ " + r.error);
  if (r.path !== DZ.path) {
    try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
    await openDesign(r.path);
  }
  DZ.anim = { frames: [], idx: 0, playing: false, onion: true, cache: {} };
  $("#dzOnionPanel").hidden = false;   // el panel 🧅 aparece con la timeline
  // cargar la escena (claves de cámara/dibujo, easing) que vive junto a los cuadros
  const sc = await api.scene_get(DZ.path);
  DZ.scene = (sc && sc.scene) || {};
  bar.hidden = false;
  await dzTimelineRefresh();
  dzOnionUpdate();
  dzCamOverlay();
}
async function dzTimelineRefresh() {
  const r = await api.list_frames(DZ.path);
  DZ.anim.frames = (r && r.frames) || [];
  DZ.anim.idx = DZ.anim.frames.indexOf(DZ.path);
  const box = $("#tlFrames");
  box.innerHTML = "";
  DZ.anim.frames.forEach((f, i) => {
    const c = document.createElement("div");
    c.className = "tl-frame" + (i === DZ.anim.idx ? " cur" : "");
    c.innerHTML = '<span class="tl-n">' + (i + 1) + "</span>";
    c.title = f.split(/[\\/]/).pop();
    c.onclick = () => dzGoFrame(i);
    box.appendChild(c);
    dzThumbInto(c, f, i);       // miniatura async (no bloquea la barra)
  });
  $("#tlInfo").textContent = DZ.anim.frames.length + " cuadro(s)";
  dzTimelineBadges();
  dzSbFrame();
  dzXsRender();
}
/* miniatura del cuadro dentro del chip de la timeline (estilo X-sheet) */
async function dzThumbInto(chip, f, i) {
  let txt = DZ.anim && DZ.anim.cache[f];
  if (!txt) {
    if (i === DZ.anim.idx) {                        // el actual: lo que se ve en vivo
      const svg = $("#dzCanvas").querySelector("svg");
      if (svg) txt = dzSerialize(svg);
    } else {
      const r = await api.image_data(f);
      txt = r && r.svg;
    }
    if (DZ.anim && txt) DZ.anim.cache[f] = txt;
  }
  if (!txt || !chip.isConnected) return;
  const tmp = document.createElement("div"); tmp.innerHTML = txt;
  const svg = tmp.querySelector("svg");
  if (!svg) return;
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const th = document.createElement("div");
  th.className = "tl-thumb"; th.appendChild(svg);
  chip.insertBefore(th, chip.firstChild);
}

/* ══ insertar cuadro DESPUÉS del actual (⎀) — Shift: en blanco ══ */
async function dzFrameInsert(blank) {
  if (!DZ.anim) return;
  await dzPersist();
  let content = null;
  if (blank) {
    // cuadro en blanco: conservar SOLO el fondo (el rect que cubre el lienzo)
    const svg = $("#dzCanvas").querySelector("svg");
    if (svg) {
      const c = svg.cloneNode(true);
      const vb = (c.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
      const area = (vb[2] || 1) * (vb[3] || 1);
      [...c.children].forEach(n => {
        const t = n.tagName.toLowerCase();
        if (t === "defs" || t === "style") return;
        const isBg = t === "rect" &&
          ((+n.getAttribute("width") || 0) * (+n.getAttribute("height") || 0)) >= area * 0.9;
        if (!isBg) n.remove();
      });
      c.classList.remove("dz-sel");
      content = c.outerHTML;
    }
  }
  const r = await api.insert_frame(DZ.path, content);
  if (r && r.error) return sysMsg("❌ " + r.error);
  DZ.anim.cache = {};                                // los números se corrieron
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
  await openDesign(r.path);
  $("#dzTimeline").hidden = false;
  await dzTimelineRefresh();
  dzOnionUpdate();
}

/* ══ 🪄 intercalado: genera el cuadro intermedio entre el actual y el
   siguiente interpolando los elementos que coinciden (por orden y tipo):
   posición, tamaño, colores, opacidad, transform y trazados compatibles ══ */
function dzLerp(a, b, t) { return a + (b - a) * t; }
function dzLerpColor(a, b, t) {
  const pa = dzHex(a), pb = dzHex(b);
  if (!pa || !pb) return t < 0.5 ? a : b;
  const na = parseInt(pa.slice(1), 16), nb = parseInt(pb.slice(1), 16);
  const r = Math.round(dzLerp(na >> 16, nb >> 16, t));
  const g = Math.round(dzLerp((na >> 8) & 255, (nb >> 8) & 255, t));
  const bl = Math.round(dzLerp(na & 255, nb & 255, t));
  return "#" + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
}
/* interpola dos strings numéricos con la MISMA estructura (d de path, points,
   transform): si los no-números difieren, devuelve null */
function dzLerpNums(a, b, t) {
  const rx = /-?[\d.]+(?:e-?\d+)?/g;
  if (a.replace(rx, "#") !== b.replace(rx, "#")) return null;
  const nb = (b.match(rx) || []).map(Number);
  let i = 0;
  return a.replace(rx, (m) => {
    const v = dzLerp(parseFloat(m), nb[i++], t);
    return String(Math.round(v * 100) / 100);
  });
}
const DZ_TWEEN_NUM = ["x", "y", "cx", "cy", "r", "rx", "ry", "width", "height",
                      "x1", "y1", "x2", "y2", "font-size", "stroke-width", "opacity"];
const DZ_TWEEN_COL = ["fill", "stroke"];
const DZ_TWEEN_STR = ["d", "points", "transform"];
function dzTweenEl(a, b, t) {
  const out = a.cloneNode(true);
  DZ_TWEEN_NUM.forEach(k => {
    const va = a.getAttribute(k), vb = b.getAttribute(k);
    if (va !== null && vb !== null && va !== vb)
      out.setAttribute(k, String(Math.round(dzLerp(parseFloat(va), parseFloat(vb), t) * 100) / 100));
  });
  DZ_TWEEN_COL.forEach(k => {
    const va = a.getAttribute(k), vb = b.getAttribute(k);
    if (va && vb && va !== vb) out.setAttribute(k, dzLerpColor(va, vb, t));
  });
  DZ_TWEEN_STR.forEach(k => {
    const va = a.getAttribute(k), vb = b.getAttribute(k);
    if (va && vb && va !== vb) {
      const v = dzLerpNums(va, vb, t);
      if (v) out.setAttribute(k, v);
    }
  });
  // recursivo en hijos que coinciden (grupos, brush)
  const ka = [...out.children], kb = [...b.children];
  for (let i = 0; i < Math.min(ka.length, kb.length); i++)
    if (ka[i].tagName === kb[i].tagName)
      ka[i].replaceWith(dzTweenEl(ka[i], kb[i], t));
  return out;
}
/* construye el SVG interpolado entre el cuadro actual (A) y el siguiente (B)
   en el instante t (0..1). Devuelve {svg, matched} o null. */
function dzTweenBuild(svgA, svgB, t) {
  const ca = [...svgA.children].filter(n => !DZ_SKIP_TAGS.includes(n.tagName.toLowerCase())
    && !(n.classList && n.classList.contains("dz-onion")));
  const cb = [...svgB.children].filter(n => !DZ_SKIP_TAGS.includes(n.tagName.toLowerCase()));
  const mid = svgA.cloneNode(false);
  [...svgA.children].forEach(n => {
    if (DZ_SKIP_TAGS.includes(n.tagName.toLowerCase())) mid.appendChild(n.cloneNode(true));
  });
  let matched = 0;
  for (let i = 0; i < ca.length; i++) {
    if (cb[i] && cb[i].tagName === ca[i].tagName) { mid.appendChild(dzTweenEl(ca[i], cb[i], t)); matched++; }
    else mid.appendChild(ca[i].cloneNode(true));    // sin par: queda como en A
  }
  mid.classList.remove("dz-sel");
  return { svg: mid.outerHTML.replace(/ class=""/g, ""), matched };
}
/* 🪄 modal: cuántos intermedios y con qué curva (interpolación de OpenToonz) */
function dzTweenModal() {
  if (!DZ.anim) return;
  if (!DZ.anim.frames[DZ.anim.idx + 1])
    return sysMsg("🪄 No hay cuadro siguiente — el intercalado va ENTRE dos cuadros (pará en el primero de los dos)");
  openModal(`<h2>🪄 Intercalar</h2>
    <div class="sub">Genera cuadros intermedios entre ESTE cuadro y el siguiente,
    interpolando posición, tamaño, color y trazados de los elementos que coinciden.</div>
    <div class="dz-style-row">
      <span class="dz-hint">Cantidad</span>
      <input type="number" id="twN" class="dz-win" value="1" min="1" max="8">
      <span class="dz-hint">Curva</span>
      <select id="twEase" class="langsel">
        <option value="linear">Lineal (ritmo parejo)</option>
        <option value="in">Ease in (arranca lento)</option>
        <option value="out">Ease out (frena suave)</option>
        <option value="inout" selected>Ease in-out (natural)</option>
      </select>
    </div>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="twGo">🪄 Intercalar</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#twGo").onclick = () => {
    const n = Math.max(1, Math.min(8, +$("#twN").value || 1));
    const ease = $("#twEase").value;
    closeModal();
    dzTweenRun(n, ease);
  };
}
async function dzTweenRun(n, ease) {
  await dzPersist();
  const next = DZ.anim.frames[DZ.anim.idx + 1];
  const svgA = $("#dzCanvas").querySelector("svg");
  const rb = await api.image_data(next);
  if (!svgA || !rb || !rb.svg) return sysMsg("❌ No pude leer los dos cuadros");
  const tmp = document.createElement("div"); tmp.innerHTML = rb.svg;
  const svgB = tmp.querySelector("svg");
  if (!svgB) return sysMsg("❌ El cuadro siguiente no tiene SVG válido");
  const fn = DZ_EASES[ease] || DZ_EASES.inout;
  // insertar en orden INVERSO: cada insert va justo después del cuadro actual,
  // así el último insertado (t más chico) queda primero
  let matched = 0, made = 0;
  dzSetStatus("🪄 Generando " + n + " intermedio(s)…");
  for (let k = n; k >= 1; k--) {
    const t = fn(k / (n + 1));
    const b = dzTweenBuild(svgA, svgB, t);
    if (!b) break;
    matched = b.matched;
    const r = await api.insert_frame(DZ.path, b.svg);
    if (r && r.error) return dzSetStatus("❌ " + r.error);
    made++;
  }
  DZ.anim.cache = {};
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
  await dzTimelineRefresh();
  dzOnionUpdate();
  dzTimelineBadges();
  dzSetStatus("🪄 " + made + " cuadro(s) intermedio(s) creados (" + matched +
    " elementos interpolados, curva " + ease + "). El papel cebolla te muestra cómo quedó el arco.");
}

/* ══ 🎬 exportar la animación: GIF / secuencia PNG / spritesheet ══ */
function dzSvgToPng(svgText, maxPx) {
  return new Promise((resolve) => {
    let s = svgText;
    if (!/<svg[^>]*\bwidth=/.test(s)) {
      const vb = /viewBox\s*=\s*["']([\d.\-\s]+)["']/.exec(s);
      if (vb) {
        const p = vb[1].trim().split(/\s+/);
        if (p.length === 4) s = s.replace(/<svg/, `<svg width="${p[2]}" height="${p[3]}"`);
      }
    }
    const blob = new Blob([s], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
        const scale = Math.min(1, (maxPx || 1080) / Math.max(w, h));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/png"));
      } catch (e) { resolve(null); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
function dzExportModal() {
  if (!DZ.anim || !DZ.anim.frames.length) return;
  openModal(`<h2>🎬 Exportar animación</h2>
    <div class="sub">${DZ.anim.frames.length} cuadros a ${$("#tlFps").value || 12} fps → carpeta export/ del proyecto.</div>
    <div class="m-actions" style="flex-wrap:wrap">
      <button class="primary" data-x="mp4">Video MP4</button>
      <button class="ghost" data-x="gif">GIF animado</button>
      <button class="ghost" data-x="png">Secuencia PNG</button>
      <button class="ghost" data-x="sheet">Spritesheet</button>
      <button class="ghost" id="mCancel">Cancelar</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  document.querySelectorAll("#modal [data-x]").forEach(b => b.onclick = () => { closeModal(); dzDoExport(b.dataset.x); });
}
async function dzDoExport(kind) {
  await dzPersist();
  const [lo, hi] = dzPlayRange();                // exporta solo el rango In/Out
  const frames = DZ.anim.frames.slice(lo, hi + 1);
  dzSetStatus("🎬 Rasterizando " + frames.length + " cuadros…");
  const pngs = [];
  const throughCam = dzHasCam();                 // hay claves de cámara → sale POR cámara
  for (let i = 0; i < frames.length; i++) {
    let txt = DZ.anim.cache[frames[i]];
    if (!txt) {
      const r = await api.image_data(frames[i]);
      txt = r && r.svg;
      if (txt) DZ.anim.cache[frames[i]] = txt;
    }
    if (!txt) continue;
    txt = dzRigView(txt, dzFrameNum(frames[i]));
    if (throughCam) txt = dzCamView(txt, dzCamAt(dzFrameNum(frames[i])));
    const du = await dzSvgToPng(txt, kind === "sheet" ? 512 : 1080);
    if (du) pngs.push(du);
    dzSetStatus(`🎬 Rasterizando${throughCam ? " por cámara 📹" : ""}… ${i + 1}/${frames.length}`);
  }
  if (!pngs.length) return dzSetStatus("❌ No pude rasterizar ningún cuadro");
  if (kind === "sheet") {
    // grilla ~cuadrada compuesta acá mismo en un canvas
    const imgs = await Promise.all(pngs.map(du => new Promise(res => {
      const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = du;
    })));
    const ok = imgs.filter(Boolean);
    const cols = Math.ceil(Math.sqrt(ok.length));
    const rows = Math.ceil(ok.length / cols);
    const fw = ok[0].naturalWidth, fh = ok[0].naturalHeight;
    const c = document.createElement("canvas"); c.width = cols * fw; c.height = rows * fh;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    ok.forEach((im, i) => ctx.drawImage(im, (i % cols) * fw, Math.floor(i / cols) * fh, fw, fh));
    const r = await api.export_anim(DZ.path, [c.toDataURL("image/png")], 12, "sheet");
    dzSetStatus(r && r.error ? "❌ " + r.error : "🎬 Spritesheet exportado (" + cols + "×" + rows + ") → " + ((r && r.path) || "export/"));
  } else {
    const fps = Math.max(1, Math.min(60, +$("#tlFps").value || 12));
    const label = { mp4: "🎬 Codificando MP4 con ffmpeg…", webm: "🎬 Codificando WebM…",
                    gif: "🎬 Armando el GIF…" }[kind] || "🎬 Guardando la secuencia…";
    dzSetStatus(label);
    const r = await api.export_anim(DZ.path, pngs, fps, kind);
    const done = { mp4: " (MP4 a " + fps + " fps)", webm: " (WebM a " + fps + " fps)",
                   gif: " (GIF a " + fps + " fps)" }[kind] || " (" + pngs.length + " PNGs)";
    dzSetStatus(r && r.error ? "❌ " + r.error : "🎬 Exportado → " + ((r && r.path) || "export/") + done);
  }
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
}
/* auto-guardado: los trazos del cuadro persisten SOLOS al cambiar de cuadro,
   reproducir, duplicar o hablar con el agente (flujo OpenToonz, sin diálogos) */
async function dzPersist() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg || !DZ.path || !DZ.dirty) return;
  const txt = dzSerialize(svg);
  try {
    await api.save_file(DZ.path, txt);
    DZ.dirty = false;
    if (DZ.anim) DZ.anim.cache[DZ.path] = txt;   // la cache/miniatura ve lo nuevo
    setStatus("💾 auto-guardado");
  } catch (e) { sysMsg("❌ auto-guardado falló: " + (e.message || e)); }
}

async function dzGoFrame(i) {
  if (!DZ.anim || !DZ.anim.frames[i]) return;
  await dzPersist();                             // el papel cebolla necesita el disco al día
  await openDesign(DZ.anim.frames[i]);
  // openDesign no conoce la animación: restaurar la barra y el estado
  DZ.anim.idx = i;
  $("#dzTimeline").hidden = false;
  await dzTimelineRefresh();
  dzOnionUpdate();
  if (DZ.rigMode) { dzRigApplyLive(dzRigCur()); dzRigPanelSync(); }
  dzCamOverlay();
}
async function dzFrameAdd() {
  if (!DZ.anim) return;
  await dzPersist();
  const r = await api.dup_frame(DZ.path);
  if (r && r.error) return sysMsg("❌ " + r.error);
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
  await openDesign(r.path);
  $("#dzTimeline").hidden = false;
  await dzTimelineRefresh();
  dzOnionUpdate();
}
/* papel cebolla estilo OpenToonz: cuadros fantasma con TINTE (rojos = los
   anteriores, verde = el siguiente), opacidad decreciente, dibujados ENCIMA
   (sin su fondo) para que se vean sobre cualquier lienzo. No editable. */
function dzOnionClear() {
  document.querySelectorAll("#dzCanvas svg g.dz-onion").forEach(n => n.remove());
}
function dzOnionGhost(svgText, tintId, rgb, opacity) {
  const tmp = document.createElement("div"); tmp.innerHTML = svgText;
  const psvg = tmp.querySelector("svg");
  if (!psvg) return null;
  // sacarle el fondo al fantasma: un rect que cubre ~todo el lienzo tapa el
  // cuadro actual — solo queremos las líneas/formas (como niveles de OpenToonz)
  const vb = (psvg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const area = (vb[2] || 1) * (vb[3] || 1);
  [...psvg.querySelectorAll("rect")].forEach(rc => {
    const a = (+rc.getAttribute("width") || 0) * (+rc.getAttribute("height") || 0);
    if (a >= area * 0.9) rc.remove();
  });
  const g = document.createElementNS(SVGNS, "g");
  g.setAttribute("class", "dz-onion");
  g.setAttribute("opacity", String(opacity));
  g.setAttribute("pointer-events", "none");
  // tinte duotono via filtro (vive DENTRO del grupo → se va con él al guardar)
  const f = document.createElementNS(SVGNS, "filter");
  f.setAttribute("id", tintId);
  f.innerHTML = `<feColorMatrix type="matrix" values="0.25 0.25 0.25 0 ${rgb[0]}  0.25 0.25 0.25 0 ${rgb[1]}  0.25 0.25 0.25 0 ${rgb[2]}  0 0 0 1 0"/>`;
  g.appendChild(f);
  const inner = document.createElementNS(SVGNS, "g");
  inner.setAttribute("filter", `url(#${tintId})`);
  [...psvg.children].forEach(n => inner.appendChild(n));
  g.appendChild(inner);
  return g;
}
/* configuración del papel cebolla (panel 🧅 flotante): cuadros antes/después,
   colores de tinte y opacidad — persistente entre sesiones */
function dzOnionCfg() {
  if (!DZ.onionCfg) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("fidel.dzonion") || "{}"); } catch (e) { /* */ }
    DZ.onionCfg = { before: 2, after: 1, alpha: 38,
                    colorB: "#8c0000", colorA: "#00731a", ...saved };
  }
  return DZ.onionCfg;
}
function dzOnionCfgSave() {
  try { localStorage.setItem("fidel.dzonion", JSON.stringify(DZ.onionCfg)); } catch (e) { /* */ }
}
function dzHexToRgbF(hex) {
  const n = parseInt((dzHex(hex) || "#888888").slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
let ONION_RUN = 0;   // token anti-carrera: navegar rápido no duplica fantasmas
async function dzOnionUpdate() {
  const run = ++ONION_RUN;
  dzOnionClear();
  if (!DZ.anim || !DZ.anim.onion) return;
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  const cfg = dzOnionCfg();
  const rgbB = dzHexToRgbF(cfg.colorB), rgbA = dzHexToRgbF(cfg.colorA);
  const base = (cfg.alpha || 38) / 100;
  const jobs = [];
  for (let k = 1; k <= (cfg.before || 0); k++)   // anteriores, cada vez más tenues
    if (DZ.anim.frames[DZ.anim.idx - k])
      jobs.push({ f: DZ.anim.frames[DZ.anim.idx - k], rgb: rgbB, op: base / k, id: "dzTintP" + k });
  for (let k = 1; k <= (cfg.after || 0); k++)    // siguientes
    if (DZ.anim.frames[DZ.anim.idx + k])
      jobs.push({ f: DZ.anim.frames[DZ.anim.idx + k], rgb: rgbA, op: base * 0.8 / k, id: "dzTintN" + k });
  for (const j of jobs) {
    const r = await api.image_data(j.f);
    if (run !== ONION_RUN) return;              // vino una pasada más nueva: abortar
    if (!r || !r.svg) continue;
    const g = dzOnionGhost(r.svg, j.id, j.rgb, j.op);
    if (g) svg.appendChild(g);                  // ENCIMA del cuadro actual
  }
}
/* ══ CÁMARA + ESCENA (estilo Toon Boom/OpenToonz) ═══════════════════════
   La escena vive en <base>_escena.json: claves de cámara por cuadro
   (posición/zoom/rotación), fotogramas clave de dibujo y curva de easing.
   La cámara se edita como un encuadre naranja sobre el lienzo (auto-key:
   moverla en un cuadro deja clave ahí). El play y el export salen POR la
   cámara, con multiplano: elementos con data-z se mueven en parallax. ══ */
const DZ_EASES = {
  linear: t => t,
  in: t => t * t,
  out: t => t * (2 - t),
  inout: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
};
function dzFrameNum(path) {
  const m = /_f(\d{3})\.svg$/i.exec(path || "");
  return m ? parseInt(m[1], 10) : 1;
}
function dzSceneSave() {
  if (DZ.path && DZ.scene) api.scene_save(DZ.path, DZ.scene);
}
function dzVB() {
  const svg = $("#dzCanvas").querySelector("svg");
  return ((svg && svg.getAttribute("viewBox")) || "0 0 1080 1080").split(/\s+/).map(Number);
}
function dzCamDefault() {
  const vb = dzVB();
  return { cx: vb[0] + vb[2] / 2, cy: vb[1] + vb[3] / 2, w: vb[2], rot: 0 };
}
/* cámara interpolada en el cuadro `num` (entre claves, con la curva elegida) */
function dzCamAt(num) {
  const cams = (DZ.scene && DZ.scene.cam) || {};
  const ks = Object.keys(cams).map(Number).sort((a, b) => a - b);
  if (!ks.length) return dzCamDefault();
  if (cams[num]) return { ...cams[num] };
  let k1 = ks[0], k2 = ks[ks.length - 1];
  if (num <= k1) return { ...cams[k1] };
  if (num >= k2) return { ...cams[k2] };
  for (const k of ks) { if (k <= num) k1 = k; else { k2 = k; break; } }
  const t = (DZ_EASES[(DZ.scene && DZ.scene.ease) || "inout"] || DZ_EASES.inout)((num - k1) / (k2 - k1));
  const a = cams[k1], b = cams[k2];
  return { cx: dzLerp(a.cx, b.cx, t), cy: dzLerp(a.cy, b.cy, t),
           w: dzLerp(a.w, b.w, t), rot: dzLerp(a.rot || 0, b.rot || 0, t) };
}
/* vista POR la cámara: recorta al encuadre (viewBox), aplica la rotación y
   el parallax multiplano de los elementos con data-z (z>0 lejos, z<0 cerca) */
function dzCamView(svgText, cam) {
  const tmp = document.createElement("div"); tmp.innerHTML = svgText;
  const svg = tmp.querySelector("svg");
  if (!svg) return svgText;
  const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const vbcx = vb[0] + vb[2] / 2, vbcy = vb[1] + vb[3] / 2;
  const h = cam.w * (vb[3] / vb[2]);
  const NS = "http://www.w3.org/2000/svg";
  const out = document.createElementNS(NS, "svg");
  out.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  out.setAttribute("viewBox", `${(cam.cx - cam.w / 2).toFixed(1)} ${(cam.cy - h / 2).toFixed(1)} ${cam.w.toFixed(1)} ${h.toFixed(1)}`);
  out.setAttribute("width", Math.round(vb[2])); out.setAttribute("height", Math.round(vb[3]));
  const g = document.createElementNS(NS, "g");
  if (cam.rot) g.setAttribute("transform", `rotate(${(-cam.rot).toFixed(2)} ${cam.cx.toFixed(1)} ${cam.cy.toFixed(1)})`);
  [...svg.children].forEach(n => {
    if (n.classList && n.classList.contains("dz-onion")) return;
    const z = Math.max(-60, Math.min(400, parseFloat(n.getAttribute && n.getAttribute("data-z")) || 0));
    if (z) {
      // multiplano: lo lejano acompaña a la cámara (se mueve menos en pantalla)
      const p = 100 / (100 + z);
      const dx = (cam.cx - vbcx) * (1 - p), dy = (cam.cy - vbcy) * (1 - p);
      const w = document.createElementNS(NS, "g");
      w.setAttribute("transform", `translate(${dx.toFixed(1)} ${dy.toFixed(1)})`);
      w.appendChild(n.cloneNode(true));
      g.appendChild(w);
    } else g.appendChild(n.cloneNode(true));
  });
  out.appendChild(g);
  return out.outerHTML;
}
function dzHasCam() { return !!(DZ.scene && DZ.scene.cam && Object.keys(DZ.scene.cam).length); }

/* ── overlay del encuadre: arrastrar = mover · esquina = zoom · ⟳ = rotar ──
   AUTO-KEY: cualquier edición deja una clave de cámara en el cuadro actual. */
function dzCamToggle() {
  DZ.camMode = !DZ.camMode;
  $("#dzCamBtn").classList.toggle("active", DZ.camMode);
  $("#tlCamKey").hidden = !DZ.camMode;
  if (DZ.camMode && !DZ.anim) { dzAnimToggle(); }   // la cámara vive en la timeline
  dzCamOverlay();
  dzSetStatus(DZ.camMode ?
    "📹 Cámara: arrastrá el encuadre (mover), la esquina (zoom), ⟳ (rotar) — cada cambio deja CLAVE en este cuadro. El play y el export salen por acá." : "");
}
function dzCamCur() { return DZ.camDrag || dzCamAt(dzFrameNum(DZ.path)); }
function dzCamOverlay() {
  const box = $("#dzCam");
  if (!DZ.camMode || !DZ.path || !$("#dzCanvas").querySelector("svg")) { box.hidden = true; return; }
  const cam = dzCamCur();
  const vb = dzVB();
  const h = cam.w * (vb[3] / vb[2]);
  const c = dzToScreen(cam.cx, cam.cy);
  const e1 = dzToScreen(cam.cx - cam.w / 2, cam.cy), e2 = dzToScreen(cam.cx + cam.w / 2, cam.cy);
  const t1 = dzToScreen(cam.cx, cam.cy - h / 2), t2 = dzToScreen(cam.cx, cam.cy + h / 2);
  const pw = Math.hypot(e2.x - e1.x, e2.y - e1.y), ph = Math.hypot(t2.x - t1.x, t2.y - t1.y);
  box.style.width = pw + "px"; box.style.height = ph + "px";
  box.style.left = (c.x - pw / 2) + "px"; box.style.top = (c.y - ph / 2) + "px";
  box.style.transform = `rotate(${cam.rot || 0}deg)`;
  const num = dzFrameNum(DZ.path);
  $("#dzCamTag").textContent = "📹 cámara · cuadro " + num +
    (DZ.scene && DZ.scene.cam && DZ.scene.cam[num] ? " 🔑" : " (interpolada)");
  box.hidden = false;
}
function dzCamSetKey(cam) {
  DZ.scene = DZ.scene || {};
  DZ.scene.cam = DZ.scene.cam || {};
  DZ.scene.cam[dzFrameNum(DZ.path)] = {
    cx: Math.round(cam.cx * 10) / 10, cy: Math.round(cam.cy * 10) / 10,
    w: Math.round(cam.w * 10) / 10, rot: Math.round((cam.rot || 0) * 10) / 10 };
  dzSceneSave(); dzCamOverlay(); dzTimelineBadges();
}
function dzCamKeyToggle() {
  if (!DZ.camMode) return;
  DZ.scene = DZ.scene || {}; DZ.scene.cam = DZ.scene.cam || {};
  const num = dzFrameNum(DZ.path);
  if (DZ.scene.cam[num]) {
    delete DZ.scene.cam[num];
    dzSetStatus("📹 Clave de cámara del cuadro " + num + " borrada");
  } else {
    DZ.scene.cam[num] = dzCamCur();
    dzSetStatus("📹🔑 Clave de cámara en el cuadro " + num);
  }
  dzSceneSave(); dzCamOverlay(); dzTimelineBadges();
}
/* ── interacción de cámara — v2, predecible ──────────────────────────────
   Durante el arrastre se muestra un PREVIEW en vivo (DZ.camDrag) SIN tocar la
   escena; recién al SOLTAR se deja UNA sola clave en el cuadro. Antes cada
   micro-movimiento clavaba un keyframe (comportamiento impredecible), y un
   simple clic sin mover dejaba una clave. Ahora un clic no clava nada. */
function dzCamCommit() {
  if (DZ.camDrag) { dzCamSetKey(DZ.camDrag); DZ.camDrag = null; }
}
function dzCamDrag(e) {
  if (e.target.id === "dzCamSize" || e.target.id === "dzCamRot") return;
  e.preventDefault(); e.stopPropagation();
  const cam0 = dzCamAt(dzFrameNum(DZ.path));
  const start = dzToUser(e.clientX, e.clientY);
  const move = (ev) => {
    const p = dzToUser(ev.clientX, ev.clientY);
    let dx = p.x - start.x, dy = p.y - start.y;
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }  // recto
    DZ.camDrag = { ...cam0, cx: Math.round((cam0.cx + dx) * 10) / 10, cy: Math.round((cam0.cy + dy) * 10) / 10 };
    dzCamOverlay();
  };
  const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); dzCamCommit(); };
  document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
}
function dzCamResize(e) {
  e.preventDefault(); e.stopPropagation();
  const cam0 = dzCamAt(dzFrameNum(DZ.path));
  const start = dzToUser(e.clientX, e.clientY);
  // zoom proporcional a la distancia al centro (alejar la esquina = achicar zoom)
  const d0 = Math.max(1, Math.hypot(start.x - cam0.cx, start.y - cam0.cy));
  const move = (ev) => {
    const p = dzToUser(ev.clientX, ev.clientY);
    const d = Math.hypot(p.x - cam0.cx, p.y - cam0.cy);
    const w = Math.max(40, Math.round(cam0.w * (d / d0) * 10) / 10);
    DZ.camDrag = { ...cam0, w };
    dzCamOverlay();
    const vb = dzVB();
    dzSetStatus("📹 zoom " + Math.round(vb[2] / w * 100) + "% del encuadre");
  };
  const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); dzCamCommit(); dzSetStatus(""); };
  document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
}
function dzCamRotate(e) {
  e.preventDefault(); e.stopPropagation();
  const cam0 = dzCamAt(dzFrameNum(DZ.path));
  const c = dzToScreen(cam0.cx, cam0.cy);
  const cv = $("#dzCanvas").getBoundingClientRect();
  const a0 = Math.atan2(e.clientY - cv.top - c.y, e.clientX - cv.left - c.x);
  const move = (ev) => {
    let deg = (cam0.rot || 0) + (Math.atan2(ev.clientY - cv.top - c.y, ev.clientX - cv.left - c.x) - a0) * 180 / Math.PI;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    DZ.camDrag = { ...cam0, rot: Math.round(deg * 10) / 10 };
    dzCamOverlay();
    dzSetStatus("📹 rotación " + Math.round(DZ.camDrag.rot) + "°");
  };
  const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); dzCamCommit(); dzSetStatus(""); };
  document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
}

/* ── fotogramas clave de dibujo (🔑) + badges del X-sheet ── */
function dzKeyToggle() {
  if (!DZ.anim) return;
  DZ.scene = DZ.scene || {};
  const keys = DZ.scene.keys = DZ.scene.keys || [];
  const num = dzFrameNum(DZ.path);
  const i = keys.indexOf(num);
  if (i >= 0) { keys.splice(i, 1); dzSetStatus("Cuadro " + num + " ya no es clave"); }
  else { keys.push(num); keys.sort((a, b) => a - b); dzSetStatus("🔑 Cuadro " + num + " marcado como FOTOGRAMA CLAVE"); }
  dzSceneSave(); dzTimelineBadges();
}
function dzTimelineBadges() {
  if (!DZ.anim) return;
  const keys = (DZ.scene && DZ.scene.keys) || [];
  const cams = (DZ.scene && DZ.scene.cam) || {};
  document.querySelectorAll("#tlFrames .tl-frame").forEach((c, i) => {
    c.querySelectorAll(".tl-key").forEach(n => n.remove());
    const num = dzFrameNum(DZ.anim.frames[i]);
    const rig = (DZ.scene && DZ.scene.rig) || {};
    const hasRig = Object.keys(rig).some(id => rig[id] && rig[id][num]);
    let badge = (keys.includes(num) ? "🔑" : "") + (cams[num] ? "📹" : "") + (hasRig ? "◆" : "");
    if (badge) {
      const b = document.createElement("span");
      b.className = "tl-key"; b.textContent = badge;
      c.appendChild(b);
    }
  });
}


/* ══ RIG: claves de transformación por PIEZA (pegs de Toon Boom / AE) ══════
   DZ.scene.rig = { id: { cuadro: {x,y,r,s} } } — vive en la escena junto a
   las claves de cámara y comparte su curva de easing. La pose interpolada se
   aplica ENCIMA del dibujo (nunca se hornea en el archivo): el transform
   original se preserva en data-rigbase y se restaura al serializar. */
function dzRigCur() {
  return (DZ.anim && DZ.anim.frames[DZ.anim.idx]) ? dzFrameNum(DZ.anim.frames[DZ.anim.idx]) : 1;
}
function dzRigAt(id, num) {
  const trk = ((DZ.scene || {}).rig || {})[id];
  if (!trk) return null;
  const ks = Object.keys(trk).map(Number).sort((a, b) => a - b);
  if (!ks.length) return null;
  if (trk[num]) return { ...trk[num] };
  if (num <= ks[0]) return { ...trk[ks[0]] };
  if (num >= ks[ks.length - 1]) return { ...trk[ks[ks.length - 1]] };
  let k1 = ks[0], k2 = ks[ks.length - 1];
  for (const k of ks) { if (k <= num) k1 = k; else { k2 = k; break; } }
  const t = (DZ_EASES[(DZ.scene && DZ.scene.ease) || "inout"] || DZ_EASES.inout)((num - k1) / (k2 - k1));
  const a = trk[k1], b = trk[k2];
  return { x: dzLerp(a.x, b.x, t), y: dzLerp(a.y, b.y, t),
           r: dzLerp(a.r || 0, b.r || 0, t), s: dzLerp(a.s == null ? 1 : a.s, b.s == null ? 1 : b.s, t) };
}
function dzRigPivotOf(el) {
  const pv = el.getAttribute && el.getAttribute("data-pivot");
  if (pv) { const p = pv.split(/\s+/).map(Number); return { x: p[0], y: p[1] }; }
  try { const b = el.getBBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
  catch (e) { return { x: 0, y: 0 }; }
}
function dzRigChunk(el, k) {
  const pv = dzRigPivotOf(el);
  let t = "";
  if (k.x || k.y) t += `translate(${k.x.toFixed(1)} ${k.y.toFixed(1)}) `;
  if (k.r) t += `rotate(${k.r.toFixed(2)} ${pv.x.toFixed(1)} ${pv.y.toFixed(1)}) `;
  const s = k.s == null ? 1 : k.s;
  if (Math.abs(s - 1) > 0.001)
    t += `translate(${pv.x.toFixed(1)} ${pv.y.toFixed(1)}) scale(${s.toFixed(3)}) translate(${(-pv.x).toFixed(1)} ${(-pv.y).toFixed(1)}) `;
  return t.trim();
}
function dzRigApplyTo(el, k) {
  if (!el.hasAttribute("data-rigbase"))
    el.setAttribute("data-rigbase", el.getAttribute("transform") || "");
  const base = el.getAttribute("data-rigbase");
  const chunk = dzRigChunk(el, k);
  if (chunk) el.setAttribute("transform", chunk + (base ? " " + base : ""));
  else if (base) el.setAttribute("transform", base);
  else el.removeAttribute("transform");
}
function dzRigStrip(root) {
  (root || document).querySelectorAll("[data-rigbase]").forEach(n => {
    const b = n.getAttribute("data-rigbase");
    if (b) n.setAttribute("transform", b); else n.removeAttribute("transform");
    n.removeAttribute("data-rigbase");
  });
}
/* aplica las poses interpoladas de TODAS las piezas con claves, en el lienzo vivo */
function dzRigApplyLive(num) {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  dzRigStrip(svg);
  const rig = (DZ.scene || {}).rig || {};
  for (const id of Object.keys(rig)) {
    const el = svg.querySelector('[id="' + id.replace(/"/g, '') + '"]');
    if (!el) continue;
    const k = dzRigAt(id, num);
    if (k) dzRigApplyTo(el, k);
  }
  dzPositionHandle();
}
/* versión para reproducción/export: sobre el TEXTO del cuadro */
function dzRigView(svgText, num) {
  const rig = (DZ.scene || {}).rig || {};
  const ids = Object.keys(rig);
  if (!ids.length) return svgText;
  const tmp = document.createElement("div"); tmp.innerHTML = svgText;
  const svg = tmp.querySelector("svg");
  if (!svg) return svgText;
  for (const id of ids) {
    const el = svg.querySelector('[id="' + id.replace(/"/g, '') + '"]');
    if (!el) continue;
    const k = dzRigAt(id, num);
    if (!k) continue;
    const chunk = dzRigChunk(el, k);
    if (!chunk) continue;
    const base = el.getAttribute("transform") || "";
    el.setAttribute("transform", chunk + (base ? " " + base : ""));
  }
  return svg.outerHTML;
}
function dzRigSetKey(id, num, k) {
  DZ.scene = DZ.scene || {};
  DZ.scene.rig = DZ.scene.rig || {};
  DZ.scene.rig[id] = DZ.scene.rig[id] || {};
  DZ.scene.rig[id][num] = { x: +k.x || 0, y: +k.y || 0, r: +k.r || 0, s: k.s == null ? 1 : +k.s };
  dzSceneSave(); dzTimelineBadges(); dzRigPanelSync();
}
function dzRigDelKey(id, num) {
  const trk = ((DZ.scene || {}).rig || {})[id];
  if (!trk || !trk[num]) return;
  delete trk[num];
  if (!Object.keys(trk).length) delete DZ.scene.rig[id];
  dzSceneSave(); dzTimelineBadges(); dzRigApplyLive(dzRigCur()); dzRigPanelSync();
}
/* ── panel: refleja la pieza seleccionada y su pose en el cuadro actual ── */
function dzRigPanelSync() {
  if ($("#dzRigPanel").hidden) return;
  const el = DZ.sel, num = dzRigCur();
  $("#rigId").value = (el && el.id) || "";
  $("#rigId").placeholder = el ? (el.id ? el.id : "sin nombre — escribí uno y Enter") : "seleccioná una pieza (D)";
  const k = (el && el.id && dzRigAt(el.id, num)) || { x: 0, y: 0, r: 0, s: 1 };
  $("#rigX").value = Math.round(k.x); $("#rigY").value = Math.round(k.y);
  $("#rigR").value = Math.round(k.r * 10) / 10; $("#rigS").value = Math.round((k.s == null ? 1 : k.s) * 100) / 100;
  const chips = $("#rigChips");
  chips.innerHTML = "";
  const trk = (el && el.id && ((DZ.scene || {}).rig || {})[el.id]) || {};
  Object.keys(trk).map(Number).sort((a, b) => a - b).forEach(n => {
    const c = document.createElement("span");
    c.className = "dz-chip" + (n === num ? " on" : "");
    c.textContent = "◆ " + n;
    c.title = "Ir al cuadro " + n + " · Alt+clic: borrar la clave";
    c.onclick = (e) => {
      if (e.altKey) { dzRigDelKey(el.id, n); return; }
      const i = DZ.anim ? DZ.anim.frames.findIndex(f => dzFrameNum(f) === n) : -1;
      if (i >= 0) dzGoFrame(i);
    };
    chips.appendChild(c);
  });
}
function dzRigReadPanel() {
  return { x: +$("#rigX").value || 0, y: +$("#rigY").value || 0,
           r: +$("#rigR").value || 0, s: +$("#rigS").value || 1 };
}
function dzRigToggle() {
  if (!DZ.anim) { sysMsg("◆ Abrí la animación (🎞) primero — el rig anima entre cuadros."); return; }
  DZ.rigMode = !DZ.rigMode;
  $("#dzRigBtn").classList.toggle("active", DZ.rigMode);
  $("#dzRigPanel").hidden = !DZ.rigMode;
  if (DZ.rigMode) {
    dzRigApplyLive(dzRigCur()); dzRigPanelSync();
    dzSetStatus("◆ Rig: seleccioná una pieza (flecha blanca D), nombrala, posala (arrastrar/panel) y clavá con K");
  } else {
    dzRigStrip($("#dzCanvas").querySelector("svg"));
  }
}


/* ══ 🎥 ACTUACIÓN — titiritero digital (Momo/motion-sketch) ═══════════════
   Marcás el lapso, ⏺, y ACTUÁS el movimiento arrastrando la pieza en vivo
   (Shift = rotarla desde su pivote, como el bastón del títere). Las pasadas
   anteriores SE REPRODUCEN mientras grabás la nueva — animación por capas,
   una pieza por toma. Al cortar, la actuación se vuelve claves de rig. */
function dzPerfFps() { return Math.max(1, Math.min(60, +($("#tlFps") && $("#tlFps").value) || 12)); }
function dzPerfDur() { return Math.max(0.5, Math.min(30, +($("#perfDur") && $("#perfDur").value) || 3)); }

function dzPerfRec() {
  if (DZ.perf && DZ.perf.rec) { dzPerfRecEnd(true); return; }   // cortar antes
  if (!DZ.rigMode) return dzSetStatus("🎥 Activá el modo rig (◆) primero");
  if (!DZ.scene) DZ.scene = {};
  let n = 3;
  $("#perfRec").classList.add("rec");
  dzSetStatus("🎥 " + n + "…");
  const cd = setInterval(() => {
    n--;
    if (n > 0) { dzSetStatus("🎥 " + n + "…"); return; }
    clearInterval(cd);
    const dur = dzPerfDur(), fps = dzPerfFps();
    DZ.perf = { rec: { t0: performance.now(), dur, fps, take: {}, active: null } };
    const loop = () => {
      if (!DZ.perf || !DZ.perf.rec) return;
      const t = (performance.now() - DZ.perf.rec.t0) / 1000;
      if (t >= dur) { dzPerfRecEnd(); return; }
      // replay de las pistas ya grabadas (menos la pieza que estás actuando)
      const num = 1 + t * fps;
      const svg = $("#dzCanvas").querySelector("svg");
      const rig = (DZ.scene || {}).rig || {};
      for (const id of Object.keys(rig)) {
        if (id === DZ.perf.rec.active) continue;
        const el2 = svg && svg.querySelector('[id="' + id.replace(/"/g, '') + '"]');
        const k = el2 && dzRigAt(id, num);
        if (k) dzRigApplyTo(el2, k);
      }
      dzSetStatus("⏺ " + t.toFixed(1) + " / " + dur + "s — ¡actuá! (arrastrá la pieza · Shift rota)");
      DZ.perf.rec.raf = requestAnimationFrame(loop);
    };
    DZ.perf.rec.raf = requestAnimationFrame(loop);
  }, 700);
}
function dzPerfRecEnd(early) {
  const rec = DZ.perf && DZ.perf.rec;
  if (!rec) return;
  cancelAnimationFrame(rec.raf);
  DZ.perf = null;
  $("#perfRec").classList.remove("rec");
  const ids = Object.keys(rec.take).filter(id => rec.take[id].length > 1);
  if (!ids.length) { dzSetStatus("🎥 Toma vacía — no moviste ninguna pieza. ⏺ y arrastrá durante la cuenta."); return; }
  // remuestrear la actuación a una clave por cuadro del lapso
  const N = Math.max(2, Math.round(rec.dur * rec.fps));
  for (const id of ids) {
    const ss = rec.take[id];
    DZ.scene.rig = DZ.scene.rig || {};
    DZ.scene.rig[id] = DZ.scene.rig[id] || {};
    for (let f = 1; f <= N + 1; f++) {
      const tf = (f - 1) / rec.fps;
      let a = ss[0], b = ss[ss.length - 1];
      if (tf <= a.t) b = a;
      else if (tf >= b.t) a = b;
      else for (let i = 0; i < ss.length - 1; i++)
        if (ss[i].t <= tf && ss[i + 1].t >= tf) { a = ss[i]; b = ss[i + 1]; break; }
      const u = (b.t === a.t) ? 0 : (tf - a.t) / (b.t - a.t);
      DZ.scene.rig[id][f] = {
        x: Math.round(dzLerp(a.x, b.x, u) * 10) / 10,
        y: Math.round(dzLerp(a.y, b.y, u) * 10) / 10,
        r: Math.round(dzLerp(a.r || 0, b.r || 0, u) * 10) / 10,
        s: a.s == null ? 1 : a.s,
      };
    }
  }
  dzSceneSave(); dzTimelineBadges(); dzRigPanelSync();
  dzSetStatus("🎥 Toma lista: " + ids.join(", ") + " (" + N + " claves). Otra ⏺ suma la próxima pieza. ▶ para verla.");
  dzPerfPlay();
}
/* reproducir la actuación completa (reloj virtual, claves fraccionales) */
function dzPerfPlay() {
  if (DZ.perfPlaying) { DZ.perfPlaying = false; return; }
  const dur = dzPerfDur(), fps = dzPerfFps();
  DZ.perfPlaying = true;
  const t0 = performance.now();
  const loop = () => {
    if (!DZ.perfPlaying) { dzRigApplyLive(dzRigCur()); return; }
    const t = (performance.now() - t0) / 1000;
    if (t >= dur) { DZ.perfPlaying = false; dzRigApplyLive(dzRigCur()); dzSetStatus("🎥 fin de la actuación"); return; }
    dzRigApplyLive(1 + t * fps);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
/* ✨ suavizado: promedio móvil sobre las claves — saca el temblor del pulso */
function dzPerfSmooth() {
  const rig = (DZ.scene || {}).rig || {};
  let done = 0;
  for (const id of Object.keys(rig)) {
    const ks = Object.keys(rig[id]).map(Number).sort((a, b) => a - b);
    if (ks.length < 3) continue;
    const orig = ks.map(k => ({ ...rig[id][k] }));
    for (let i = 1; i < ks.length - 1; i++) {
      const p = orig[i - 1], c = orig[i], nx = orig[i + 1];
      rig[id][ks[i]] = {
        x: Math.round((p.x + 2 * c.x + nx.x) / 4 * 10) / 10,
        y: Math.round((p.y + 2 * c.y + nx.y) / 4 * 10) / 10,
        r: Math.round(((p.r || 0) + 2 * (c.r || 0) + (nx.r || 0)) / 4 * 10) / 10,
        s: c.s == null ? 1 : c.s,
      };
    }
    done++;
  }
  dzSceneSave(); dzRigApplyLive(dzRigCur()); dzRigPanelSync();
  dzSetStatus(done ? "✨ actuación suavizada (" + done + " pista(s)) — repetí para más suave" : "✨ no hay pistas para suavizar");
}
/* 🔥 generar los cuadros del lapso (mismo dibujo; el rig se aplica al exportar) */
async function dzPerfBake() {
  if (!DZ.anim) return dzSetStatus("🔥 Abrí la animación (🎞) primero");
  const N = Math.max(2, Math.round(dzPerfDur() * dzPerfFps()));
  if (N > 200) return dzSetStatus("🔥 Demasiados cuadros (" + N + ") — bajá duración o fps");
  await dzPersist();
  let cur = DZ.anim.frames.length;
  dzSetStatus("🔥 generando cuadros… (" + cur + "/" + N + ")");
  let last = DZ.anim.frames[DZ.anim.frames.length - 1];
  while (cur < N) {
    const r = await api.dup_frame(last);
    if (r && r.error) return dzSetStatus("🔥 " + r.error);
    last = r.path; cur++;
    if (cur % 6 === 0) dzSetStatus("🔥 generando cuadros… (" + cur + "/" + N + ")");
  }
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
  await dzTimelineRefresh();
  dzSetStatus("🔥 " + cur + " cuadros listos — la actuación sale en el export (GIF/video)");
}

/* ══ animación de ELEMENTOS (pegs de Toon Boom, versión LOW) ═══════════
   🏃 interpolación de movimiento: fijás inicio, movés el elemento al final
   y LOW genera los cuadros del recorrido con la curva elegida.
   ⏺ grabación en vivo: arrastrás el elemento y el recorrido REAL de tu mano
   (con sus tiempos) se convierte en cuadros — actuación en vivo. ══ */
function dzElPath(el) {
  // ruta de índices desde el svg raíz (las capas de UI van siempre al final,
  // así que los índices del contenido se mantienen entre vivo y serializado)
  const svg = $("#dzCanvas").querySelector("svg");
  const path = [];
  let n = el;
  while (n && n !== svg) {
    const p = n.parentNode;
    if (!p) return null;
    path.unshift([...p.children].indexOf(n));
    n = p;
  }
  return n === svg ? path : null;
}
function dzElAt(root, path) {
  let n = root;
  for (const i of path) { n = n.children[i]; if (!n) return null; }
  return n;
}
function dzPosDelta(a, b) {
  if (a.mode === "c") return [b.cx - a.cx, b.cy - a.cy];
  if (a.mode === "xy") return [b.x - a.x, b.y - a.y];
  return [b.tx - a.tx, b.ty - a.ty];
}
async function dzTweenFrames(baseSvgText, elPath, offsets) {
  // genera un cuadro por offset [dx,dy,rot] (en orden) insertándolos tras el actual
  // pivote de rotación: bbox del elemento VIVO — los clones no están montados y
  // getBBox() en un árbol desmontado devuelve 0×0 (giraría sobre el origen)
  let cx = 540, cy = 540;
  const live = dzElAt($("#dzCanvas").querySelector("svg"), elPath);
  if (live && live.getBBox) {
    try { const b = live.getBBox(); cx = b.x + b.width / 2; cy = b.y + b.height / 2; } catch (e) { /* sin render */ }
  }
  for (let k = offsets.length - 1; k >= 0; k--) {
    const tmp = document.createElement("div"); tmp.innerHTML = baseSvgText;
    const svg2 = tmp.querySelector("svg");
    const el2 = dzElAt(svg2, elPath);
    if (!el2) return "no encontré el elemento en el cuadro clonado";
    dzWritePos(el2, dzReadPos(el2), offsets[k][0], offsets[k][1]);
    if (offsets[k][2]) {
      const tr = el2.getAttribute("transform") || "";
      el2.setAttribute("transform", (tr ? tr + " " : "")
        + `rotate(${offsets[k][2]} ${cx + offsets[k][0]} ${cy + offsets[k][1]})`);
    }
    const r = await api.insert_frame(DZ.path, svg2.outerHTML);
    if (r && r.error) return r.error;
  }
  return null;
}
async function dzMoveTween() {
  if (!DZ.anim) return sysMsg("🏃 Abrí la animación (🎞) primero");
  if (!DZ.moveT) {
    if (!DZ.sel) return dzSetStatus("🏃 Seleccioná el elemento a animar y tocá 🏃 para fijar el INICIO");
    const path = dzElPath(DZ.sel);
    if (!path) return dzSetStatus("🏃 Ese elemento no se puede animar (no cuelga del lienzo)");
    DZ.moveT = { el: DZ.sel, path, start: dzReadPos(DZ.sel) };
    $("#tlMove").classList.add("rec");
    dzSetStatus("🏃 INICIO fijado. Arrastrá el elemento a su posición FINAL y tocá 🏃 otra vez.");
    return;
  }
  const t = DZ.moveT; DZ.moveT = null; $("#tlMove").classList.remove("rec");
  if (!t.el.isConnected) return dzSetStatus("🏃 El elemento ya no está — cancelo");
  const [dx, dy] = dzPosDelta(t.start, dzReadPos(t.el));
  if (Math.abs(dx) + Math.abs(dy) < 2)
    return dzSetStatus("🏃 No lo moviste de lugar — cancelo. Fijá inicio, arrastrá y volvé a tocar 🏃.");
  openModal(`<h2>🏃 Interpolación de movimiento</h2>
    <div class="sub">Recorrido: ${Math.round(Math.hypot(dx, dy))} unidades. El elemento vuelve al inicio
    y se generan los cuadros del viaje (el último queda en la posición final).</div>
    <div class="dz-style-row">
      <span class="dz-hint">Cuadros</span>
      <input type="number" id="mtN" class="dz-win" value="6" min="2" max="24">
      <span class="dz-hint">Curva</span>
      <select id="mtEase" class="langsel">
        <option value="linear">Lineal</option>
        <option value="in">Ease in (acelera)</option>
        <option value="out">Ease out (frena)</option>
        <option value="inout" selected>Ease in-out (natural)</option>
      </select>
    </div>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="mtGo">🏃 Generar</button>
    </div>`);
  $("#mCancel").onclick = () => { closeModal(); };
  $("#mtGo").onclick = async () => {
    const n = Math.max(2, Math.min(24, +$("#mtN").value || 6));
    const fn = DZ_EASES[$("#mtEase").value] || DZ_EASES.inout;
    closeModal();
    // el elemento vuelve al INICIO en este cuadro; los nuevos hacen el viaje
    dzWritePos(t.el, dzReadPos(t.el), -dx, -dy);
    dzMarkDirty();
    await dzPersist();
    const base = dzSerialize($("#dzCanvas").querySelector("svg"));
    dzSetStatus("🏃 Generando " + n + " cuadros del recorrido…");
    const offs = [];
    for (let k = 1; k <= n; k++) offs.push([dx * fn(k / n), dy * fn(k / n)]);
    const err = await dzTweenFrames(base, t.path, offs);
    if (err) return dzSetStatus("❌ " + err);
    DZ.anim.cache = {};
    try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
    await dzTimelineRefresh(); dzOnionUpdate(); dzTimelineBadges();
    dzSetStatus("🏃 " + n + " cuadros generados — reproducí (▶) para ver el movimiento.");
  };
}
/* ⏺ grabación en vivo: armás la grabación, arrastrás el elemento y el
   recorrido con SUS TIEMPOS reales se muestrea al fps de la timeline */
function dzRecToggle() {
  if (!DZ.anim) return sysMsg("⏺ Abrí la animación (🎞) primero");
  if (DZ.rec) { DZ.rec = null; $("#tlRec").classList.remove("rec"); dzSetStatus("⏺ Grabación desarmada"); return; }
  DZ.rec = { armed: true };
  $("#tlRec").classList.add("rec");
  dzSetStatus("⏺ Grabación ARMADA: agarrá un elemento y arrastralo actuando el movimiento — al soltar, cada instante se vuelve un cuadro.");
}
async function dzRecFinish(rec) {
  $("#tlRec").classList.remove("rec");
  DZ.rec = null;
  const fps = Math.max(1, Math.min(60, +$("#tlFps").value || 12));
  const dur = rec.samples.length ? rec.samples[rec.samples.length - 1][2] : 0;
  let nFrames = Math.min(48, Math.max(2, Math.round(dur / 1000 * fps)));
  if (rec.samples.length < 2 || dur < 120)
    return dzSetStatus("⏺ Muy corto — arrastrá el recorrido completo con el mouse apretado.");
  // remuestrear el gesto al fps de la timeline (interpolando entre muestras)
  const at = (ms) => {
    let i = rec.samples.findIndex(s => s[2] >= ms);
    if (i < 0) return rec.samples[rec.samples.length - 1];
    if (i === 0) return rec.samples[0];
    const a = rec.samples[i - 1], b = rec.samples[i];
    const f = (ms - a[2]) / Math.max(1, b[2] - a[2]);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const offs = [];
  for (let k = 1; k <= nFrames; k++) offs.push(at(dur * k / nFrames));
  // el elemento vuelve al inicio del gesto en el cuadro actual
  dzWritePos(rec.el, dzReadPos(rec.el), -rec.last[0], -rec.last[1]);
  dzMarkDirty();
  await dzPersist();
  const base = dzSerialize($("#dzCanvas").querySelector("svg"));
  dzSetStatus("⏺ Convirtiendo tu actuación en " + nFrames + " cuadros…");
  const err = await dzTweenFrames(base, rec.path, offs);
  if (err) return dzSetStatus("❌ " + err);
  DZ.anim.cache = {};
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
  await dzTimelineRefresh(); dzOnionUpdate(); dzTimelineBadges();
  dzSetStatus("⏺ Actuación grabada: " + nFrames + " cuadros a " + fps + " fps — dale ▶.");
}

/* ══ 🎦 TITIRITERO (marioneta digital) ═══════════════════════════════════
   Grabación en vivo de performance: apretás REC, manipulás el muñeco en
   tiempo real (arrastrás/rotás cabeza, brazos, piezas del rig) y LOW captura
   la escena entera cada 1/fps segundos como cuadros — hasta que parás. Es el
   titiritero de varilla (rod puppet) digital: la actuación ES la animación.
   A diferencia de la grabación en vivo (un elemento), acá capturás TODO lo
   que muevas, con las manos, en wall-clock real. ══ */
function dzPuppetToggle() {
  if (DZ.pup && DZ.pup.recording) { dzPuppetStop(); return; }
  if (DZ.pup && DZ.pup.counting) { return; }        // en cuenta regresiva
  if (!DZ.anim) { dzAnimToggle(); }                 // el titiritero vive en la timeline
  if (!DZ.path) return sysMsg("🎦 Abrí un diseño primero (✒).");
  // cuenta regresiva 3·2·1 para que agarres el muñeco listo
  DZ.pup = { counting: true, recording: false, snaps: [] };
  dzPuppetHUD("preparate…");
  let n = 3;
  const tick = () => {
    if (!DZ.pup || !DZ.pup.counting) return;        // cancelado
    if (n > 0) { dzPuppetHUD("🎬 " + n); n--; setTimeout(tick, 700); }
    else dzPuppetStart();
  };
  tick();
}
function dzPuppetStart() {
  const fps = Math.max(1, Math.min(60, +$("#tlFps").value || 12));
  DZ.pup = { recording: true, counting: false, snaps: [], t0: performance.now(), fps };
  $("#tlPuppet").classList.add("rec");
  dzPuppetHUD("● REC  0.0s · 0 cuadros");
  // capturá la escena entera cada 1/fps mientras manipulás el muñeco
  DZ.pup.timer = setInterval(() => {
    const svg = $("#dzCanvas").querySelector("svg");
    if (!svg) return;
    DZ.pup.snaps.push(dzSerialize(svg));
    const secs = ((performance.now() - DZ.pup.t0) / 1000).toFixed(1);
    dzPuppetHUD("● REC  " + secs + "s · " + DZ.pup.snaps.length + " cuadros");
  }, 1000 / fps);
  dzSetStatus("🎦 GRABANDO — movés el muñeco con la mano; cada instante es un cuadro. Apretá 🎦 (o Esc) para cortar.");
}
async function dzPuppetStop() {
  const pup = DZ.pup; DZ.pup = null;
  if (pup && pup.timer) clearInterval(pup.timer);
  $("#tlPuppet").classList.remove("rec");
  dzPuppetHUD(null);
  if (!pup || !pup.recording) { dzSetStatus("🎦 Titiritero cancelado"); return; }
  const snaps = pup.snaps || [];
  if (snaps.length < 2) return dzSetStatus("🎦 Toma muy corta — apretá REC y movés el muñeco un rato antes de cortar.");
  dzSetStatus("🎦 Guardando la actuación (" + snaps.length + " cuadros)…");
  const r = await api.record_take(DZ.path, snaps);
  if (r && r.error) return dzSetStatus("❌ " + r.error);
  DZ.anim.cache = {};
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
  await dzTimelineRefresh(); dzTimelineBadges();
  if (r && r.path) { await dzGoFrame(DZ.anim.frames.indexOf(r.path)); }
  dzSetStatus("🎦 ¡Actuación grabada! " + (r.n || snaps.length) + " cuadros a " + pup.fps + " fps — dale ▶ para verla.");
}
/* HUD grande de grabación sobre el lienzo (texto o null para ocultar) */
function dzPuppetHUD(txt) {
  let h = $("#dzPupHud");
  if (txt == null) { if (h) h.remove(); return; }
  if (!h) {
    h = document.createElement("div");
    h.id = "dzPupHud"; h.className = "dz-pup-hud";
    $("#dzCanvas").appendChild(h);
  }
  h.textContent = txt;
}

/* ══ 🚶 CICLO DE CAMINATA automático (estilo Toon Boom / OpenToonz) ══ */
function dzWalkCycleModal() {
  if (!DZ.anim) { dzAnimToggle(); if (!DZ.anim) return; }
  if (!DZ.sel) return sysMsg("🚶 Seleccioná un elemento para animar el ciclo de caminata");
  openModal(`<h2>🚶 Ciclo de caminata</h2>
    <div class="sub">Genera un ciclo automático de pasos: el elemento sube/baja y se inclina
    rítmicamente. Ideal para personajes enteros, siluetas o props que "caminan".</div>
    <div class="dz-style-row">
      <span class="dz-hint">Pasos (ciclo completo)</span>
      <input type="number" id="wcSteps" class="dz-win" value="2" min="1" max="8">
      <span class="dz-hint">Cuadros por paso</span>
      <input type="number" id="wcFrames" class="dz-win" value="8" min="4" max="24">
    </div>
    <div class="dz-style-row">
      <span class="dz-hint">Altura del paso (px)</span>
      <input type="number" id="wcBounce" class="dz-win" value="20" min="1" max="120">
      <span class="dz-hint">Balanceo (°)</span>
      <input type="number" id="wcSway" class="dz-win" value="8" min="0" max="45">
    </div>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="wcGo">🚶 Generar ciclo</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#wcGo").onclick = () => {
    const steps = Math.max(1, Math.min(8, +$("#wcSteps").value || 2));
    const fpb = Math.max(4, Math.min(24, +$("#wcFrames").value || 8));
    const bounce = Math.max(1, Math.min(120, +$("#wcBounce").value || 20));
    const sway = Math.max(0, Math.min(45, +$("#wcSway").value || 8));
    closeModal();
    dzWalkCycleRun(steps, fpb, bounce, sway);
  };
}
async function dzWalkCycleRun(steps, fpb, bounce, sway) {
  const el = DZ.sel;
  if (!el) return;
  const elPath = dzElPath(el);
  if (!elPath) return dzSetStatus("🚶 Ese elemento no se puede animar (no cuelga del lienzo)");
  const totalFrames = steps * fpb;
  dzSnapshot();
  await dzPersist();
  const base = dzSerialize($("#dzCanvas").querySelector("svg"));
  dzSetStatus("🚶 Generando " + totalFrames + " cuadros de caminata…");
  const offs = [];
  for (let k = 1; k <= totalFrames; k++) {
    const phase = (k - 1) / fpb;                // 0..steps
    // parábola para el bounce: sube en el medio del paso
    const b = Math.sin(phase * Math.PI) * bounce;
    // sway sinusoidal
    const s = Math.sin(phase * Math.PI * 2) * sway;
    offs.push([0, -Math.abs(b), s]);            // [dx, dy, rotation]
  }
  const err = await dzTweenFrames(base, elPath, offs);
  if (err) return dzSetStatus("❌ " + err);
  DZ.anim.cache = {};
  try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
  await dzTimelineRefresh(); dzOnionUpdate(); dzTimelineBadges();
  dzSetStatus("🚶 ¡Ciclo de caminata listo! " + totalFrames + " cuadros — dale ▶ para verlo. Probá distintos bounce/sway para ajustar.");
}

/* ══ 🎭 DIORAMA: compositing sin nodos ═══════════════════════════════════
   En vez del mapa de nodos de Harmony/OpenToonz, una vista LATERAL física
   del multiplano (el diorama de la cámara multiplano de Disney): la cámara
   a la izquierda, el plano de acción en el medio, el fondo a la derecha, y
   cada capa es una tarjeta que arrastrás en profundidad. El grafo ya existe
   en la escena (orden = compositing, grupos = jerarquía, data-z = plano) —
   esto solo lo hace tangible. ══ */
const DZ_Z_MIN = -60, DZ_Z_MAX = 400;
function dzZToX(z, W) {
  // -60 (pegado a cámara) … 0 (acción) … 400 (fondo) → posición en el riel
  return ((z - DZ_Z_MIN) / (DZ_Z_MAX - DZ_Z_MIN)) * (W - 46) + 6;
}
function dzXToZ(x, W) {
  const z = ((x - 6) / (W - 46)) * (DZ_Z_MAX - DZ_Z_MIN) + DZ_Z_MIN;
  return Math.max(DZ_Z_MIN, Math.min(DZ_Z_MAX, Math.round(z)));
}
function dzZPanelToggle() {
  const p = $("#dzZPanel");
  p.hidden = !p.hidden;
  $("#dzZBtn").classList.toggle("active", !p.hidden);
  if (!p.hidden) dzZPanelRender();
}
function dzZPanelRender() {
  const rail = $("#dzZRail");
  if (!rail || $("#dzZPanel").hidden) return;
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) { rail.innerHTML = ""; return; }
  const W = rail.clientWidth || 260;
  rail.innerHTML = `<div class="dz-zaction" style="left:${dzZToX(0, W)}px" title="Plano de acción (z = 0)"></div>`;
  const kids = [...svg.children].filter(n => !DZ_SKIP_TAGS.includes(n.tagName.toLowerCase())
    && !(n.classList && (n.classList.contains("dz-onion") || n.classList.contains("dz-penui"))));
  kids.forEach((el, i) => {
    const z = Math.max(DZ_Z_MIN, Math.min(DZ_Z_MAX, parseFloat(el.getAttribute("data-z")) || 0));
    const card = document.createElement("div");
    card.className = "dz-zcard" + (el === DZ.sel ? " sel" : "");
    card.style.left = dzZToX(z, W) + "px";
    card.style.top = (6 + (i % 5) * 13) + "px";        // escalonadas para leerlas
    const name = el.id || dzLayerLabel(el);
    card.innerHTML = `<span class="dz-zname">${name.slice(0, 12)}</span><span class="dz-zz">${z}</span>`;
    card.title = name + " · z=" + z + " — arrastrá: izquierda acerca, derecha aleja";
    card.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      dzSnapshot();
      const railR = rail.getBoundingClientRect();
      const move = (ev) => {
        const zNew = dzXToZ(ev.clientX - railR.left, W);
        if (zNew === 0) el.removeAttribute("data-z");   // 0 = plano de acción, sin attr
        else el.setAttribute("data-z", zNew);
        card.style.left = dzZToX(zNew, W) + "px";
        card.querySelector(".dz-zz").textContent = zNew;
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        dzMarkDirty();
        if (DZ.sel === el) dzBuildInspector(el);        // sincronizar el campo Z
        dzSetStatus("🎭 «" + name.slice(0, 20) + "» a z=" + (el.getAttribute("data-z") || 0) +
                    " — mové la cámara (📹) y mirá el parallax en ▶");
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    card.onclick = (e) => { e.stopPropagation(); if (!el.hasAttribute("data-locked")) dzSelect(el); };
    rail.appendChild(card);
  });
}

/* ══ CHROME DE ESTUDIO: menubar, barra de estado, opciones de herramienta,
   splitter del inspector y X-sheet — la cara de software en serio ══ */
const DZ_TOOL_NAMES = { select: "seleccionar", hand: "mano", nodes: "nodos",
  pencil: "lápiz", brush: "pincel", pen: "pluma", eraser: "borrador",
  dropper: "cuentagotas", bucket: "balde", pivot: "pivote de rig", ruler: "regla",
  inflator: "inflador", handler: "manejador", iron: "plancha", pliers: "pinza", magnet: "imán" };
function dzMenuAction(act) {
  const A = {
    nuevo: () => api.new_design().then(r => { if (r && r.path) openDesign(r.path); }),
    documento: dzDocModal, guardar: () => dzSave(), importar: dzImportImage,
    exportar: dzExportModal, exportanim: dzExportModal,
    navegador: () => { if (DZ.path) api.preview_html(DZ.path, $("#dzCanvas").innerHTML); },
    cerrar: () => closeDesign(),
    deshacer: dzUndo, rehacer: dzRedo, duplicar: dzDuplicate, borrar: dzDeleteSelected,
    agrupar: () => dzGroupSel(false), desagrupar: () => dzGroupSel(true),
    preferencias: dzPrefsModal, atajos: dzPrefsModal, pendebug: dzPenDebugToggle,
    zoomin: () => dzZoom(0.15), zoomout: () => dzZoom(-0.15),
    zoom100: () => dzRunAction("zoom100"), fit: dzFitView,
    rotl: () => dzRotView(-15), rotr: () => dzRotView(15),
    enderezar: () => { DZ.viewRot = 0; dzApplyZoom(); },
    diorama: dzZPanelToggle, profundidad: dzZPanelToggle,
    cebolla: () => { const p = $("#dzOnionPanel"); p.hidden = !p.hidden; },
    xsheet: dzXsToggle, codigo: dzToggleCode,
    alfrente: () => { if (!DZ.sel) return dzSetStatus("Seleccioná un elemento primero");
      dzSnapshot(); DZ.sel.parentNode.appendChild(DZ.sel); dzMarkDirty(); dzBuildLayers(); },
    atras: () => { if (!DZ.sel) return dzSetStatus("Seleccioná un elemento primero");
      dzSnapshot(); DZ.sel.parentNode.insertBefore(DZ.sel, DZ.sel.parentNode.firstChild); dzMarkDirty(); dzBuildLayers(); },
    bloquear: () => { if (!DZ.sel) return dzSetStatus("Seleccioná un elemento primero");
      dzSnapshot();
      if (DZ.sel.hasAttribute("data-locked")) DZ.sel.removeAttribute("data-locked");
      else { DZ.sel.setAttribute("data-locked", "1"); const el = DZ.sel; dzDeselect(); }
      dzMarkDirty(); dzBuildLayers(); },
    renombrar: () => { if (!DZ.sel) return dzSetStatus("Seleccioná un elemento primero");
      const name = prompt("Nombre de la capa:", DZ.sel.id || "");
      if (name === null) return;
      dzSnapshot();
      const clean = name.trim().replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]/g, "_");
      if (clean) DZ.sel.id = clean; else DZ.sel.removeAttribute("id");
      dzMarkDirty(); dzBuildLayers(); },
    pivote: () => dzSetTool("pivot"),
    timeline: dzAnimToggle, cuadro: dzFrameAdd, insertar: () => dzFrameInsert(false),
    clave: dzKeyToggle, intercalar: dzTweenModal, interpolar: dzMoveTween,
    grabar: dzRecToggle, claveia: dzAIKeyModal, camara: dzCamToggle, clavecam: dzCamKeyToggle,
    acerca: () => {
      openModal(`<h2>LOW Estudio</h2>
        <div class="sub">Editor de vectores y animación 2D con IA integrada, dentro de LOW v${S.version || ""}.
        Dibujo con presión, X-sheet, papel cebolla, cámara multiplano, rigging con pivotes,
        intercalado automático y fotogramas clave generados por IA.<br><br>
        Hecho por Mauro Gatti con LOW — código abierto.</div>
        <div class="m-actions"><button class="primary" id="mCancel">Cerrar</button></div>`);
      $("#mCancel").onclick = closeModal;
    },
  };
  if (A[act]) A[act]();
}
function dzMenubarWire() {
  const menus = document.querySelectorAll("#dzMenubar .dz-menu");
  const closeAll = () => menus.forEach(m => m.classList.remove("open"));
  menus.forEach(m => {
    m.addEventListener("mousedown", (e) => {
      if (e.target.closest(".dz-dd")) return;
      e.preventDefault();
      const was = m.classList.contains("open");
      closeAll();
      if (!was) m.classList.add("open");
    });
    m.addEventListener("mouseenter", () => {
      // si hay un menú abierto, pasar el mouse cambia de menú (comportamiento clásico)
      if ([...menus].some(x => x.classList.contains("open"))) { closeAll(); m.classList.add("open"); }
    });
    m.querySelectorAll("[data-act]").forEach(item =>
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        closeAll();
        dzMenuAction(item.dataset.act);
      }));
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest || !e.target.closest("#dzMenubar")) closeAll();
  });
}
/* barra de estado: herramienta · posición del cursor · zoom · cuadro · hint */
function dzSbTool() {
  const el = $("#sbTool");
  if (el) el.textContent = DZ_TOOL_NAMES[DZ.tool || "select"] || DZ.tool;
}
function dzSbFrame() {
  const el = $("#sbFrame");
  if (!el) return;
  el.textContent = DZ.anim ? `cuadro ${DZ.anim.idx + 1}/${DZ.anim.frames.length}` : "";
}
/* opciones contextuales de la herramienta activa (franja bajo la barra) */
function dzToolOptsRender() {
  const box = $("#dzToolOpts");
  if (!box) return;
  const t = DZ.tool || "select";
  const sm = DZ.smooth === undefined ? 40 : DZ.smooth;
  let html = `<span class="dz-to-name">${DZ_TOOL_NAMES[t] || t}</span>`;
  if (["pencil", "brush", "pen"].includes(t)) {
    html += `<label>Trazo <input type="color" id="toColor" value="${dzHex(DZ.drawColor) || "#1a1a1a"}"></label>
      <label>Grosor <input type="number" id="toW" min="1" max="120" value="${DZ.drawW || 6}" class="dz-win"></label>` +
      (t !== "pen" ? `<label>Suavizado <input type="range" id="toSmooth" min="0" max="100" value="${sm}"><span id="toSmoothLbl">${sm}</span></label>` : "") +
      (t === "brush" ? `<span class="dz-hint">el grosor sigue la presión de la tableta</span>` : "") +
      (DZ.mirror ? `<span class="dz-hint">🪞 espejo activo</span>` : "");
  } else if (t === "bucket") {
    html += `<label>Relleno <input type="color" id="toFill" value="${dzHex(DZ.fillColor) || "#F0450E"}"></label>
      <span class="dz-hint">clic pinta el relleno · Shift+clic pinta el trazo</span>`;
  } else if (t === "ruler") {
    html += `<label>Trazo <input type="color" id="toColor" value="${dzHex(DZ.drawColor) || "#1a1a1a"}"></label>
      <label>Grosor <input type="number" id="toW" min="1" max="40" value="${DZ.drawW || 4}" class="dz-win"></label>
      <span class="dz-hint">clic = inicio · clic = fin (trazado continuo) · Shift = 15° · clic der = punto de fuga · Esc = cancela</span>`;
  } else if (t === "inflator") {
    html += `<span class="dz-hint">seleccioná una forma y arrastrá para inflar · Shift arrastrar = desinflar</span>`;
  } else if (t === "handler") {
    html += `<span class="dz-hint">clic en un trazo y arrastrá ↕ para cambiar el grosor en tiempo real</span>`;
  } else if (t === "iron") {
    html += `<span class="dz-hint">clic sobre un trazo para suavizarlo · cada clic lo alisa más</span>`;
  } else if (t === "pliers") {
    html += `<span class="dz-hint">clic justo sobre el borde de un path para partirlo en dos</span>`;
  } else if (t === "magnet") {
    html += `<span class="dz-hint">arrastrá cerca de los vértices para atraerlos y deformar</span>`;
  } else if (t === "eraser") {
    html += `<span class="dz-hint">pasá por encima y borra trazos enteros — las capas con candado no se tocan</span>`;
  } else if (t === "nodes") {
    html += `<span class="dz-hint">clic en un trazado muestra sus puntos · arrastralos · doble clic borra un punto</span>`;
  } else if (t === "dropper") {
    html += `<span class="dz-hint">clic en cualquier elemento toma su relleno, trazo y grosor</span>`;
  } else if (t === "pivot") {
    html += `<span class="dz-hint">clic fija el eje de rotación de la pieza (hombro, codo…) · Alt+clic lo quita</span>`;
  } else if (t === "hand") {
    html += `<span class="dz-hint">arrastrá para navegar · también espacio+arrastrar o botón del medio</span>`;
  } else {
    html += `<span class="dz-hint">clic selecciona · arrastrá mueve · Shift+clic suma a la selección · Alt+clic entra al grupo</span>`;
  }
  box.innerHTML = html;
  const oc = $("#toColor"); if (oc) oc.oninput = e => { DZ.drawColor = e.target.value; const p = $("#dzPStroke"); if (p) p.value = e.target.value; };
  const ow = $("#toW"); if (ow) ow.oninput = e => { DZ.drawW = +e.target.value || 6; const p = $("#dzDrawW"); if (p) p.value = DZ.drawW; };
  const os = $("#toSmooth"); if (os) os.oninput = e => {
    DZ.smooth = +e.target.value; $("#toSmoothLbl").textContent = e.target.value;
    const p = $("#dzSmooth"); if (p) { p.value = e.target.value; $("#dzSmoothLbl").textContent = e.target.value; }
    try { localStorage.setItem("fidel.dzsmooth", String(DZ.smooth)); } catch (err) { /* */ }
  };
  const of2 = $("#toFill"); if (of2) of2.oninput = e => { DZ.fillColor = e.target.value; const p = $("#dzPFill"); if (p) p.value = e.target.value; };
}
/* splitter: redimensionar el inspector arrastrando (persistente) */
function dzSplitWire() {
  const sp = $("#dzSplit"), insp = document.querySelector(".dz-inspector");
  if (!sp || !insp) return;
  const saved = +localStorage.getItem("fidel.dzinsw");
  if (saved >= 200 && saved <= 520) insp.style.width = saved + "px";
  sp.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const move = (ev) => {
      const w = Math.max(200, Math.min(520, window.innerWidth - ev.clientX));
      insp.style.width = w + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try { localStorage.setItem("fidel.dzinsw", parseInt(insp.style.width) || 260); } catch (err) { /* */ }
      dzPositionHandle();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
/* X-sheet: planilla de exposición vertical (número · nombre · claves) */
function dzXsToggle() {
  const p = $("#dzXsheet");
  p.hidden = !p.hidden;
  const b = $("#tlXs"); if (b) b.classList.toggle("active", !p.hidden);
  if (!p.hidden) {
    if (!DZ.anim) dzAnimToggle();
    dzXsRender();
  }
}
/* X-sheet (planilla de exposición): una fila por cuadro con MINIATURA, número,
   marcas (🔑 clave · 📹 cámara) y NOTAS editables. Las notas se guardan en la
   escena (<base>_escena.json) junto a las claves y la cámara. */
function dzXsRender() {
  const box = $("#dzXsRows");
  if (!box || $("#dzXsheet").hidden || !DZ.anim) return;
  const keys = (DZ.scene && DZ.scene.keys) || [];
  const cams = (DZ.scene && DZ.scene.cam) || {};
  const notes = (DZ.scene && DZ.scene.notes) || {};
  box.innerHTML =
    '<div class="dz-xs-head"><span>#</span><span>cuadro</span><span></span><span>nota</span></div>';
  DZ.anim.frames.forEach((f, i) => {
    const num = dzFrameNum(f);
    const row = document.createElement("div");
    row.className = "dz-xs-row" + (i === DZ.anim.idx ? " cur" : "") +
      (keys.includes(num) ? " key" : "");
    // número (clic = ir al cuadro)
    const n = document.createElement("span");
    n.className = "dz-xs-n"; n.textContent = i + 1;
    n.title = "Ir al cuadro " + (i + 1);
    n.onclick = () => { dzAnimStopIf(); dzGoFrame(i); };
    // miniatura (clic = ir al cuadro)
    const thumb = document.createElement("div");
    thumb.className = "dz-xs-thumb";
    thumb.onclick = () => { dzAnimStopIf(); dzGoFrame(i); };
    dzXsThumbInto(thumb, f, i);
    // marcas
    const badge = document.createElement("span");
    badge.className = "dz-xs-b";
    badge.textContent = (keys.includes(num) ? "🔑" : "") + (cams[num] ? "📹" : "");
    // nota editable
    const note = document.createElement("input");
    note.className = "dz-xs-note"; note.type = "text";
    note.placeholder = "…"; note.value = notes[num] || "";
    note.title = "Nota de este cuadro (timing, acción, referencia…)";
    note.onchange = () => {
      DZ.scene = DZ.scene || {}; DZ.scene.notes = DZ.scene.notes || {};
      const v = note.value.trim();
      if (v) DZ.scene.notes[num] = v; else delete DZ.scene.notes[num];
      dzSceneSave();
    };
    row.append(n, thumb, badge, note);
    box.appendChild(row);
  });
}
/* miniatura del cuadro dentro de una celda del X-sheet */
async function dzXsThumbInto(cell, f, i) {
  let txt = DZ.anim && DZ.anim.cache[f];
  if (!txt) {
    if (i === DZ.anim.idx) {
      const svg = $("#dzCanvas").querySelector("svg");
      if (svg) txt = dzSerialize(svg);
    } else {
      const r = await api.image_data(f);
      txt = r && r.svg;
    }
    if (DZ.anim && txt) DZ.anim.cache[f] = txt;
  }
  if (!txt || !cell.isConnected) return;
  const tmp = document.createElement("div"); tmp.innerHTML = txt;
  const svg = tmp.querySelector("svg");
  if (!svg) return;
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  cell.innerHTML = ""; cell.appendChild(svg);
}

/* ══ 🪞 modo espejo: lápiz/pincel/pluma dibujan también reflejados sobre el
   eje vertical del lienzo — para personajes y diseños simétricos ══ */
function dzMirrorToggle() {
  DZ.mirror = !DZ.mirror;
  const b = $("#dzMirror"); if (b) b.classList.toggle("active", DZ.mirror);
  dzSetStatus(DZ.mirror ?
    "🪞 Modo espejo ACTIVADO: cada trazo se duplica reflejado (eje vertical del lienzo)" :
    "🪞 Modo espejo desactivado");
}
function dzMirrorClone(el) {
  if (!DZ.mirror || !el || !el.parentNode) return null;
  const vb = dzVB();
  const c = el.cloneNode(true);
  const own = el.getAttribute("transform") || "";
  c.setAttribute("transform",
    `translate(${(2 * (vb[0] + vb[2] / 2)).toFixed(1)} 0) scale(-1 1)` + (own ? " " + own : ""));
  el.parentNode.insertBefore(c, el.nextSibling);
  return c;
}

/* ── ✨ fotograma clave con IA: describís el movimiento, el modelo dibuja la pose ── */
function dzAIKeyModal() {
  if (!DZ.anim) return;
  openModal(`<h2>✨ Fotograma clave con IA</h2>
    <div class="sub">El modelo mira el cuadro actual y dibuja la PRÓXIMA pose según tu indicación.
    Se inserta después de este cuadro y queda marcada como clave (🔑). Después podés intercalar (🪄).</div>
    <textarea id="aiKeyTxt" class="cmp-field" rows="3" spellcheck="false"
      placeholder="ej: «el personaje levanta el brazo derecho y mira hacia arriba», «la pelota toca el piso y se aplasta»"></textarea>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="aiKeyGo">✨ Dibujar la pose</button>
    </div>`);
  $("#mCancel").onclick = closeModal;
  $("#aiKeyGo").onclick = async () => {
    const txt = $("#aiKeyTxt").value.trim();
    closeModal();
    if (!txt) return;
    await dzPersist();
    dzSetStatus("✨ El modelo está dibujando el próximo fotograma clave…");
    const r = await api.ai_keyframe(DZ.path, txt);
    if (r && r.error) return dzSetStatus("❌ " + r.error);
    DZ.anim.cache = {};
    // la pose nueva nace marcada como clave
    DZ.scene = DZ.scene || {}; DZ.scene.keys = DZ.scene.keys || [];
    const num = dzFrameNum(r.path);
    if (!DZ.scene.keys.includes(num)) { DZ.scene.keys.push(num); DZ.scene.keys.sort((a, b) => a - b); }
    dzSceneSave();
    try { S.tree = (await api.refresh_tree()).tree; renderTree(); } catch (e) { /* */ }
    await openDesign(r.path);
    $("#dzTimeline").hidden = false;
    await dzTimelineRefresh();
    dzOnionUpdate();
    dzSetStatus("✨ Pose nueva en el cuadro " + num + " (🔑). Revisala, retocá lo que haga falta y usá 🪄 para intercalar.");
  };
}

/* reproducir: precarga los cuadros y los cicla a 12 fps */
async function dzAnimPlay() {
  if (!DZ.anim) return;
  if (DZ.anim.playing) return dzAnimStop();
  await dzPersist();
  const cv = $("#dzCanvas");
  for (const f of DZ.anim.frames) {
    if (!DZ.anim.cache[f]) {
      const r = await api.image_data(f);
      if (r && r.svg) DZ.anim.cache[f] = r.svg;
    }
  }
  dzOnionClear();
  $("#dzCam").hidden = true;                     // el encuadre no se dibuja: SE VE por él
  DZ.anim.playing = true;
  $("#tlPlay").textContent = "⏸";
  const [lo, hi] = dzPlayRange();                // rango In/Out (0-based, inclusive)
  const loop = DZ.anim.loop !== false;
  let i = (DZ.anim.idx >= lo && DZ.anim.idx <= hi) ? DZ.anim.idx : lo;
  const fps = Math.max(1, Math.min(60, +($("#tlFps") && $("#tlFps").value) || 12));
  const throughCam = dzHasCam();                 // hay claves de cámara → play POR cámara
  DZ.anim.timer = setInterval(() => {
    if (i >= hi) {                               // llegó al final del rango
      if (!loop) { dzAnimStop(); return; }
      i = lo;
    } else i++;
    let svgTxt = DZ.anim.cache[DZ.anim.frames[i]];
    if (svgTxt && throughCam)
      svgTxt = dzRigView(svgTxt, dzFrameNum(DZ.anim.frames[i]));
      svgTxt = dzCamView(svgTxt, dzCamAt(dzFrameNum(DZ.anim.frames[i])));
    if (svgTxt) {
      const old = cv.querySelector("svg");
      const tmp = document.createElement("div"); tmp.innerHTML = svgTxt;
      const ns = tmp.querySelector("svg");
      if (old && ns) { if (!ns.getAttribute("width") || throughCam) ns.style.width = old.style.width || "min(80vw, 900px)"; old.replaceWith(ns); dzApplyZoom(); }
    }
    document.querySelectorAll("#tlFrames .tl-frame").forEach((c, k) => c.classList.toggle("cur", k === i));
  }, 1000 / fps);
}
/* rango de reproducción/export [lo,hi] 0-based inclusive, según In/Out de la
   barra (In 1-based; Out 1-based, 0 = hasta el final), clamp a los cuadros */
function dzPlayRange() {
  const n = DZ.anim ? DZ.anim.frames.length : 1;
  let lo = (+($("#tlIn") && $("#tlIn").value) || 1) - 1;
  let out = +($("#tlOut") && $("#tlOut").value) || 0;
  let hi = out > 0 ? out - 1 : n - 1;
  lo = Math.max(0, Math.min(lo, n - 1));
  hi = Math.max(lo, Math.min(hi, n - 1));
  return [lo, hi];
}
function dzAnimStopIf() { if (DZ.anim && DZ.anim.playing) dzAnimStop(); }
function dzAnimStop() {
  if (!DZ.anim || !DZ.anim.playing) return;
  clearInterval(DZ.anim.timer);
  DZ.anim.playing = false;
  $("#tlPlay").textContent = "▶";
  dzGoFrame(DZ.anim.idx);   // volver al cuadro editable real
}

/* ── panel de capas: lista de elementos, reordenar (z), mostrar/ocultar ── */
/* ══ ESPACIO 3D: visor tipo Blender para el multiplano ══════════════════════
   Cada capa (elemento de primer nivel del svg) es un PLANO flotando en
   profundidad — el mismo data-z del diorama y del export con parallax, ahora
   navegable: orbitás la escena, activás un plano y dibujás 2D sobre él
   (grease pencil de Blender). El truco que lo hace posible sin librerías:
   el browser proyecta solo los pointer events sobre elementos con CSS 3D,
   así que offsetX/offsetY llegan en coordenadas LOCALES del plano rotado. */
const DZ3D_DEPTH = 1.2;               // px de translateZ por unidad de data-z
const DZ3D_VIEWS = { persp: [-18, 28], front: [0, 0], top: [-89.9, 0], side: [0, 89.9] };

function dz3dToggle() {
  if (DZ.d3) return dz3dExit();
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return sysMsg("Abrí un diseño primero");
  DZ.d3 = { rx: -18, ry: 28, zoom: 0.65, panX: 0, panY: 30, act: -1, els: [] };
  $("#dz3DBtn").classList.add("active");
  dz3dBuild();
  dzSetStatus("Espacio 3D — arrastrá: orbitar · Shift: panear · rueda: zoom · " +
    "clic en un plano lo activa · lápiz/pincel dibujan sobre el plano · mover imanta a las guías (Alt: libre) · " +
    "Z: manejador al costado del plano o slider");
}

function dz3dKids(svg) {
  return [...svg.children].filter(n => !DZ_SKIP_TAGS.includes(n.tagName.toLowerCase())
    && !(n.classList && (n.classList.contains("dz-onion") || n.classList.contains("dz-penui"))));
}

function dz3dBuild() {
  const cv = $("#dzCanvas");
  const svg = cv.querySelector("svg");
  if (!svg || !DZ.d3) return;
  const old = $("#dz3dStage"); if (old) old.remove();
  svg.style.visibility = "hidden";
  $("#dzHandle").hidden = true; $("#dzRotate").hidden = true;

  // lienzo vacío: crear un plano base para que se pueda dibujar ya
  if (!dz3dKids(svg).length) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("data-low", "plano");
    svg.appendChild(g);
  }
  const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const W = vb[2] || 1080, H = vb[3] || 1080;
  const G = Math.max(W, H) * 1.6;                       // tamaño del piso/ejes

  DZ.d3.vb = vb;                                        // para reglas y manejador Z
  const stage = document.createElement("div");
  stage.id = "dz3dStage";
  stage.classList.add("show-mesh", "show-rulers");
  stage.innerHTML = `
    <div class="dz3d-world" id="dz3dWorld">
      <div class="dz3d-grid" style="width:${G}px;height:${G}px;margin-left:${-G / 2}px;margin-top:${-G / 2}px;transform:translateY(${H / 2}px) rotateX(90deg)"></div>
      <div class="dz3d-axis ax-x" style="width:${G}px;margin-left:${-G / 2}px;transform:translateY(${H / 2}px)"></div>
      <div class="dz3d-axis ax-y" style="height:${G}px;margin-top:${-G / 2}px"></div>
      <div class="dz3d-axis ax-z" style="width:${G}px;margin-left:${-G / 2}px;transform:translateY(${H / 2}px) rotateY(90deg)"></div>
      <div class="dz3d-zhandle" id="dz3dZH" hidden
        title="Manejador del eje Z: arrastrá para acercar/alejar el plano activo en profundidad">
        <span class="zh-a">▲</span><span class="zh-z">Z</span><span class="zh-a">▼</span>
      </div>
    </div>
    <div class="dz3d-gizmo">
      <span class="dz3d-axlbl x" title="Eje X (ancho del lienzo)">X</span>
      <span class="dz3d-axlbl y" title="Eje Y (alto del lienzo)">Y</span>
      <span class="dz3d-axlbl z" title="Eje Z (profundidad · data-z)">Z</span>
      <button data-v="persp" class="active" title="Vista en perspectiva">Persp</button>
      <button data-v="front" title="De frente (como el lienzo plano)">Frente</button>
      <button data-v="top" title="Desde arriba: se ve la separación en Z">Arriba</button>
      <button data-v="side" title="De costado: los planos de perfil">Lado</button>
      <span class="vsep"></span>
      <button data-t="mesh" class="active" title="Malla de edición: grilla sobre el plano activo">Malla</button>
      <button data-t="rulers" class="active" title="Reglas X·Y en unidades del lienzo sobre el plano activo">Reglas</button>
      <button class="dz3d-x" title="Salir del espacio 3D">${icoUse("i-x")}</button>
    </div>
    <div class="dz3d-zbar" id="dz3dZbar" hidden>
      <span class="dz3d-zname" id="dz3dZname"></span>
      <span class="dz3d-axlbl z">Z</span>
      <input type="range" id="dz3dZr" min="-60" max="400" step="1" value="0"
        title="Profundidad del plano activo: negativo = más cerca de la cámara, 0 = plano de acción, positivo = fondo">
      <input type="number" id="dz3dZn" min="-60" max="400" step="1" value="0" class="dz-win">
      <span class="dz-hint">cerca ← 0 → lejos · mueve el parallax del export</span>
    </div>`;
  cv.appendChild(stage);

  // ── planos: un svg por capa, con los defs (gradientes/filtros) clonados ──
  const world = $("#dz3dWorld");
  const defs = [...svg.children].filter(n => DZ_SKIP_TAGS.includes(n.tagName.toLowerCase()));
  const kids = dz3dKids(svg);
  DZ.d3.els = kids;
  kids.forEach((el, i) => {
    const card = document.createElement("div");
    card.className = "dz3d-card";
    card.dataset.i = i;
    card.style.cssText = `width:${W}px;height:${H}px;margin-left:${-W / 2}px;margin-top:${-H / 2}px;`;
    const cs = document.createElementNS(SVGNS, "svg");
    cs.setAttribute("viewBox", vb.join(" "));
    cs.setAttribute("width", W); cs.setAttribute("height", H);
    defs.forEach(d => cs.appendChild(d.cloneNode(true)));
    const clone = el.cloneNode(true);
    clone.setAttribute("data-dz3d", "content");
    dz3dPlaneUI(cs, vb, clone);        // malla + contenido + reglas X·Y + guías
    card.appendChild(cs);
    const tag = document.createElement("span");
    tag.className = "dz3d-tag";
    card.appendChild(tag);
    world.appendChild(card);
    dz3dCardZ(card, el);
    dz3dWireCard(card, cs, el, i);
  });

  // ── controles de vista ──
  stage.querySelectorAll(".dz3d-gizmo [data-v]").forEach(b => b.onclick = () => {
    const [rx, ry] = DZ3D_VIEWS[b.dataset.v];
    DZ.d3.rx = rx; DZ.d3.ry = ry;
    stage.querySelectorAll(".dz3d-gizmo [data-v]").forEach(x => x.classList.toggle("active", x === b));
    dz3dApply();
  });
  stage.querySelector(".dz3d-x").onclick = () => dz3dExit();

  // ── órbita / paneo / zoom sobre el fondo ──
  stage.addEventListener("pointerdown", e => {
    if (e.target.closest(".dz3d-card") || e.target.closest(".dz3d-gizmo") ||
        e.target.closest(".dz3d-zbar")) return;
    const d3 = DZ.d3, sx = e.clientX, sy = e.clientY;
    const base = { rx: d3.rx, ry: d3.ry, px: d3.panX, py: d3.panY };
    const pan = e.shiftKey || e.button === 1;
    stage.setPointerCapture(e.pointerId);
    const move = ev => {
      if (pan) { d3.panX = base.px + (ev.clientX - sx); d3.panY = base.py + (ev.clientY - sy); }
      else {
        d3.ry = base.ry + (ev.clientX - sx) * 0.4;
        d3.rx = Math.max(-90, Math.min(90, base.rx - (ev.clientY - sy) * 0.4));
      }
      dz3dApply();
    };
    const up = () => { stage.removeEventListener("pointermove", move); stage.removeEventListener("pointerup", up); };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    e.preventDefault();
  });
  stage.addEventListener("wheel", e => {
    e.preventDefault();
    DZ.d3.zoom = Math.max(0.12, Math.min(3, DZ.d3.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    dz3dApply();
  }, { passive: false });

  // ── toggles de malla y reglas ──
  stage.querySelectorAll(".dz3d-gizmo [data-t]").forEach(b => b.onclick = () => {
    const on = stage.classList.toggle("show-" + b.dataset.t);
    b.classList.toggle("active", on);
  });

  // ── barra Z (slider) + manejador Z arrastrable ──
  $("#dz3dZr").addEventListener("input", e => dz3dSetZ(DZ.d3.act, e.target.value, false));
  $("#dz3dZr").addEventListener("change", e => dz3dSetZ(DZ.d3.act, e.target.value, true));
  $("#dz3dZn").addEventListener("change", e => dz3dSetZ(DZ.d3.act, e.target.value, true));
  const zh = $("#dz3dZH");
  zh.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    const i = DZ.d3.act; if (i < 0) return;
    const z0 = parseFloat(DZ.d3.els[i].getAttribute("data-z")) || 0;
    const dir = dz3dZDir();                       // eje Z del mundo, en px de pantalla
    const L2 = dir.x * dir.x + dir.y * dir.y;
    const sx = e.clientX, sy = e.clientY;
    zh.setPointerCapture(e.pointerId);
    zh.classList.add("drag");
    const move = ev => {
      // proyecta el arrastre sobre la dirección del eje Z en pantalla;
      // de frente (el eje apunta a cámara) cae al arrastre vertical
      const dz = L2 < 0.01 ? (sy - ev.clientY) * 0.8
        : ((ev.clientX - sx) * dir.x + (ev.clientY - sy) * dir.y) / L2;
      dz3dSetZ(i, z0 + dz, false);
    };
    const up = () => {
      zh.removeEventListener("pointermove", move); zh.removeEventListener("pointerup", up);
      zh.classList.remove("drag");
      dz3dSetZ(i, +$("#dz3dZr").value, true);
    };
    zh.addEventListener("pointermove", move);
    zh.addEventListener("pointerup", up);
  });

  dz3dApply();
  if (DZ.d3.act >= 0 && DZ.d3.act < kids.length) dz3dActivate(DZ.d3.act);
  else if (kids.length === 1) dz3dActivate(0);
}

function dz3dCardZ(card, el) {
  const z = parseFloat(el.getAttribute("data-z")) || 0;
  card.style.transform = `translateZ(${(-z * DZ3D_DEPTH).toFixed(1)}px)`;
  const tag = card.querySelector(".dz3d-tag");
  if (tag) tag.textContent = dzLayerLabel(el) + " · z=" + z;
}

function dz3dApply() {
  const d3 = DZ.d3, w = $("#dz3dWorld");
  if (!d3 || !w) return;
  w.style.transform = `translate(${d3.panX}px, ${d3.panY}px) scale(${d3.zoom}) ` +
                      `rotateX(${d3.rx}deg) rotateY(${d3.ry}deg)`;
  const sb = $("#sbZoom");
  if (sb) sb.textContent = Math.round(d3.zoom * 100) + "% · 3D " +
    Math.round(d3.rx) + "°/" + Math.round(d3.ry) + "°";
}

function dz3dActivate(i) {
  const d3 = DZ.d3; if (!d3) return;
  d3.act = i;
  document.querySelectorAll("#dz3dWorld .dz3d-card").forEach(c =>
    c.classList.toggle("act", +c.dataset.i === i));
  const el = d3.els[i];
  DZ.sel = el;                                   // props/rig/walk usan la selección
  const zb = $("#dz3dZbar");
  zb.hidden = false;
  $("#dz3dZname").textContent = dzLayerLabel(el);
  const z = parseFloat(el.getAttribute("data-z")) || 0;
  $("#dz3dZr").value = z; $("#dz3dZn").value = z;
  const zh = $("#dz3dZH");
  if (zh) { zh.hidden = false; dz3dZHandlePlace(); }
}

/* mueve el plano activo en el eje Z (slider, manejador y teclado comparten esto) */
function dz3dSetZ(i, z, commit) {
  const d3 = DZ.d3; if (!d3 || i < 0) return;
  const el = d3.els[i];
  z = Math.max(-60, Math.min(400, Math.round(+z || 0)));
  if (z === 0) el.removeAttribute("data-z"); else el.setAttribute("data-z", z);
  $("#dz3dZr").value = z; $("#dz3dZn").value = z;
  const card = document.querySelector(`#dz3dWorld .dz3d-card[data-i="${i}"]`);
  if (card) dz3dCardZ(card, el);
  if (i === d3.act) dz3dZHandlePlace();
  if (commit) { DZ.dirty = true; dzPersist(); dzZPanelRender(); }
}

/* dirección del eje Z del mundo en PANTALLA (px por unidad de data-z) */
function dz3dZDir() {
  const w = $("#dz3dWorld");
  const m = new DOMMatrix(getComputedStyle(w).transform);
  const o = m.transformPoint(new DOMPoint(0, 0, 0));
  const p = m.transformPoint(new DOMPoint(0, 0, -DZ3D_DEPTH));
  return { x: p.x - o.x, y: p.y - o.y };
}

/* pega el manejador Z al borde derecho del plano activo, a su profundidad */
function dz3dZHandlePlace() {
  const d3 = DZ.d3, zh = $("#dz3dZH");
  if (!d3 || !zh || d3.act < 0) return;
  const el = d3.els[d3.act];
  const z = parseFloat(el.getAttribute("data-z")) || 0;
  const W = (d3.vb && d3.vb[2]) || 1080;
  zh.style.transform =
    `translateZ(${(-z * DZ3D_DEPTH).toFixed(1)}px) translate(${W / 2 + 30}px, 0)`;
}

/* malla de edición + reglas X·Y + capa de guías del plano — UI del visor:
   vive SOLO en el svg del plano, jamás se guarda al archivo */
function dz3dPlaneUI(cs, vb, contentNode) {
  const [x0, y0, W, H] = [vb[0], vb[1], vb[2] || 1080, vb[3] || 1080];
  const mk = (tag, at) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in at) n.setAttribute(k, at[k]);
    return n;
  };
  const step = W > 1600 ? 100 : 50, major = step * 2;
  // malla (detrás del dibujo)
  const mesh = mk("g", { "data-dz3d": "mesh", class: "dz3d-mesh" });
  for (let x = x0; x <= x0 + W + 0.1; x += step)
    mesh.appendChild(mk("line", { x1: x, y1: y0, x2: x, y2: y0 + H,
      class: (x - x0) % major === 0 ? "mj" : "mn" }));
  for (let y = y0; y <= y0 + H + 0.1; y += step)
    mesh.appendChild(mk("line", { x1: x0, y1: y, x2: x0 + W, y2: y,
      class: (y - y0) % major === 0 ? "mj" : "mn" }));
  cs.appendChild(mesh);
  cs.appendChild(contentNode);
  // reglas: X arriba (rojo) · Y a la izquierda (verde), en unidades del lienzo
  const rul = mk("g", { "data-dz3d": "rulers", class: "dz3d-rulers" });
  rul.appendChild(mk("rect", { x: x0, y: y0, width: W, height: 17, class: "rbg" }));
  rul.appendChild(mk("rect", { x: x0, y: y0, width: 17, height: H, class: "rbg" }));
  for (let x = x0; x <= x0 + W + 0.1; x += step) {
    const mj = (x - x0) % major === 0;
    rul.appendChild(mk("line", { x1: x, y1: y0, x2: x, y2: y0 + (mj ? 13 : 7), class: "rx" }));
    if (mj && x > x0) {
      const t = mk("text", { x: x + 3, y: y0 + 13, class: "rt" });
      t.textContent = x; rul.appendChild(t);
    }
  }
  for (let y = y0; y <= y0 + H + 0.1; y += step) {
    const mj = (y - y0) % major === 0;
    rul.appendChild(mk("line", { x1: x0, y1: y, x2: x0 + (mj ? 13 : 7), y2: y, class: "ry" }));
    if (mj && y > y0) {
      const t = mk("text", { x: x0 + 3, y: y - 4, class: "rt" });
      t.textContent = y; rul.appendChild(t);
    }
  }
  cs.appendChild(rul);
  cs.appendChild(mk("g", { "data-dz3d": "guides" }));
}

/* refresca el contenido del plano i desde el svg real (tras dibujar/mover) */
function dz3dSyncCard(i) {
  const d3 = DZ.d3; if (!d3) return;
  const card = document.querySelector(`#dz3dWorld .dz3d-card[data-i="${i}"]`);
  const el = d3.els[i];
  if (!card || !el) return;
  const cs = card.querySelector("svg");
  const clone = el.cloneNode(true);
  clone.setAttribute("data-dz3d", "content");
  cs.replaceChild(clone, cs.querySelector('[data-dz3d="content"]'));
  dz3dCardZ(card, el);
}

function dz3dWireCard(card, cs, el, i) {
  cs.addEventListener("pointerdown", e => {
    e.stopPropagation();
    const d3 = DZ.d3;
    if (d3.act !== i) { dz3dActivate(i); return; }     // 1er clic: activar el plano
    const tool = DZ.tool || "select";

    // ── dibujo 2D sobre el plano activo (lápiz / pincel) ──
    if (tool === "pencil" || tool === "brush") {
      const pts = [[e.offsetX, e.offsetY, e.pressure || 0.5]];
      const live = document.createElementNS(SVGNS, "path");
      live.setAttribute("fill", "none");
      live.setAttribute("stroke", $("#dzPStroke").value || "#1a1a1a");
      live.setAttribute("stroke-width", +$("#dzDrawW").value || 6);
      live.setAttribute("stroke-linecap", "round");
      live.setAttribute("opacity", "0.8");
      cs.appendChild(live);
      cs.setPointerCapture(e.pointerId);
      const move = ev => {
        pts.push([ev.offsetX, ev.offsetY, ev.pressure || 0.5]);
        live.setAttribute("d", "M " + pts.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L "));
      };
      const up = () => {
        cs.removeEventListener("pointermove", move); cs.removeEventListener("pointerup", up);
        live.remove();
        if (pts.length < 3) return;
        dzSnapshot();
        const refined = dzRefineStroke(pts);
        const color = $("#dzPStroke").value || "#1a1a1a";
        const w = +$("#dzDrawW").value || 6;
        let stroke;
        if (tool === "brush") stroke = dzBrushRibbon(refined, w, color);
        else {
          stroke = document.createElementNS(SVGNS, "path");
          stroke.setAttribute("d", dzSmoothPath(refined));
          stroke.setAttribute("fill", "none");
          stroke.setAttribute("stroke", color);
          stroke.setAttribute("stroke-width", w);
          stroke.setAttribute("stroke-linecap", "round");
          stroke.setAttribute("stroke-linejoin", "round");
          stroke.setAttribute("data-low", "pencil");
        }
        if (!stroke) return;
        // al grupo activo si es <g>; si no, al lienzo con el mismo data-z
        if (el.tagName.toLowerCase() === "g") el.appendChild(stroke);
        else {
          const z = el.getAttribute("data-z");
          if (z) stroke.setAttribute("data-z", z);
          el.parentNode.insertBefore(stroke, el.nextSibling);
          DZ.dirty = true; dzPersist(); dz3dBuild();   // capa nueva → replanificar planos
          return;
        }
        DZ.dirty = true; dzPersist();
        dz3dSyncCard(i);
        dzBuildLayers();
      };
      cs.addEventListener("pointermove", move);
      cs.addEventListener("pointerup", up);
      e.preventDefault();
      return;
    }

    // ── mover la capa DENTRO de su plano (ejes X·Y locales) con guías ──
    if (tool === "select" || tool === "direct") {
      const sx = e.offsetX, sy = e.offsetY;
      const clone = cs.querySelector('[data-dz3d="content"]');
      const start = dzReadPos(clone);
      const guides = cs.querySelector('[data-dz3d="guides"]');
      const vb = (cs.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
      const [x0, y0, W, H] = [vb[0], vb[1], vb[2] || 1080, vb[3] || 1080];
      // guías inteligentes: centro y bordes del lienzo + centros de las otras capas
      let b0 = null;
      try { b0 = clone.getBBox(); } catch (err) { /* sin render */ }
      const tX = [x0 + W / 2], tY = [y0 + H / 2];
      document.querySelectorAll("#dz3dWorld .dz3d-card").forEach(c => {
        if (+c.dataset.i === i) return;
        try {
          const b = c.querySelector('[data-dz3d="content"]').getBBox();
          if (b.width || b.height) { tX.push(b.x + b.width / 2); tY.push(b.y + b.height / 2); }
        } catch (err) { /* vacía */ }
      });
      const SNAP = 8;
      let dx = 0, dy = 0;
      cs.setPointerCapture(e.pointerId);
      const move = ev => {
        dx = ev.offsetX - sx; dy = ev.offsetY - sy;
        guides.innerHTML = "";
        if (b0 && !ev.altKey) {                       // Alt = mover libre, sin imán
          const cx = b0.x + b0.width / 2 + dx, cy = b0.y + b0.height / 2 + dy;
          let gx = null, gy = null;
          for (const t of tX) if (Math.abs(cx - t) < SNAP) { dx += t - cx; gx = t; break; }
          for (const t of tY) if (Math.abs(cy - t) < SNAP) { dy += t - cy; gy = t; break; }
          if (gx === null && Math.abs(b0.x + dx - x0) < SNAP) { dx = x0 - b0.x; gx = x0; }
          if (gx === null && Math.abs(b0.x + b0.width + dx - (x0 + W)) < SNAP) { dx = x0 + W - b0.x - b0.width; gx = x0 + W; }
          if (gy === null && Math.abs(b0.y + dy - y0) < SNAP) { dy = y0 - b0.y; gy = y0; }
          if (gy === null && Math.abs(b0.y + b0.height + dy - (y0 + H)) < SNAP) { dy = y0 + H - b0.y - b0.height; gy = y0 + H; }
          const gl = (x1, y1, x2, y2) => {
            const l = document.createElementNS(SVGNS, "line");
            l.setAttribute("x1", x1); l.setAttribute("y1", y1);
            l.setAttribute("x2", x2); l.setAttribute("y2", y2);
            l.setAttribute("class", "dz3d-gl");
            guides.appendChild(l);
          };
          if (gx !== null) gl(gx, y0, gx, y0 + H);
          if (gy !== null) gl(x0, gy, x0 + W, gy);
        }
        dzWritePos(clone, start, dx, dy);
      };
      const up = () => {
        cs.removeEventListener("pointermove", move); cs.removeEventListener("pointerup", up);
        guides.innerHTML = "";
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        dzSnapshot();
        dzWritePos(el, dzReadPos(el), dx, dy);
        DZ.dirty = true; dzPersist();
        dz3dSyncCard(i);
      };
      cs.addEventListener("pointermove", move);
      cs.addEventListener("pointerup", up);
      e.preventDefault();
    }
  });
}

function dz3dExit(silent) {
  const stage = $("#dz3dStage"); if (stage) stage.remove();
  const svg = $("#dzCanvas").querySelector("svg");
  if (svg) svg.style.visibility = "";
  $("#dz3DBtn").classList.remove("active");
  DZ.d3 = null;
  if (!silent) {
    dzPersist();
    dzBuildLayers();
    dzApplyZoom();
    dzSetStatus("Lienzo plano — la profundidad Z de cada capa quedó guardada (diorama/parallax)");
  }
}

const DZ_SKIP_TAGS = ["defs", "title", "desc", "style", "metadata", "lineargradient",
                      "radialgradient", "filter", "clippath", "mask", "symbol"];
function dzLayerLabel(el) {
  const t = el.tagName.toLowerCase();
  if (t === "text" || t === "tspan") return "T «" + (el.textContent || "").trim().slice(0, 16) + "»";
  if (el.id) return t + " #" + el.id;
  const f = el.getAttribute("fill");
  return t + (f && f !== "none" ? " · " + f : "");
}
/* Panel de capas por COLUMNAS estilo Toon Boom: visibilidad · candado ·
   color · nombre (con jerarquía padre/hijo) · opacidad · profundidad Z.
   La profundidad Z es la superposición del multiplano (parallax/diorama). */
function dzBuildLayers() {
  const box = $("#dzLayers");
  if (!box) return;
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) { box.innerHTML = ""; return; }
  const kids = [...svg.children].filter(n => !DZ_SKIP_TAGS.includes(n.tagName.toLowerCase())
    && !(n.classList && (n.classList.contains("dz-onion") || n.classList.contains("dz-penui"))));
  if (!kids.length) { box.innerHTML = ""; return; }
  box.innerHTML =
    '<div class="dz-layers-h">CAPAS <span class="dz-hint">arrastrá: reordena · Alt+soltar: emparenta · doble clic: renombra</span></div>' +
    '<div class="dz-lay-head"><span title="Visible">👁</span><span title="Bloquear">🔒</span>' +
    '<span></span><span class="dz-lh-name">Nombre</span>' +
    '<span class="dz-lh-op" title="Opacidad %">OP</span>' +
    '<span class="dz-lh-z" title="Profundidad Z (superposición/multiplano)">Z</span></div>';
  // en DOM el último dibuja arriba → mostramos al frente primero (como Illustrator)
  [...kids].reverse().forEach(el => {
    box.appendChild(dzLayerRow(el, 0));
    // jerarquía: un grupo muestra sus hijos directos indentados (rig/superposición)
    if (el.tagName.toLowerCase() === "g" && !el.hasAttribute("data-collapsed")) {
      const sub = [...el.children].filter(n => !DZ_SKIP_TAGS.includes(n.tagName.toLowerCase()));
      [...sub].reverse().forEach(ch => box.appendChild(dzLayerRow(ch, 1)));
    }
  });
  dzZPanelRender();   // el diorama refleja los cambios de capas al instante
}

function dzLayerRow(el, depth) {
  const isGroup = el.tagName.toLowerCase() === "g" && depth === 0
    && [...el.children].some(n => !DZ_SKIP_TAGS.includes(n.tagName.toLowerCase()));
  const row = document.createElement("div");
  row.className = "dz-lay-row" + (el === DZ.sel ? " sel" : "") + (depth ? " child" : "");
  if (!depth) row.draggable = true;
  // 👁 visibilidad
  const hidden = el.getAttribute("display") === "none";
  const eye = document.createElement("span");
  eye.className = "dz-eye"; eye.textContent = hidden ? "◌" : "👁";
  eye.title = hidden ? "Mostrar" : "Ocultar";
  if (hidden) eye.style.opacity = ".4";
  eye.onclick = (e) => { e.stopPropagation(); dzSnapshot();
    hidden ? el.removeAttribute("display") : el.setAttribute("display", "none");
    dzMarkDirty(); dzBuildLayers(); };
  // 🔒 candado
  const locked = el.hasAttribute("data-locked");
  const lock = document.createElement("span");
  lock.className = "dz-eye"; lock.textContent = locked ? "🔒" : "🔓";
  lock.title = locked ? "Desbloquear" : "Bloquear";
  lock.style.opacity = locked ? "1" : "0.4";
  lock.onclick = (e) => { e.stopPropagation(); dzSnapshot();
    if (locked) el.removeAttribute("data-locked"); else el.setAttribute("data-locked", "1");
    if (!locked && el === DZ.sel) dzDeselect();
    dzMarkDirty(); dzBuildLayers(); };
  // ▦ color / disclosure de grupo
  const chip = document.createElement("span");
  if (isGroup) {
    chip.className = "dz-lay-disc";
    chip.textContent = el.hasAttribute("data-collapsed") ? "▸" : "▾";
    chip.title = "Plegar / desplegar el grupo";
    chip.onclick = (e) => { e.stopPropagation();
      if (el.hasAttribute("data-collapsed")) el.removeAttribute("data-collapsed");
      else el.setAttribute("data-collapsed", "1");
      dzBuildLayers(); };
  } else {
    chip.className = "dz-chipcolor";
    const f = el.getAttribute("fill"), st = el.getAttribute("stroke");
    chip.style.background = (f && f !== "none" ? f : st && st !== "none" ? st : "transparent");
  }
  // nombre (indentado si es hijo)
  const lbl = document.createElement("span");
  lbl.className = "dz-layer-t";
  lbl.style.paddingLeft = (depth * 12) + "px";
  lbl.textContent = el.id ? el.id : dzLayerLabel(el);
  lbl.ondblclick = (e) => {
    e.stopPropagation();
    const name = prompt("Nombre de la capa (para vos y para el rig):", el.id || "");
    if (name === null) return;
    dzSnapshot();
    const clean = name.trim().replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]/g, "_");
    if (clean) el.id = clean; else el.removeAttribute("id");
    dzMarkDirty(); dzBuildLayers();
  };
  // opacidad (columna Toon Boom)
  const op = document.createElement("input");
  op.className = "dz-lay-op"; op.type = "number"; op.min = 0; op.max = 100;
  const curOp = el.getAttribute("opacity");
  op.value = curOp == null ? 100 : Math.round(parseFloat(curOp) * 100);
  op.title = "Opacidad %";
  op.onclick = (e) => e.stopPropagation();
  op.onchange = (e) => { dzSnapshot();
    const v = Math.max(0, Math.min(100, +e.target.value || 0));
    if (v >= 100) el.removeAttribute("opacity"); else el.setAttribute("opacity", (v / 100).toFixed(2));
    dzMarkDirty(); };
  // profundidad Z (superposición / multiplano)
  const z = document.createElement("input");
  z.className = "dz-lay-z"; z.type = "number"; z.step = 10;
  z.value = parseFloat(el.getAttribute("data-z")) || 0;
  z.title = "Profundidad Z: negativo = cerca de cámara, 0 = plano de acción, positivo = fondo";
  z.onclick = (e) => e.stopPropagation();
  z.onchange = (e) => { dzSnapshot();
    const v = Math.max(-60, Math.min(400, Math.round(+e.target.value || 0)));
    if (v === 0) el.removeAttribute("data-z"); else el.setAttribute("data-z", v);
    dzMarkDirty(); dzBuildLayers(); };
  row.append(eye, lock, chip, lbl, op, z);
  row.onclick = () => { if (!el.hasAttribute("data-locked")) dzSelect(el); };
  if (!depth) {
    row.ondragstart = (e) => { DZ.dragLayer = el; e.dataTransfer.effectAllowed = "move"; };
    row.ondragover = (e) => { e.preventDefault(); row.classList.add("dz-dropover"); };
    row.ondragleave = () => row.classList.remove("dz-dropover");
    row.ondrop = (e) => {
      e.preventDefault(); row.classList.remove("dz-dropover");
      const src = DZ.dragLayer; DZ.dragLayer = null;
      if (!src || src === el || el.contains(src) || src.contains(el)) return;
      dzSnapshot();
      if (e.altKey) {
        if (el.tagName.toLowerCase() === "g") {
          el.appendChild(src);
          dzSetStatus("⧉ «" + (src.id || src.tagName) + "» ahora es parte de «" + (el.id || "grupo") + "» — rota y se mueve con él");
        } else {
          const g = document.createElementNS(SVGNS, "g");
          el.parentNode.insertBefore(g, el);
          g.appendChild(el); g.appendChild(src);
          dzSetStatus("⧉ Grupo nuevo con ambos — nombralo con doble clic (Ctrl+Shift+G desagrupa)");
        }
      } else {
        el.parentNode.insertBefore(src, el.nextSibling);
      }
      dzMarkDirty(); dzBuildLayers(); dzPositionHandle();
    };
  }
  return row;
}

/* F7: mostrar/ocultar el panel de capas y superposiciones (el inspector) */
function dzLayersToggle() {
  const insp = $("#dzInspector");
  if (!insp) return;
  const hidden = insp.style.display === "none";
  insp.style.display = hidden ? "" : "none";
  dzSetStatus(hidden ? "" : "Panel de capas oculto (F7 para mostrarlo)");
}

/* ── alinear el elemento seleccionado respecto del lienzo (viewBox) ── */
function dzAlign(mode) {
  const el = DZ.sel;
  const svg = $("#dzCanvas").querySelector("svg");
  if (!el || !svg) return;
  dzSnapshot();
  const vb = (svg.getAttribute("viewBox") || "0 0 1080 1080").split(/\s+/).map(Number);
  const b = el.getBoundingClientRect();
  const p1 = dzToUser(b.left, b.top), p2 = dzToUser(b.right, b.bottom);
  let dx = 0, dy = 0;
  if (mode === "l") dx = vb[0] - p1.x;
  if (mode === "ch") dx = (vb[0] + vb[2] / 2) - (p1.x + p2.x) / 2;
  if (mode === "r") dx = (vb[0] + vb[2]) - p2.x;
  if (mode === "t") dy = vb[1] - p1.y;
  if (mode === "cv") dy = (vb[1] + vb[3] / 2) - (p1.y + p2.y) / 2;
  if (mode === "b") dy = (vb[1] + vb[3]) - p2.y;
  dzWritePos(el, dzReadPos(el), dx, dy);
  dzPositionHandle(); dzMarkDirty(); dzBuildInspector(el);
}

/* ── alineación ENTRE objetos + distribuir (multi-selección, estilo Illustrator) ── */
function dzSelBounds(els) {
  return els.map(el => {
    const b = el.getBoundingClientRect();
    const p1 = dzToUser(b.left, b.top), p2 = dzToUser(b.right, b.bottom);
    return { el, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
             cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2, w: p2.x - p1.x, h: p2.y - p1.y };
  });
}
function dzAlignSel(mode) {
  const els = (DZ.multi || []).length > 1 ? DZ.multi : null;
  if (!els) return;
  dzSnapshot();
  const bs = dzSelBounds(els);
  const L = Math.min(...bs.map(b => b.x1)), R = Math.max(...bs.map(b => b.x2));
  const T = Math.min(...bs.map(b => b.y1)), B = Math.max(...bs.map(b => b.y2));
  for (const b of bs) {
    let dx = 0, dy = 0;
    if (mode === "l") dx = L - b.x1;
    if (mode === "ch") dx = (L + R) / 2 - b.cx;
    if (mode === "r") dx = R - b.x2;
    if (mode === "t") dy = T - b.y1;
    if (mode === "cv") dy = (T + B) / 2 - b.cy;
    if (mode === "b") dy = B - b.y2;
    if (dx || dy) dzWritePos(b.el, dzReadPos(b.el), dx, dy);
  }
  dzPositionHandle(); dzMarkDirty();
  dzSetStatus("⧉ " + els.length + " alineados");
}
function dzDistribute(axis) {
  const els = (DZ.multi || []).length > 2 ? DZ.multi : null;
  if (!els) { dzSetStatus("distribuir necesita 3+ elementos (Shift+clic)"); return; }
  dzSnapshot();
  const bs = dzSelBounds(els).sort((a, b) => axis === "h" ? a.cx - b.cx : a.cy - b.cy);
  const first = bs[0], last = bs[bs.length - 1];
  const span = axis === "h" ? last.cx - first.cx : last.cy - first.cy;
  const step = span / (bs.length - 1);
  bs.forEach((b, i) => {
    if (i === 0 || i === bs.length - 1) return;
    const target = (axis === "h" ? first.cx : first.cy) + step * i;
    const d = target - (axis === "h" ? b.cx : b.cy);
    dzWritePos(b.el, dzReadPos(b.el), axis === "h" ? d : 0, axis === "h" ? 0 : d);
  });
  dzMarkDirty(); dzSetStatus("⧉ distribuidos con espaciado parejo");
}
/* voltear horizontal/vertical (uno o varios), anclado al centro local */
function dzFlip(axis) {
  const els = (DZ.multi || []).length > 1 ? DZ.multi : (DZ.sel ? [DZ.sel] : []);
  if (!els.length) return;
  dzSnapshot();
  for (const el of els) {
    let lb = null; try { lb = el.getBBox(); } catch (e) { continue; }
    const cx = lb.x + lb.width / 2, cy = lb.y + lb.height / 2;
    const sx = axis === "h" ? -1 : 1, sy = axis === "h" ? 1 : -1;
    const chunk = ` translate(${(cx * (1 - sx)).toFixed(2)} ${(cy * (1 - sy)).toFixed(2)}) scale(${sx} ${sy})`;
    const tr = el.getAttribute("transform") || "";
    el.setAttribute("transform", (tr ? tr + " " : "") + chunk.trim());
  }
  dzPositionHandle(); dzMarkDirty();
}

/* ── 🧬 Variaciones: el agente evoluciona el diseño y elegís con un clic.
   Cría selectiva de diseños — elegí una y volvé a evolucionar desde ella. ── */
async function dzVariations() {
  if (!DZ.path || DZ.busy) return;
  DZ.busy = true;
  dzSetStatus("🧬 Generando variaciones del diseño (4 direcciones en paralelo)…");
  try {
    // mandar el estado ACTUAL del lienzo (con tus últimos toques, aún sin guardar)
    const svg = $("#dzCanvas").querySelector("svg");
    const r = await api.design_variations(DZ.path, svg ? dzSerialize(svg) : "");
    const vs = (r && r.variants) || [];
    if (r && r.error) { dzSetStatus("❌ " + r.error); return; }
    if (!vs.length) { dzSetStatus("⚠ No salieron variaciones válidas — probá de nuevo (o cambiá de modelo)."); return; }
    openModal(`<h2>🧬 Variaciones</h2>
      <div class="sub">Clic en una para reemplazar el diseño — después podés volver a 🧬 y evolucionar desde ella. (Nada se guarda hasta que toques 💾.)</div>
      <div class="var-grid">` +
      vs.map((v, i) => `<div class="var-cell" data-i="${i}"><div class="var-tag">${v.dir}</div>${v.svg}</div>`).join("") +
      `</div><div class="m-actions"><button class="ghost" id="mCancel">Cerrar</button></div>`);
    document.querySelectorAll(".var-cell").forEach(c => c.onclick = () => {
      const v = vs[+c.dataset.i];
      $("#dzCodeArea").value = v.svg;
      dzApplyCode();
      closeModal();
      dzSetStatus("🧬 Aplicada la variación «" + v.dir + "» — 💾 para guardarla, o 🧬 para seguir evolucionando.");
    });
    $("#mCancel").onclick = closeModal;
    dzSetStatus("");
  } catch (e) {
    dzSetStatus("❌ " + (e.message || e));
  } finally {
    DZ.busy = false;
  }
}

/* ── open code design: ver/editar el SVG como código, lado a lado ── */
function dzToggleCode() {
  const panel = $("#dzCode");
  if (panel.hidden) {
    const svg = $("#dzCanvas").querySelector("svg");
    $("#dzCodeArea").value = svg ? dzSerialize(svg) : "";
    panel.hidden = false;
  } else {
    panel.hidden = true;
  }
}
/* reemplaza el svg del lienzo por otro (texto), conservando tirador/pin */
function dzApplySvgText(txt) {
  const cv = $("#dzCanvas");
  const handle = $("#dzHandle");
  const old = cv.querySelector("svg");
  const tmp = document.createElement("div"); tmp.innerHTML = txt;
  const nsvg = tmp.querySelector("svg");
  if (!nsvg) { sysMsg("❌ El código no tiene un <svg> válido."); return false; }
  if (old) old.remove();
  cv.insertBefore(nsvg, handle);
  if (!nsvg.getAttribute("width")) nsvg.style.width = "min(80vw, 900px)";
  DZ.sel = null; DZ.multi = []; dzNodesClear();
  $("#dzProps").hidden = true; $("#dzEmpty").hidden = false; handle.hidden = true;
  dzApplyZoom(); dzMarkDirty(); dzBuildLayers();
  if (DZ.anim) dzOnionUpdate();
  return true;
}
function dzApplyCode() {
  const txt = $("#dzCodeArea").value.trim();
  if (!txt) return;
  dzSnapshot();
  dzApplySvgText(txt);
}

/* ── deshacer/rehacer (Ctrl+Z / Ctrl+Y): fotos del SVG antes de cada cambio ── */
function dzSnapshot() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg) return;
  DZ.undo = DZ.undo || [];
  DZ.undo.push(dzSerialize(svg));
  if (DZ.undo.length > 50) DZ.undo.shift();
  DZ.redo = [];               // un cambio nuevo invalida los "rehacer"
}
function dzUndo() {
  if (!DZ.undo || !DZ.undo.length) { setStatus("(nada para deshacer)"); return; }
  const svg = $("#dzCanvas").querySelector("svg");
  if (svg) { DZ.redo = DZ.redo || []; DZ.redo.push(dzSerialize(svg)); }
  dzApplySvgText(DZ.undo.pop());
  setStatus("↩ deshecho");
}
function dzRedo() {
  if (!DZ.redo || !DZ.redo.length) return;
  const svg = $("#dzCanvas").querySelector("svg");
  if (svg) { DZ.undo = DZ.undo || []; DZ.undo.push(dzSerialize(svg)); }
  dzApplySvgText(DZ.redo.pop());
  setStatus("↪ rehecho");
}
/* serializa el svg sin las marcas de la UI (clase de selección) */
function dzSerialize(svg) {
  const c = svg.cloneNode(true);
  dzRigStrip(c);            // restaurar transform original: la pose vive en la escena
  c.querySelectorAll("g.dz-onion").forEach(n => n.remove());   // papel cebolla: solo UI
  c.querySelectorAll("g.dz-penui").forEach(n => n.remove());   // guías de la pluma: solo UI
  c.querySelectorAll("g.dz-vp-guides,[data-low='ruler-guide']").forEach(n => n.remove()); // guías de regla
  c.querySelectorAll(".dz-sel").forEach(n => n.classList.remove("dz-sel"));
  c.querySelectorAll(".dz-msel").forEach(n => n.classList.remove("dz-msel"));
  c.querySelectorAll("[class='']").forEach(n => n.removeAttribute("class"));
  c.style.removeProperty("transform"); c.style.removeProperty("width");
  if (!c.getAttribute("style")) c.removeAttribute("style");   // no dejar style="" vacío
  return c.outerHTML;
}

/* ── chat del diseño: pedirle una corrección al agente sin salir del editor ── */
function dzSetStatus(txt) {
  const el = $("#dzStatus");
  const sb = $("#sbHint");
  if (sb) sb.textContent = txt || "";
  if (!txt) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false; el.textContent = txt;
}
async function designPrompt() {
  const ta = $("#dzPrompt");
  const text = ta.value.trim();
  if (!text || !DZ.path || DZ.busy) return;
  ta.value = "";
  DZ.busy = true;
  const tag = DZ.sel ? DZ.sel.tagName.toLowerCase() : null;
  dzSetStatus(tag ? `✍ LOW edita el <${tag}>…` : "✍ LOW está ajustando el diseño…");
  userMsg("🎨 " + (tag ? `[${tag}] ` : "") + text); persist("user", "(diseño) " + text);
  try {
    let msg;
    if (DZ.sel) {
      // MODO COMENTARIO/PIN: el cambio aplica SOLO al elemento marcado. Le paso el
      // código exacto del elemento como ancla para que edit_file sea preciso.
      const exact = dzElementCode(DZ.sel);
      msg = "Estás editando el SVG «" + DZ.path + "» en el editor de diseño de LOW. " +
        "El usuario dejó un comentario sobre UN elemento puntual. Modificá SOLO ese elemento " +
        "(no toques el resto del SVG) con edit_file, usando este fragmento exacto como old_text:\n" +
        "```\n" + exact + "\n```\n" +
        "Comentario del usuario: " + text +
        "\nMantené el viewBox y que quede dentro del lienzo. Confirmá en una línea qué cambiaste.";
    } else {
      msg = "Estás editando el SVG «" + DZ.path + "» abierto en el editor de diseño de LOW. " +
        "Aplicá SOLO este cambio con edit_file (mantené el viewBox y todo dentro del lienzo, " +
        "prolijo y alineado): " + text +
        "\nConfirmá en una línea qué cambiaste.";
    }
    const r = await api.send_chat(msg, "", "xml", null);
    const reply = (r && (r.full || r.text)) || "";
    dzSetStatus(reply ? reply.slice(0, 300) : (r && r.status) || "Listo.");
  } catch (e) {
    dzSetStatus("❌ " + (e.message || e));
  } finally {
    DZ.busy = false;
  }
}

/* código exacto de un elemento (sin marcas de UI) para anclar el edit_file */
function dzElementCode(el) {
  const c = el.cloneNode(true);
  c.classList.remove("dz-sel");
  if (!c.getAttribute("class")) c.removeAttribute("class");
  return c.outerHTML;
}

const dzGet = (el, attr, cssProp) => el.getAttribute(attr) ||
  (cssProp ? getComputedStyle(el)[cssProp] : "") || "";

function dzField(label, id, value, type) {
  const v = (value == null ? "" : String(value)).replace(/"/g, "&quot;");
  return `<div class="dz-field"><label>${label}</label>` +
    `<input id="${id}" type="${type || "text"}" value="${v}"></div>`;
}

function dzBuildInspector(el) {
  const tag = el.tagName.toLowerCase();
  const P = $("#dzProps");
  const isText = tag === "text" || tag === "tspan";
  let html = `<div class="dz-tag">&lt;${tag}&gt;</div>`;
  // alinear respecto del lienzo
  html += `<div class="dz-field"><label>Alinear al lienzo</label><div class="dz-alignrow">` +
    `<span class="dz-al" data-al="l" title="Izquierda">⇤</span>` +
    `<span class="dz-al" data-al="ch" title="Centro horizontal">↔</span>` +
    `<span class="dz-al" data-al="r" title="Derecha">⇥</span>` +
    `<span class="dz-al" data-al="t" title="Arriba">⤒</span>` +
    `<span class="dz-al" data-al="cv" title="Centro vertical">↕</span>` +
    `<span class="dz-al" data-al="b" title="Abajo">⤓</span>` +
    `</div></div>`;
  html += `<div class="dz-field"><label>Voltear</label><div class="dz-alignrow">` +
    `<span class="dz-al" data-flip="h" title="Voltear horizontal">⇋</span>` +
    `<span class="dz-al" data-flip="v" title="Voltear vertical">⇵</span>` +
    `</div></div>`;
  if ((DZ.multi || []).length > 1) {
    html += `<div class="dz-field"><label>⧉ Entre los ${DZ.multi.length} seleccionados</label><div class="dz-alignrow">` +
      `<span class="dz-al" data-alsel="l" title="Izquierdas juntas">⇤</span>` +
      `<span class="dz-al" data-alsel="ch" title="Centros verticales">↔</span>` +
      `<span class="dz-al" data-alsel="r" title="Derechas juntas">⇥</span>` +
      `<span class="dz-al" data-alsel="t" title="Arribas juntas">⤒</span>` +
      `<span class="dz-al" data-alsel="cv" title="Centros horizontales">↕</span>` +
      `<span class="dz-al" data-alsel="b" title="Abajos juntas">⤓</span>` +
      `</div><div class="dz-alignrow" style="margin-top:4px">` +
      `<span class="dz-al" data-dist="h" title="Distribuir horizontal (3+)">⇹</span>` +
      `<span class="dz-al" data-dist="v" title="Distribuir vertical (3+)">⇳</span>` +
      `</div></div>`;
  }
  // color de relleno y trazo (picker + texto para aceptar none/hex/nombre)
  html += `<div class="dz-field"><label>Relleno (fill)</label><div class="dz-row">` +
    `<input id="dzFillC" type="color" value="${dzHex(dzGet(el, "fill", "fill"))}" style="width:44px">` +
    `<input id="dzFill" type="text" value="${dzGet(el, "fill", "fill")}" style="flex:1"></div></div>`;
  html += `<div class="dz-field"><label>Trazo (stroke)</label><div class="dz-row">` +
    `<input id="dzStrokeC" type="color" value="${dzHex(dzGet(el, "stroke", "stroke"))}" style="width:44px">` +
    `<input id="dzStroke" type="text" value="${dzGet(el, "stroke", "stroke")}" style="flex:1"></div></div>`;
  html += `<div class="dz-row">` +
    dzField("Grosor trazo", "dzSW", dzGet(el, "stroke-width", ""), "number") +
    dzField("Opacidad", "dzOp", dzGet(el, "opacity", "opacity"), "number") + `</div>`;
  // multiplano: profundidad respecto de la cámara (0 = plano de acción,
  // positivo = fondo lejano se mueve menos, negativo = primer plano más rápido)
  html += `<div class="dz-row">` +
    dzField("Profundidad Z 📹", "dzZ", el.getAttribute("data-z") || "", "number") +
    `<div class="dz-field"><label>&nbsp;</label><div class="dz-hint">0=acción · +lejos · −cerca</div></div></div>`;
  if (isText) {
    html += `<div class="dz-field"><label>Texto</label><input id="dzText" type="text" value="${(el.textContent || "").replace(/"/g, "&quot;")}"></div>`;
    const fam = dzGet(el, "font-family", "fontFamily").replace(/["']/g, "");
    html += `<div class="dz-field"><label>Tipografía</label><select id="dzFont">` +
      DZ_FONTS.map(f => `<option ${fam.indexOf(f) === 0 ? "selected" : ""}>${f}</option>`).join("") +
      `</select></div>`;
    html += `<div class="dz-row">` +
      dzField("Tamaño", "dzFS", parseFloat(dzGet(el, "font-size", "fontSize")) || "", "number") +
      `<div class="dz-field"><label>Peso</label><select id="dzFW">` +
      ["normal", "bold", "300", "400", "500", "600", "700", "800", "900"].map(w =>
        `<option ${String(dzGet(el, "font-weight", "fontWeight")) === w ? "selected" : ""}>${w}</option>`).join("") +
      `</select></div></div>`;
    const anc = dzGet(el, "text-anchor", "") || "start";
    html += `<div class="dz-field"><label>Alineación del texto</label><div class="dz-alignrow">` +
      `<span class="dz-al${anc === "start" ? " on" : ""}" data-anchor="start" title="Izquierda">⤆</span>` +
      `<span class="dz-al${anc === "middle" ? " on" : ""}" data-anchor="middle" title="Centrado">☰</span>` +
      `<span class="dz-al${anc === "end" ? " on" : ""}" data-anchor="end" title="Derecha">⤇</span>` +
      `<span class="dz-al${dzGet(el, "font-style", "") === "italic" ? " on" : ""}" data-italic="1" title="Cursiva"><i>I</i></span>` +
      `</div></div>`;
    html += `<div class="dz-field"><label>Pares sugeridos</label><div class="dz-suggest">` +
      DZ_PAIRS.map((p, i) => `<span class="dz-chip" data-pair="${i}">${p[0]} / ${p[1]}</span>`).join("") +
      `</div><div class="dz-hint">Aplica la tipografía de título al elemento.</div></div>`;
  }
  // posición: x/y (rect,text) o cx/cy (circle,ellipse)
  if (el.hasAttribute("x") || el.hasAttribute("y"))
    html += `<div class="dz-row">` + dzField("X", "dzX", dzGet(el, "x", ""), "number") +
      dzField("Y", "dzY", dzGet(el, "y", ""), "number") + `</div>`;
  else if (el.hasAttribute("cx") || el.hasAttribute("cy"))
    html += `<div class="dz-row">` + dzField("Centro X", "dzCX", dzGet(el, "cx", ""), "number") +
      dzField("Centro Y", "dzCY", dzGet(el, "cy", ""), "number") + `</div>`;
  if (el.hasAttribute("width") || el.hasAttribute("height"))
    html += `<div class="dz-row">` + dzField("Ancho", "dzW", dzGet(el, "width", ""), "number") +
      dzField("Alto", "dzH", dzGet(el, "height", ""), "number") + `</div>`;
  if (tag === "line")
    html += `<div class="dz-row">` + dzField("X1", "dzX1", dzGet(el, "x1", ""), "number") +
      dzField("Y1", "dzY1", dzGet(el, "y1", ""), "number") + `</div>` +
      `<div class="dz-row">` + dzField("X2", "dzX2", dzGet(el, "x2", ""), "number") +
      dzField("Y2", "dzY2", dzGet(el, "y2", ""), "number") + `</div>`;
  P.innerHTML = html; P.hidden = false; $("#dzEmpty").hidden = true;
  dzWire(el, isText);
}

// aplicar un atributo (o quitarlo si queda vacío) al elemento seleccionado
function dzSet(el, attr, val) {
  if (val === "" || val == null) el.removeAttribute(attr);
  else el.setAttribute(attr, val);
}
function dzWire(el, isText) {
  const on = (id, fn) => { const e = $("#" + id); if (e) e.addEventListener("input", fn); };
  on("dzFill", e => { dzSet(el, "fill", e.target.value); const c = $("#dzFillC"); if (c) c.value = dzHex(e.target.value); });
  on("dzFillC", e => { dzSet(el, "fill", e.target.value); $("#dzFill").value = e.target.value; });
  on("dzStroke", e => { dzSet(el, "stroke", e.target.value); const c = $("#dzStrokeC"); if (c) c.value = dzHex(e.target.value); });
  on("dzStrokeC", e => { dzSet(el, "stroke", e.target.value); $("#dzStroke").value = e.target.value; });
  on("dzSW", e => dzSet(el, "stroke-width", e.target.value));
  on("dzOp", e => dzSet(el, "opacity", e.target.value));
  on("dzZ", e => dzSet(el, "data-z", e.target.value));
  on("dzX", e => dzSet(el, "x", e.target.value));
  on("dzY", e => dzSet(el, "y", e.target.value));
  on("dzCX", e => dzSet(el, "cx", e.target.value));
  on("dzCY", e => dzSet(el, "cy", e.target.value));
  on("dzW", e => dzSet(el, "width", e.target.value));
  on("dzH", e => dzSet(el, "height", e.target.value));
  on("dzX1", e => dzSet(el, "x1", e.target.value));
  on("dzY1", e => dzSet(el, "y1", e.target.value));
  on("dzX2", e => dzSet(el, "x2", e.target.value));
  on("dzY2", e => dzSet(el, "y2", e.target.value));
  document.querySelectorAll("#dzProps .dz-al").forEach(b => b.onclick = () => {
    if (b.dataset.al) dzAlign(b.dataset.al);
    else if (b.dataset.flip) dzFlip(b.dataset.flip);
    else if (b.dataset.alsel) dzAlignSel(b.dataset.alsel);
    else if (b.dataset.dist) dzDistribute(b.dataset.dist);
    else if (b.dataset.anchor) { dzSnapshot(); dzSet(el, "text-anchor", b.dataset.anchor); dzBuildInspector(el); dzMarkDirty(); }
    else if (b.dataset.italic) { dzSnapshot();
      dzSet(el, "font-style", dzGet(el, "font-style", "") === "italic" ? "" : "italic");
      dzBuildInspector(el); dzMarkDirty(); }
  });
  if (isText) {
    on("dzText", e => { el.textContent = e.target.value; });
    on("dzFont", e => dzSet(el, "font-family", e.target.value));
    on("dzFS", e => dzSet(el, "font-size", e.target.value));
    on("dzFW", e => dzSet(el, "font-weight", e.target.value));
    document.querySelectorAll("#dzProps .dz-chip").forEach(ch => ch.onclick = () => {
      const pair = DZ_PAIRS[+ch.dataset.pair];
      dzSet(el, "font-family", pair[0]);
      const sel = $("#dzFont"); if (sel) sel.value = DZ_FONTS.includes(pair[0]) ? pair[0] : sel.value;
    });
  }
}

// normaliza un color SVG (nombre/hex/rgb) a #rrggbb para el <input type=color>
function dzHex(c) {
  c = (c || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c.slice(1).split("").map(x => x + x).join("");
  try {
    const cx = document.createElement("canvas").getContext("2d");
    cx.fillStyle = "#000"; cx.fillStyle = c;
    if (/^#[0-9a-f]{6}$/i.test(cx.fillStyle)) return cx.fillStyle;
  } catch (e) { /* */ }
  return "#000000";
}

async function dzSave() {
  const svg = $("#dzCanvas").querySelector("svg");
  if (!svg || !DZ.path) return;
  const r = await api.save_file(DZ.path, dzSerialize(svg));
  if (r) { DZ.dirty = false; setStatus("💾 " + (r.name || "diseño guardado")); sysMsg("💾 Diseño guardado: " + (r.name || DZ.path)); }
}

/* ── Herramientas del agente (qué puede hacer solo) ── */
function modalTools() {
  const rows = (S.agentTools || []).map(t =>
    `<div class="listrow"><span class="lr-name">${t.name}</span>` +
    `<span class="lr-desc">${(t.desc || "").replace(/</g, "&lt;")}</span></div>`).join("");
  openModal(`<h2>Herramientas del agente</h2>
    <div class="sub">Lo que LOW puede hacer por su cuenta cuando le pedís algo. No hay filtros ocultos.</div>
    ${rows || '<div class="sub">—</div>'}
    <div class="m-actions"><button class="primary" id="mCancel">Cerrar</button></div>`);
  $("#mCancel").onclick = closeModal;
}

/* ── Plantillas de órdenes: un clic las carga en el input ── */
const TEMPLATES = [
  ["Crear una app web", "Creá una app web completa en un solo archivo HTML (con CSS y JS embebidos) que "],
  ["Explicar el código", "Explicá qué hace el código del editor, paso a paso y en criollo."],
  ["Encontrar bugs", "Revisá el código del editor y encontrá bugs o casos borde que fallen. Listalos."],
  ["Escribir tests", "Escribí tests para el código del editor y corrélos para verificar que pasan."],
  ["Refactorizar", "Refactorizá el código del editor para que sea más legible, sin cambiar su comportamiento."],
  ["Documentar", "Agregá comentarios y docstrings claros al código del editor."],
  ["Juego en HTML", "Hacé un juego simple jugable en un solo archivo HTML (canvas + JS), sin dependencias."],
];
/* ── Rutinas: órdenes reutilizables (predefinidas + guardadas por el usuario) ──
   Clic ▶ ejecuta al instante · clic en el nombre la carga en el input para editar */
function modalRoutines() {
  const user = (S.routines || []).map((r, i) =>
    `<div class="listrow"><span class="lr-name rt-fill" data-p="${esc(r.prompt)}">${esc(r.name)}</span>` +
    `<span class="lr-desc">${esc(r.prompt).slice(0, 70)}…</span>` +
    `<div class="rt-actions"><span class="rt-run" data-p="${esc(r.prompt)}">▶ ejecutar</span>` +
    `<span class="rt-del" data-n="${esc(r.name)}">✕</span></div></div>`).join("");
  const built = TEMPLATES.map(t =>
    `<div class="listrow"><span class="lr-name rt-fill" data-p="${esc(t[1])}">${esc(t[0])}</span>` +
    `<span class="lr-desc">${esc(t[1]).slice(0, 70)}…</span>` +
    `<div class="rt-actions"><span class="rt-run" data-p="${esc(t[1])}">▶ ejecutar</span></div></div>`).join("");
  openModal(`<h2>Rutinas</h2>
    <div class="sub">Órdenes reutilizables. <b>▶ ejecutar</b> la manda ya; el nombre la carga en el input.</div>
    ${user ? '<div class="rt-group">Tuyas</div>' + user : ''}
    <div class="rt-group">Predefinidas</div>${built}
    <div class="rt-save">
      <input id="rtName" class="cmp-field" placeholder="Nombre de la rutina" spellcheck="false">
      <button class="ghost" id="rtSaveBtn">＋ Guardar la orden que está en el input</button>
    </div>
    <div class="m-actions"><button class="primary" id="mCancel">Cerrar</button></div>`);
  const fill = p => { $("#inp").value = p; closeModal(); $("#inp").focus(); };
  const runp = p => { closeModal(); $("#inp").value = p; send(); };
  document.querySelectorAll("#modal .rt-fill").forEach(e => e.onclick = () => fill(e.dataset.p));
  document.querySelectorAll("#modal .rt-run").forEach(e => e.onclick = () => runp(e.dataset.p));
  document.querySelectorAll("#modal .rt-del").forEach(e => e.onclick = async () => {
    const st = await api.delete_routine(e.dataset.n); S.routines = st.routines; modalRoutines();
  });
  $("#rtSaveBtn").onclick = async () => {
    const name = $("#rtName").value.trim();
    const prompt = $("#inp").value.trim();
    if (!name) { $("#rtName").focus(); return; }
    if (!prompt) { sysMsg("Escribí primero la orden en el cuadro de texto, después guardala como rutina."); return; }
    const st = await api.save_routine(name, prompt);
    S.routines = st.routines; modalRoutines();
  };
  $("#mCancel").onclick = closeModal;
}

/* ── Servidores SSH (alias para ssh_exec / scp_upload / /ssh) ── */
function modalServers() {
  const esc = v => (v == null ? "" : String(v)).replace(/"/g, "&quot;");
  const hosts = (S.sshHosts || []).map(h => ({ ...h }));   // copia editable
  openModal(`<h2>Servidores SSH</h2>
    <div class="sub">Guardá servidores para que el agente los use por alias
    (ssh_exec / scp_upload) o con <b>/ssh &lt;alias&gt; &lt;comando&gt;</b>.
    «clave» = ruta a tu clave privada (opcional si usás el agente SSH).</div>
    <div id="srvList"></div>
    <button class="ghost" id="srvAdd" style="margin-top:8px">＋ Agregar servidor</button>
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="mSave">Guardar</button>
    </div>`);
  const render = () => {
    const box = $("#srvList");
    box.innerHTML = "";
    if (!hosts.length) { box.innerHTML = '<div class="sub">Todavía no hay servidores.</div>'; return; }
    hosts.forEach((h, i) => {
      const row = document.createElement("div");
      row.className = "srv-row";
      row.innerHTML =
        `<input data-k="name" placeholder="alias" value="${esc(h.name)}" spellcheck="false">` +
        `<input data-k="user" placeholder="usuario" value="${esc(h.user)}" spellcheck="false">` +
        `<input data-k="host" placeholder="ip o dominio" value="${esc(h.host)}" spellcheck="false">` +
        `<input data-k="port" placeholder="22" value="${esc(h.port)}" class="srv-port" spellcheck="false">` +
        `<input data-k="key" placeholder="ruta clave (opcional)" value="${esc(h.key)}" spellcheck="false">` +
        `<button class="srv-del" title="Quitar">✕</button>`;
      row.querySelectorAll("input").forEach(inp => {
        inp.oninput = () => { hosts[i][inp.dataset.k] = inp.value; };
      });
      row.querySelector(".srv-del").onclick = () => { hosts.splice(i, 1); render(); };
      box.appendChild(row);
    });
  };
  render();
  $("#srvAdd").onclick = () => { hosts.push({ name: "", user: "", host: "", port: "", key: "" }); render(); };
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const r = await api.save_ssh_hosts(
      hosts.filter(h => (h.name || "").trim() && (h.host || "").trim()));
    S.sshHosts = r.ssh_hosts;
    closeModal();
    sysMsg(`✅ ${S.sshHosts.length} servidor(es) SSH guardado(s). Usalos por alias con ssh_exec o /ssh.`);
  };
}

/* ── Historial de conversaciones (clickeable → restaurar) ── */
async function modalHistory() {
  const files = await api.history();
  const rows = files.length ? files.map(f =>
    `<div class="listrow hist" data-id="${f.id}"><span class="lr-name">${f.id}</span>` +
    `<span class="lr-desc">${(f.first || "").replace(/</g, "&lt;")}</span></div>`).join("")
    : '<div class="sub">Todavía no hay conversaciones guardadas.</div>';
  openModal(`<h2>Historial de conversaciones</h2>
    <div class="sub">Un clic restaura la conversación en el chat.</div>
    ${rows}
    <div class="m-actions"><button class="primary" id="mCancel">Cerrar</button></div>`);
  document.querySelectorAll("#modal .hist").forEach(el => {
    el.onclick = () => { closeModal(); resume(el.dataset.id); };
  });
  $("#mCancel").onclick = closeModal;
}

/* ── barra de estado ── */
function updateLnCol() {
  const c = cm.getCursor();
  $("#lncol").textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
}
