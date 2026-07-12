# LOW ★

**Editor de código con agente IA multi-proveedor.** Escribís una orden, el agente
lee, escribe y ejecuta archivos de tu proyecto — y LOW verifica que el código
generado compile antes de darlo por bueno. Pensado para comparar qué modelo
escribe código más preciso, rápido y funcional.

- **Multi-proveedor**: Groq, NVIDIA NIM, OpenAI, Anthropic, DeepSeek, Qwen, GLM,
  xAI y cualquier endpoint compatible OpenAI (Ollama, LM Studio). Una key por
  proveedor; la lista de modelos se trae en vivo de cada API.
- **Agente con herramientas**: crea y lee archivos, ejecuta comandos y corre el
  código del editor. Los archivos generados se abren solos en el editor.
- **Verificación del harness**: todo `.py` que escribe el agente se compila; si
  tiene errores de sintaxis, LOW se los devuelve al modelo para que los
  corrija antes de reportar "listo".
- **Desafío de código (⚖)**: la misma consigna a varios modelos en paralelo;
  LOW compila, ejecuta y compara la salida. Gana el código que funciona.
- **Editor**: CodeMirror con temas claro/oscuro, terminal integrada, y las apps
  con ventana (pygame, tkinter…) corren en proceso aparte. Los HTML se abren
  directo en el navegador.

## Descargar

En [Releases](../../releases) está la última versión:

| Sistema | Archivo |
|---|---|
| Windows 10/11 | `LOWSetup-x.y.z.exe` (instalador, no pide administrador) |
| macOS | `LOW-macos.zip` (primera vez: clic derecho → Abrir, por Gatekeeper) |
| Linux | `LOW-linux` (`chmod +x` y ejecutar) |

## Correr desde el código

```bash
git clone <este-repo>
cd low
pip install -r requirements.txt
# Linux además: pip install "pywebview[qt]"
python main.py
```

Requisitos: Python 3.11+. En Windows usa WebView2 (ya viene en Windows 10/11);
en macOS usa WebKit del sistema; en Linux, Qt WebEngine.

## Configurar

Engranaje ⚙ → pegá tus API keys. Para empezar gratis:

- **Groq** — [console.groq.com](https://console.groq.com) · recomendado:
  `openai/gpt-oss-120b`
- **NVIDIA NIM** — [build.nvidia.com](https://build.nvidia.com) · una sola key
  habilita todo el catálogo (DeepSeek, Kimi, Nemotron, GLM…)

Las keys se guardan localmente (`%APPDATA%\LOW` en Windows, `~/.config/LOW`
en Linux, `~/Library/Application Support/LOW` en macOS) y nunca entran al repo.

## Compilar

- **Windows**: `python build_exe.py` (PyInstaller + Inno Setup).
- **Todos los sistemas**: al pushear un tag `vX.Y.Z`, GitHub Actions compila
  Windows, macOS y Linux y sube los archivos al release automáticamente.

## Licencia

[MIT](LICENSE) — Mauro Gatti, Tropa Circa.
