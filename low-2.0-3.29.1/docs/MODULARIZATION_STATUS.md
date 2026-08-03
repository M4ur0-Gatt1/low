# Modularización de LOW

## Implementado

- Modelo de escena versionado y adaptador para escenas históricas.
- Historial de comandos con deshacer y rehacer.
- Operaciones de exposiciones: asignar, mantener, insertar, eliminar y mover bloques.
- Estado común para Timeline y X-sheet.
- Controlador de reproducción independiente.
- Muestreo interpolado de cámara.
- Entrada normalizada de mouse/tableta con presión, inclinación, giro y borrador.
- Estabilizador y motor de trazos desacoplados.
- Biblioteca inicial de diez pinceles y presets personalizados persistentes.
- Registro general de paneles y espacios de trabajo.
- Coordinación de ventanas desacopladas.
- Comandos estructurados de IA, detector de repetición, reintentos limitados y checkpoints.
- Timeline externa y X-sheet externa sincronizadas y reacoplables.
- Historial central compartido, con captura tardía y transacciones.
- Recuperación de documentos no guardados después de cierres inesperados.
- Persistencia de disposición y tamaño de paneles.
- Construcción rápida de Windows verificada con todos los módulos incluidos.

## Migración en curso

El editor existente funciona como adaptador de interfaz. Los módulos nuevos se
cargan en producción; Timeline publica su estado mediante el nuevo núcleo, el
estabilizador participa del dibujo real y la escena modular se conserva dentro del
JSON existente. El modo `legacyFrames` mantiene los proyectos anteriores mientras
se completa la transición desde archivos duplicados hacia exposiciones referenciadas.

## Regla de desarrollo

No incorporar sistemas grandes directamente en `ui/app.js`. Crear o ampliar el
módulo correspondiente y dejar en `app.js` solamente el enlace con el DOM.
