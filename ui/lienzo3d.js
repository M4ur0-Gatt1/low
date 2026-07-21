/* ══ LIENZO 3D — dibujo con MALLAS reales (WebGL / Three.js) ══
   Distinto del "Espacio 3D" del estudio (SVG sobre planos): acá los trazos
   son geometría 3D de verdad — tubos con presión, luces, sombras y export
   GLB. Three.js r147 vendoreado (ui/vendor/three.min.js): sin toolchain,
   offline, como todo LOW.

   FASE 1 (esta): escena base — grilla infinita con niebla, luces con
   sombras, órbita/pan/zoom con inercia, toolbar flotante, render on-demand.
   FASE 2: pincel de tubos (presión + ancla de profundidad + espejo).
   FASE 3: edición con gizmos (mover/rotar/escalar).
   FASE 4: export GLB + bloom/DoF + guardado nativo.

   Estado en L3D (mismo patrón que DZ): un objeto módulo, funciones l3d*. */

const L3D = {
  open: false,
  renderer: null, scene: null, camera: null, controls: null,
  tool: "brush",          // brush | move | erase (Fases 2-3)
  dirty: true,            // render on-demand: solo dibuja si algo cambió
  raf: 0,
  strokes: [],            // Fase 2: [{points:[[x,y,z,p]...], mesh, color, width}]
};

function l3dToggle() { L3D.open ? l3dClose() : l3dOpen(); }

function l3dOpen() {
  const view = $("#l3dView");
  if (!view) return;
  if (typeof THREE === "undefined") return sysMsg(" Falta ui/vendor/three.min.js — reinstalá LOW.");
  view.hidden = false;
  const ab = $("#abL3d"); if (ab) ab.classList.add("active");
  if (!L3D.renderer) l3dInit();
  L3D.open = true;
  l3dResize();
  l3dInvalidate();
  l3dLoop();
  setStatus("Lienzo 3D — arrastrá: orbitar · rueda: zoom · Shift/medio: panear · Esc: salir");
}

function l3dClose() {
  L3D.open = false;
  cancelAnimationFrame(L3D.raf);
  const view = $("#l3dView"); if (view) view.hidden = true;
  const ab = $("#abL3d"); if (ab) ab.classList.remove("active");
  setStatus("Listo");
}

function l3dInit() {
  const host = $("#l3dCanvasHost");

  // ── renderer: antialias + sombras suaves + color correcto ──
  const r = new THREE.WebGLRenderer({ antialias: true });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.outputEncoding = THREE.sRGBEncoding;
  host.appendChild(r.domElement);
  // pointer capture tolerante: OrbitControls revienta si el pointer ya no
  // existe (stylus que se levanta rápido, eventos sintéticos del arnés)
  const rawCap = r.domElement.setPointerCapture.bind(r.domElement);
  const rawRel = r.domElement.releasePointerCapture.bind(r.domElement);
  r.domElement.setPointerCapture = id => { try { rawCap(id); } catch (err) { /* pointer ido */ } };
  r.domElement.releasePointerCapture = id => { try { rawRel(id); } catch (err) { /* pointer ido */ } };

  // ── escena: el mismo gris del Espacio 3D; la niebla "disuelve" el borde
  //    de la grilla → sensación de lienzo infinito ──
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xD9D9D6);
  scene.fog = new THREE.Fog(0xD9D9D6, 2600, 7000);

  const camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  camera.position.set(430, 400, 760);

  // ── luces: hemisferio (relleno suave) + sol con sombras ──
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8f8f89, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(650, 950, 420);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -1600; sun.shadow.camera.right = 1600;
  sun.shadow.camera.top = 1600; sun.shadow.camera.bottom = -1600;
  sun.shadow.camera.far = 5000;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // ── piso fantasma: SOLO recibe la sombra (no se ve un "suelo") ──
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20000, 20000),
    new THREE.ShadowMaterial({ opacity: 0.16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;               // apenas bajo la grilla: sin z-fighting
  ground.receiveShadow = true;
  scene.add(ground);

  // ── grilla doble escala + ejes (como los editores 3D pro) ──
  const grid = new THREE.GridHelper(4000, 40, 0x8f8f89, 0xc2c2bc);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);
  const axes = new THREE.AxesHelper(220);
  axes.position.y = 0.5;
  scene.add(axes);

  // ── órbita con inercia — mismo lenguaje del Espacio 3D del estudio ──
  const controls = new THREE.OrbitControls(camera, r.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 160, 0);
  controls.maxPolarAngle = Math.PI * 0.96;   // no atravesar el piso del todo
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,                // Fase 2: izquierdo = pincel; órbita pasa a fondo/derecho
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.addEventListener("change", l3dInvalidate);

  L3D.renderer = r; L3D.scene = scene; L3D.camera = camera; L3D.controls = controls;

  // ── toolbar flotante ──
  document.querySelectorAll("#l3dTools [data-l3dtool]").forEach(b =>
    b.onclick = () => l3dSetTool(b.dataset.l3dtool));
  const exit = $("#l3dExit"); if (exit) exit.onclick = l3dClose;

  window.addEventListener("resize", () => { if (L3D.open) l3dResize(); });
  document.addEventListener("keydown", e => {
    if (!L3D.open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); l3dClose(); }
  });
}

function l3dSetTool(t) {
  L3D.tool = t;
  document.querySelectorAll("#l3dTools [data-l3dtool]").forEach(b =>
    b.classList.toggle("active", b.dataset.l3dtool === t));
  const NAMES = { brush: "Pincel 3D (tubos — llega en Fase 2)",
                  move: "Mover/rotar/escalar (Fase 3)", erase: "Borrador (Fase 2)" };
  setStatus("Lienzo 3D · " + (NAMES[t] || t));
}

function l3dResize() {
  const host = $("#l3dCanvasHost");
  if (!host || !L3D.renderer) return;
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  L3D.camera.aspect = w / h;
  L3D.camera.updateProjectionMatrix();
  L3D.renderer.setSize(w, h);
  l3dInvalidate();
}

function l3dInvalidate() { L3D.dirty = true; }

/* bucle on-demand: la GPU descansa si no pasa nada (batería, ventilador) */
function l3dLoop() {
  if (!L3D.open) return;
  L3D.raf = requestAnimationFrame(l3dLoop);
  if (L3D.controls.update()) L3D.dirty = true;   // la inercia sigue moviendo la cámara
  if (L3D.dirty) {
    L3D.renderer.render(L3D.scene, L3D.camera);
    L3D.dirty = false;
  }
}
