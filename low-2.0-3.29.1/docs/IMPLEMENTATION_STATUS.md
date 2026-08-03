# Estado real de implementación de LOW

Este documento diferencia funciones terminadas, parciales y pendientes. No describe aspiraciones como si ya estuvieran disponibles.

## Implementado

- Timeline de animación acoplada, redimensionable, con niveles en filas, fotogramas en columnas, exposiciones, cámara y rango futuro.
- X-sheet vertical alternativa con niveles, exposiciones y fotogramas.
- Timeline y X-sheet separables en ventanas nativas para trabajar en otro monitor.
- Selección, selección directa, marco múltiple, nodos, rotación y escala mediante Pointer Events para mouse y tableta.
- Cursores visuales específicos para lápiz, pincel, pluma, borrador y herramientas de edición.
- Barra rápida de dibujo tipo Procreate con pincel, lápiz, mezcla, borrador, capas, color, tamaño y opacidad.
- Generación de secuencias IA de 1 a 24 frames, encadenadas desde el cuadro anterior e incorporadas a la Timeline.
- Papel cebolla, cámara animable, claves de dibujo, rig básico, intercalado y exportación.
- Recuperación automática del agente ante errores de herramientas y detección corregida de progreso real.

## Parcial

- Estudio 3D independiente: existe como módulo separado y puede cerrarse sin cerrar LOW, pero todavía conviven rutas antiguas del visor 3D dentro del editor SVG.
- Superficies 3D editables, simetría XYZ y joystick: implementados en `low2-hybrid`; falta unificar totalmente su persistencia con el proyecto principal Python.
- Flujo OpenToonz: la estructura Timeline/X-sheet y varias operaciones están presentes; faltan equivalentes completos de FX Schematic, Stage Schematic, columnas de sonido y edición avanzada de celdas.
- Flujo Procreate: barra rápida, presión, tamaño, opacidad y mezcla básica están integrados; faltan biblioteca completa de motores de pincel, estabilización avanzada y gestos multitáctiles configurables.

## Pendiente prioritario

- Sincronización bidireccional completa del inspector/capas como tercera ventana separable.
- Selección y desplazamiento de rangos completos de celdas en Timeline/X-sheet.
- Pistas de audio con forma de onda, scrubbing y sincronización labial.
- Motor de pinceles con presets, texturas, grano, mezcla húmeda, curvas de presión y favoritos.
- Unificación definitiva entre el módulo 3D híbrido y el documento principal de LOW.
- Pruebas automatizadas de tableta real y ventanas múltiples en Windows con dos monitores.
