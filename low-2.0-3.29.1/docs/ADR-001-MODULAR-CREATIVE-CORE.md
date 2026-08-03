# ADR-001: Núcleo creativo modular y migración compatible

**Estado:** Aceptado  
**Fecha:** 2026-08-02  
**Autor y decisor:** Mauro Gatti / Tropa Circa

## Contexto

LOW creció concentrando dibujo, animación, cámara, 3D, ventanas e IA en `ui/app.js`.
Eso permitió avanzar rápido, pero acopló el estado de la escena a elementos de la
interfaz. Timeline y X-sheet duplicaban transformaciones y los paneles no tenían
un contrato común para desacoplarse o guardar su disposición.

## Decisión

Crear núcleos JavaScript independientes, cargados antes de la interfaz histórica y
expuestos bajo el namespace `window.LOW`:

- `LOW.animation`: escena, exposiciones, Timeline, X-sheet, reproducción y cámara.
- `LOW.drawing`: entrada unificada, estabilización, trazos y pinceles.
- `LOW.workspace`: paneles, ventanas y espacios de trabajo.
- `LOW.ai`: comandos validados, ejecución limitada y recuperación.

La migración es gradual: `app.js` conserva las funciones existentes y delega en los
nuevos contratos. Los formatos de proyecto actuales siguen siendo aceptados.

## Opciones consideradas

### Reescritura completa

Ventaja: estructura limpia inmediatamente. Desventajas: alto riesgo de perder
funciones, romper proyectos y demorar la publicación durante meses.

### Migración modular progresiva — elegida

Ventajas: LOW continúa funcionando, cada extracción se prueba aisladamente y se
puede revertir por componente. Desventaja: durante la transición conviven código
histórico y nuevo.

## Consecuencias

- Las nuevas funciones deben entrar por los núcleos, no agregarse directamente a
  `app.js` salvo como adaptadores de interfaz.
- Toda operación de escena debe poder representarse como comando y entrar en el
  historial unificado.
- Timeline y X-sheet son vistas del mismo modelo de exposiciones.
- Los paneles se registran por identidad y no por posición fija.
- Los agentes no ejecutan acciones estructurales sin validación previa.

## Compatibilidad y licencias

La arquitectura es propia de LOW. Cualquier código futuro derivado de proyectos
externos debe conservar su aviso, licencia y procedencia en un archivo dedicado.
Inspirarse en flujos de trabajo no implica copiar código.

## Próximas migraciones

1. Sustituir la duplicación física de SVG por referencias de exposición.
2. Llevar el historial de dibujo y escena a `LOW.animation.History`.
3. Conectar todos los eventos de tableta con `LOW.drawing.PointerInput`.
4. Generalizar ventanas auxiliares más allá de Timeline y X-sheet.
5. Hacer que las operaciones del agente usen `LOW.ai.commands`.
