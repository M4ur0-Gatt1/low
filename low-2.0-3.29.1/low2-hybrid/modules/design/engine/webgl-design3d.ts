/**
 * Motor de dibujo 3D estilo Feather para LOW 2.0 (backend WebGL / Three.js).
 *
 * PROFUNDIDAD: el lápiz emite un rayo de cámara y el punto se resuelve sobre una
 * SUPERFICIE (guía extruida, primitiva, o plano frontal por defecto). Nunca se
 * adivina Z.
 *
 * SISTEMA DE GUÍAS (Feather): la herramienta Guía extruye tu trazo a una
 * superficie translúcida perpendicular a la vista. Hay UNA guía activa a la vez
 * (una nueva reemplaza a la anterior; se puede borrar). Los trazos NO se borran
 * con la guía.
 *
 * Este archivo también implementa: vistas ortogonales (frente/lado/arriba) +
 * perspectiva, deshacer/rehacer (Ctrl+Z / Ctrl+Alt+Z / Ctrl+Shift+Z),
 * selección por click y por LAZO, mover y borrar selección, y goma con lazo.
 *
 * @module design/engine/webgl-design3d
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { lowStore, type LowStore } from '../../../store/low-store';
import type { BrushSettings, GizmoMode, SurfaceType, ToolType } from '../../../types/design-types';

export type Theme = 'light' | 'dark';
export type ViewName = 'persp' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';

interface SurfaceObj {
  id: string;
  type: SurfaceType;
  mesh: THREE.Mesh;
}

interface StrokeRecord {
  id: string;
  object: THREE.Object3D; // grupo (trazo) o malla (guía)
  points: THREE.Vector3[];
  /** Presión 0–1 por punto (mismo índice que `points`). Solo relevante para
   *  trazos ('stroke'); las guías no varían de ancho. */
  pressures: number[];
  kind: 'stroke' | 'guide';
  /** Capa/grupo al que pertenece el trazo (id del store). Determina
   *  visibilidad y opacidad grupal. */
  layerId: string;
  /** Opacidad propia del trazo (del pincel al crearlo); la opacidad efectiva
   *  es baseOpacity × opacidad de la capa. */
  baseOpacity: number;
}

interface Command {
  undo: () => void;
  redo: () => void;
}

interface HitInfo {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  noSupport?: boolean;
  /** Object3D que debe quedar bloqueado durante el gesto. */
  target?: THREE.Object3D;
  /** Plano matematico de respaldo cuando el target visible no recibe el rayo. */
  plane?: THREE.Plane;
  kind?: 'guide' | 'surface' | 'stroke' | 'fallback' | 'free';
}

export interface Low3DProject {
  format: 'low3d';
  version: 1;
  savedAt: string;
  camera: { view: ViewName; position: number[]; target: number[]; orthoSize: number };
  settings: { brush: BrushSettings; mirror: { x: boolean; y: boolean; z: boolean }; theme: Theme;
    activeSurface: ReturnType<typeof lowStore.getState>['activeSurface'] };
  layers: ReturnType<typeof lowStore.getState>['layers'];
  activeLayerId: string | null;
  strokes: Array<{
    id: string; layerId: string; points: number[][]; pressures: number[]; baseOpacity: number;
    position: number[]; quaternion: number[]; scale: number[];
  }>;
}

const MIN_SAMPLE_DIST = 0.012;
// salto máximo (mundo) entre puntos consecutivos de un trazo a mano alzada. Un
// rayo rasante sobre una superficie profunda (bóveda) puede devolver un punto
// lejísimo → recta larga espuria; se descarta ese salto irreal.
const MAX_DRAW_JUMP = 2.5;
const DRAG_THRESHOLD = 6; // px para distinguir click de arrastre
const ORTHO_SIZE = 4;
const NS = 'http://www.w3.org/2000/svg';

export class WebGLDesign3D {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private perspCamera!: THREE.PerspectiveCamera;
  private camera!: THREE.Camera & { position: THREE.Vector3 }; // cámara activa
  private controls!: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private surfacesGroup!: THREE.Group;
  private guidesGroup!: THREE.Group;
  private strokesGroup!: THREE.Group;
  private grid!: THREE.GridHelper;

  private surfaces: SurfaceObj[] = [];
  private strokes: StrokeRecord[] = [];
  // varias guías pueden coexistir (crear una nueva ya NO borra las
  // anteriores) — `activeGuide` es la más reciente, usada como fallback de
  // plano infinito en resolveHit; cualquiera se borra individualmente con la
  // goma (click sobre ella) o deleteGuide() borra la última.
  private guides: { id: string; mesh: THREE.Mesh; plane?: THREE.Plane }[] = [];
  private activeGuide: { id: string; mesh: THREE.Mesh; plane?: THREE.Plane } | null = null;
  // guía elegida con la herramienta 'move' (click sobre ella, sin arrastre
  // libre): el gizmo existente (translate/scale) se le adjunta directo, así
  // se puede mover y deformar sin código nuevo de arrastre. Mutuamente
  // excluyente con `selected` (elegir una cosa deselecciona la otra).
  private selectedGuide: { id: string; mesh: THREE.Mesh } | null = null;
  private selected = new Set<StrokeRecord>();

  private fallbackPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  private view: ViewName = 'persp';
  private orthoSize = ORTHO_SIZE;

  // dibujo libre ("en el aire"): en vez de proyectar sobre una guía/
  // superficie, el punto se calcula a una distancia fija de la cámara a lo
  // largo del rayo del cursor — esa distancia (`freeDrawDepth`) es la que se
  // ajusta con el scroll (ver onWheel). El OrbitControls.enableZoom se
  // desactiva mientras esta herramienta está activa para que el scroll no
  // termine haciendo las dos cosas (zoom Y profundidad) a la vez.
  private freeDrawDepth = 0; // 0 = todavía no inicializado, ver ensureFreeDrawDepth()
  private freeDrawPreview?: THREE.Mesh;
  private freeDepthEl!: HTMLDivElement;
  private static readonly FREE_DEPTH_MIN = 0.15;
  private static readonly FREE_DEPTH_MAX = 80;

  // liquify: arrastra los puntos de control de UN trazo hacia el pincel,
  // dentro de un radio, con caída suave — igual idea que el prototipo viejo
  // de `ui/lienzo3d.js` (`l3dLiquifyStroke`), portada al motor actual
  // (rebuildStrokeMesh + undo/redo). El radio de influencia reusa el slider
  // de tamaño de pincel existente (no hace falta un control nuevo).
  private liquifyStroke: StrokeRecord | null = null;
  private liquifyBefore: THREE.Vector3[] = [];
  private static readonly LIQUIFY_STRENGTH = 0.18;

  // interacción
  private mode: 'idle' | 'draw' | 'move' | 'lasso' | 'point-drag' | 'pivot-drag' | 'liquify-drag' = 'idle';
  private current: {
    points: THREE.Vector3[];
    pressures: number[];
    kind: 'stroke' | 'guide';
    line?: THREE.Line;
    mirrorLine?: THREE.Line;
    /** normal de la superficie sobre la que se apoyó el primer punto — para
     *  que una guía nueva salga PERPENDICULAR al plano en el que se estaba
     *  dibujando (ver buildGuideSurface), no siempre de cara a la cámara. */
    baseNormal?: THREE.Vector3;
    /** Plano de guía fijado al comenzar el gesto. Evita saltos de profundidad
     *  si la punta sale de los límites visibles de la guía. */
    drawPlane?: THREE.Plane;
    /** Superficie/malla fijada al comenzar el gesto. Evita que el raycast
     *  cambie a otra guía, stroke o primitiva mientras el usuario dibuja. */
    drawTarget?: THREE.Object3D;
    /** true si el primer punto se resolvió contra el plano de fallback
     *  genérico (sin guía ni superficie real de apoyo) — dispara la
     *  auto-creación de guía al cerrar el trazo, ver commitStroke(). */
    noSupport?: boolean;
  } | null = null;
  private downScreen = new THREE.Vector2();
  private lastMoveWorld = new THREE.Vector3();
  private moveStart = new Map<THREE.Object3D, THREE.Vector3>();
  private lassoPts: [number, number][] = [];
  private lassoEl!: SVGSVGElement;
  private lassoPoly!: SVGPolygonElement;

  // ejes globales XYZ + puntos de fuga automáticos (solo guía visual — NUNCA
  // se dibujan ni se exportan, se recalculan en vivo según la cámara)
  private axesHelper!: THREE.AxesHelper;
  private showAxes = false;
  private vpEl!: SVGSVGElement;

  // edición de nodos (herramienta 'select'): un trazo a la vez, sus puntos de
  // control se muestran como esferitas arrastrables en 3D.
  private handlesGroup!: THREE.Group;
  private editingStroke: StrokeRecord | null = null;
  private pointHandles: THREE.Mesh[] = [];
  private dragPointIndex = -1;
  private dragPointStart = new THREE.Vector3();

  // gizmo de transformación (herramienta 'move', un solo trazo seleccionado):
  // pensado como base para animación futura (posar y grabar keyframes).
  private gizmo?: TransformControls;
  private gizmoTarget: THREE.Object3D | null = null;
  private gizmoDragStart = new THREE.Vector3();
  private gizmoDragStartQuat = new THREE.Quaternion();
  private currentGizmoMode: GizmoMode = 'translate';

  // eje móvil del gizmo de rotación: una esferita arrastrable que define
  // DÓNDE gira el objeto, en vez de rotar siempre sobre su propio origen.
  // Se implementa reparentando el objeto bajo un Object3D "proxy" ubicado en
  // el pivote elegido — pero SOLO durante el gesto de rotación en sí (nunca
  // mientras se arrastra el marcador): moverlo con el objeto ya adentro lo
  // arrastraría rígidamente. `pivotForObj` recuerda a qué objeto pertenece
  // el pivote actual, para resetearlo si cambia la selección.
  private pivotWorldPos: THREE.Vector3 | null = null;
  private pivotForObj: THREE.Object3D | null = null;
  private pivotMarker?: THREE.Mesh;
  private pivotProxy: THREE.Object3D | null = null;
  private pivotOwnerObj: THREE.Object3D | null = null;
  private pivotOwnerParent: THREE.Object3D | null = null;
  private pivotBeforePos = new THREE.Vector3();
  private pivotBeforeQuat = new THREE.Quaternion();
  private static readonly PIVOT_EPS = 1e-6;

  // portapapeles: copiar/pegar trazos (Ctrl+C / Ctrl+V)
  private clipboard: { points: THREE.Vector3[]; pressures: number[] }[] = [];

  // estabilizador de pulso ("Stable Strokes"): el punto que se agrega al
  // trazo persigue con retraso al punto crudo del puntero.
  private smoothed: THREE.Vector3 | null = null;
  /** Puntero dueño del trazo; filtra mouse sintético, borrador y contactos
   *  auxiliares que algunas tabletas emiten durante el mismo gesto. */
  private activePointerId: number | null = null;

  // historia
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  private canvas!: HTMLCanvasElement;
  private container!: HTMLElement;
  private cursorEl!: HTMLDivElement;
  private ro?: ResizeObserver;
  private raf = 0;
  private unsub?: () => void;
  private seq = 0;
  private disposed = false;

  private tool: ToolType = 'pencil';
  private brush: BrushSettings = { color: '#22252e', size: 12, opacity: 1, hardness: 0.8, pressureSensitivity: 0.6, stabilization: 0.35 };
  private mirror = { x: false, y: false, z: false };
  private theme: Theme = 'light';
  private lastSurfaceKey = '';

  // ---------------------------------------------------------------- ciclo de vida

  mount(canvas: HTMLCanvasElement, container: HTMLElement): void {
    this.canvas = canvas;
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();

    this.perspCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    this.perspCamera.position.set(0, 1.2, 6);
    this.camera = this.perspCamera;

    this.makeControls();
    this.controls.target.set(0, 0.6, 0);

    this.buildEnvironment();

    this.surfacesGroup = new THREE.Group();
    this.guidesGroup = new THREE.Group();
    this.strokesGroup = new THREE.Group();
    this.handlesGroup = new THREE.Group();
    this.scene.add(this.surfacesGroup, this.guidesGroup, this.strokesGroup, this.handlesGroup);

    // marcador del eje móvil de rotación: mismo estilo que los handles de
    // edición de puntos, pero en un color distinto para no confundirlo con
    // los nodos de un trazo.
    {
      const geo = new THREE.SphereGeometry(0.05, 16, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff5ac8, depthTest: false });
      this.pivotMarker = new THREE.Mesh(geo, mat);
      this.pivotMarker.renderOrder = 1000;
      this.pivotMarker.visible = false;
      this.handlesGroup.add(this.pivotMarker);
    }

    // mira de puntería del modo "dibujo libre": dónde vas a apoyar el
    // próximo punto, a la distancia de cámara actual (`freeDrawDepth`).
    {
      const geo = new THREE.SphereGeometry(0.045, 16, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0x4cf0ff, depthTest: false, transparent: true, opacity: 0.85 });
      this.freeDrawPreview = new THREE.Mesh(geo, mat);
      this.freeDrawPreview.renderOrder = 1000;
      this.freeDrawPreview.visible = false;
      this.handlesGroup.add(this.freeDrawPreview);
    }

    this.axesHelper = new THREE.AxesHelper(3);
    this.axesHelper.visible = false;
    this.scene.add(this.axesHelper);

    // gizmo de mover (translate): solo responde al botón izquierdo (lo
    // decide TransformControls internamente), así que nunca pisa el
    // giro con el botón derecho de OrbitControls. Empieza sin objeto — inerte
    // hasta que haya exactamente un trazo seleccionado con la herramienta 'move'.
    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmo.setMode('translate');
    this.gizmo.setSize(0.85);
    this.gizmo.detach();
    this.gizmo.addEventListener('dragging-changed', (ev) => {
      this.controls.enabled = !ev.value;
      if (ev.value) {
        this.gizmoTarget = (this.gizmo!.object as THREE.Object3D | undefined) ?? null;
        if (this.gizmoTarget) {
          this.gizmoDragStart.copy(this.gizmoTarget.position);
          this.gizmoDragStartQuat.copy(this.gizmoTarget.quaternion);
        }
      } else if (this.gizmoTarget) {
        const obj = this.gizmoTarget;
        const before = this.gizmoDragStart.clone();
        const beforeQuat = this.gizmoDragStartQuat.clone();
        this.gizmoTarget = null;
        if (this.pivotProxy && obj === this.pivotProxy) {
          // se rotó alrededor del eje móvil: "hornear" la transformación
          // acumulada en el objeto real (unwrapPivot ya arma el undo con el
          // antes/después correctos) y dejar el pivote listo para el
          // próximo gesto sin que el usuario tenga que reposicionarlo.
          this.unwrapPivot();
          if (this.pivotForObj) this.applyPivotAttachment(this.pivotForObj);
        } else {
          const after = obj.position.clone();
          const afterQuat = obj.quaternion.clone();
          if (before.distanceToSquared(after) > 1e-8 || beforeQuat.angleTo(afterQuat) > 1e-4) {
            this.pushCmd({
              undo: () => { obj.position.copy(before); obj.quaternion.copy(beforeQuat); },
              redo: () => { obj.position.copy(after); obj.quaternion.copy(afterQuat); },
            });
          }
        }
      }
    });
    this.scene.add(this.gizmo);

    // overlay SVG para los puntos de fuga (guía pura, no se dibuja ni exporta)
    this.vpEl = document.createElementNS(NS, 'svg') as SVGSVGElement;
    Object.assign(this.vpEl.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '20', display: 'none',
    } as CSSStyleDeclaration);
    container.appendChild(this.vpEl);

    this.cursorEl = document.createElement('div');
    Object.assign(this.cursorEl.style, {
      position: 'absolute', left: '0', top: '0', borderRadius: '50%',
      border: '1.5px solid #333', transform: 'translate(-50%, -50%)',
      pointerEvents: 'none', display: 'none', zIndex: '50', mixBlendMode: 'difference',
    } as CSSStyleDeclaration);
    container.appendChild(this.cursorEl);

    // lectura numérica de profundidad del modo "dibujo libre" — sin esto el
    // scroll cambia algo invisible; con el número puesto al lado del cursor
    // el ajuste deja de ser "a ciegas".
    this.freeDepthEl = document.createElement('div');
    Object.assign(this.freeDepthEl.style, {
      position: 'absolute', left: '0', top: '0', transform: 'translate(14px, -8px)',
      pointerEvents: 'none', display: 'none', zIndex: '51', fontFamily: 'system-ui, sans-serif',
      fontSize: '11px', color: '#4cf0ff', background: 'rgba(0,0,0,0.55)', padding: '1px 5px',
      borderRadius: '4px', whiteSpace: 'nowrap',
    } as CSSStyleDeclaration);
    container.appendChild(this.freeDepthEl);

    // overlay SVG para el lazo
    this.lassoEl = document.createElementNS(NS, 'svg') as SVGSVGElement;
    Object.assign(this.lassoEl.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '40', display: 'none',
    } as CSSStyleDeclaration);
    this.lassoPoly = document.createElementNS(NS, 'polygon') as SVGPolygonElement;
    this.lassoPoly.setAttribute('fill', 'rgba(76,155,255,0.12)');
    this.lassoPoly.setAttribute('stroke', '#4c9bff');
    this.lassoPoly.setAttribute('stroke-width', '1.5');
    this.lassoPoly.setAttribute('stroke-dasharray', '5 4');
    this.lassoEl.appendChild(this.lassoPoly);
    container.appendChild(this.lassoEl);

    this.syncFromStore(lowStore.getState() as unknown as LowStore);
    this.unsub = lowStore.subscribe(() => this.syncFromStore(lowStore.getState() as unknown as LowStore));

    canvas.style.cursor = 'none';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.setTheme(this.theme);
    this.animate();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsub?.();
    this.ro?.disconnect();
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas?.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.cursorEl?.remove();
    this.freeDepthEl?.remove();
    this.lassoEl?.remove();
    this.vpEl?.remove();
    this.gizmo?.dispose();
    this.controls?.dispose();
    this.scene?.traverse((o) => this.disposeNode(o));
    this.renderer?.dispose();
  }

  private makeControls(): void {
    this.controls?.dispose();
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.mouseButtons = {
      LEFT: -1 as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.enableRotate = this.view === 'persp';
  }

  // ---------------------------------------------------------------- entorno / tema

  private buildEnvironment(): void {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9099aa, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(3, 6, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd0ff, 0.5);
    rim.position.set(-5, 2, -4);
    this.scene.add(rim);

    this.grid = new THREE.GridHelper(20, 40, 0xc2c8d2, 0xd7dce4);
    const gm = this.grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.5;
    this.scene.add(this.grid);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    const dark = theme === 'dark';
    this.scene.fog = dark ? new THREE.FogExp2(0x0e0f13, 0.025) : null;
    const gm = this.grid.material as THREE.LineBasicMaterial;
    const colors = this.grid.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c1 = new THREE.Color(dark ? 0x3a3f4b : 0xc2c8d2);
    const c2 = new THREE.Color(dark ? 0x23262e : 0xd7dce4);
    for (let i = 0; i < colors.count; i++) {
      const c = i < colors.count / 2 ? c1 : c2;
      colors.setXYZ(i, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
    gm.opacity = dark ? 0.35 : 0.5;
    this.cursorEl.style.borderColor = dark ? '#e6ebf5' : '#2a2f3a';
  }

  // ---------------------------------------------------------------- ejes / puntos de fuga

  /** Prende/apaga los ejes XYZ y, en perspectiva, los puntos de fuga de cada
   *  eje (recalculados en vivo — es guía pura, jamás se dibuja ni exporta). */
  toggleAxes(): boolean {
    this.showAxes = !this.showAxes;
    this.axesHelper.visible = this.showAxes;
    this.updateVPOverlay();
    return this.showAxes;
  }

  axesOn(): boolean { return this.showAxes; }

  private static readonly VP_AXES: [THREE.Vector3, string][] = [
    [new THREE.Vector3(1, 0, 0), '#e74c3c'],
    [new THREE.Vector3(0, 1, 0), '#2ecc71'],
    [new THREE.Vector3(0, 0, 1), '#3b82f6'],
  ];

  /** Punto de fuga = a dónde converge en pantalla una dirección del mundo al
   *  proyectarla al infinito. Solo tiene sentido en perspectiva — en
   *  ortográfica las líneas paralelas a un eje siguen paralelas en pantalla,
   *  no convergen a ningún punto. Se recalcula cada frame según la cámara. */
  private updateVPOverlay(): void {
    if (!this.vpEl) return;
    if (!this.showAxes || this.view !== 'persp') {
      this.vpEl.style.display = 'none';
      return;
    }
    this.vpEl.style.display = 'block';
    while (this.vpEl.lastChild) this.vpEl.removeChild(this.vpEl.lastChild);
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 1, h = rect.height || 1;
    const cam = this.camera as THREE.Camera;
    const camFwd = new THREE.Vector3();
    cam.getWorldDirection(camFwd);
    const span = Math.max(w, h) * 3;
    for (const [axis, color] of WebGLDesign3D.VP_AXES) {
      // de las dos direcciones (+eje/-eje) usamos la que mira "hacia adelante"
      // — así el punto de fuga aparece del lado que se está mirando, no
      // detrás de la cámara.
      const align = camFwd.dot(axis);
      if (Math.abs(align) > 0.985) continue; // cámara casi alineada con el eje: sin convergencia útil
      const d = align >= 0 ? axis : axis.clone().negate();
      const far = cam.position.clone().add(d.clone().multiplyScalar(500));
      const ndc = far.project(cam);
      if (!isFinite(ndc.x) || !isFinite(ndc.y)) continue;
      const sx = ((ndc.x + 1) / 2) * w, sy = ((1 - ndc.y) / 2) * h;
      if (Math.abs(sx) > w * 4 || Math.abs(sy) > h * 4) continue; // demasiado lejos: no aporta
      const g = document.createElementNS(NS, 'g');
      const N = 8;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', sx.toFixed(1)); line.setAttribute('y1', sy.toFixed(1));
        line.setAttribute('x2', (sx + Math.cos(a) * span).toFixed(1));
        line.setAttribute('y2', (sy + Math.sin(a) * span).toFixed(1));
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '1.4');
        line.setAttribute('stroke-opacity', '0.4');
        g.appendChild(line);
      }
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', sx.toFixed(1)); dot.setAttribute('cy', sy.toFixed(1));
      dot.setAttribute('r', '5'); dot.setAttribute('fill', color);
      g.appendChild(dot);
      this.vpEl.appendChild(g);
    }
  }

  // ---------------------------------------------------------------- vistas orto / persp

  setView(v: ViewName): void {
    const t = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(t) || 8;
    if (v === 'persp') {
      this.camera = this.perspCamera;
    } else {
      const dir: Record<Exclude<ViewName, 'persp'>, [number, number, number]> = {
        front: [0, 0, 1], back: [0, 0, -1], top: [0, 1, 0],
        bottom: [0, -1, 0], left: [-1, 0, 0], right: [1, 0, 0],
      };
      const d = dir[v];
      const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
      ortho.position.set(t.x + d[0] * dist, t.y + d[1] * dist, t.z + d[2] * dist);
      if (v === 'top' || v === 'bottom') ortho.up.set(0, 0, v === 'top' ? -1 : 1);
      this.camera = ortho;
    }
    this.view = v;
    this.camera.lookAt(t);
    this.makeControls();
    this.controls.target.copy(t);
    this.applyOrthoFrustum();
    if (this.gizmo) this.gizmo.camera = this.camera as THREE.Camera;
  }

  private applyOrthoFrustum(): void {
    if (this.view === 'persp') return;
    const cam = this.camera as THREE.OrthographicCamera;
    const c = this.renderer.domElement;
    const aspect = (c.clientWidth || 1) / (c.clientHeight || 1);
    cam.left = -this.orthoSize * aspect;
    cam.right = this.orthoSize * aspect;
    cam.top = this.orthoSize;
    cam.bottom = -this.orthoSize;
    cam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- superficies-guía (toolbar)

  /** Superficie primitiva activa (plano/cilindro/esfera/toro/loft) — solo UNA
   *  a la vez, como ya sugiere el botón-toggle de la barra. Antes, apagar o
   *  cambiar de tipo nunca borraba la malla anterior: quedaban "fantasmas"
   *  acumulados en `surfaces` interfiriendo con resolveHit (raycasts que
   *  pegaban en un plano viejo en una orientación rarísima e inesperada). */
  private activeSurfaceId: string | null = null;

  private removeActiveSurface(): void {
    if (!this.activeSurfaceId) return;
    const s = this.surfaces.find((x) => x.id === this.activeSurfaceId);
    if (s) {
      this.surfacesGroup.remove(s.mesh);
      s.mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      this.surfaces = this.surfaces.filter((x) => x.id !== this.activeSurfaceId);
    }
    this.activeSurfaceId = null;
  }

  private addSurface(type: SurfaceType, params: Record<string, unknown> = {}): void {
    this.removeActiveSurface();
    const radius = Math.max(0.1, Number(params.radius ?? 1.4));
    const segments = Math.max(3, Math.floor(Number(params.segments ?? 48)));
    const geo = type === 'plane'
      ? new THREE.PlaneGeometry(Number(params.width ?? radius * 3), Number(params.height ?? radius * 3), 1, 1)
      : this.surfaceGeometry(type, radius, segments, Number(params.tubeRadius ?? radius * 0.35));
    const mesh = this.makeSurfaceMesh(geo);
    mesh.position.copy(this.controls.target);
    if (type === 'plane') mesh.lookAt(this.camera.position);
    if (Array.isArray(params.position)) mesh.position.fromArray(params.position as number[]);
    if (Array.isArray(params.rotation)) {
      const r = params.rotation as number[];
      mesh.rotation.set(THREE.MathUtils.degToRad(Number(r[0] || 0)),
        THREE.MathUtils.degToRad(Number(r[1] || 0)), THREE.MathUtils.degToRad(Number(r[2] || 0)));
    }
    if (Array.isArray(params.scale)) mesh.scale.fromArray(params.scale as number[]);
    const s: SurfaceObj = { id: `surf-${this.seq++}`, type, mesh };
    mesh.userData.surfaceId = s.id;
    this.surfacesGroup.add(mesh);
    this.surfaces.push(s);
    this.activeSurfaceId = s.id;
  }

  private makeSurfaceMesh(geo: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: 0x4c7bd0, roughness: 0.9, metalness: 0, transparent: true,
        opacity: 0.08, side: THREE.DoubleSide, depthWrite: false,
      })
    );
    mesh.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x4c9bff, transparent: true, opacity: 0.3 })
    ));
    return mesh;
  }

  private surfaceGeometry(type: SurfaceType, r: number, segments = 48, tubeRadius = r * 0.35): THREE.BufferGeometry {
    switch (type) {
      case 'sphere': return new THREE.SphereGeometry(r, segments, Math.max(3, Math.floor(segments * 0.66)));
      case 'cylinder': return new THREE.CylinderGeometry(r, r, r * 2, segments, 1, true);
      case 'torus': return new THREE.TorusGeometry(r, tubeRadius, Math.max(3, Math.floor(segments / 2)), segments);
      default: return new THREE.PlaneGeometry(r * 2, r * 2);
    }
  }

  // ---------------------------------------------------------------- store

  private syncFromStore(s: LowStore): void {
    if (this.tool === 'select' && s.currentTool !== 'select') this.clearPointEdit();
    const toolChanged = this.tool !== s.currentTool;
    this.tool = s.currentTool;
    this.brush = s.brushSettings;
    this.mirror = s.mirrorMode;
    const key = s.activeSurface ? JSON.stringify(s.activeSurface) : '';
    if (key !== this.lastSurfaceKey) {
      if (key) this.addSurface(s.activeSurface!.type, s.activeSurface!.params);
      else this.removeActiveSurface();
    }
    this.lastSurfaceKey = key;
    const newGizmoMode = s.gizmoMode || 'translate';
    const gizmoModeChanged = this.currentGizmoMode !== newGizmoMode;
    this.currentGizmoMode = newGizmoMode;
    this.gizmo?.setMode(newGizmoMode);
    if (toolChanged || gizmoModeChanged) this.syncGizmo();
    // dibujo libre: el scroll controla la profundidad, no el zoom de cámara.
    if (this.controls) this.controls.enableZoom = this.tool !== 'pencil-free';
    if (toolChanged && this.tool !== 'pencil-free') this.hideFreeDrawPreview();
    this.applyLayerStyles(); // visibilidad/opacidad de capas
  }

  // ---------------------------------------------------------------- input

  private setPointerFromEvent(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private screenOf(e: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private updateCursor(e: PointerEvent): void {
    const [x, y] = this.screenOf(e);
    const size = Math.max(6, this.brush.size);
    this.cursorEl.style.display = 'block';
    this.cursorEl.style.width = `${size}px`;
    this.cursorEl.style.height = `${size}px`;
    this.cursorEl.style.left = `${x}px`;
    this.cursorEl.style.top = `${y}px`;
  }

  /** Rayo → superficie/guía si hay; si no, plano que mira a la cámara.
   *  `noSupport` marca ese último caso — ninguna guía/superficie/trazo real
   *  bajo el cursor, solo el plano genérico — así beginDraw() sabe cuándo
   *  hace falta auto-generar una guía real (ver commitStroke). */
  private resolveHit(): HitInfo | null {
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.Camera);
    // PRIORIDAD: la guía ACTIVA gana sobre cualquier otra superficie. Con varias
    // guías, el rayo agarraba la que quedaba más cerca en profundidad (aunque no
    // fuera la que estás usando). Si el cursor está sobre la malla de la guía
    // activa, se usa esa; así "dibujás donde tenés la guía activa".
    if (this.tool !== 'guide' && this.activeGuide) {
      const ah = this.raycaster.intersectObject(this.activeGuide.mesh, false);
      if (ah.length) {
        const h = ah[0];
        const normal = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : new THREE.Vector3(0, 0, 1);
        return { point: h.point.clone(), normal, target: this.activeGuide.mesh, plane: this.activeGuide.plane?.clone(), kind: 'guide' };
      }
      // La guía activa conserva prioridad también fuera de su malla visible.
      // Antes se probaban otras superficies primero y Z podía cambiar a mitad
      // del trazo, produciendo rectas largas como las de la captura.
      if (this.activeGuide.plane) {
        const gp = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this.activeGuide.plane, gp)) {
          return { point: gp, normal: this.activeGuide.plane.normal.clone(), target: this.activeGuide.mesh, plane: this.activeGuide.plane.clone(), kind: 'guide' };
        }
      }
    }
    const targets: THREE.Object3D[] = this.surfaces.map((s) => s.mesh);
    // Una vez que ya hay forma armada, no hace falta seguir creando guías
    // para todo: se puede dibujar directamente APOYADO en los trazos ya
    // hechos (como el Grease Pencil de Blender sobre una malla), igual que
    // Feather permite dibujar sobre la superficie de un volumen existente.
    // No aplica al crear una guía nueva (tool 'guide'): ahí conviene que la
    // normal de apoyo salga de una superficie plana real, no del borde
    // curvo de un tubo de tinta.
    if (this.tool !== 'guide') {
      this.strokesGroup.traverse((o) => { if ((o as THREE.Mesh).isMesh) targets.push(o); });
    }
    if (targets.length) {
      const hits = this.raycaster.intersectObjects(targets, false);
      if (hits.length) {
        const h = hits[0];
        const normal = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : new THREE.Vector3(0, 0, 1);
        let obj: THREE.Object3D | null = h.object;
        while (obj?.parent && obj.parent !== this.strokesGroup && obj.parent !== this.surfacesGroup && obj.parent !== this.guidesGroup) obj = obj.parent;
        const target = obj ?? h.object;
        const isStroke = !!this.strokes.find((s) => s.object === target || s.object === target.parent);
        const isGuide = !!this.guides.find((g) => g.mesh === target || g.mesh === h.object);
        return { point: h.point.clone(), normal, target, kind: isGuide ? 'guide' : isStroke ? 'stroke' : 'surface' };
      }
    }
    // Guía activa: si el rayo no tocó la malla finita, proyectar sobre el PLANO
    // (infinito) de la guía → los trazos caen EXACTAMENTE donde se hizo la guía,
    // no en el centro del dibujo (como esperaba el usuario en vista de lado).
    // NO al crear una guía nueva (tool 'guide'): esa se dibuja sobre el plano
    // de la cámara, no sobre la guía anterior.
    if (this.tool !== 'guide' && this.activeGuide?.plane) {
      const gp = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.activeGuide.plane, gp)) {
        return { point: gp.clone(), normal: this.activeGuide.plane.normal.clone(), target: this.activeGuide.mesh, plane: this.activeGuide.plane.clone(), kind: 'guide' };
      }
    }
    // Un trazo artístico nunca cae sobre un plano implícito. La única operación
    // autorizada sin soporte previo es crear la primera guía.
    if (this.tool !== 'guide') return null;
    const camDir = new THREE.Vector3();
    (this.camera as THREE.Camera).getWorldDirection(camDir);
    this.fallbackPlane.setFromNormalAndCoplanarPoint(camDir.clone().negate(), this.controls.target);
    const p = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.fallbackPlane, p)) {
      return { point: p.clone(), normal: this.fallbackPlane.normal.clone(), noSupport: true, plane: this.fallbackPlane.clone(), kind: 'fallback' };
    }
    return null;
  }

  // ---------------------------------------------------------------- dibujo libre ("en el aire")

  /** Primera vez que se entra al modo: arrancar la profundidad en la
   *  distancia de órbita actual (donde ya está mirando la cámara), no en un
   *  valor arbitrario — así el primer punto cae cerca de lo que se ve. */
  private ensureFreeDrawDepth(): void {
    if (this.freeDrawDepth > 0) return;
    this.freeDrawDepth = THREE.MathUtils.clamp(
      this.camera.position.distanceTo(this.controls.target),
      WebGLDesign3D.FREE_DEPTH_MIN, WebGLDesign3D.FREE_DEPTH_MAX,
    );
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.tool !== 'pencil-free') return;
    e.preventDefault();
    this.ensureFreeDrawDepth();
    // multiplicativo (no aditivo): el mismo gesto de scroll acerca/aleja el
    // mismo PORCENTAJE ya sea que estés a 0.5m o a 50m de la cámara.
    const factor = Math.exp(-e.deltaY * 0.0012);
    this.freeDrawDepth = THREE.MathUtils.clamp(this.freeDrawDepth * factor, WebGLDesign3D.FREE_DEPTH_MIN, WebGLDesign3D.FREE_DEPTH_MAX);
    this.updateFreeDrawPreview();
  };

  /** Punto sobre el rayo de cámara a `freeDrawDepth` de distancia — nunca
   *  proyecta sobre ninguna guía/superficie/trazo, es la esencia del modo:
   *  dibujar en cualquier dirección del espacio, no solo sobre un plano. */
  private resolveFreeHit(): { point: THREE.Vector3; normal: THREE.Vector3 } {
    this.ensureFreeDrawDepth();
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.Camera);
    const point = this.raycaster.ray.origin.clone().addScaledVector(this.raycaster.ray.direction, this.freeDrawDepth);
    const normal = this.raycaster.ray.direction.clone().negate();
    return { point, normal };
  }

  private intersectLockedDrawContext(): HitInfo | null {
    if (!this.current?.drawTarget && !this.current?.drawPlane) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.Camera);
    if (this.current.drawTarget) {
      const hits = this.raycaster
        .intersectObject(this.current.drawTarget, true)
        .filter((h) => (h.object as THREE.Mesh).isMesh);
      if (hits.length) {
        const h = hits[0];
        const normal = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : this.current.baseNormal?.clone() ?? new THREE.Vector3(0, 0, 1);
        return { point: h.point.clone(), normal, target: this.current.drawTarget, plane: this.current.drawPlane?.clone() };
      }
    }
    if (this.current.drawPlane) {
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.current.drawPlane, p)) {
        return { point: p, normal: this.current.drawPlane.normal.clone(), plane: this.current.drawPlane.clone() };
      }
    }
    return null;
  }

  /** Mira de puntería + lectura numérica de profundidad, actualizada en cada
   *  pointermove (aun sin estar dibujando: sirve para "apuntar" antes de
   *  bajar el lápiz) y en cada scroll. */
  private updateFreeDrawPreview(): void {
    if (this.tool !== 'pencil-free' || !this.freeDrawPreview) return;
    const hit = this.resolveFreeHit();
    this.freeDrawPreview.position.copy(hit.point);
    this.freeDrawPreview.visible = true;
    const w = hit.point.clone().project(this.camera as THREE.Camera);
    const rect = this.canvas.getBoundingClientRect();
    this.freeDepthEl.style.left = `${((w.x + 1) / 2) * rect.width}px`;
    this.freeDepthEl.style.top = `${((1 - w.y) / 2) * rect.height}px`;
    this.freeDepthEl.style.display = 'block';
    this.freeDepthEl.textContent = `${this.freeDrawDepth.toFixed(2)} m`;
  }

  private hideFreeDrawPreview(): void {
    if (this.freeDrawPreview) this.freeDrawPreview.visible = false;
    if (this.freeDepthEl) this.freeDepthEl.style.display = 'none';
  }

  private pickStroke(): StrokeRecord | null {
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.Camera);
    const meshes: THREE.Object3D[] = [];
    const collect = (g: THREE.Group) => g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    collect(this.strokesGroup);
    collect(this.guidesGroup);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj && !obj.userData.strokeId) obj = obj.parent;
    if (!obj) return null;
    return this.strokes.find((s) => s.id === obj!.userData.strokeId) ?? null;
  }

  // ---------------------------------------------------------------- tijera (cortar trazos)

  /** Trazo + índice del punto de control más cercano al click — ahí se corta.
   *  No hace falta detectar el cruce con OTRA curva: se corta donde el
   *  usuario clickea sobre la línea, igual que la herramienta Tijera de
   *  Illustrator — que suele ser justo donde dos trazos se cruzan visualmente. */
  private pickCutPoint(): { rec: StrokeRecord; index: number } | null {
    // Proximidad EN PANTALLA (no raycast al tubo): el tubo es finísimo y pegarle
    // exacto es casi imposible → antes "no hacía nada". Ahora corta en el punto
    // de control más cercano al click dentro de un radio en px.
    const rect = this.canvas.getBoundingClientRect();
    const cx = ((this.pointer.x + 1) / 2) * rect.width;
    const cy = ((1 - this.pointer.y) / 2) * rect.height;
    const cam = this.camera as THREE.Camera;
    let best: { rec: StrokeRecord; index: number } | null = null;
    let bestDist = 22; // px
    for (const rec of this.strokes) {
      if (rec.kind !== 'stroke' || rec.points.length < 3) continue;
      rec.object.updateMatrixWorld(true);
      for (let i = 0; i < rec.points.length; i++) {
        const w = rec.object.localToWorld(rec.points[i].clone()).project(cam);
        const sx = ((w.x + 1) / 2) * rect.width;
        const sy = ((1 - w.y) / 2) * rect.height;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < bestDist) { bestDist = d; best = { rec, index: i }; }
      }
    }
    return best;
  }

  /** Divide un trazo en dos en el índice dado (ambos comparten el punto de
   *  corte, sin hueco visual). Deshacer restaura el trazo original entero. */
  private cutStroke(rec: StrokeRecord, index: number): void {
    if (index <= 0 || index >= rec.points.length - 1) return; // nada que cortar en una punta
    // Dejar un HUECO visible a cada lado del corte (si no, las dos mitades
    // quedan idénticas al trazo original y parece que "no hizo nada").
    const P = rec.points;
    const GAP = 0.06; // luz del corte por lado (mundo)
    let ja = index, accA = 0;
    while (ja > 1 && accA < GAP) { accA += P[ja].distanceTo(P[ja - 1]); ja--; }
    let jb = index, accB = 0;
    while (jb < P.length - 2 && accB < GAP) { accB += P[jb].distanceTo(P[jb + 1]); jb++; }
    const ptsA = P.slice(0, ja + 1).map((p) => p.clone());
    const prsA = rec.pressures.slice(0, ja + 1);
    const ptsB = P.slice(jb).map((p) => p.clone());
    const prsB = rec.pressures.slice(jb);
    if (ptsA.length < 2 || ptsB.length < 2) return;

    const makeHalf = (pts: THREE.Vector3[], prs: number[]): StrokeRecord => {
      const group = new THREE.Group();
      group.position.copy(rec.object.position);
      const a = this.buildTube(pts, prs);
      if (a) group.add(a);
      const half: StrokeRecord = {
        id: `stroke-${this.seq++}`, object: group, points: pts, pressures: prs,
        kind: 'stroke', layerId: rec.layerId, baseOpacity: rec.baseOpacity,
      };
      group.userData.strokeId = half.id;
      return half;
    };

    const halfA = makeHalf(ptsA, prsA);
    const halfB = makeHalf(ptsB, prsB);
    this.removeStrokeRecord(rec);
    this.addStrokeRecord(halfA);
    this.addStrokeRecord(halfB);
    this.pushCmd({
      undo: () => { this.removeStrokeRecord(halfA); this.removeStrokeRecord(halfB); this.addStrokeRecord(rec); },
      redo: () => { this.removeStrokeRecord(rec); this.addStrokeRecord(halfA); this.addStrokeRecord(halfB); },
    });
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.pointerType === 'touch' || !e.isPrimary) return;
    if (this.activePointerId !== null) return;
    if (this.panMode) return; // Espacio = mano: OrbitControls panea, no dibujar
    this.setPointerFromEvent(e);
    this.updateCursor(e);
    this.downScreen.set(...this.screenOf(e));

    if (this.tool === 'pencil' || this.tool === 'guide' || this.tool === 'pencil-free') {
      this.activePointerId = e.pointerId;
      this.beginDraw(e);
      if (this.mode !== 'draw') this.activePointerId = null;
    } else if (this.tool === 'move') {
      // el eje móvil del pivote de rotación tiene prioridad sobre los
      // anillos del gizmo: es un blanco más chico y conviene poder
      // agarrarlo aunque quede pegado a ellos en pantalla.
      if (this.currentGizmoMode === 'rotate' && !this.gizmo?.axis && this.pickPivotMarker()) {
        this.beginPivotDrag(e);
        return;
      }
      // el pointerdown sobre un handle del gizmo lo maneja TransformControls
      // solo (su propio listener, ya enterado por el hover del pointermove
      // anterior) — no arrancar además un lazo/mover libre encima.
      if (this.gizmo?.axis) return;
      const rec = this.pickStroke();
      if (rec) {
        if (!this.selected.has(rec)) this.setSelection([rec]);
        this.beginMove();
      } else {
        const g = this.pickGuide();
        if (g) this.selectGuide(g);
        else { this.selectGuide(null); this.beginLasso(e); }
      }
    } else if (this.tool === 'select') {
      this.onSelectPointerDown(e);
    } else if (this.tool === 'eraser') {
      this.beginLasso(e); // click corto = borrar bajo cursor; arrastre = lazo
    } else if (this.tool === 'scissors') {
      const cut = this.pickCutPoint();
      if (cut) this.cutStroke(cut.rec, cut.index);
    } else if (this.tool === 'liquify') {
      this.beginLiquify(e);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    if (this.mode === 'draw' && e.pointerType === 'pen' && e.pressure === 0 && e.buttons === 0) return;
    this.updateCursor(e);
    this.setPointerFromEvent(e);
    if (this.mode === 'draw') this.moveDraw(e);
    else if (this.mode === 'move') this.moveDrag(e);
    else if (this.mode === 'lasso') this.moveLasso(e);
    else if (this.mode === 'point-drag') this.movePointDrag();
    else if (this.mode === 'pivot-drag') this.movePivotDrag();
    else if (this.mode === 'liquify-drag') this.moveLiquify();
    if (this.tool === 'pencil-free') this.updateFreeDrawPreview();
  };

  private onPointerLeave = (): void => {
    if (this.mode === 'idle') this.cursorEl.style.display = 'none';
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    if (this.mode === 'draw') { this.endDraw(e); }
    else if (this.mode === 'move') { this.endMove(); }
    else if (this.mode === 'lasso') { this.endLasso(e); }
    else if (this.mode === 'point-drag') { this.endPointDrag(); }
    else if (this.mode === 'pivot-drag') { this.endPivotDrag(); }
    else if (this.mode === 'liquify-drag') { this.endLiquify(); }
    this.mode = 'idle';
    this.controls.enabled = true;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    this.activePointerId = null;
  };

  private static readonly TOOL_KEYS: Record<string, ToolType> = {
    p: 'pencil', g: 'guide', v: 'move', a: 'select', e: 'eraser', l: 'liquify', c: 'scissors', f: 'pencil-free',
  };

  private panMode = false; // barra espaciadora = mano (pan de cámara)

  private onKeyDown = (e: KeyboardEvent): void => {
    const ctrl = e.ctrlKey || e.metaKey;
    const target = document.activeElement;
    const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    // Barra espaciadora = MANO: mientras se mantiene, el botón izquierdo panea
    // (mover la vista vertical/horizontal, sobre todo en vistas ortogonales).
    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      if (!this.panMode) {
        this.panMode = true;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
        this.controls.enabled = true;
        this.canvas.style.cursor = 'grab';
      }
      return;
    }
    if (!ctrl && !e.altKey && !typing && WebGLDesign3D.TOOL_KEYS[e.key.toLowerCase()]) {
      e.preventDefault();
      lowStore.setCurrentTool(WebGLDesign3D.TOOL_KEYS[e.key.toLowerCase()]);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey || e.altKey) this.redo();
      else this.undo();
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selected.size) { e.preventDefault(); this.deleteSelection(); }
    } else if (ctrl && e.key.toLowerCase() === 'c') {
      if (this.selected.size) { e.preventDefault(); this.copySelection(); }
    } else if (ctrl && e.key.toLowerCase() === 'v') {
      if (this.clipboard.length) { e.preventDefault(); this.pasteClipboard(); }
    } else if (ctrl && e.key.toLowerCase() === 'd') {
      if (this.selectedGuide) { e.preventDefault(); this.duplicateGuide(this.selectedGuide); }
    } else if (e.key === 'Escape') {
      this.setSelection([]);
      this.selectGuide(null);
      this.clearPointEdit();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && this.panMode) {
      this.panMode = false;
      this.controls.mouseButtons.LEFT = -1 as unknown as THREE.MOUSE; // vuelve a dibujar
      this.canvas.style.cursor = 'none';
    }
  };

  // ---------------------------------------------------------------- portapapeles

  copySelection(): void {
    const strokesOnly = [...this.selected].filter((r) => r.kind === 'stroke');
    if (!strokesOnly.length) return;
    this.clipboard = strokesOnly.map((r) => ({
      points: r.points.map((p) => r.object.localToWorld(p.clone())),
      pressures: [...r.pressures],
    }));
  }

  pasteClipboard(): void {
    if (!this.clipboard.length) return;
    const offset = new THREE.Vector3(0.18, 0, 0.18); // corrido para no tapar el original
    const created: StrokeRecord[] = [];
    for (const c of this.clipboard) {
      const pts = c.points.map((p) => p.clone());
      const pressures = [...c.pressures];
      const group = new THREE.Group();
      const a = this.buildTube(pts, pressures);
      if (a) group.add(a);
      group.position.copy(offset);
      const rec: StrokeRecord = {
        id: `stroke-${this.seq++}`, object: group, points: pts, pressures, kind: 'stroke',
        layerId: this.activeLayerId(), baseOpacity: 1,
      };
      group.userData.strokeId = rec.id;
      created.push(rec);
    }
    for (const rec of created) this.addStrokeRecord(rec);
    this.setSelection(created);
    this.pushCmd({
      undo: () => created.forEach((r) => this.removeStrokeRecord(r)),
      redo: () => created.forEach((r) => this.addStrokeRecord(r)),
    });
  }

  // ---------------------------------------------------------------- dibujo

  /** Presión normalizada 0–1 para esta muestra. El mouse no reporta presión
   *  real (siempre ~0.5 con botón apretado) → se ignora y dibuja a ancho
   *  completo; solo el lápiz/tableta modula el ancho del trazo. */
  private samplePressure(e: PointerEvent): number {
    if (e.pointerType !== 'pen') return 1;
    return THREE.MathUtils.clamp(e.pressure || 0.5, 0, 1);
  }

  private static readonly SNAP_PX = 14;

  /** Si el puntero está cerca (en pantalla) de un vértice de un trazo ya
   *  dibujado, devuelve ese punto exacto en mundo — para poder arrancar (o
   *  terminar) una línea nueva pegada a una existente sin tener que apuntar
   *  perfecto. Las guías no cuentan: no retienen sus puntos tras dibujarlas. */
  private findSnapVertex(e: PointerEvent, refPoint?: THREE.Vector3, maxWorld = Infinity): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const cam = this.camera as THREE.Camera;
    let best: THREE.Vector3 | null = null;
    let bestDist = WebGLDesign3D.SNAP_PX;
    for (const rec of this.strokes) {
      rec.object.updateMatrixWorld(true);
      for (const p of rec.points) {
        const world = rec.object.localToWorld(p.clone());
        // filtro de PROFUNDIDAD: no enganchar vértices que solo caen cerca en
        // pantalla pero están a otra profundidad (lo que rompía en vista de lado)
        if (refPoint && world.distanceTo(refPoint) > maxWorld) continue;
        const v = world.clone().project(cam);
        const sx = ((v.x + 1) / 2) * rect.width, sy = ((1 - v.y) / 2) * rect.height;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestDist) { bestDist = d; best = world; }
      }
    }
    // Las esquinas/puntos que originaron una guía también son anclajes 3D.
    // Sin esto, al pasar de Frente a Derecha la segunda guía podía verse
    // alineada en pantalla pero quedar desplazada a otra coordenada Z.
    for (const guide of this.guides) {
      guide.mesh.updateMatrixWorld(true);
      const anchors = guide.mesh.userData.guideAnchors as THREE.Vector3[] | undefined;
      if (!Array.isArray(anchors)) continue;
      for (const local of anchors) {
        const p = local instanceof THREE.Vector3
          ? local.clone()
          : new THREE.Vector3(Number((local as { x?: number }).x || 0),
            Number((local as { y?: number }).y || 0), Number((local as { z?: number }).z || 0));
        const world = p.applyMatrix4(guide.mesh.matrixWorld);
        if (refPoint && world.distanceTo(refPoint) > maxWorld) continue;
        const v = world.clone().project(cam);
        const sx = ((v.x + 1) / 2) * rect.width, sy = ((1 - v.y) / 2) * rect.height;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestDist) { bestDist = d; best = world; }
      }
    }
    return best;
  }

  /** "Hilo tenso": ajusta el punto final para que el segmento start→raw
   *  quede exactamente paralelo al eje X, Y o Z del mundo (el que más se
   *  parezca a la dirección real que tiró el gesto) — proyecta el vector de
   *  arrastre sobre ese eje. Una recta paralela a un eje SIEMPRE converge a
   *  el punto de fuga de ese eje al verla en perspectiva, sin importar desde
   *  dónde salga — por eso no hace falta apuntar al punto de fuga a mano. */
  private snapToNearestAxis(start: THREE.Vector3, raw: THREE.Vector3): THREE.Vector3 {
    const drag = raw.clone().sub(start);
    if (drag.lengthSq() < 1e-10) return raw;
    const dragN = drag.clone().normalize();
    let bestAxis = WebGLDesign3D.VP_AXES[0][0];
    let bestAbsCos = -1;
    for (const [axis] of WebGLDesign3D.VP_AXES) {
      const c = Math.abs(dragN.dot(axis));
      if (c > bestAbsCos) { bestAbsCos = c; bestAxis = axis; }
    }
    const proj = drag.dot(bestAxis);
    return start.clone().add(bestAxis.clone().multiplyScalar(proj));
  }

  private beginDraw(e: PointerEvent): void {
    // dibujo libre: el punto sale del rayo de cámara + profundidad de
    // scroll, nunca de una guía/superficie — es justamente lo que lo hace
    // "libre". El snap a vértices existentes se mantiene igual (ayuda a
    // cerrar formas), pero no cuenta como "sin soporte" ni dispara la
    // auto-guía (ver commitStroke): esta herramienta es intencionalmente
    // sin plano de apoyo, no un accidente que haya que corregir.
    if (this.tool === 'pencil-free') {
      const surf = this.resolveFreeHit();
      const snap = this.findSnapVertex(e, surf.point, 0.8);
      const hit = snap ? { point: snap, normal: surf.normal } : surf;
      this.canvas.setPointerCapture(e.pointerId);
      this.mode = 'draw';
      this.controls.enabled = false;
      const line = this.makePreviewLine('stroke');
      this.strokesGroup.add(line);
      let mirrorLine: THREE.Line | undefined;
      if (this.mirror.x || this.mirror.y || this.mirror.z) { mirrorLine = this.makePreviewLine('stroke'); this.strokesGroup.add(mirrorLine); }
      this.smoothed = hit.point.clone();
      this.current = {
        points: [hit.point], pressures: [this.samplePressure(e)], kind: 'stroke', line, mirrorLine,
        baseNormal: hit.normal.clone(), noSupport: false,
      };
      this.updatePreview();
      return;
    }
    // arrancar puede engancharse a un vértice existente, pero SOLO si está cerca
    // en 3D de la superficie donde se dibuja (evita agarrar un vértice de otro
    // plano que solo cae cerca en pantalla, p. ej. en vista de lado).
    const surf = this.resolveHit();
    // Al CREAR una guía desde otra vista, la coincidencia en pantalla es la
    // intención de compartir vértice: no se descarta por la profundidad
    // provisional del plano de cámara. El punto devuelto conserva el XYZ real.
    const snap = this.findSnapVertex(e, surf?.point, this.tool === 'guide' ? Infinity : 0.8);
    const hit = snap ? { point: snap, normal: surf?.normal ?? new THREE.Vector3(0, 0, 1) } : surf;
    if (!hit) {
      this.canvas.title = 'Creá o activá una guía antes de dibujar';
      this.cursorEl.style.borderColor = '#ff4d4d';
      setTimeout(() => { this.canvas.title = ''; this.cursorEl.style.borderColor = '#333'; }, 1400);
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.mode = 'draw';
    this.controls.enabled = false;
    const kind = this.tool === 'guide' ? 'guide' : 'stroke';
    const line = this.makePreviewLine(kind);
    this.strokesGroup.add(line);
    let mirrorLine: THREE.Line | undefined;
    if ((this.mirror.x || this.mirror.y || this.mirror.z) && kind === 'stroke') {
      mirrorLine = this.makePreviewLine(kind);
      this.strokesGroup.add(mirrorLine);
    }
    this.smoothed = hit.point.clone(); // sin retraso en el primer punto
    this.current = {
      points: [hit.point], pressures: [this.samplePressure(e)], kind, line, mirrorLine,
      baseNormal: hit.normal.clone(),
      drawTarget: this.tool === 'pencil' ? hit.target : undefined,
      drawPlane: this.tool === 'pencil' ? hit.plane?.clone() : undefined,
      // el snap a un vértice existente SÍ cuenta como soporte real (ese
      // vértice pertenece a un trazo/guía ya apoyado), aunque `surf` haya
      // caído en el plano de fallback antes de encontrar el snap.
      noSupport: !snap && !!surf?.noSupport,
    };
    this.updatePreview();
  }

  /** "Stable Strokes": qué tan rápido el punto agregado al trazo alcanza al
   *  punto crudo del puntero. 0 = sin estabilizar (comportamiento de antes,
   *  sigue exacto). Más cerca de 1 = más retraso = pulso más limpio, a costa
   *  de "cortar camino" en curvas muy rápidas — por eso el piso en 0.15, no
   *  0, para que nunca se vuelva inmanejable. */
  private stabilizedPoint(raw: THREE.Vector3): THREE.Vector3 {
    const amt = THREE.MathUtils.clamp(this.brush.stabilization ?? 0, 0, 1);
    if (!this.smoothed) this.smoothed = raw.clone();
    if (amt <= 0) { this.smoothed.copy(raw); return raw; }
    const catchUp = THREE.MathUtils.lerp(1, 0.15, amt);
    this.smoothed.lerp(raw, catchUp);
    return this.smoothed;
  }

  /** Re-muestreo (Resample Curve, como lo describe Feather): si dos puntos
   *  consecutivos quedaron muy separados (arrastre rápido del mouse: pocas
   *  muestras en un tramo largo), inserta puntos intermedios por
   *  interpolación lineal para pareja la densidad. CatmullRomCurve3 hace
   *  overshoot/rulos cuando interpola tramos largos con giros filosos y
   *  pocos puntos de apoyo — subir la densidad ANTES de armar el tubo es la
   *  forma estándar de evitarlo (no es un ajuste de "estilo" como el
   *  estabilizador, por eso corre siempre, sin depender del slider). */
  private static readonly RESAMPLE_GAP = MIN_SAMPLE_DIST * 2.5;

  private resamplePoints(points: THREE.Vector3[], pressures: number[]): { points: THREE.Vector3[]; pressures: number[] } {
    if (points.length < 2) return { points, pressures };
    const gap = WebGLDesign3D.RESAMPLE_GAP;
    const outPts: THREE.Vector3[] = [points[0].clone()];
    const outPrs: number[] = [pressures[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dist = a.distanceTo(b);
      const steps = Math.min(40, Math.max(1, Math.ceil(dist / gap))); // tope: gaps absurdos no generan miles de puntos
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        outPts.push(a.clone().lerp(b, t));
        outPrs.push(pressures[i - 1] + (pressures[i] - pressures[i - 1]) * t);
      }
    }
    return { points: outPts, pressures: outPrs };
  }

  /** Segunda pasada de "Stable Strokes": al soltar el trazo, además del
   *  retraso en vivo (`stabilizedPoint`), se aplican unas pasadas de media
   *  móvil de 3 puntos (like `dzRefineStroke`/`dzMovingAvg` del editor 2D) —
   *  el temblor de alta frecuencia que el retraso en vivo no llega a limar
   *  del todo queda mejor resuelto post-trazo, sin perder los extremos
   *  (inicio/fin no se tocan, para no mover dónde arrancó/terminó el gesto). */
  private refineStroke(points: THREE.Vector3[], pressures: number[]): { points: THREE.Vector3[]; pressures: number[] } {
    const amt = THREE.MathUtils.clamp(this.brush.stabilization ?? 0, 0, 1);
    if (amt <= 0 || points.length < 4) return { points, pressures };
    const passes = Math.round(THREE.MathUtils.lerp(0, 3, amt));
    let pts = points.map((p) => p.clone());
    let prs = [...pressures];
    for (let pass = 0; pass < passes; pass++) {
      const nextPts = pts.map((p, i) => (i === 0 || i === pts.length - 1)
        ? p.clone()
        : pts[i - 1].clone().add(p).add(pts[i + 1]).divideScalar(3));
      const nextPrs = prs.map((v, i) => (i === 0 || i === prs.length - 1)
        ? v
        : (prs[i - 1] + v + prs[i + 1]) / 3);
      pts = nextPts;
      prs = nextPrs;
    }
    return { points: pts, pressures: prs };
  }

  private moveDraw(e: PointerEvent): void {
    if (!this.current) return;
    // El cuerpo del trazo NO engancha a vértices (eso hacía saltar los puntos a
    // vértices de otros planos en vista de lado). El snap solo aplica al inicio
    // (beginDraw) y al cierre (endDraw).
    let hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null;
    if (this.tool === 'pencil-free') {
      hit = this.resolveFreeHit();
    } else if (this.current.drawTarget || this.current.drawPlane) {
      hit = this.intersectLockedDrawContext();
    } else {
      hit = this.resolveHit();
    }
    if (!hit) return;
    const pts = this.current.points;
    const pressures = this.current.pressures;

    if (e.altKey && pts.length >= 1) {
      // "Hilo tenso": recta pegada al eje X/Y/Z más parecido al gesto —
      // al ser paralela a ese eje del mundo, converge sola hacia SU punto de
      // fuga cuando se ve en perspectiva (ver updateVPOverlay). No hace falta
      // apuntar al punto de fuga a mano, alcanza con tirar en esa dirección.
      const start = pts[0];
      const raw = this.stabilizedPoint(hit.point).clone();
      const end = this.snapToNearestAxis(start, raw);
      pts.length = 1;
      pressures.length = 1;
      if (end.distanceTo(start) >= MIN_SAMPLE_DIST) {
        pts.push(end);
        pressures.push(this.samplePressure(e));
      }
      this.updatePreview();
      return;
    }

    if (e.shiftKey && pts.length >= 1) {
      // Shift: línea recta desde el punto inicial hasta el punto actual — se
      // reemplazan los intermedios en cada movimiento (rubber-band), no se
      // "traba" en modo recto: al soltar Shift sigue a mano libre normal.
      const start = pts[0];
      const end = this.stabilizedPoint(hit.point).clone();
      pts.length = 1;
      pressures.length = 1;
      if (end.distanceTo(start) >= MIN_SAMPLE_DIST) {
        pts.push(end);
        pressures.push(this.samplePressure(e));
      }
      this.updatePreview();
      return;
    }

    const point = this.stabilizedPoint(hit.point).clone();
    const jump = point.distanceTo(pts[pts.length - 1]);
    if (jump < MIN_SAMPLE_DIST) return;
    if (pts.length >= 1 && jump > MAX_DRAW_JUMP) return; // salto irreal (rayo rasante) → descartar
    pts.push(point);
    pressures.push(this.samplePressure(e));
    this.updatePreview();
  }

  private endDraw(e: PointerEvent): void {
    // Ctrl al soltar = cerrar y redondear en un círculo limpio (asistente de
    // forma). Al ser con tecla, no se dispara en momentos indeseados.
    if ((e.ctrlKey || e.metaKey) && this.current && this.current.kind === 'stroke'
        && this.current.points.length >= 4) {
      this.beautifyCircle(this.current);
      this.commitStroke();
      return;
    }
    // cierre opcional: enganchar SOLO el último punto a un vértice existente
    // cercano en pantalla Y en 3D → conectar limpio con una línea previa sin
    // afectar el cuerpo del trazo. También para guías ("imán de guía"): si
    // trazás una guía nueva cerca de un trazo ya hecho, se engancha a él
    // igual que un trazo normal — antes solo aplicaba a kind==='stroke'.
    if (this.current && this.current.points.length >= 2) {
      const pts = this.current.points;
      const last = pts[pts.length - 1];
      const v = this.findSnapVertex(e, last, 0.6);
      if (v) pts[pts.length - 1] = v.clone();
    }
    this.commitStroke();
  }

  /** Reemplaza el trazo actual por un CÍRCULO limpio y cerrado, ajustado al
   *  gesto: centro = centroide, radio = distancia media, en el plano de mejor
   *  ajuste del trazo (normal de Newell). Une los extremos automáticamente. */
  private beautifyCircle(cur: { points: THREE.Vector3[]; pressures: number[] }): void {
    const pts = cur.points;
    const C = new THREE.Vector3();
    pts.forEach((p) => C.add(p));
    C.multiplyScalar(1 / pts.length);

    // normal del mejor plano (Newell) sobre el lazo del trazo
    const normal = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      normal.x += (a.y - b.y) * (a.z + b.z);
      normal.y += (a.z - b.z) * (a.x + b.x);
      normal.z += (a.x - b.x) * (a.y + b.y);
    }
    if (normal.lengthSq() < 1e-8) return; // degenerado (línea recta): no forzar círculo
    normal.normalize();

    let r = 0;
    pts.forEach((p) => (r += p.distanceTo(C)));
    r /= pts.length;
    if (r < 1e-3) return;

    // base ortonormal del plano
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.dot(u)) > 0.9) u.set(0, 1, 0);
    u.crossVectors(normal, u).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();

    const N = Math.max(48, pts.length);
    const circle: THREE.Vector3[] = [];
    const prs: number[] = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      circle.push(C.clone().addScaledVector(u, r * Math.cos(a)).addScaledVector(v, r * Math.sin(a)));
      prs.push(1);
    }
    cur.points.length = 0; cur.points.push(...circle);
    cur.pressures.length = 0; cur.pressures.push(...prs);
  }

  private makePreviewLine(kind: 'stroke' | 'guide'): THREE.Line {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({
      color: kind === 'guide' ? 0xffa53a : new THREE.Color(this.brush.color),
      transparent: true, opacity: kind === 'guide' ? 0.95 : Math.max(this.brush.opacity, 0.6),
    });
    return new THREE.Line(geo, mat);
  }

  private updatePreview(): void {
    if (!this.current) return;
    this.current.line?.geometry.setFromPoints(this.current.points);
    if (this.current.mirrorLine) this.current.mirrorLine.geometry.setFromPoints(this.mirroredVariants(this.current.points)[0] || []);
  }

  private strokeRadius(): number {
    return 0.01 + (this.brush.size / 100) * 0.12;
  }

  /** Radio en el punto de índice `i` (0..n-1) según su presión: con
   *  `pressureSensitivity` en 0 el ancho es constante (comportamiento de
   *  antes); en 1 llega a angostarse hasta ~15% del ancho con presión mínima.
   *  El piso evita que el trazo desaparezca del todo con presión 0. */
  private radiusAt(pressure: number): number {
    const base = this.strokeRadius();
    const sens = THREE.MathUtils.clamp(this.brush.pressureSensitivity ?? 0, 0, 1);
    const floor = THREE.MathUtils.lerp(1, 0.15, sens);
    return base * THREE.MathUtils.lerp(floor, 1, THREE.MathUtils.clamp(pressure, 0, 1));
  }

  /** Interpola `pressures[]` (indexado 0..n-1, uniforme) al parámetro `t`
   *  crudo de la curva (NO al `u` de arco-longitud de getPointAt). */
  private pressureAtT(pressures: number[], t: number): number {
    const n = pressures.length;
    if (n < 2) return pressures[0] ?? 1;
    const pos = THREE.MathUtils.clamp(t, 0, 1) * (n - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, n - 1);
    const frac = pos - i0;
    return pressures[i0] * (1 - frac) + pressures[i1] * frac;
  }

  /** Tubo de ancho variable: arma un TubeGeometry de radio unitario (misma
   *  malla/normales que Three.js generaría con radio fijo) y después re-escala
   *  cada anillo según la presión interpolada en ese punto de la curva. Así
   *  se reusa el cálculo de frames (Frenet/parallel-transport) de Three.js —
   *  sin reimplementarlo a mano — y solo se toca el radio. */
  private buildTube(points: THREE.Vector3[], pressures: number[]): THREE.Mesh | null {
    if (points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const radialSegs = 10;
    const segs = Math.min(Math.max(points.length * 6, 8), 1400);
    const geo = new THREE.TubeGeometry(curve, segs, 1, radialSegs, false);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const vertsPerRing = radialSegs + 1;
    const ringCount = segs + 1;
    for (let i = 0; i < ringCount; i++) {
      const u = i / segs;
      const t = curve.getUtoTmapping(u, 0);
      const center = curve.getPoint(t);
      const radius = this.radiusAt(this.pressureAtT(pressures, t));
      for (let j = 0; j < vertsPerRing; j++) {
        const vi = i * vertsPerRing + j;
        const ox = pos.getX(vi) - center.x;
        const oy = pos.getY(vi) - center.y;
        const oz = pos.getZ(vi) - center.z;
        pos.setXYZ(vi, center.x + ox * radius, center.y + oy * radius, center.z + oz * radius);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const col = new THREE.Color(this.brush.color);
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: col, emissive: col.clone().multiplyScalar(0.06),
      roughness: THREE.MathUtils.lerp(0.9, 0.25, this.brush.hardness ?? 0.8), metalness: 0,
      transparent: this.brush.opacity < 1, opacity: this.brush.opacity,
    }));
  }

  /** Guía 3D estilo Feather: una "hoja" GRANDE (no una tira angosta con la
   *  forma exacta del trazo) — así se puede seguir dibujando en cualquier
   *  dirección sobre ella, lejos de la línea que la creó, con la misma
   *  precisión. El trazo original queda marcado en naranja como referencia,
   *  pero no define el límite de la superficie.
   *
   *  Orientación: la guía nueva sale PERPENDICULAR al plano sobre el que se
   *  estaba dibujando (el "suelo", otra guía, una superficie primitiva…),
   *  como cuando en Feather trazás un lado de la base y aparece una "hoja"
   *  vertical parada sobre ese lado — no siempre de cara a la cámara. Si no
   *  había ninguna superficie activa (el primer trazo del proyecto, dibujado
   *  sobre el plano de reserva que mira a la cámara), el resultado es
   *  equivalente a una guía de cara a la cámara, que es lo correcto en ese
   *  caso — no es un caso especial, sale solo de la misma fórmula. */
  private static readonly GUIDE_SIZE = 24;

  private buildGuideSurface(points: THREE.Vector3[], baseNormal?: THREE.Vector3): THREE.Mesh | null {
    if (points.length < 2) return null;
    const camAxis = new THREE.Vector3();
    (this.camera as THREE.Camera).getWorldDirection(camAxis).normalize();

    const centroid = new THREE.Vector3();
    points.forEach((p) => centroid.add(p));
    centroid.multiplyScalar(1 / points.length);

    // Eje de EXTRUSIÓN = normal del plano donde se dibujó el trazo (o el eje de
    // cámara). Barremos la CURVA REAL a lo largo de ese eje → la guía SIGUE la
    // forma del trazo: un arco genera una bóveda/techo curvo, no un plano recto.
    let axis = (baseNormal ?? camAxis).clone();
    if (axis.lengthSq() < 1e-6) axis.copy(camAxis);
    axis.normalize();

    // media-longitud del barrido en profundidad (bóveda larga para dibujar
    // encima, proporcional al tamaño del trazo)
    const box = new THREE.Box3().setFromPoints(points);
    const L = THREE.MathUtils.clamp(box.getSize(new THREE.Vector3()).length() * 2, 5, 14);

    // vértices en espacio LOCAL (relativo al centroide) → el gizmo mueve/rota/
    // escala la guía alrededor de su centro, y la geometría lleva la curva.
    const n = points.length;
    const pos: number[] = [];
    const idx: number[] = [];
    const front: THREE.Vector3[] = [];
    const back: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const local = points[i].clone().sub(centroid);
      const f = local.clone().addScaledVector(axis, L);
      const b = local.clone().addScaledVector(axis, -L);
      front.push(f); back.push(b);
      pos.push(f.x, f.y, f.z, b.x, b.y, b.z);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = 2 * i, b = 2 * i + 1, c = 2 * (i + 1), d = 2 * (i + 1) + 1;
      idx.push(a, b, c, c, b, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x4c9bff, roughness: 1, metalness: 0, transparent: true,
      opacity: 0.09, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.position.copy(centroid);
    // Puntos locales que originaron la guía: se conservan como anclajes para
    // iniciar la siguiente guía exactamente en el mismo vértice 3D.
    mesh.userData.guideAnchors = points.map((p) => p.clone().sub(centroid));

    // grilla: bordes de adelante/atrás + secciones transversales + curva naranja
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x4c9bff, transparent: true, opacity: 0.25 });
    mesh.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(front), edgeMat));
    mesh.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(back), edgeMat.clone()));
    const sec: THREE.Vector3[] = [];
    const step = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i += step) sec.push(front[i], back[i]);
    mesh.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(sec), edgeMat.clone()));
    mesh.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points.map((p) => p.clone().sub(centroid))),
      new THREE.LineBasicMaterial({ color: 0xffa53a }))); // naranja = trazo original

    // plano de respaldo (infinito) para rayos que salgan de la malla finita:
    // el plano donde se dibujó el trazo. La malla CURVA es el objetivo primario.
    mesh.userData.guidePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, centroid);
    return mesh;
  }

  private mirroredVariants(points: THREE.Vector3[]): THREE.Vector3[][] {
    const axes = ['x', 'y', 'z'].filter((a) => this.mirror[a as 'x' | 'y' | 'z']);
    const variants: THREE.Vector3[][] = [];
    for (let mask = 1; mask < (1 << axes.length); mask++) {
      variants.push(points.map((p) => {
        const q = p.clone();
        axes.forEach((axis, i) => { if (mask & (1 << i)) q[axis as 'x' | 'y' | 'z'] *= -1; });
        return q;
      }));
    }
    return variants;
  }

  private commitStroke(): void {
    if (!this.current) return;
    this.smoothed = null;
    for (const l of [this.current.line, this.current.mirrorLine]) {
      if (!l) continue;
      this.strokesGroup.remove(l);
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    let { points, pressures } = this.current;
    const { kind, baseNormal, noSupport } = this.current;
    this.current = null;
    if (points.length < 2) return;

    if (kind === 'guide') {
      const mesh = this.buildGuideSurface(points, baseNormal);
      if (mesh) this.setGuide(mesh);
      return;
    }
    // Como Feather: si este trazo se dibujó "en el aire" (sin ninguna guía ni
    // superficie real de apoyo — cayó al plano genérico de cámara) se
    // auto-genera una guía a partir de él mismo, ANTES de resamplear/afinar
    // los puntos (con la curva cruda, igual que la herramienta 'guide'). Le
    // da soporte de profundidad real a los trazos siguientes en vez de que
    // todos sigan cayendo al mismo plano de cámara sin memoria entre sí.
    if (noSupport && !this.activeGuide) {
      const guideMesh = this.buildGuideSurface(points, baseNormal);
      if (guideMesh) this.setGuide(guideMesh);
    }
    ({ points, pressures } = this.resamplePoints(points, pressures));
    ({ points, pressures } = this.refineStroke(points, pressures));
    const group = new THREE.Group();
    const a = this.buildTube(points, pressures);
    if (a) group.add(a);
    for (const variant of this.mirroredVariants(points)) { const b = this.buildTube(variant, pressures); if (b) group.add(b); }
    const rec: StrokeRecord = {
      id: `stroke-${this.seq++}`, object: group, points, pressures, kind,
      layerId: this.activeLayerId(), baseOpacity: this.brush.opacity,
    };
    group.userData.strokeId = rec.id;
    this.addStrokeRecord(rec);
    this.pushCmd({
      undo: () => this.removeStrokeRecord(rec),
      redo: () => this.addStrokeRecord(rec),
    });
  }

  /** Reconstruye la malla del trazo tras editar sus puntos (herramienta
   *  'select'). Descarta la malla vieja y crea una nueva con los mismos
   *  materiales/presión — más simple y robusto que mutar geometría en vivo. */
  private rebuildStrokeMesh(rec: StrokeRecord): void {
    while (rec.object.children.length) {
      const child = rec.object.children[0] as THREE.Mesh;
      rec.object.remove(child);
      child.geometry?.dispose();
      (child.material as THREE.Material)?.dispose();
    }
    const a = this.buildTube(rec.points, rec.pressures);
    if (a) rec.object.add(a);
    for (const variant of this.mirroredVariants(rec.points)) {
      const b = this.buildTube(variant, rec.pressures); if (b) rec.object.add(b);
    }
  }

  private addStrokeRecord(rec: StrokeRecord): void {
    this.strokesGroup.add(rec.object);
    if (!this.strokes.includes(rec)) this.strokes.push(rec);
    this.applyLayerStyles();
  }

  private removeStrokeRecord(rec: StrokeRecord): void {
    // si el trazo está envuelto en el proxy del pivote móvil, liberarlo
    // primero — si no, `strokesGroup.remove` no encuentra un hijo directo y
    // el trazo queda fantasma, colgado del proxy.
    if (this.pivotOwnerObj === rec.object) this.unwrapPivot();
    this.strokesGroup.remove(rec.object);
    this.strokes = this.strokes.filter((s) => s !== rec);
    this.selected.delete(rec);
    if (this.editingStroke === rec) this.clearPointEdit();
    if (this.gizmo?.object === rec.object) this.gizmo.detach();
  }

  // ---------------------------------------------------------------- capas / grupos

  private activeLayerId(): string {
    return lowStore.getState().activeLayerId ?? 'layer-0';
  }

  /** Aplica visibilidad y opacidad de cada capa a sus trazos. Se llama en cada
   *  cambio del store (visibilidad, opacidad) y al agregar trazos. */
  /** Onion-skin por profundidad en vistas ortogonales: lo que está más lejos
   *  del plano de referencia (controls.target, a lo largo del eje de la
   *  cámara) se desvanece — como el papel cebolla de animación 2D, pero
   *  usando la profundidad real en vez de cuadros distintos. Nunca se aplica
   *  en perspectiva (ahí ya se percibe la profundidad por escala/paralaje,
   *  desvanecer sería confuso). */
  private static readonly ONION_DEPTH_RANGE = 6;
  private static readonly ONION_MIN_OPACITY = 0.15;

  private strokeWorldCenter(rec: StrokeRecord): THREE.Vector3 {
    const c = new THREE.Vector3();
    for (const p of rec.points) c.add(p);
    rec.object.updateMatrixWorld(true);
    return rec.object.localToWorld(c.divideScalar(Math.max(1, rec.points.length)));
  }

  private applyLayerStyles(): void {
    const layers = lowStore.getState().layers;
    const byId = new Map(layers.map((l) => [l.id, l]));
    const ortho = this.view !== 'persp';
    let camDir: THREE.Vector3 | null = null;
    let refDepth = 0;
    if (ortho) {
      camDir = new THREE.Vector3();
      (this.camera as THREE.Camera).getWorldDirection(camDir);
      refDepth = this.controls.target.dot(camDir);
    }
    for (const rec of this.strokes) {
      const layer = byId.get(rec.layerId);
      const visible = layer ? layer.visible : true;
      const op = layer ? layer.opacity : 1;
      rec.object.visible = visible;
      let depthMult = 1;
      if (ortho && camDir) {
        const depth = this.strokeWorldCenter(rec).dot(camDir) - refDepth;
        const t = THREE.MathUtils.clamp(Math.abs(depth) / WebGLDesign3D.ONION_DEPTH_RANGE, 0, 1);
        depthMult = THREE.MathUtils.lerp(1, WebGLDesign3D.ONION_MIN_OPACITY, t);
      }
      rec.object.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'opacity' in m) {
          m.opacity = rec.baseOpacity * op * depthMult;
          m.transparent = m.opacity < 1;
          m.needsUpdate = true;
        }
      });
    }
  }

  private strokesOfLayer(id: string): StrokeRecord[] {
    return this.strokes.filter((r) => r.layerId === id);
  }

  /** Selección masiva: todas las curvas de una capa (para transformar o
   *  recolorear en bloque, como el long-press de grupo en Feather). */
  selectLayer(id: string): void {
    this.setSelection(this.strokesOfLayer(id));
    this.syncGizmo();
  }

  private getStrokeColor(rec: StrokeRecord): string {
    let hex = '#22252e';
    rec.object.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.color) hex = '#' + m.color.getHexString();
    });
    return hex;
  }

  private paintStroke(rec: StrokeRecord, hex: string): void {
    const col = new THREE.Color(hex);
    rec.object.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.color) {
        m.color.copy(col);
        if (m.emissive) m.emissive.copy(col.clone().multiplyScalar(0.06));
        m.needsUpdate = true;
      }
    });
  }

  /** Cambia el color de TODOS los trazos de una capa (undoable). */
  setLayerColor(id: string, hex: string): void {
    const recs = this.strokesOfLayer(id);
    if (!recs.length) return;
    const before = recs.map((r) => this.getStrokeColor(r));
    const apply = () => recs.forEach((r) => this.paintStroke(r, hex));
    apply();
    this.pushCmd({
      undo: () => recs.forEach((r, i) => this.paintStroke(r, before[i])),
      redo: apply,
    });
  }

  /** Borra una capa Y sus trazos (undoable), luego quita la metadata del store. */
  deleteLayer(id: string): void {
    const recs = this.strokesOfLayer(id);
    const remove = () => recs.forEach((r) => this.removeStrokeRecord(r));
    const add = () => recs.forEach((r) => this.addStrokeRecord(r));
    remove();
    if (recs.length) this.pushCmd({ undo: add, redo: remove });
    lowStore.removeLayer(id);
  }

  // ---------------------------------------------------------------- guías

  /** Agrega una guía SIN tocar las que ya existen — se puede tener varias
   *  guías a la vez, cada una se borra individualmente (goma, click sobre
   *  ella) en vez de que la última creada reemplace a la anterior. */
  private setGuide(mesh: THREE.Mesh): void {
    const id = `guide-${this.seq++}`;
    mesh.userData.surfaceId = id;
    mesh.userData.guideId = id;
    const plane = mesh.userData.guidePlane as THREE.Plane | undefined;
    const g = { id, mesh, plane };
    const attach = () => {
      this.guidesGroup.add(mesh);
      this.surfaces.push({ id, type: 'loft', mesh });
      this.guides.push(g);
      this.activeGuide = g;
    };
    attach();
    this.pushCmd({
      undo: () => this.detachGuide(g),
      redo: () => attach(),
    });
  }

  private detachGuide(g: { id: string; mesh: THREE.Mesh }): void {
    if (this.pivotOwnerObj === g.mesh) this.unwrapPivot();
    this.guidesGroup.remove(g.mesh);
    this.surfaces = this.surfaces.filter((s) => s.id !== g.id);
    this.guides = this.guides.filter((x) => x.id !== g.id);
    if (this.activeGuide?.id === g.id) this.activeGuide = this.guides[this.guides.length - 1] ?? null;
    if (this.selectedGuide?.id === g.id) { this.selectedGuide = null; this.gizmo?.detach(); }
  }

  /** Borra la ÚLTIMA guía creada (botón "Borrar guía" de la barra). */
  deleteGuide(): boolean {
    if (!this.activeGuide) return false;
    return this.deleteGuideById(this.activeGuide.id);
  }

  /** Borra una guía específica por id (undoable) — usado por el botón
   *  "Borrar guía" (la última) y por la goma con click sobre cualquiera. */
  private deleteGuideById(id: string): boolean {
    const g = this.guides.find((x) => x.id === id);
    if (!g) return false;
    this.detachGuide(g);
    this.pushCmd({
      undo: () => { this.guidesGroup.add(g.mesh); this.surfaces.push({ id: g.id, type: 'loft', mesh: g.mesh }); this.guides.push(g); this.activeGuide = g; },
      redo: () => this.detachGuide(g),
    });
    return true;
  }

  /** Guía bajo el puntero actual (para borrarla individualmente con la
   *  goma), o null si no hay ninguna ahí. */
  private pickGuide(): { id: string; mesh: THREE.Mesh } | null {
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.Camera);
    const hits = this.raycaster.intersectObjects(this.guidesGroup.children, false);
    if (!hits.length) return null;
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj && !obj.userData.guideId) obj = obj.parent;
    if (!obj) return null;
    const id = obj.userData.guideId as string;
    return this.guides.find((g) => g.id === id) ?? null;
  }

  hasGuide(): boolean {
    return this.guides.length > 0;
  }

  /** "Guía invisible" (truco de Feather): bajar la opacidad a 0 no la
   *  desactiva — sigue dando soporte matemático a los trazos (resolveHit no
   *  mira la opacidad), solo deja de estorbar visualmente. Afecta a TODAS
   *  las guías activas por igual. */
  setGuideOpacity(v: number): void {
    const op = THREE.MathUtils.clamp(v, 0, 1);
    for (const g of this.guides) {
      (g.mesh.material as THREE.MeshStandardMaterial).opacity = op * 0.08;
      const edges = g.mesh.children.find((c) => c instanceof THREE.LineSegments) as THREE.LineSegments | undefined;
      if (edges) (edges.material as THREE.LineBasicMaterial).opacity = op * 0.25;
    }
  }

  // ---------------------------------------------------------------- selección

  private setSelection(recs: StrokeRecord[]): void {
    this.selectedGuide = null;
    for (const r of this.selected) this.highlight(r, false);
    this.selected = new Set(recs);
    for (const r of this.selected) this.highlight(r, true);
    this.syncGizmo();
  }

  /** Elige una guía con la herramienta 'move' (no arrastre libre — se mueve
   *  y deforma con el gizmo). `null` deselecciona. */
  private selectGuide(g: { id: string; mesh: THREE.Mesh } | null): void {
    this.selectedGuide = g;
    for (const r of this.selected) this.highlight(r, false);
    this.selected = new Set();
    this.syncGizmo();
  }

  /** Copia la guía elegida (posición, orientación, tamaño) desplazada un
   *  poco para no tapar la original — Ctrl+D con una guía seleccionada. */
  private duplicateGuide(g: { id: string; mesh: THREE.Mesh }): void {
    const offset = new THREE.Vector3(0.4, 0, 0.4);
    const clone = g.mesh.clone(true);
    const anchors = g.mesh.userData.guideAnchors as THREE.Vector3[] | undefined;
    if (Array.isArray(anchors)) clone.userData.guideAnchors = anchors.map((p) =>
      p instanceof THREE.Vector3 ? p.clone() : new THREE.Vector3(Number((p as { x?: number }).x || 0),
        Number((p as { y?: number }).y || 0), Number((p as { z?: number }).z || 0)));
    clone.position.add(offset);
    clone.traverse((o) => {
      const withMat = o as THREE.Mesh | THREE.Line | THREE.LineSegments;
      if (withMat.material) {
        withMat.material = Array.isArray(withMat.material)
          ? withMat.material.map((m) => m.clone())
          : withMat.material.clone();
      }
    });
    const plane = g.mesh.userData.guidePlane as THREE.Plane | undefined;
    if (plane) clone.userData.guidePlane = plane.clone().translate(offset);
    this.setGuide(clone);
    this.selectGuide({ id: clone.userData.guideId as string, mesh: clone });
  }

  /** El gizmo de mover/escalar se adjunta a lo que esté elegido con la
   *  herramienta 'move': un trazo (si hay exactamente uno — con varios sigue
   *  el arrastre libre de siempre) o una guía. */
  private syncGizmo(): void {
    if (!this.gizmo) return;
    if (this.tool !== 'move') { this.resetPivot(); this.gizmo.detach(); return; }
    let target: THREE.Object3D | null = null;
    if (this.selected.size === 1) target = [...this.selected][0].object;
    else if (this.selectedGuide) target = this.selectedGuide.mesh;
    if (!target) { this.resetPivot(); this.gizmo.detach(); return; }
    if (this.currentGizmoMode === 'rotate') {
      if (this.pivotForObj !== target) {
        this.unwrapPivot();
        this.pivotForObj = target;
        this.pivotWorldPos = target.getWorldPosition(new THREE.Vector3());
      }
      this.applyPivotAttachment(target);
      this.showPivotMarker();
    } else {
      this.unwrapPivot();
      this.hidePivotMarker();
      this.gizmo.attach(target);
    }
  }

  // ---------------------------------------------------------------- eje móvil de rotación

  private resetPivot(): void {
    this.unwrapPivot();
    this.hidePivotMarker();
    this.pivotWorldPos = null;
    this.pivotForObj = null;
  }

  private showPivotMarker(): void {
    if (!this.pivotMarker || !this.pivotWorldPos) return;
    this.pivotMarker.position.copy(this.pivotWorldPos);
    this.pivotMarker.visible = true;
  }

  private hidePivotMarker(): void {
    if (this.pivotMarker) this.pivotMarker.visible = false;
  }

  /** ¿El pointer actual cayó sobre el marcador de pivote? Proximidad en
   *  pantalla (como pickCutPoint), no raycast exacto: la esfera es chica y
   *  suele quedar pegada a los anillos del gizmo de rotación. */
  private pickPivotMarker(): boolean {
    if (!this.pivotMarker?.visible) return false;
    const rect = this.canvas.getBoundingClientRect();
    const cx = ((this.pointer.x + 1) / 2) * rect.width;
    const cy = ((1 - this.pointer.y) / 2) * rect.height;
    const w = this.pivotMarker.getWorldPosition(new THREE.Vector3()).project(this.camera as THREE.Camera);
    const sx = ((w.x + 1) / 2) * rect.width;
    const sy = ((1 - w.y) / 2) * rect.height;
    return Math.hypot(sx - cx, sy - cy) < 16;
  }

  /** Decide, según qué tan lejos está el pivote elegido del origen propio
   *  del objeto, si hace falta el truco del proxy (pivote custom) o alcanza
   *  con el attach directo de siempre (pivote = origen del objeto, sin
   *  reparenting). Se llama después de mover el marcador y después de cada
   *  gesto de rotación — nunca en medio de un drag activo del gizmo. */
  private applyPivotAttachment(target: THREE.Object3D): void {
    if (!this.gizmo || this.currentGizmoMode !== 'rotate' || !this.pivotWorldPos) return;
    const wp = target.getWorldPosition(new THREE.Vector3());
    const custom = this.pivotWorldPos.distanceToSquared(wp) > WebGLDesign3D.PIVOT_EPS;
    if (custom) {
      this.wrapPivot(target);
    } else {
      if (this.pivotProxy) this.unwrapPivot();
      this.gizmo.attach(target);
    }
  }

  private wrapPivot(target: THREE.Object3D): void {
    if (!this.pivotWorldPos) return;
    if (this.pivotProxy && this.pivotOwnerObj === target) {
      this.pivotProxy.position.copy(this.pivotWorldPos);
      this.gizmo?.attach(this.pivotProxy);
      return;
    }
    if (this.pivotProxy) this.unwrapPivot();
    this.pivotOwnerObj = target;
    this.pivotOwnerParent = target.parent;
    this.pivotBeforePos.copy(target.position);
    this.pivotBeforeQuat.copy(target.quaternion);
    const proxy = new THREE.Object3D();
    proxy.position.copy(this.pivotWorldPos);
    this.scene.add(proxy);
    proxy.attach(target); // preserva la transformación mundial del objeto
    this.pivotProxy = proxy;
    this.gizmo?.attach(proxy);
  }

  /** Devuelve el objeto a su grupo original con la transformación acumulada
   *  ya "horneada" en su position/quaternion, y empuja el undo/redo del
   *  gesto de rotación (antes/después capturados en wrapPivot). */
  private unwrapPivot(): void {
    if (!this.pivotProxy || !this.pivotOwnerObj) return;
    const obj = this.pivotOwnerObj;
    const parent = this.pivotOwnerParent ?? this.strokesGroup;
    parent.attach(obj);
    this.scene.remove(this.pivotProxy);
    const before = this.pivotBeforePos.clone();
    const beforeQuat = this.pivotBeforeQuat.clone();
    const after = obj.position.clone();
    const afterQuat = obj.quaternion.clone();
    this.pivotProxy = null;
    this.pivotOwnerObj = null;
    this.pivotOwnerParent = null;
    if (before.distanceToSquared(after) > 1e-8 || beforeQuat.angleTo(afterQuat) > 1e-4) {
      this.pushCmd({
        undo: () => { obj.position.copy(before); obj.quaternion.copy(beforeQuat); },
        redo: () => { obj.position.copy(after); obj.quaternion.copy(afterQuat); },
      });
    }
  }

  private beginPivotDrag(e: PointerEvent): void {
    if (this.pivotProxy) this.unwrapPivot(); // soltar el objeto antes de mover el eje
    this.canvas.setPointerCapture(e.pointerId);
    this.mode = 'pivot-drag';
    this.controls.enabled = false;
  }

  private movePivotDrag(): void {
    if (!this.pivotWorldPos) return;
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.Camera);
    const camDir = new THREE.Vector3();
    (this.camera as THREE.Camera).getWorldDirection(camDir);
    this.fallbackPlane.setFromNormalAndCoplanarPoint(camDir.clone().negate(), this.pivotWorldPos);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.fallbackPlane, p)) return;
    this.pivotWorldPos.copy(p);
    this.pivotMarker?.position.copy(p);
  }

  private endPivotDrag(): void {
    if (this.pivotForObj) this.applyPivotAttachment(this.pivotForObj);
  }

  private highlight(rec: StrokeRecord, on: boolean): void {
    rec.object.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.emissive) {
        m.emissive.set(on ? 0x2b6fff : 0x000000);
        m.emissiveIntensity = on ? 0.9 : 1;
        m.needsUpdate = true;
      }
    });
  }

  selectedCount(): number {
    return this.selected.size;
  }

  deleteSelection(): void {
    const recs = [...this.selected];
    if (!recs.length) return;
    const wasGuide = new Map<string, { id: string; mesh: THREE.Mesh } | null>();
    const remove = () => {
      for (const r of recs) {
        if (this.pivotOwnerObj === r.object) this.unwrapPivot();
        r.object.parent?.remove(r.object);
        this.strokes = this.strokes.filter((s) => s !== r);
        if (r.kind === 'guide') { this.surfaces = this.surfaces.filter((s) => s.id !== r.id); if (this.activeGuide?.id === r.id) this.activeGuide = null; }
      }
    };
    const add = () => {
      for (const r of recs) {
        (r.kind === 'guide' ? this.guidesGroup : this.strokesGroup).add(r.object);
        if (!this.strokes.includes(r)) this.strokes.push(r);
        if (r.kind === 'guide') { this.surfaces.push({ id: r.id, type: 'loft', mesh: r.object as THREE.Mesh }); this.activeGuide = { id: r.id, mesh: r.object as THREE.Mesh }; }
      }
    };
    void wasGuide;
    remove();
    this.setSelection([]);
    this.pushCmd({ undo: add, redo: remove });
  }

  // ---------------------------------------------------------------- mover

  private beginMove(): void {
    this.mode = 'move';
    this.controls.enabled = false;
    const hit = this.resolveHit();
    this.lastMoveWorld.copy(hit ? hit.point : this.controls.target);
    this.moveStart.clear();
    for (const r of this.selected) this.moveStart.set(r.object, r.object.position.clone());
  }

  private moveDrag(_e: PointerEvent): void {
    const hit = this.resolveHit();
    if (!hit) return;
    const delta = hit.point.clone().sub(this.lastMoveWorld);
    for (const r of this.selected) r.object.position.add(delta);
    this.lastMoveWorld.copy(hit.point);
  }

  private endMove(): void {
    const moved = [...this.selected];
    const deltas = moved.map((r) => r.object.position.clone().sub(this.moveStart.get(r.object) ?? r.object.position));
    if (deltas.every((d) => d.lengthSq() < 1e-8)) return;
    this.pushCmd({
      undo: () => moved.forEach((r, i) => r.object.position.sub(deltas[i])),
      redo: () => moved.forEach((r, i) => r.object.position.add(deltas[i])),
    });
  }

  // ---------------------------------------------------------------- edición de nodos (herramienta 'select')
  //
  // Distinta de 'move': ahí se arrastra el TRAZO entero (su object.position).
  // Acá se edita un PUNTO DE CONTROL individual del vector — como la flecha
  // blanca de Illustrator frente a la negra. Solo aplica a trazos ('stroke'),
  // no a guías.

  private static readonly HANDLE_RADIUS = 0.028;

  private makeHandleMesh(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(WebGLDesign3D.HANDLE_RADIUS, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0x2b6fff, depthTest: false });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 999;
    return m;
  }

  /** Puntos de control en espacio MUNDO (el trazo puede estar desplazado por
   *  la herramienta 'move', que solo toca `object.position`). */
  private showPointHandles(rec: StrokeRecord): void {
    this.clearPointEdit();
    this.editingStroke = rec;
    rec.object.updateMatrixWorld(true);
    this.pointHandles = rec.points.map((p, i) => {
      const h = this.makeHandleMesh();
      h.position.copy(rec.object.localToWorld(p.clone()));
      h.userData.pointIndex = i;
      this.handlesGroup.add(h);
      return h;
    });
  }

  private clearPointEdit(): void {
    for (const h of this.pointHandles) {
      this.handlesGroup.remove(h);
      h.geometry.dispose();
      (h.material as THREE.Material).dispose();
    }
    this.pointHandles = [];
    this.editingStroke = null;
    this.dragPointIndex = -1;
  }

  private pickHandle(): number {
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.Camera);
    const hits = this.raycaster.intersectObjects(this.pointHandles, false);
    if (!hits.length) return -1;
    return (hits[0].object.userData.pointIndex as number) ?? -1;
  }

  private onSelectPointerDown(e: PointerEvent): void {
    const idx = this.editingStroke ? this.pickHandle() : -1;
    if (idx >= 0 && this.editingStroke) {
      this.canvas.setPointerCapture(e.pointerId);
      this.mode = 'point-drag';
      this.controls.enabled = false;
      this.dragPointIndex = idx;
      this.dragPointStart.copy(this.editingStroke.points[idx]);
      return;
    }
    // click fuera de un handle: elegir otro trazo (o deseleccionar)
    const rec = this.pickStroke();
    if (rec && rec.kind === 'stroke') this.showPointHandles(rec);
    else this.clearPointEdit();
  }

  private movePointDrag(): void {
    if (!this.editingStroke || this.dragPointIndex < 0) return;
    const hit = this.resolveHit();
    if (!hit) return;
    const local = this.editingStroke.object.worldToLocal(hit.point.clone());
    this.editingStroke.points[this.dragPointIndex].copy(local);
    this.rebuildStrokeMesh(this.editingStroke);
    const h = this.pointHandles[this.dragPointIndex];
    if (h) h.position.copy(this.editingStroke.object.localToWorld(local.clone()));
  }

  private endPointDrag(): void {
    if (!this.editingStroke || this.dragPointIndex < 0) return;
    const rec = this.editingStroke;
    const idx = this.dragPointIndex;
    const before = this.dragPointStart.clone();
    const after = rec.points[idx].clone();
    this.dragPointIndex = -1;
    if (before.distanceToSquared(after) < 1e-8) return;
    this.pushCmd({
      undo: () => { rec.points[idx].copy(before); this.rebuildStrokeMesh(rec); if (this.editingStroke === rec) this.pointHandles[idx]?.position.copy(rec.object.localToWorld(before.clone())); },
      redo: () => { rec.points[idx].copy(after); this.rebuildStrokeMesh(rec); if (this.editingStroke === rec) this.pointHandles[idx]?.position.copy(rec.object.localToWorld(after.clone())); },
    });
  }

  // ---------------------------------------------------------------- liquify

  /** Radio de influencia en unidades de mundo — reusa el slider de tamaño de
   *  pincel existente (más pincel = más área de arrastre), sin agregar un
   *  control nuevo a la UI. */
  private liquifyRadius(): number {
    return THREE.MathUtils.clamp(0.15 + (this.brush.size / 100) * 1.2, 0.15, 1.4);
  }

  private beginLiquify(e: PointerEvent): void {
    const rec = this.pickStroke();
    if (!rec || rec.kind !== 'stroke') return;
    this.canvas.setPointerCapture(e.pointerId);
    this.mode = 'liquify-drag';
    this.controls.enabled = false;
    this.liquifyStroke = rec;
    this.liquifyBefore = rec.points.map((p) => p.clone());
    this.applyLiquifyAt();
  }

  private moveLiquify(): void {
    this.applyLiquifyAt();
  }

  /** Empuja cada punto de control DENTRO del radio hacia la posición actual
   *  del pincel, con caída lineal (más cerca del centro = más arrastre) —
   *  mismo criterio que `l3dLiquifyStroke` del prototipo anterior, ahora
   *  regenerando la malla real del trazo en vez de tocar triángulos sueltos. */
  private applyLiquifyAt(): void {
    const rec = this.liquifyStroke;
    if (!rec) return;
    const hit = this.resolveHit();
    if (!hit) return;
    const localBrush = rec.object.worldToLocal(hit.point.clone());
    const radius = this.liquifyRadius();
    let touched = false;
    for (const p of rec.points) {
      const dist = p.distanceTo(localBrush);
      if (dist < radius && dist > 1e-6) {
        const falloff = 1 - dist / radius;
        p.addScaledVector(localBrush.clone().sub(p), WebGLDesign3D.LIQUIFY_STRENGTH * falloff);
        touched = true;
      }
    }
    if (touched) this.rebuildStrokeMesh(rec);
  }

  private endLiquify(): void {
    const rec = this.liquifyStroke;
    const before = this.liquifyBefore;
    this.liquifyStroke = null;
    this.liquifyBefore = [];
    if (!rec) return;
    const after = rec.points.map((p) => p.clone());
    const changed = before.some((p, i) => p.distanceToSquared(after[i]) > 1e-10);
    if (!changed) return;
    this.pushCmd({
      undo: () => { before.forEach((p, i) => rec.points[i]?.copy(p)); this.rebuildStrokeMesh(rec); },
      redo: () => { after.forEach((p, i) => rec.points[i]?.copy(p)); this.rebuildStrokeMesh(rec); },
    });
  }

  // ---------------------------------------------------------------- lazo (selección / goma)

  private beginLasso(e: PointerEvent): void {
    this.mode = 'lasso';
    this.controls.enabled = false;
    this.canvas.setPointerCapture(e.pointerId);
    this.lassoPts = [this.screenOf(e)];
    this.lassoEl.style.display = 'block';
    this.lassoPoly.setAttribute('points', '');
  }

  private moveLasso(e: PointerEvent): void {
    this.lassoPts.push(this.screenOf(e));
    this.lassoPoly.setAttribute('points', this.lassoPts.map((p) => p.join(',')).join(' '));
  }

  private endLasso(e: PointerEvent): void {
    this.lassoEl.style.display = 'none';
    const moved = Math.hypot(...this.screenOf(e).map((v, i) => v - [this.downScreen.x, this.downScreen.y][i]));
    if (moved < DRAG_THRESHOLD) {
      // click corto: seleccionar/borrar el trazo bajo el cursor
      const rec = this.pickStroke();
      if (this.tool === 'eraser') {
        if (rec) { this.setSelection([rec]); this.deleteSelection(); }
        else { const g = this.pickGuide(); if (g) this.deleteGuideById(g.id); } // click en una guía: borra solo esa
      } else {
        this.setSelection(rec ? [rec] : []);
      }
      return;
    }
    const inside = this.strokesInLasso();
    if (this.tool === 'eraser') {
      this.setSelection(inside);
      this.deleteSelection();
    } else {
      this.setSelection(inside);
    }
  }

  private strokesInLasso(): StrokeRecord[] {
    if (this.lassoPts.length < 3) return [];
    const rect = this.canvas.getBoundingClientRect();
    const cam = this.camera as THREE.Camera;
    const res: StrokeRecord[] = [];
    for (const rec of this.strokes) {
      const pts = rec.points;
      let hitCount = 0;
      rec.object.updateMatrixWorld(true);
      for (const p of pts) {
        const v = rec.object.localToWorld(p.clone()).project(cam);
        const sx = ((v.x + 1) / 2) * rect.width;
        const sy = ((-v.y + 1) / 2) * rect.height;
        if (this.pointInPoly(sx, sy)) { hitCount++; if (hitCount >= Math.max(1, pts.length * 0.3)) break; }
      }
      if (hitCount >= Math.max(1, pts.length * 0.3)) res.push(rec);
    }
    return res;
  }

  private pointInPoly(x: number, y: number): boolean {
    const poly = this.lassoPts;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------------------------------------------------------------- historia

  private pushCmd(cmd: Command): void {
    this.undoStack.push(cmd);
    this.redoStack = [];
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.setSelection([]);
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    this.setSelection([]);
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  // ---------------------------------------------------------------- utilidades

  private disposeNode(o: THREE.Object3D): void {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }

  clear(): void {
    for (const rec of this.strokes) { rec.object.parent?.remove(rec.object); }
    this.strokes = [];
    for (const g of [...this.guides]) this.detachGuide(g);
    this.removeActiveSurface();
    this.selected.clear();
    this.clearPointEdit();
    this.gizmo?.detach();
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Serializa puntos de control en lugar de la malla derivada, para conservar
   *  la capacidad de editar los trazos al volver a abrir el proyecto. */
  exportProject(): Low3DProject {
    const state = lowStore.getState();
    return {
      format: 'low3d', version: 1, savedAt: new Date().toISOString(),
      camera: { view: this.view, position: this.camera.position.toArray(),
        target: this.controls.target.toArray(), orthoSize: this.orthoSize },
      settings: { brush: { ...this.brush }, mirror: { ...this.mirror }, theme: this.theme,
        activeSurface: state.activeSurface ? { type: state.activeSurface.type, params: { ...state.activeSurface.params } } : null },
      layers: state.layers.map((l) => ({ ...l })), activeLayerId: state.activeLayerId,
      strokes: this.strokes.map((rec) => ({
        id: rec.id, layerId: rec.layerId,
        points: rec.points.map((p) => p.toArray()), pressures: [...rec.pressures],
        baseOpacity: rec.baseOpacity, position: rec.object.position.toArray(),
        quaternion: rec.object.quaternion.toArray(), scale: rec.object.scale.toArray(),
      })),
    };
  }

  importProject(data: unknown): void {
    const doc = data as Partial<Low3DProject>;
    if (!doc || doc.format !== 'low3d' || doc.version !== 1 || !Array.isArray(doc.strokes))
      throw new Error('El archivo no es un proyecto LOW 3D compatible');
    this.clear();
    lowStore.restoreLayers(doc.layers || [], doc.activeLayerId);
    if (doc.settings?.brush) lowStore.setBrushSettings({ ...doc.settings.brush });
    if (doc.settings?.mirror) lowStore.setMirrorMode({ ...doc.settings.mirror });
    lowStore.setActiveSurface(doc.settings?.activeSurface || null);
    for (const item of doc.strokes) {
      if (!Array.isArray(item.points) || item.points.length < 2) continue;
      const points = item.points.map((p) => new THREE.Vector3(Number(p[0]), Number(p[1]), Number(p[2])));
      const pressures = points.map((_, i) => Number(item.pressures?.[i] ?? 1));
      const group = new THREE.Group();
      const tube = this.buildTube(points, pressures);
      if (tube) group.add(tube);
      group.position.fromArray(item.position || [0, 0, 0]);
      group.quaternion.fromArray(item.quaternion || [0, 0, 0, 1]);
      group.scale.fromArray(item.scale || [1, 1, 1]);
      const rec: StrokeRecord = {
        id: item.id || `stroke-${this.seq++}`, object: group, points, pressures,
        kind: 'stroke', layerId: item.layerId || this.activeLayerId(),
        baseOpacity: Number(item.baseOpacity ?? 1),
      };
      group.userData.strokeId = rec.id;
      this.addStrokeRecord(rec);
    }
    const cam = doc.camera;
    if (cam) {
      this.orthoSize = Number(cam.orthoSize || ORTHO_SIZE);
      this.setView(cam.view || 'persp');
      this.camera.position.fromArray(cam.position || [0, 1.2, 6]);
      this.controls.target.fromArray(cam.target || [0, 0.6, 0]);
      this.camera.lookAt(this.controls.target);
      this.controls.update();
    }
    this.applyLayerStyles();
    this.undoStack = [];
    this.redoStack = [];
  }

  // ---------------------------------------------------------------- loop / resize

  private resize(): void {
    const c = this.renderer.domElement;
    const pr = Math.min(window.devicePixelRatio, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (w === 0 || h === 0) return;
    const needW = Math.floor(w * pr), needH = Math.floor(h * pr);
    if (c.width === needW && c.height === needH) return;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    if (this.view === 'persp') {
      this.perspCamera.aspect = w / h;
      this.perspCamera.updateProjectionMatrix();
    } else {
      this.applyOrthoFrustum();
    }
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    this.resize();
    this.controls.update();
    this.renderer.render(this.scene, this.camera as THREE.Camera);
    if (this.showAxes) this.updateVPOverlay();
    if (this.view !== 'persp') this.applyLayerStyles(); // onion-skin por profundidad, depende de la cámara
  };

  // ---------------------------------------------------------------- debug
  debugDemo(): void {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * 1.2, 0.6 + Math.sin(a) * 1.2, 0));
    }
    const pressures = pts.map(() => 1);
    const g = new THREE.Group();
    const t = this.buildTube(pts, pressures);
    if (t) g.add(t);
    const rec: StrokeRecord = {
      id: `stroke-${this.seq++}`, object: g, points: pts, pressures, kind: 'stroke',
      layerId: this.activeLayerId(), baseOpacity: 1,
    };
    g.userData.strokeId = rec.id;
    this.addStrokeRecord(rec);
  }
}

export default WebGLDesign3D;
