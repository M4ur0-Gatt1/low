/* Fidel — frontend. Toda la lógica pesada vive en Python (main.py, js_api). */
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

/* ── errores SIEMPRE visibles: en el chat y en %APPDATA%/Fidel/fidel.log ── */
window.__errs = [];
function reportErr(msg) {
  window.__errs.push(msg);
  try { if (api) api.log_js(msg); } catch (e) { /* sin puente */ }
  try { sysMsg("❌ Error interno: " + msg); } catch (e) { /* UI no lista */ }
}
window.addEventListener("error", e =>
  reportErr(`${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", e =>
  reportErr("promesa rechazada: " + (e.reason && e.reason.message || e.reason)));

/* ── eventos que empuja Python ── */
window.Fidel = {
  onPy(m) {
    try {
      if (m.event === "tool") toolStep(m.data.name, m.data.res);
      if (m.event === "propose") propose(m.data.code);
      if (m.event === "status") setStatus(m.data);
      if (m.event === "sys") { sysMsg(m.data); persist("system", m.data); }
      if (m.event === "ws") setWs(m.data);
      if (m.event === "wrote") onWrote(m.data.path);
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
        else toolDesc = `🔧 ${toolName}`;
        setStatus(toolDesc);
        // indicador persistente: siempre a la vista donde está trabajando ahora
        setWorkingOn(fileName || toolDesc.replace(/^\S+\s*/, ""));
        // Mostrar mensaje temporal con detalles
        let msgText = toolDesc;
        if (toolRes && toolRes.length > 0) {
          msgText += `: ${toolRes.substring(0, 100)}${toolRes.length > 100 ? '...' : ''}`;
        }
        const tempMsg = sysMsg(msgText);
        setTimeout(() => tempMsg.remove(), 3000);
      }
    } catch (e) { reportErr("onPy(" + m.event + "): " + e.message); }
  },
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
  loadChatTabs().catch(() => {});
  bind();
  restorePanelSizes();
  initSplitters();
  sysMsg("Fidel v" + (S.version || "?") + " — listo.\n" +
         "⚙ API keys · 📁 proyecto · barra izquierda: 🧊 Artefactos (vista previa en vivo), " +
         "⟳ Rutinas, 🔧 Herramientas, 🖧 Servidores SSH, ⟲ Historial, ▦ Ranking.\n" +
         "El agente sabe git, ssh y scp: pedile «subí esto a github» o «entrá al server X y…».\n" +
         "Comandos: /commit /push /git /ssh /compare /ranking /undo /history /resume /run /files /search /preview · Zoom Ctrl +/−/0");
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
}

async function onWrote(path) {
  const r = await api.refresh_tree();
  S.tree = r.tree;
  renderTree();
  openFile(path);   // mostrar lo que generó el agente en el editor
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
  if (st.version) $("#ver").textContent = "Fidel v" + st.version;
  applyZoom(st.zoom || 1.0, true);
  document.body.classList.toggle("light", st.theme === "light");
  $("#btnTheme").innerHTML = icoUse(st.theme === "dark" ? "i-sun" : "i-moon");
  fillSelect($("#selProv"), st.providers.map(p => p.name), st.provider);
  fillSelect($("#selModel"), st.models, st.model);
  fillSelect($("#selLang"), ["auto", ...(st.langs || [])], "auto");
  S.tree = st.tree || [];
  $("#projName").textContent = st.ws ? st.ws.split(/[\\/]/).pop().toUpperCase() : "SIN PROYECTO";
  $("#branch").textContent = st.branch ? "⑂ " + st.branch : "";
  updApis(st);
  renderTree();
}

function updApis(st) {
  const n = st.apis;
  $("#apiTxt").textContent = `${n} API${n === 1 ? "" : "s"} conectada${n === 1 ? "" : "s"}`;
  $("#apiDot").classList.toggle("off", !n);
  const p = S.providers.find(x => x.name === $("#selProv").value);
  const ok = p && (p.has_key || p.name === "custom");
  $("#agBadge").textContent = ok ? "activo" : "sin key";
  $("#agBadge").classList.toggle("off", !ok);
  $("#provDot").classList.toggle("off", !ok);
}

function fillSelect(sel, values, cur) {
  sel.innerHTML = "";
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
    const r = await api.set_provider($("#selProv").value);
    fillSelect($("#selModel"), r.models, r.model);
    updApis(r);
    sysMsg(`Proveedor → ${$("#selProv").value} · ${r.model}`);
  };
  $("#selModel").onchange = () => api.set_model($("#selModel").value);
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
  $("#abRoutines").onclick = modalRoutines;
  $("#abTools").onclick = modalTools;
  $("#abServers").onclick = modalServers;
  $("#abHistory").onclick = modalHistory;
  $("#abRanking").onclick = () => { showLeaderboard(); };
  // visor de artefactos
  $("#artClose").onclick = closeArtifacts;
  $("#artReload").onclick = paintArtifact;
  $("#artSel").onchange = () => { S.artIdx = +$("#artSel").value; paintArtifact(); };
  $("#artExt").onclick = async () => {
    const a = (S.artifacts || [])[S.artIdx];
    if (a) await api.preview_html(a.path || "", a.html);
  };
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
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); run(); }
    if (e.ctrlKey && (e.key === "+" || e.key === "=")) { e.preventDefault(); applyZoom(S.zoom + 0.1); }
    if (e.ctrlKey && e.key === "-") { e.preventDefault(); applyZoom(S.zoom - 0.1); }
    if (e.ctrlKey && e.key === "0") { e.preventDefault(); applyZoom(1.0); }
    if (e.key === "Escape") {
      if (!$("#overlay").hidden) closeModal();         // 1º cierra modal abierto
      else if (!$("#artView").hidden) closeArtifacts(); // 2º cierra el visor de artefactos
      else if (S.busy) cancelRequest();                // 3º detiene consulta en curso
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
  document.title = "Fidel — " + t.name;
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

async function openFile(path) {
  const r = await api.open_file(path);
  if (r.error) return sysMsg("❌ " + r.error);
  addTab(r.path, r.name, r.content, r.lang);
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
  document.title = "Fidel — " + t.name;
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
      // HTML no se "ejecuta": se renderiza EN VIVO adentro de Fidel (artefacto)
      const name = t && t.name ? t.name : "vista previa.html";
      addArtifact(name, cm.getValue(), t && t.path ? t.path : "");
      showArtifacts();
      termLine("🎨 Artefacto renderizado dentro de Fidel (botón ⧉ para el navegador)", "t-ok");
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
function persist(role, content) { api && api.persist(role, content); }

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

function agentMsg(text) {
  const w = document.createElement("div");
  w.className = "m-agent";
  const h = document.createElement("div");
  h.className = "m-head";
  h.innerHTML = '<div class="m-ava">★</div>';
  const who = document.createElement("span");
  who.className = "m-who";
  who.textContent = "Fidel · " + $("#selModel").value;
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
function toolStep(name, res) {
  if (!S.plan) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<div class="card-h">Plan <span class="n">ejecutando…</span>' +
      '<div class="prog"><div></div></div></div><div class="card-b"></div>';
    $("#msgs").appendChild(card);
    S.plan = { card, steps: 0 };
  }
  const body = S.plan.card.querySelector(".card-b");
  const d = document.createElement("div");
  d.className = "step";
  const short = (res || "").split("\n")[0].slice(0, 60);
  d.innerHTML = `<span class="ck">✓</span> <span class="fn"></span> <span></span>`;
  d.children[1].textContent = name;
  d.children[2].textContent = short;
  body.appendChild(d);
  S.plan.steps++;
  S.plan.card.querySelector(".prog > div").style.width = Math.min(100, S.plan.steps * 25) + "%";
  scrollMsgs();
}

function planDone() {
  clearWorkingOn();
  if (!S.plan) return;
  S.plan.card.querySelector(".card-h .n").textContent = `${S.plan.steps}/${S.plan.steps}`;
  S.plan.card.querySelector(".prog > div").style.width = "100%";
  S.plan = null;
}

/* indicador en vivo de en qué archivo/acción está el agente ahora mismo */
function setWorkingOn(text) {
  const el = $("#workingOn");
  el.textContent = text;
  el.hidden = false;
}
function clearWorkingOn() {
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
  userMsg(msg, img ? `data:${img.mime};base64,${img.data}` : null);
  persist("user", msg || "(imagen adjunta)");
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
    if (r && r.streamed) { persist("Fidel", r.full || ""); }
    else if (r && r.text) { agentMsg(r.text); persist("Fidel", r.text); }
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
    else if (m.role === "Fidel") agentMsg(m.content);
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
    const tw = localStorage.getItem("fidel.tree.w"); if (tw) $("#treewrap").style.width = tw;
    const aw = localStorage.getItem("fidel.agent.w"); if (aw) $("#agentPanel").style.width = aw;
    const th = localStorage.getItem("fidel.term.h"); if (th) $("#termOut").style.height = th;
  } catch (e) { /* */ }
}
function initSplitters() {
  makeColSplitter($("#splitTree"), $("#treewrap"), "left", "fidel.tree.w");
  makeColSplitter($("#splitAgent"), $("#agentPanel"), "right", "fidel.agent.w");
  makeRowSplitter($("#splitTerm"), $("#termOut"), "fidel.term.h");
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const withKey = S.providers.filter(p => p.has_key);
  let rows = withKey.map(p =>
    `<label class="crow"><input type="checkbox" checked data-p="${p.name}">` +
    `<span>${p.name}</span><span class="cm-model">${p.model || ""}</span></label>`).join("");
  if (!withKey.length) rows = '<div class="sub">Ningún proveedor tiene API key configurada</div>';
  openModal(`
    <h2>Desafío de código</h2>
    <div class="sub">La misma consigna a cada modelo. Fidel compila, ejecuta y verifica
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
    <div class="sub">El system prompt completo que recibe el modelo — Fidel no
    agrega nada más, ni filtros ni instrucciones ocultas. Vacío = usar el de fábrica.</div>
    <textarea id="sysP" class="cmp-field" rows="4" spellcheck="false"></textarea>
    <h2 style="margin-top:16px">Límites del agente</h2>
    <div class="sub">Fidel no le pone techo al trabajo salvo lo que elijas acá (y el
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
    <div class="m-actions">
      <button class="ghost" id="mCancel">Cancelar</button>
      <button class="primary" id="mSave">Guardar</button>
    </div>`);
  api.config_path().then(p => { $("#cfgPath").textContent = "Se guardan en " + p; });
  $("#sysP").value = S.sysPrompt || "";
  $("#sysP").placeholder = S.defaultSp || "";
  $("#agSteps").value = S.agent.max_steps ?? 40;
  $("#agConts").value = S.agent.max_continuations ?? 25;
  $("#agMem").value = S.agent.memory_turns ?? 24;
  $("#agVerify").checked = S.agent.verify_runtime !== false;   // default: activado
  $("#mCancel").onclick = closeModal;
  $("#mSave").onclick = async () => {
    const keys = {};
    document.querySelectorAll('#modal input[type="password"]').forEach(i => { keys[i.dataset.p] = i.value.trim(); });
    S.sysPrompt = $("#sysP").value.trim();
    await api.save_system_prompt(S.sysPrompt);
    S.agent = await api.save_agent_config($("#agSteps").value, $("#agConts").value, $("#agMem").value, $("#agVerify").checked);
    const st = await api.save_keys(keys);
    S.providers = st.providers;
    updApis(st);
    closeModal();
    sysMsg("✅ Configuración guardada");
  };
}

function openModal(html) { $("#modal").innerHTML = html; $("#overlay").hidden = false; }
function closeModal() { $("#overlay").hidden = true; }

/* ══ Artefactos: vista previa en vivo del HTML/web generado, DENTRO de Fidel ══ */
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
  renderArtSelect();
}
function showArtifacts() {
  if (!(S.artifacts || []).length) { sysMsg("Todavía no hay artefactos — pedile al agente una página o app web, o abrí un .html y tocá ▶"); return; }
  $("#artView").hidden = false;
  paintArtifact();
}
function closeArtifacts() { $("#artView").hidden = true; }

/* ── Herramientas del agente (qué puede hacer solo) ── */
function modalTools() {
  const rows = (S.agentTools || []).map(t =>
    `<div class="listrow"><span class="lr-name">${t.name}</span>` +
    `<span class="lr-desc">${(t.desc || "").replace(/</g, "&lt;")}</span></div>`).join("");
  openModal(`<h2>Herramientas del agente</h2>
    <div class="sub">Lo que Fidel puede hacer por su cuenta cuando le pedís algo. No hay filtros ocultos.</div>
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
