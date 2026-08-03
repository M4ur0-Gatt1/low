# Diagnostico de guias y profundidad 3D

Fecha: 2026-08-03

## Etapa 1 - Arquitectura actual

El flujo principal de dibujo 3D vive en:

- `low2-hybrid/modules/design/engine/webgl-design3d.ts`
- Entrada: `pointerdown/pointermove/pointerup`
- Conversion 2D -> 3D: `setPointerFromEvent()` + `THREE.Raycaster`
- Resolucion de profundidad: `resolveHit()`
- Trazo en curso: `beginDraw()` + `moveDraw()`
- Commit final: `commitStroke()`
- Guia tipo Feather: `buildGuideSurface()` + `setGuide()`

El prototipo viejo sigue existiendo en `ui/lienzo3d.js`, pero el motor activo y mas completo es el modulo TypeScript.

## Etapa 2 - Problema critico encontrado

Una guia creada de frente debe seguir siendo util al pasar a vista derecha, porque justamente representa una superficie 3D de apoyo para construir volumen.

El bug estaba en el bloqueo del contexto de dibujo:

- Al comenzar un trazo sobre una guia, `beginDraw()` guardaba `drawPlane` si existia `activeGuide.plane`.
- Durante `moveDraw()`, si habia `drawPlane`, el trazo intersectaba solo ese plano.
- Una guia hecha de frente puede tener un plano de respaldo paralelo al rayo de la vista derecha.
- Resultado: al rotar a vista derecha, el trazo no caia sobre la superficie extruida real de la guia, o saltaba/perdia continuidad.

La guia si tenia malla 3D util, pero el trazo no la estaba usando de forma persistente.

## Etapa 3 - Correcciones aplicadas

Se agrego `HitInfo` para que `resolveHit()` devuelva no solo `point/normal`, sino tambien:

- `target`: objeto 3D que recibio el impacto.
- `plane`: plano matematico de respaldo, si existe.
- `kind`: `guide`, `surface`, `stroke`, `fallback` o `free`.

Ahora `beginDraw()` congela el contexto activo del trazo:

- Primero intenta seguir intersectando la malla/superficie real donde comenzo.
- Si el rayo sale del borde visible, recien ahi usa el plano de respaldo.

Esto evita que el trazo cambie de guia/superficie a mitad del gesto y permite que una guia creada de frente siga funcionando desde la derecha.

## Etapa 4 - Coherencia de espacios

Tambien se corrigieron calculos que asumian que convertir de local a mundo era `p + object.position`.

Eso falla si el trazo fue rotado o escalado con gizmos. Ahora usan matrices completas:

- `localToWorld()`
- `worldToLocal()`
- `updateMatrixWorld(true)`

Areas corregidas:

- snapping a vertices
- tijera
- lazo
- handles de edicion de puntos
- liquify
- centro de stroke para onion-depth
- copiar seleccion

## Etapa 5 - Verificacion

Resultados:

- `tsc` paso dentro de `npm run build:app`.
- `node tests/ui-cores.test.js` paso con `LOW modular cores: OK`.
- `vite build` fallo despues de TypeScript por ejecutar el proyecto desde una ruta UNC/unidad temporal: Rollup recibio `index.html` como ruta absoluta. No es un error de tipos ni de las correcciones del motor.

## Proxima etapa sugerida

Probar manualmente este caso:

1. Crear guia en vista frente.
2. Cambiar a vista derecha.
3. Dibujar con pencil sobre la guia.
4. Confirmar que el trazo cae sobre la superficie extruida de la guia, no sobre el plano frontal original.
5. Rotar la camara durante/entre trazos y revisar que no salte a otra guia o stroke cercano.

Si aun se siente raro, la siguiente mejora es agregar un visual debug de `HitInfo.kind/target` bajo el cursor para ver exactamente que superficie esta ganando cada raycast.
