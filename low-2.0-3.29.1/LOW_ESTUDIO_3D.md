# LOW Estudio — módulo de dibujo 3D (estado real, julio 2026)

Este documento describe lo que **efectivamente corre hoy** en el producto para el
dibujo 3D. Si estás por tocar algo relacionado con "3D" en este repo, leé esto
primero — hay varios intentos anteriores que NO son el camino actual (ver
"Intentos anteriores / no usar" más abajo).

## Qué es

**LOW Estudio** es el módulo de dibujo 3D estilo Feather (guías de dibujo:
plano/cilindro/esfera/toro/loft, trazos con presión, deshacer/rehacer,
selección por click y por lazo, borrador, vistas orto/perspectiva). Se abre
con el botón 🧊 de la barra lateral izquierda de LOW (id `abL3d`, tooltip
"LOW Estudio").

## Cómo está armado (arquitectura real)

El motor **NO** es código nativo de LOW ni vive en `ui/*.js` a mano. Es una
app web independiente — React + TypeScript + Three.js, construida con Vite —
que vive en su propio proyecto:

```
low2-hybrid/                    ← proyecto fuente (React/TS/Three.js/Vite)
  src/...                       ← el motor real: guías, trazos, cámara, etc.
  package.json                 → script "build:renderer": vite build
  dist/renderer/                ← build estático (index.html + assets/*.js)
```

Ese build estático **no usa nada de Electron ni de Node** — es HTML/JS/CSS
puro (`base: './'` en `vite.config.ts`, sin `window.electronAPI`, sin
`require`). Por eso se puede incrustar en cualquier lado sin tocar nada.

Para que quede **integrado dentro del mismo LOW.exe** (un solo software, sin
instalador aparte), el build de `low2-hybrid` se copia tal cual dentro del
proyecto principal:

```
ui/estudio3d/                  ← copia de low2-hybrid/dist/renderer/*
  index.html
  assets/index-XXXX.js
```

Y en la UI principal de LOW (`ui/index.html` + `ui/app.js`) el botón 🧊 abre
un panel (`#l3dView`) que contiene un `<iframe id="l3dFrame">` apuntando a
`estudio3d/index.html` (carga perezosa: el `src` se asigna la primera vez que
se abre, no antes). Ver `openL3d()` / `closeL3d()` en `ui/app.js`.

`ui/index.html` (`('ui', 'ui')` en `LOW.spec`) ya empaqueta la carpeta
`ui/` completa recursivamente en el instalador — no hace falta tocar el
`.spec` ni el `.iss` para que `estudio3d/` viaje adentro del `.exe`.

## Cómo hacer una corrección al motor 3D

El código que hay que editar para corregir/mejorar el dibujo 3D está en
**`low2-hybrid/modules/design/`** (TypeScript + React + Three.js):
- `engine/webgl-design3d.ts` — el motor real (dibujo, selección, gizmo, ejes,
  puntos de fuga, undo/redo). La gran mayoría de las correcciones van acá.
- `components/Toolbar3D.tsx`, `PropertiesPanel3D.tsx`, `ColorWheel.tsx`,
  `LayerManager3D.tsx` — la UI flotante sobre el canvas.
- `animation-3d-native.tsx` — monta el motor + la UI, tiene los botones de
  vista (Persp/Frente/…/Abajo) y deshacer/rehacer.
- `store/low-store.ts`, `types/design-types.ts` — estado global (herramienta
  activa, pincel, gizmo) y sus tipos.

`low2-hybrid/src/main.tsx` es SOLO el punto de entrada de Vite (15 líneas),
no el motor — no confundir. `low2-hybrid/native/` y `include/Low/` (C++) son
el plan aspiracional de motor nativo, tampoco es esto (ver más abajo).

Flujo:
1. Editar el código en `low2-hybrid/modules/design/...`
2. `cd low2-hybrid && npm run build:renderer` (equivale a `vite build`,
   genera `low2-hybrid/dist/renderer/`)
3. Copiar el resultado a `ui/estudio3d/` (reemplaza todo el contenido):
   ```
   rm -rf ui/estudio3d/*
   cp -r low2-hybrid/dist/renderer/* ui/estudio3d/
   ```
4. Reconstruir el `.exe`/instalador de LOW como siempre (PyInstaller +
   Inno Setup / GitHub Actions).

No hace falta tocar `electron/`, `electron-builder`, ni nada del empaquetado
de Electron de `low2-hybrid` para este flujo — eso solo se usaba para probar
el motor como app de escritorio suelta, y quedó descartado (ver abajo).

## Herramientas del motor (`webgl-design3d.ts`)

- `pencil` / `guide`: dibujar / crear superficie-guía Feather-style.
- `move`: seleccionar (click o lazo) y mover el TRAZO entero.
- `select` (jul-2026): edición de nodos — muestra los puntos de control de
  UN trazo como esferitas arrastrables en 3D y permite reposicionar cada
  punto individualmente (reconstruye el tubo en vivo). Distinto de `move`:
  es la "flecha blanca" (edición directa de vectores) frente a la "flecha
  negra" (mover el objeto entero).
- `eraser`, `liquify` (liquify: tipo declarado, sin implementar todavía).
- Presión del lápiz (jul-2026): `BrushSettings.pressureSensitivity` (0–1)
  hace que el ancho del trazo varíe con la presión real del dispositivo
  `pointerType==='pen'` — el mouse siempre dibuja a ancho completo, no hay
  presión real que leer ahí. Implementado re-escalando los anillos de un
  `THREE.TubeGeometry` de radio unitario según la presión interpolada en
  cada punto (reusa el cálculo de frames de Three.js, no lo reimplementa).
  `BrushSettings.hardness` ahora también afecta la rugosidad del material
  (antes existía en el tipo pero no se usaba en ningún lado).
- Atajos de teclado (jul-2026, `TOOL_KEYS` en `onKeyDown`): P lápiz, G guía,
  V mover, A editar puntos, E goma, L liquify. Se ignoran si hay un
  `<input>/<textarea>/<select>` enfocado (paneles de propiedades).
- Snap a vértices (`findSnapVertex`): al arrancar o continuar un trazo, si el
  puntero está a ≤14px en pantalla de un punto de un trazo YA HECHO, ancla
  ahí exacto — para conectar líneas sin tener que apuntar perfecto. Las
  guías no cuentan (no retienen sus puntos tras dibujarlas).
- Shift = recta libre; Alt = "hilo tenso" (`snapToNearestAxis`): ajusta el
  trazo para que quede paralelo al eje X/Y/Z del mundo más parecido al
  gesto. Una recta paralela a un eje SIEMPRE converge a SU punto de fuga en
  perspectiva — por eso alcanza con tirar en esa dirección, no hace falta
  apuntar al punto de fuga a mano.
- `select` con el gizmo (jul-2026): con la herramienta `move` y exactamente
  un trazo seleccionado aparece un `TransformControls` (modo translate o
  scale, toggle en la Toolbar). Pensado como base para animación futura
  (posar piezas y grabar keyframes). Solo responde al botón izquierdo del
  mouse — el giro con el botón derecho de `OrbitControls` nunca se pisa.
  Con más de un trazo seleccionado sigue funcionando el arrastre libre de
  siempre.
- Presets de pincel (`BRUSH_PRESETS` en `Toolbar3D.tsx`): Lápiz/Tinta/Pincel
  son solo combinaciones distintas de los mismos parámetros (tamaño,
  dureza, sensibilidad a presión, estabilizador) — no hay geometría nueva
  por preset.
- `ColorWheel.tsx`: rueda HSV (matiz=ángulo, saturación=radio, valor=slider)
  hecha con gradientes CSS puros (conic + radial), sin canvas ni deps
  nuevas. Se abre haciendo click en el swatch de color de la Toolbar.
- Ejes XYZ + puntos de fuga automáticos (`toggleAxes`/`updateVPOverlay`):
  guía pura vía overlay SVG, recalculada cada frame según la cámara — nunca
  se dibuja ni se exporta. Solo con perspectiva (en ortográfica no hay
  convergencia real).
- Ícono del botón 🧊 en `ui/index.html` (`#i-cube-sketch`, no `#i-cube`):
  cubo a mano alzada con doble trazo levemente desalineado ("línea
  peluda"). El `#i-cube` original queda intacto por si algo más lo usa.
- Guías (jul-2026, revisado dos veces tras feedback del usuario): son un
  plano GRANDE (24×24, `GUIDE_SIZE`), no una tira con la forma del trazo, y
  **perpendicular al plano de apoyo** sobre el que se dibujó la línea que la
  creó — no de cara a la cámara. `normal = dirección_del_trazo ×
  normal_del_plano_de_apoyo` (`buildGuideSurface`, recibe `baseNormal`
  capturado en `beginDraw`). Coexisten varias a la vez (`this.guides[]`,
  crear una nueva ya NO borra las anteriores) — cada una se borra individual
  con la Goma + click sobre ella (`pickGuide`/`deleteGuideById`), o la más
  reciente con el botón "Borrar guía". Opacidad ajustable con el slider 👻
  de la barra (`setGuideOpacity`) sin desactivarla (el "truco de la guía
  invisible" de Feather — resolveHit no mira la opacidad). Con la
  herramienta `move`, click sobre una guía la selecciona (`selectGuide`) y
  le adjunta el MISMO gizmo (translate/scale) que usan los trazos → mover y
  deformar sin código de arrastre nuevo. Ctrl+D la duplica
  (`duplicateGuide`, desplazada para no tapar la original). También se
  puede dibujar directamente APOYADO en trazos ya hechos, no solo en guías
  (`resolveHit` raycastea `strokesGroup` además de `surfaces` cuando la
  herramienta no es `guide`) — una vez armada una forma, no hace falta
  seguir creando guías para cada línea nueva.
- `resamplePoints` (jul-2026, corre SIEMPRE, no depende del estabilizador):
  si el mouse se movió rápido y dos muestras consecutivas quedaron muy
  separadas, inserta puntos intermedios por interpolación lineal antes de
  `refineStroke`/`buildTube`. Es el "Resample Curve" que menciona la
  documentación de Feather — sin esto, `CatmullRomCurve3` puede hacer
  overshoot/rulos en tramos largos con pocos puntos de apoyo y giros
  filosos (reportado por el usuario: trazos rápidos salían con loops que no
  estaban en el gesto original).
- Superficies primitivas (plano/cilindro/esfera/toro/loft, botones de
  "Superficies"): solo UNA a la vez — `addSurface()` llama
  `removeActiveSurface()` antes de agregar. Antes NO se borraban nunca al
  togglear/cambiar de tipo → quedaban mallas fantasma interfiriendo con
  `resolveHit` de forma impredecible.
- `scissors` (tijera, tecla C, jul-2026): corta un trazo en dos donde se
  clickea encima (`pickCutPoint` + `cutStroke`) — no detecta el cruce con
  OTRA curva, corta donde cae el click, que en la práctica suele ser justo
  el cruce visual entre dos líneas. Deja un HUECO visible a cada lado del
  corte (`GAP` en unidades de mundo) — sin esto las dos mitades quedaban
  idénticas al trazo original y parecía que la tijera "no hacía nada"
  (reportado dos veces por el usuario hasta encontrar la causa real).
- Gizmo: además de translate/scale, ahora tiene modo **rotate**.
- Guías (revisado de nuevo, jul-2026): la malla ya no es un plano recto —
  sigue la CURVA real del trazo que la creó, barrida a lo largo del eje de
  apoyo (bóveda/arco, no una hoja plana). Geometría en espacio LOCAL
  (relativa al centroide) para que el gizmo mueva/rote/escale bien. Además:
  - `resolveHit` prioriza la guía ACTIVA por sobre cualquier otra superficie
    (antes, con varias guías, ganaba la que quedaba más cerca en
    profundidad, no necesariamente la que se estaba usando).
  - Imán de guía: el snap de cierre (`endDraw`, antes solo para
    `kind==='stroke'`) ahora también aplica a `kind==='guide'` — trazar una
    guía cerca de un trazo existente la engancha a él en el inicio Y el
    cierre.
  - Espacio (barra espaciadora) = mano: mientras se mantiene, el botón
    izquierdo pasa a pan de `OrbitControls` en vez de dibujar; al soltar
    Espacio vuelve a dibujar (`panMode`, gateado en `onPointerDown`).
  - Ctrl al soltar el trazo = cerrar y redondear en un círculo limpio
    (`beautifyCircle`, asistente de forma).
- Onion-skin por profundidad en vistas ortogonales (`applyLayerStyles`,
  corre cada frame en `animate()` cuando `view!=='persp'`): lo que está más
  lejos del plano de referencia (`controls.target`, a lo largo del eje de
  la cámara) se desvanece — nunca en perspectiva, ahí la profundidad ya se
  percibe por escala/paralaje. Rango y opacidad mínima son constantes fijas
  (`ONION_DEPTH_RANGE`/`ONION_MIN_OPACITY`) — si hace falta un slider para
  ajustarlas a mano, es la próxima extensión natural.
- Eje móvil del gizmo de rotación (v3.28.14): con `move`+`rotate` y un solo
  trazo/guía seleccionado aparece una esferita rosa (`pivotMarker`) en el
  origen del objeto — arrastrarla reubica DÓNDE gira, en vez de rotar
  siempre sobre el propio origen. Implementación: mientras se arrastra el
  marcador el objeto NO se toca (es un Vector3 libre + malla visual, sin
  parentesco); recién al soltar (`endPivotDrag`) o al iniciar un gesto de
  rotación, si el pivote quedó lejos del origen del objeto
  (`applyPivotAttachment`), se lo reparenta transitoriamente bajo un
  `Object3D` proxy ubicado en ese punto (`wrapPivot`, vía `proxy.attach()`
  para preservar la transformación mundial) y el gizmo rota ESE proxy. Al
  soltar el gizmo (`unwrapPivot`) se "hornea" la rotación acumulada de
  vuelta en el `position`/`quaternion` reales del objeto y se lo devuelve a
  su grupo original — de paso esto agregó undo/redo a la rotación (antes
  `dragging-changed` solo trackeaba `position`, rotar no tenía deshacer).
  Nunca se reparenta en medio de un drag activo de `TransformControls` (se
  probó y rompe: `_positionStart`/`worldPositionStart` quedan capturados
  del objeto viejo) — el wrap/unwrap solo ocurre ANTES de que empiece el
  próximo gesto. Por eso `removeStrokeRecord`/`detachGuide`/
  `deleteSelection` llaman `unwrapPivot()` como guard antes de sacar un
  objeto de su grupo (si no, el trazo queda huérfano colgado del proxy).
- Auto-guía desde el primer trazo (v3.28.14, como Feather): si se dibuja un
  trazo de tinta sin NINGUNA guía/superficie/trazo real de apoyo bajo el
  cursor (`resolveHit` cae al plano de fallback genérico de cámara —
  marcado como `noSupport` en su retorno), al cerrar el trazo se genera
  automáticamente una guía real a partir de esos mismos puntos
  (`buildGuideSurface` + `setGuide`, igual que la herramienta `guide`
  manual) — le da soporte de profundidad a los trazos siguientes en vez de
  que todos seguían cayendo al mismo plano de cámara sin memoria entre sí
  (la causa de que "sin guías" se sintiera errático). No se dispara si ya
  hay una guía activa, ni si el trazo se apoyó en algo real (otra guía,
  superficie primitiva, u otro trazo, o si el snap de inicio enganchó a un
  vértice existente).
- Dibujo libre "en el aire" (v3.28.15, tecla F, `pencil-free`): como Feather
  necesita SIEMPRE una guía/superficie real (nunca dibuja en el vacío sin
  crear una — ver auto-guía arriba), pero el usuario pidió además una forma
  de dibujar sin ningún plano de apoyo, en cualquier dirección del espacio.
  El punto sale de `resolveFreeHit()`: origen del rayo de cámara +
  dirección × `freeDrawDepth` (distancia a cámara) — NUNCA proyecta sobre
  guía/superficie/trazo, a propósito. `freeDrawDepth` se ajusta con la
  rueda del mouse (`onWheel`, factor multiplicativo `exp(-deltaY*0.0012)`,
  así el mismo gesto de scroll es el mismo % de acercamiento cerca o lejos),
  con una mira de puntería (esfera cian `freeDrawPreview`) y un HUD
  numérico (`freeDepthEl`, "X.XX m") que se actualiza en cada pointermove Y
  en cada scroll — sin esto el ajuste de profundidad era "a ciegas", que es
  la falta de precisión que el usuario había notado en intentos previos.
  Mientras esta herramienta está activa, `OrbitControls.enableZoom = false`
  (ver `syncFromStore`): si no, el mismo scroll haría zoom de cámara Y
  cambiaría la profundidad a la vez, imposible de controlar. Los trazos de
  este modo nunca disparan la auto-guía (`noSupport` se fuerza a `false` en
  `beginDraw`) — son intencionalmente sin plano de apoyo, no un accidente a
  corregir. El snap a vértices existentes se mantiene (ayuda a cerrar
  formas).
- Liquify (v3.28.15, tecla L) — **antes esta herramienta estaba en el
  ToolType/Toolbar pero sin ningún handler de mouse, no hacía nada**.
  Portado el concepto del prototipo viejo `ui/lienzo3d.js`
  (`l3dLiquifyStroke`: empuja puntos de control dentro de un radio hacia el
  pincel con caída lineal) al motor actual: click+arrastre sobre un trazo
  (`pickStroke`) mueve sus `points` hacia la posición del pincel
  (`resolveHit`) dentro de `liquifyRadius()` (reusa el slider de tamaño de
  pincel existente, 0.15–1.4 unidades — no se agregó un control nuevo), con
  `rebuildStrokeMesh` en cada frame de arrastre y undo/redo de la lista
  completa de puntos (antes/después) al soltar.
- **Limitación conocida, no corregida todavía**: `buildTube`/
  `rebuildStrokeMesh`/`cutStroke` usan `this.brush.color` (el color ACTUAL
  del pincel), no un color guardado por trazo — `StrokeRecord` no tiene
  campo `color`. Si editás un punto de un trazo rojo (herramienta `select`)
  o lo cortás con la tijera después de cambiar el pincel a otro color, el
  trazo/las mitades salen con el color nuevo, no el original. Para
  arreglarlo de raíz hay que agregar `color` a `StrokeRecord` y usarlo en
  vez de `this.brush.color` en esos tres lugares (más `commitStroke`,
  `pasteClipboard`, `debugDemo`, que son los que crean StrokeRecords).
- `ColorWheel` se abre vía **React Portal a `document.body`** (no como hijo
  absoluto de la Toolbar) — la Toolbar tiene `overflowY:auto` (scroll
  interno) y por regla de CSS eso fuerza a `overflow-x` a `auto` también,
  clippeando cualquier hijo absoluto que se saliera del panel. Si se agrega
  otro popover/flotante a la Toolbar en el futuro, usar el mismo patrón
  (`createPortal` + `position:fixed` + `getBoundingClientRect` del disparador).

## Cámara multiplano del editor 2D (¡ojo, es OTRO código!)

`ui/app.js` (`dzZBtn`/`dzCamAt`/`dzCamView`, no `webgl-design3d.ts`) tiene su
propia cámara multiplano 2D/SVG para el editor de animación clásico (línea de
tiempo + papel cebolla) — capas con `data-z` que producen parallax real al
panear/zoomear la cámara, estilo Toon Boom/OpenToonz. No confundir con LOW
Estudio: es un sistema totalmente distinto (SVG + transforms 2D, no
WebGL/Three.js). En jul-2026 se le agregó escala-por-profundidad al hacer
zoom (antes solo paneaba con parallax, el zoom afectaba a todas las capas
por igual) y se retiró `#dz3DBtn` ("Espacio 3D", ~1100 líneas de un visor
CSS-3D aparte) porque quedó redundante con LOW Estudio — el código sigue en
`app.js` sin usar, no borrado.

## Intentos anteriores / NO usar como referencia

Hubo (al menos) tres líneas de trabajo distintas para "dibujo 3D" en este
repo. Para evitar confusión, dos quedaron descartadas:

1. **`ui/lienzo3d.js`** ("Lienzo 3D", funciones `l3d*`, vendorizaba
   `ui/vendor/three.min.js` + `three-orbit.js`). Era una reimplementación
   nativa (vanilla JS) más vieja y menos completa del mismo concepto
   (superficies-guía Feather-style). **Reemplazada** por LOW Estudio en
   julio 2026 — el archivo sigue en el repo por si sirve de referencia, pero
   ya no está enlazado desde `ui/index.html` (se sacaron los `<script>` que
   lo cargaban). No seguir desarrollando ahí.

2. **`low2-hybrid` empaquetado como app Electron independiente**
   (`electron/main.cjs`, `npm run dist:win`, instalador `.exe` separado
   "LOW 3D"). Se llegó a publicar una build portable suelta en un release de
   GitHub (`low2-hybrid-v0.1.0-portable`) para probarla antes de integrarla.
   **Descartado como forma de distribución** — el motor de ese proyecto es
   el que se **incrustó** dentro de LOW (ver arriba), pero ya NO se
   distribuye como `.exe`/app aparte. Si alguien pide "bajar el 3D suelto",
   la respuesta correcta es "ya está adentro de LOW, no hace falta bajar
   nada más".

3. **`ARCHITECTURE.md` (raíz del repo) + `CMakeLists.txt` + `include/Low/*`
   + `low2-hybrid/native/`**: un ADR para un motor 3D nativo en **C++20 +
   OpenGL 4.6** ("Programar Motores, no Herramientas"), pensado para
   10M+ puntos de control. Es un documento de **diseño/aspiracional**, no
   hay un motor C++ funcional integrado a LOW hoy. No confundir ese plan con
   LOW Estudio (que es el motor real que corre ahora, en Three.js/WebGL). Si
   se retoma ese camino nativo en el futuro, actualizar este archivo.

## Resumen para el próximo modelo que lea esto

- ¿Dónde está el motor 3D que usa el usuario? → `low2-hybrid/src/` (fuente),
  `ui/estudio3d/` (build embebido), botón 🧊 = "LOW Estudio".
- ¿Dónde NO tocar? → `ui/lienzo3d.js` (viejo, desconectado),
  `ARCHITECTURE.md`/C++ (plan a futuro, no implementado).
- ¿Cómo se prueba sin instalar nada? → `ui/mock-api.js`, abrir
  `ui/index.html?mock=1` con un `python -m http.server` en la carpeta `ui/`.
