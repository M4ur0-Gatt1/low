# LOW 2.0 - Motor de Dibujo 3D Procedural

**Low Poly Observer Workshop** - Nueva generación de software de ilustración técnica 3D para Windows.

## Visión

LOW 2.0 no es un clon de Feather. Es una reinterpretación optimizada para:
- **Mouse** (precisión pixel-perfect)
- **Tableta Wacom** (presión, inclinación)
- **SpaceMouse** (navegación 6DOF)
- **Windows 10/11** (nativo, sin capas de abstracción)

## Arquitectura

Basada en **motores independientes** que se comunican mediante interfaces:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ Input Engine│────▶│ Surface Engine│────▶│Stroke Engine│
└─────────────┘     └──────────────┘     └─────────────┘
                           │                    │
                           ▼                    ▼
                    ┌──────────────┐     ┌─────────────┐
                    │ Scene Engine │◀────│Render Engine│
                    └──────────────┘     └─────────────┘
```

### Principio Fundamental

> **El lápiz NUNCA calcula profundidad (Z).**  
> Siempre dibuja SOBRE una superficie definida por contexto.

Esto elimina el problema del "slider Z" y hace que el dibujo 3D sea tan intuitivo como el 2D.

## Stack Tecnológico

| Componente | Tecnología |
|------------|-----------|
| Lenguaje | C++20 |
| Compilador | MSVC / GCC |
| Gráficos | OpenGL 4.6 + GLAD |
| Math | GLM (o implementación propia) |
| UI | Dear ImGui |
| Build | CMake 3.20+ |

## Estructura del Proyecto

```
LOW/
├── src/
│   ├── Core/          # Tipos base, Logger, UUID
│   ├── Math/          # Vec3, Mat4, Ray, AABB
│   ├── Scene/         # SceneGraph, SceneObject
│   ├── Surface/       # ISurface, SurfaceEngine
│   ├── Stroke/        # StrokeEngine, Spline
│   ├── Render/        # OpenGL, Shaders
│   ├── Input/         # Mouse, Wacom, SpaceMouse
│   └── App/           # Main loop
├── include/Low/
│   ├── Core/
│   ├── Math/
│   ├── Scene/
│   ├── Surface/
│   └── ...
├── shaders/           # GLSL
├── tests/             # Unit tests
└── ARCHITECTURE.md    # Decisiones de diseño
```

## Estado Actual

### ✅ Fase 1 Completada: Núcleo

- [x] Sistema de build CMake
- [x] Matemáticas básicas (Vec3, Mat4, Ray, AABB)
- [x] Sistema de UUID y Logger
- [x] SceneObject y Scene
- [x] **Surface Engine completo** (ISurface, PlaneSurface, SphereSurface)

### 🚧 Próximamente: Fase 2

- [ ] Stroke Engine (Spline Catmull-Rom, Parallel Transport Frames)
- [ ] Ribbon Builder (generación de geometría procedural)
- [ ] Input Engine (mouse picking, ray casting desde cámara)
- [ ] Render Engine (OpenGL 4.6, geometry shaders)

## Compilación

```bash
mkdir build && cd build
cmake ..
cmake --build .
```

## Documentación

- [ARCHITECTURE.md](ARCHITECTURE.md) - Decisiones de diseño (ADR)
- Comentarios en código - Cada clase y método está documentado

## Licencia

En desarrollo. Todos los derechos reservados.

---

*"Programar motores, no herramientas."*
