"""Fidel — editor de código con agente IA multi-proveedor.

UI web (pywebview + WebView2) que implementa design_handoff_fidel_editor 1:1.
Este módulo es el puente: expone la lógica Python (providers, runner, config)
como js_api para ui/app.js. La versión CustomTkinter quedó en main_ctk.py.
"""
import base64
import datetime
import difflib
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import requests
import webview

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import Config, data_dir
from providers import get_provider, PROVIDERS
from code_runner import CodeRunner

IGNORE_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv",
               "dist", "build", ".idea", ".vscode"}
CODE_EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".md", ".txt", ".json",
            ".html", ".css", ".sh", ".ps1", ".yml", ".yaml", ".toml",
            ".sql", ".c", ".cpp", ".h", ".rs", ".go", ".java"}
LANG_BY_EXT = {".py": "python", ".js": "javascript", ".ts": "javascript",
               ".sh": "bash", ".ps1": "powershell"}

FIDEL_VERSION = "2.0.27"

# Desafío por defecto del comparador: verificable automáticamente
DEFAULT_TASK = ("Escribe un programa Python que imprima los primeros 10 numeros "
                "primos en una sola linea separados por coma.")
DEFAULT_EXPECTED = "2, 3, 5, 7, 11, 13, 17, 19, 23, 29"

# System prompt por defecto del agente. Editable desde ⚙ — Fidel no agrega
# ningún filtro ni instrucción oculta más allá de esto.
DEFAULT_SP = ("Eres Fidel, programador senior. Tienes HERRAMIENTAS: read_file, "
              "write_file, edit_file, exec_cmd, run_code, list_files, search_code, "
              "git, ssh_exec, scp_upload, generate_image. Usalas y ACTUA directo, sin pedir permiso. "
              "Si el usuario adjunta una imagen la ves directo en el mensaje (mockup, "
              "screenshot, foto de un error) — describila o usala de referencia segun "
              "lo que pida. Para generar assets/ilustraciones usa generate_image "
              "(requiere key de OpenAI o SiliconFlow cargada en Configuracion). "
              "Antes de editar un proyecto grande, usa search_code para ubicar lo que "
              "buscas. Para modificar un archivo QUE YA EXISTE preferi edit_file "
              "(reemplaza solo el fragmento exacto que cambia) — es mas confiable y "
              "barato que reescribir todo el archivo. Usa write_file solo para archivos "
              "nuevos o reescrituras completas cortas. Elegi el lenguaje mas adecuado "
              "para cada tarea. Para SUBIR A GITHUB usa la herramienta git: 'add -A', "
              "'commit -m \"mensaje\"', 'push' (gh CLI esta autenticado para crear repos). "
              "Para servidores usa ssh_exec (podes pasar un alias guardado o usuario@ip) "
              "y scp_upload para subir archivos. REGLA CLAVE: si una herramienta devuelve "
              "un error (empieza con ❌), NO repitas la misma llamada — LEE el mensaje, "
              "corregi los argumentos (ej: si falta 'path', agregalo) o cambia de enfoque. "
              "Repetir la misma llamada da el mismo error. Al escribir codigo: sintaxis "
              "valida y COMPLETO, sin funciones a medias, TODOs ni placeholders — tiene que "
              "andar. Elegi el lenguaje mas adecuado. Cuando termines de verdad, decilo "
              "claro. No crees entornos virtuales salvo pedido explicito. Responde en "
              "espanol, breve.")


LOG_PATH = data_dir() / 'fidel.log'


def log(msg):
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat()} {msg}\n")
    except OSError:
        pass


class Api:
    def __init__(s):
        s.cfg = Config()
        s._window = None
        s.ws = None
        s.prov = None
        s.ses_dir = data_dir() / 'historial'
        s.ses_dir.mkdir(parents=True, exist_ok=True)
        s.ses_id = datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        s.ses_msgs = []
        s._written = []
        s._mem = []          # memoria de conversación (pares user/assistant)
        s._checkpoint = {}   # {path: contenido_previo|None} del último turno → /undo
        s._ollama = []       # modelos locales de Ollama detectados (para failover)
        s._cancel = False    # bandera para detener una consulta en curso
        s._initp()

    def cancel(s):
        """El usuario pidió detener la consulta en curso."""
        s._cancel = True

    def _mem_limit(s):
        """Cuántos mensajes de la conversación recordar (2 por turno).
        Configurable desde ⚙ (config agent.memory_turns)."""
        try:
            return max(2, int(s.cfg.data.get("agent", {}).get("memory_turns", 24))) * 2
        except (TypeError, ValueError):
            return 48

    # ── Reflexion: aprende de sus errores y los recuerda ──────
    def _lessons_path(s):
        return data_dir() / 'lecciones.json'

    def _load_lessons(s):
        try:
            data = json.loads(s._lessons_path().read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _save_lesson(s, txt):
        txt = (txt or "").strip().strip('"').strip()
        # descartar respuestas vacías o que no son una regla (el modelo a veces divaga)
        if not txt or len(txt) < 8:
            return
        ls = s._load_lessons()
        if any(txt.lower() == x.get("txt", "").lower() for x in ls):
            return                      # ya la aprendió
        ls.append({"txt": txt[:400],
                   "ts": datetime.datetime.now().isoformat()})
        ls = ls[-40:]                   # no acumular infinito
        try:
            s._lessons_path().write_text(json.dumps(ls, ensure_ascii=False, indent=2),
                                         encoding="utf-8")
        except OSError as e:
            log(f"no pude guardar lección: {e}")

    def _reflect_and_learn(s, task, reason):
        """Tras un fallo, pide al modelo UNA regla concreta para no repetirlo y la
        guarda (patrón Reflexion). Desactivable con config agent.learn=false."""
        if not s.cfg.data.get("agent", {}).get("learn", True):
            return
        if not s.prov:
            return
        try:
            r = s.prov.chat(
                [{"role": "user", "content":
                  f"Estabas resolviendo esta tarea: «{(task or '')[:300]}».\n"
                  f"Fallaste asi: {reason}.\n"
                  "En UNA sola frase corta y accionable, escribi la REGLA que seguirias "
                  "la proxima vez para NO repetir este error (empezando con un verbo). "
                  "Solo la regla, sin preambulo ni comillas."}],
                system_prompt="Sos un ingeniero senior que aprende de sus errores. Respondes con UNA regla breve y concreta.",
                temperature=0.3, max_tokens=120)
            lesson = re.sub(r"<think>.*?</think>", "", r.content or "", flags=re.DOTALL).strip()
            if lesson:
                s._save_lesson(lesson)
                s._push("sys", f"🧠 Aprendí: {lesson[:180]}")
        except Exception as e:
            log(f"reflect fallo: {e}")

    # ── infraestructura ───────────────────────────────────
    def _push(s, event, data):
        if not s._window:
            return
        payload = json.dumps({"event": event, "data": data}, ensure_ascii=False)
        try:
            s._window.evaluate_js(f"Fidel.onPy({payload})")
        except Exception as e:
            log(f"_push({event}) fallo: {e}")

    def log_js(s, msg):
        """El frontend reporta acá sus errores y el boot — queda en fidel.log."""
        log(f"[js] {msg}")

    def _base(s):
        """Workspace efectivo para las tools. Si no hay, crea uno por defecto
        en Documentos/Fidel y avisa al frontend para que muestre el árbol."""
        if not s.ws:
            try:
                d = Path.home() / "Documents" / "Fidel"
                d.mkdir(parents=True, exist_ok=True)
                s.ws = str(d)
                s._push("ws", {"ws": s.ws, "tree": s._tree(), "branch": ""})
            except (OSError, PermissionError) as e:
                log(f"Error creando workspace por defecto: {e}")
                # Fallback a directorio temporal si Documents no está disponible
                import tempfile
                d = Path(tempfile.gettempdir()) / "Fidel"
                d.mkdir(parents=True, exist_ok=True)
                s.ws = str(d)
                s._push("ws", {"ws": s.ws, "tree": s._tree(), "branch": ""})
        return Path(s.ws)

    def _initp(s):
        n = s.cfg.get_active_provider()
        kw = {"model": s.cfg.get_model(n)}
        bu = s.cfg.data.get("providers", {}).get(n, {}).get("base_url", "")
        if bu:
            kw["base_url"] = bu
        try:
            s.prov = get_provider(n, api_key=s.cfg.get_api_key(n), **kw)
        except Exception as e:
            log(f"Error inicializando provider {n}: {e}")
            s.prov = None

    def _models(s, name):
        try:
            kw = {"model": s.cfg.get_model(name)}
            bu = s.cfg.data.get("providers", {}).get(name, {}).get("base_url", "")
            if bu:
                kw["base_url"] = bu
            return get_provider(name, api_key=s.cfg.get_api_key(name) or "x", **kw).list_models()
        except Exception as e:
            log(f"Error obteniendo modelos para {name}: {e}")
            return ["(configura la key)"]

    def _apis_state(s):
        provs = s.cfg.data.get("providers", {})
        return {
            "apis": sum(1 for d in provs.values() if d.get("api_key")),
            "providers": [{"name": k, "has_key": bool(d.get("api_key")),
                           "key": d.get("api_key", ""), "model": d.get("model", "")}
                          for k, d in provs.items()],
        }

    # ── estado / config ───────────────────────────────────
    def get_state(s):
        active = s.cfg.get_active_provider()
        st = {
            "theme": s.cfg.theme if s.cfg.theme in ("dark", "light") else "dark",
            "provider": active,
            "model": s.cfg.get_model(active),
            "models": s._models(active),
            "langs": CodeRunner.supported_languages(),
            "ws": s.ws,
            "branch": s._git_branch(),
            "tree": s._tree(),
            "zoom": s.cfg.data.get("zoom", 1.0),
            "system_prompt": s.cfg.data.get("system_prompt", ""),
            "default_sp": DEFAULT_SP,
            "version": FIDEL_VERSION,
            "tools": [{"name": t["function"]["name"],
                       "desc": t["function"].get("description", "")}
                      for t in s._get_tools()],
            "routines": s.cfg.data.get("routines", []),
            "agent": s.cfg.data.get("agent", {}),
            "session_id": s.ses_id,
            "ssh_hosts": s.cfg.data.get("ssh_hosts", []),
            "lessons": len(s._load_lessons()),
        }
        st.update(s._apis_state())
        return st

    def save_system_prompt(s, text):
        s.cfg.data["system_prompt"] = (text or "").strip()
        s.cfg.save()

    def save_agent_config(s, steps, conts, mem, verify_runtime=None):
        """Guarda los límites del agente (⚙). Fidel no le pone techo al trabajo
        salvo el que elijas acá y el de la API."""
        a = s.cfg.data.setdefault("agent", {})

        def _int(v, d):
            try:
                return max(1, int(v))
            except (TypeError, ValueError):
                return d
        a["max_steps"] = _int(steps, 40)
        a["max_continuations"] = _int(conts, 25)
        a["memory_turns"] = _int(mem, 24)
        if verify_runtime is not None:
            a["verify_runtime"] = bool(verify_runtime)
        s.cfg.save()
        return a

    def set_verify_runtime(s, on):
        """Activa/desactiva la verificación de ejecución (correr el código para
        confirmar que no revienta en runtime, no solo que compila)."""
        s.cfg.data.setdefault("agent", {})["verify_runtime"] = bool(on)
        s.cfg.save()
        return {"verify_runtime": bool(on)}

    def current_session(s):
        """Id de la conversación activa — el frontend lo usa para marcar la solapa."""
        return {"id": s.ses_id}

    # ── rutinas: órdenes reutilizables que guarda el usuario ──
    def save_routine(s, name, prompt):
        name, prompt = (name or "").strip(), (prompt or "").strip()
        if not name or not prompt:
            return {"routines": s.cfg.data.get("routines", [])}
        rs = [r for r in s.cfg.data.get("routines", []) if r.get("name") != name]
        rs.append({"name": name, "prompt": prompt})
        s.cfg.data["routines"] = rs
        s.cfg.save()
        return {"routines": rs}

    def delete_routine(s, name):
        rs = [r for r in s.cfg.data.get("routines", []) if r.get("name") != name]
        s.cfg.data["routines"] = rs
        s.cfg.save()
        return {"routines": rs}

    def artifact_content(s, path):
        """Contenido de un archivo, para renderizar artefactos in-app."""
        try:
            return {"content": Path(path).read_text(encoding="utf-8", errors="replace"),
                    "name": Path(path).name}
        except OSError as e:
            return {"error": str(e)}

    def set_zoom(s, z):
        s.cfg.data["zoom"] = z
        s.cfg.save()

    def refresh_tree(s):
        return {"tree": s._tree()}

    def config_path(s):
        return str(s.cfg.path)

    def set_theme(s, theme):
        s.cfg.data["theme"] = theme
        s.cfg.save()

    def set_provider(s, name):
        s.cfg.set_active_provider(name)
        s._initp()
        r = {"model": s.cfg.get_model(name) or (s.prov.model if s.prov else ""),
             "models": s._models(name)}
        r.update(s._apis_state())
        return r

    def set_model(s, model):
        s.cfg.set_model(s.cfg.get_active_provider(), model.strip())
        s._initp()

    def save_keys(s, keys):
        for p, v in (keys or {}).items():
            s.cfg.set_api_key(p, v)
        s._initp()
        return s._apis_state()

    # ── workspace / archivos ──────────────────────────────
    def _git_branch(s):
        if not s.ws:
            return ""
        try:
            txt = (Path(s.ws) / ".git" / "HEAD").read_text(encoding="utf-8").strip()
            return txt.rsplit("/", 1)[-1] if txt.startswith("ref:") else txt[:8]
        except OSError:
            return ""

    @staticmethod
    def _is_venv(p):
        return (p / "pyvenv.cfg").exists() or p.name == "site-packages"

    def _iter_files(s, base, max_files=5000):
        """Archivos de código del workspace, salteando venvs y basura.
        max_files: límite de seguridad para evitar iteraciones excesivas."""
        file_count = 0
        for root, dirs, files in os.walk(base):
            rp = Path(root)
            dirs[:] = [d for d in dirs
                       if not d.startswith(".") and d not in IGNORE_DIRS
                       and not s._is_venv(rp / d)]
            for f in sorted(files):
                if file_count >= max_files:
                    return
                p = rp / f
                if p.suffix.lower() in CODE_EXT:
                    yield p
                    file_count += 1

    def _tree(s):
        if not s.ws:
            return []

        def walk(dirp, depth):
            items = []
            try:
                entries = sorted(dirp.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
            except OSError:
                return items
            for p in entries:
                if p.name.startswith("."):
                    continue
                if p.is_dir():
                    if p.name in IGNORE_DIRS or s._is_venv(p):
                        continue
                    items.append({"name": p.name, "path": str(p), "dir": True,
                                  "children": walk(p, depth + 1) if depth < 3 else []})
                elif p.suffix.lower() in CODE_EXT:
                    items.append({"name": p.name, "path": str(p), "dir": False})
            return items
        return walk(Path(s.ws), 0)

    def pick_ws(s):
        r = s._window.create_file_dialog(webview.FOLDER_DIALOG)
        if not r:
            return None
        s.ws = r[0] if isinstance(r, (list, tuple)) else str(r)
        return {"ws": s.ws, "tree": s._tree(), "branch": s._git_branch()}

    def _file_payload(s, path):
        p = Path(path)
        try:
            content = p.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return {"error": f"No pude abrir {p.name}: {e}"}
        return {"path": str(p), "name": p.name, "content": content,
                "lang": LANG_BY_EXT.get(p.suffix.lower(), "python")}

    def open_file(s, path):
        return s._file_payload(path)

    def open_dialog(s):
        r = s._window.create_file_dialog(webview.OPEN_DIALOG,
                                        directory=s.ws or "")
        if not r:
            return None
        return s._file_payload(r[0] if isinstance(r, (list, tuple)) else str(r))

    IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}

    def pick_image(s):
        """Diálogo de archivo para adjuntar una imagen al chat (visión).
        Devuelve {data, mime, name} en base64, listo para mandar al modelo."""
        r = s._window.create_file_dialog(
            webview.OPEN_DIALOG,
            file_types=("Imágenes (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp)",))
        if not r:
            return None
        p = Path(r[0] if isinstance(r, (list, tuple)) else str(r))
        mime = s.IMG_MIME.get(p.suffix.lower())
        if not mime:
            return {"error": f"Formato no soportado: {p.suffix}"}
        try:
            data = base64.b64encode(p.read_bytes()).decode("ascii")
        except OSError as e:
            return {"error": str(e)}
        return {"data": data, "mime": mime, "name": p.name}

    def save_file(s, path, content):
        if not path:
            r = s._window.create_file_dialog(webview.SAVE_DIALOG,
                                            directory=s.ws or "",
                                            save_filename="codigo.py")
            if not r:
                return None
            path = r[0] if isinstance(r, (list, tuple)) else str(r)
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return {"path": str(p), "name": p.name}

    # ── ejecutar código ───────────────────────────────────
    GUI_LIBS = re.compile(r"\b(pygame|tkinter|turtle|PyQt5|PyQt6|PySide6|kivy|arcade)\b")

    def run_code(s, code, lang):
        # los juegos/apps con ventana no pueden correr capturados con timeout
        # de 30s: se lanzan en un proceso aparte y viven lo que el usuario quiera
        if lang == "python" and s.GUI_LIBS.search(code):
            import shutil
            import tempfile
            f = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False,
                                            encoding="utf-8")
            f.write(code)
            f.close()
            # pythonw no abre consola fantasma; si no está, python con consola propia
            exe = (shutil.which("pythonw") or shutil.which("python")
                   or shutil.which("python3"))
            if not exe:
                return {"success": False, "stdout": "", "stderr": "",
                        "error": "No encuentro Python en el PATH"}
            flags = (subprocess.CREATE_NEW_CONSOLE
                     if os.name == "nt" and exe.lower().endswith("python.exe") else 0)
            try:
                subprocess.Popen([exe, f.name], cwd=s.ws or None, creationflags=flags)
                return {"success": True, "returncode": 0, "stderr": "",
                        "stdout": "🎮 App con ventana: corriendo en un proceso aparte. "
                                  "Cerrala desde su propia ventana."}
            except OSError as e:
                return {"success": False, "stdout": "", "stderr": "",
                        "error": f"No pude lanzar la app: {e}"}
        return CodeRunner.run(code, lang)

    def preview_html(s, path, content):
        """Guarda el HTML (en su archivo o en un temporal) y lo abre en el navegador."""
        try:
            if path:
                p = Path(path)
                p.write_text(content, encoding="utf-8")
            else:
                import tempfile
                f = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False,
                                                encoding="utf-8")
                f.write(content)
                f.close()
                p = Path(f.name)
            webbrowser.open(p.resolve().as_uri())
            return {"path": str(p)}
        except Exception as e:
            return {"error": str(e)}

    # ── diff para la tarjeta de cambios ───────────────────
    def diff_stats(s, old, new):
        sm = difflib.SequenceMatcher(None, old.splitlines(), new.splitlines())
        adds = dels = 0
        ranges = []
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op in ("replace", "insert"):
                adds += j2 - j1
                ranges.append([j1, j2])
            if op in ("replace", "delete"):
                dels += i2 - i1
        return {"adds": adds, "dels": dels, "ranges": ranges}

    # ── failover automático entre modelos/proveedores ────
    # errores que justifican saltar al siguiente modelo (no son culpa del prompt)
    FAILOVER_HINTS = ("429", "500", "502", "503", "504", "529", "decommission",
                      "rate limit", "límite de uso", "sobrecargado", "caído",
                      "timeout", "timed out", "max retries", "connection",
                      "temporarily", "unavailable", "overloaded", "401", "403",
                      "capacity", "not found", "does not exist")

    def _is_failover(s, err):
        e = str(err).lower()
        return any(h in e for h in s.FAILOVER_HINTS)

    # modelo RÁPIDO y confiable por proveedor para el failover (evita razonadores
    # lentos como glm-5.2 al saltar: queremos que responda YA, no que piense 40s)
    FAST_MODEL = {
        "groq": "openai/gpt-oss-120b",
        "nvidia": "meta/llama-3.3-70b-instruct",
        "deepseek": "deepseek-v4-flash",
        "siliconflow": "deepseek-ai/DeepSeek-V3",
        "openai": "gpt-4o-mini",
        "qwen": "qwen-plus",
        "glm": "glm-4-flash",
        "xai": "grok-2",
    }

    def _chain(s):
        """Cadena de failover: (proveedor, modelo). El activo usa el modelo que
        eligió el usuario; los de respaldo usan su modelo RÁPIDO conocido. Termina
        en Ollama local (custom) que no tiene límites de cupo → siempre responde."""
        provs = s.cfg.data.get("providers", {})
        active = s.cfg.get_active_provider()
        # Prioridad: deepseek, siliconflow, nvidia, groq, openai, anthropic, …, custom
        pref = ["deepseek", "siliconflow", "nvidia", "groq", "openai",
                "anthropic", "qwen", "glm", "xai", "custom"]
        rest = sorted((p for p in provs if p != active),
                      key=lambda p: pref.index(p) if p in pref else 99)
        chain = []
        for i, name in enumerate([active] + rest):
            d = provs.get(name, {})
            if not (d.get("api_key") or name == "custom"):
                continue
            if i == 0:
                model = d.get("model") or None            # respeta la elección del usuario
            elif name == "custom":
                # Ollama local: usar un modelo REALMENTE instalado (detectado)
                if not s._ollama:
                    s.ollama_models()   # detección perezosa (timeout 2s)
                model = (s._ollama[0] if s._ollama else None) or d.get("model") or None
            else:
                model = s.FAST_MODEL.get(name) or d.get("model") or None
            chain.append((name, model))
        return chain

    def _mk_provider(s, name, model=None):
        d = s.cfg.data.get("providers", {}).get(name, {})
        kw = {"model": model or d.get("model") or None}
        if d.get("base_url"):
            kw["base_url"] = d["base_url"]
        return get_provider(name, api_key=d.get("api_key", ""), **kw)

    @staticmethod
    def _arg_path(args):
        """Ruta desde los args de una tool, tolerando alias comunes que el modelo
        a veces usa (file/filename/filepath) en vez de 'path'."""
        for k in ("path", "file", "filename", "filepath", "file_path"):
            v = args.get(k)
            if v:
                return str(v).strip()
        return ""

    # ── servidores SSH guardados ──────────────────────────
    def _resolve_ssh(s, alias_or_target):
        """Devuelve (target, key, port). Si 'alias_or_target' coincide con un
        servidor guardado (config ssh_hosts), usa sus datos; si no, lo trata
        como 'usuario@ip' directo."""
        alias_or_target = (alias_or_target or "").strip()
        for h in s.cfg.data.get("ssh_hosts", []):
            if h.get("name") == alias_or_target:
                user = (h.get("user") or "").strip()
                host = (h.get("host") or "").strip()
                target = f"{user}@{host}" if user else host
                return target, (h.get("key") or "").strip(), h.get("port")
        return alias_or_target, "", None

    @staticmethod
    def _ssh_base(target, key, port):
        parts = ["ssh", "-o", "StrictHostKeyChecking=accept-new",
                 "-o", "ConnectTimeout=15", "-o", "BatchMode=yes"]
        if port:
            parts += ["-p", str(port)]
        if key:
            parts += ["-i", key]
        parts.append(target)
        return parts

    def save_ssh_hosts(s, hosts):
        """Guarda la lista de servidores SSH (⚙). Cada uno: name, user, host, port, key."""
        clean = []
        for h in (hosts or []):
            name = (h.get("name") or "").strip()
            host = (h.get("host") or "").strip()
            if not name or not host:
                continue
            clean.append({"name": name, "user": (h.get("user") or "").strip(),
                          "host": host, "port": h.get("port") or "",
                          "key": (h.get("key") or "").strip()})
        s.cfg.data["ssh_hosts"] = clean
        s.cfg.save()
        return {"ssh_hosts": clean}

    # ── agente ────────────────────────────────────────────
    def _get_tools(s):
        return [
            {"type": "function", "function": {"name": "read_file", "description": "Lee un archivo (ruta relativa al workspace O absoluta). Para archivos grandes leelo por partes con start_line y max_lines; si la salida avisa que hay mas, segui desde el start_line que indica.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "start_line": {"type": "integer", "description": "linea inicial, 1 = principio"}, "max_lines": {"type": "integer", "description": "cuantas lineas leer; 0 = hasta el final o el tope"}}, "required": ["path"]}}},
            {"type": "function", "function": {"name": "write_file", "description": "Escribe archivo COMPLETO (crea o reemplaza todo el contenido). Para archivos existentes grandes preferi edit_file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
            {"type": "function", "function": {"name": "edit_file", "description": "Reemplaza un fragmento exacto de un archivo existente por otro, sin reescribir el resto. old_text debe aparecer LITERAL y UNA SOLA VEZ en el archivo (copialo de un read_file previo, con la indentacion exacta). Preferi esto sobre write_file para archivos grandes.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, "required": ["path", "old_text", "new_text"]}}},
            {"type": "function", "function": {"name": "exec_cmd", "description": "Ejecuta comando shell", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
            {"type": "function", "function": {"name": "run_code", "description": "Corre codigo del editor", "parameters": {"type": "object", "properties": {"language": {"type": "string"}}, "required": ["language"]}}},
            {"type": "function", "function": {"name": "list_files", "description": "Lista archivos del workspace", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}},
            {"type": "function", "function": {"name": "search_code", "description": "Busca texto/regex en los archivos del proyecto y devuelve archivo:linea:coincidencia. Usalo para ubicar funciones o usos antes de editar.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
            {"type": "function", "function": {"name": "git", "description": "Ejecuta un comando git EN EL WORKSPACE (status, add, commit, push, pull, log, diff, branch, clone, remote, init...). Para SUBIR A GITHUB: 'add -A' -> 'commit -m \"mensaje\"' -> 'push'. Si el repo no existe aun podes usar exec_cmd con 'gh repo create' (gh CLI ya esta autenticado). No hace falta pedir permiso.", "parameters": {"type": "object", "properties": {"args": {"type": "string", "description": "argumentos de git, ej: commit -m \"fix login\""}}, "required": ["args"]}}},
            {"type": "function", "function": {"name": "ssh_exec", "description": "Ejecuta un comando en un servidor remoto por SSH y devuelve stdout/stderr. 'host' puede ser un ALIAS guardado (ver lista de servidores) o 'usuario@ip' directo. Usalo para administrar servidores, desplegar, revisar logs, etc.", "parameters": {"type": "object", "properties": {"host": {"type": "string", "description": "alias guardado o usuario@ip"}, "command": {"type": "string"}}, "required": ["host", "command"]}}},
            {"type": "function", "function": {"name": "scp_upload", "description": "Sube un archivo o carpeta local a un servidor remoto por scp. 'host' = alias guardado o usuario@ip.", "parameters": {"type": "object", "properties": {"host": {"type": "string"}, "local": {"type": "string", "description": "ruta local (relativa al workspace o absoluta)"}, "remote": {"type": "string", "description": "ruta destino en el servidor"}}, "required": ["host", "local", "remote"]}}},
            {"type": "function", "function": {"name": "generate_image", "description": "Genera una imagen a partir de una descripcion (DALL-E de OpenAI, o SiliconFlow si no hay key de OpenAI) y la guarda en el workspace. Requiere API key de OpenAI o SiliconFlow cargada en Configuracion.", "parameters": {"type": "object", "properties": {"prompt": {"type": "string", "description": "descripcion de la imagen a generar, en ingles da mejor resultado"}, "path": {"type": "string", "description": "ruta donde guardarla dentro del workspace, ej assets/logo.png. Si se omite usa assets/img_<fecha>.png"}, "size": {"type": "string", "description": "tamano, ej 1024x1024 (default) — no todos los tamanos existen en todos los proveedores"}}, "required": ["prompt"]}}},
        ]

    def _exec_tool(s, name, args, code, lang):
        try:
            if name == "read_file":
                rel = s._arg_path(args)
                if not rel:
                    return ("❌ Falta 'path'. Llamá read_file con {\"path\": \"archivo.js\"} "
                            "(opcional start_line/max_lines). No repitas sin el path.")
                p = Path(rel) if os.path.isabs(rel) else s._base() / rel
                if not p.exists():
                    return f"❌ No existe: {rel}. Usá list_files para ver los nombres exactos."
                if p.is_dir():
                    return "❌ Es un directorio — usá list_files"
                try:
                    txt = p.read_text(encoding="utf-8", errors="replace")
                except OSError as e:
                    return f"❌ {e}"
                lines = txt.splitlines(keepends=True)
                start = max(1, int(args.get("start_line", 1) or 1))
                maxl = int(args.get("max_lines", 0) or 0)
                end = (start - 1 + maxl) if maxl else len(lines)
                seg = "".join(lines[start - 1:end])
                cap = 20000
                if len(seg) > cap:
                    return seg[:cap] + (f"\n\n… (cortado en {cap} chars — pedí un rango "
                                        "menor con start_line/max_lines)")
                if end < len(lines):
                    seg += (f"\n\n… ({len(lines)} líneas en total; mostradas {start}-{end}. "
                            f"Seguí con start_line={end + 1})")
                return seg or "(archivo vacío)"
            if name == "write_file":
                rel = s._arg_path(args)
                if not rel:
                    return ("❌ Falta 'path'. Llamá write_file con "
                            "{\"path\": \"archivo.py\", \"content\": \"...\"}. "
                            "No repitas la llamada sin el path — corregila.")
                if "content" not in args and "text" not in args:
                    return ("❌ Falta 'content' — write_file necesita {path, content} con el "
                            "contenido COMPLETO del archivo. Si querés cambiar solo una parte, usá edit_file.")
                content = args.get("content")
                if content is None:
                    content = args.get("text") or ""
                p = s._base() / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                # checkpoint: guardar el contenido previo (o None si es nuevo) una
                # sola vez por turno, para poder deshacer todo el turno con /undo
                key = str(p)
                if key not in s._checkpoint:
                    s._checkpoint[key] = p.read_text(encoding="utf-8",
                                                     errors="replace") if p.exists() else None
                p.write_text(content, encoding="utf-8")
                s._written.append(str(p))
                s._push("wrote", {"path": str(p)})
                return f"✅ Escrito {rel} ({len(content)}c)"
            if name == "edit_file":
                rel = s._arg_path(args)
                if not rel:
                    return ("❌ Falta 'path'. Llamá edit_file con "
                            "{path, old_text, new_text}. No repitas sin el path.")
                p = s._base() / rel
                if not p.exists():
                    return f"❌ No existe {rel} — usa write_file para crear un archivo nuevo"
                old, new = args.get("old_text", ""), args.get("new_text", "")
                if not old:
                    return "❌ old_text vacio — copia el fragmento exacto a reemplazar (de un read_file previo)"
                try:
                    src = p.read_text(encoding="utf-8", errors="replace")
                except OSError as e:
                    return f"❌ {e}"
                n = src.count(old)
                if n == 0:
                    return ("❌ No encontre ese texto exacto en el archivo — releelo con "
                             "read_file y copia el fragmento tal cual (indentacion incluida)")
                if n > 1:
                    return f"❌ Ese texto aparece {n} veces en el archivo — agrega mas contexto para que sea unico"
                key = str(p)
                if key not in s._checkpoint:
                    s._checkpoint[key] = src
                p.write_text(src.replace(old, new, 1), encoding="utf-8")
                s._written.append(str(p))
                s._push("wrote", {"path": str(p)})
                return f"✅ Editado ({len(new)}c)"
            if name == "exec_cmd":
                cmd = args.get("command") or args.get("cmd") or ""
                if not cmd:
                    return "❌ Falta 'command'. Llamá exec_cmd con {\"command\": \"...\"}."
                r = subprocess.run(cmd, shell=True, capture_output=True,
                                   text=True, timeout=30, cwd=str(s._base()))
                return f"⚡ exit={r.returncode}\n" + ((r.stdout + "\n" + r.stderr).strip()[:3000])
            if name == "git":
                a = (args.get("args") or "").strip()
                if not a:
                    return "❌ Faltan argumentos de git (ej: 'commit -m \"msg\"', 'push')"
                r = subprocess.run("git " + a, shell=True, capture_output=True,
                                   text=True, timeout=180, cwd=str(s._base()))
                out = (r.stdout + "\n" + r.stderr).strip()
                return f"⎇ git {a} (exit={r.returncode})\n{out[:3500] or '(sin salida)'}"
            if name == "ssh_exec":
                target, key, port = s._resolve_ssh(args.get("host", ""))
                if not target:
                    return "❌ Falta el host (alias guardado o usuario@ip)"
                cmd = args.get("command", "")
                if not cmd:
                    return "❌ Falta el comando a ejecutar en el servidor"
                r = subprocess.run(s._ssh_base(target, key, port) + [cmd],
                                   capture_output=True, text=True, timeout=180)
                out = (r.stdout + "\n" + r.stderr).strip()
                return f"🔌 {target} (exit={r.returncode})\n{out[:3500] or '(sin salida)'}"
            if name == "scp_upload":
                target, key, port = s._resolve_ssh(args.get("host", ""))
                if not target:
                    return "❌ Falta el host"
                local = args.get("local", "")
                lp = local if os.path.isabs(local) else str(s._base() / local)
                remote = args.get("remote", "")
                parts = ["scp", "-r", "-o", "StrictHostKeyChecking=accept-new"]
                if port:
                    parts += ["-P", str(port)]
                if key:
                    parts += ["-i", key]
                parts += [lp, f"{target}:{remote}"]
                r = subprocess.run(parts, capture_output=True, text=True, timeout=300)
                out = (r.stdout + "\n" + r.stderr).strip()
                return f"📤 {local} → {target}:{remote} (exit={r.returncode})\n{out[:2000]}"
            if name == "run_code":
                if not code or code.strip() == "// Nuevo archivo":
                    return "❌ Editor vacio"
                return json.dumps(CodeRunner.run(code, args.get("language", lang)),
                                  indent=2)[:3000]
            if name == "list_files":
                base = s._base()
                return "\n".join(str(f.relative_to(base))
                                 for f in s._iter_files(base))[:3000] or "(vacío)"
            if name == "search_code":
                base = s._base()
                q = args.get("query", "")
                try:
                    rx = re.compile(q, re.IGNORECASE)
                except re.error:
                    rx = re.compile(re.escape(q), re.IGNORECASE)
                hits = []
                max_hits = 50
                for f in s._iter_files(base):
                    if len(hits) >= max_hits:
                        break
                    try:
                        content = f.read_text(encoding="utf-8", errors="replace")
                        lines = content.splitlines()
                        for i, line in enumerate(lines, 1):
                            if rx.search(line):
                                hits.append(f"{f.relative_to(base)}:{i}: {line.strip()[:120]}")
                                if len(hits) >= max_hits:
                                    break
                    except (OSError, UnicodeDecodeError):
                        pass
                return "\n".join(hits) or f"(sin coincidencias para «{q}»)"
            if name == "generate_image":
                prompt = (args.get("prompt") or "").strip()
                if not prompt:
                    return "❌ Falta 'prompt' — describí la imagen que querés generar."
                size = args.get("size") or "1024x1024"
                rel = args.get("path") or (
                    f"assets/img_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.png")
                img_bytes, used, err = s._gen_image(prompt, size)
                if err:
                    return f"❌ {err}"
                p = s._base() / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(img_bytes)
                s._written.append(str(p))
                s._push("wrote", {"path": str(p)})
                return f"✅ Imagen generada con {used} → {rel}"
        except Exception as e:
            return f"❌ {e}"

    def _gen_image(s, prompt, size="1024x1024"):
        """Genera una imagen con la primera API disponible: OpenAI (dall-e-3)
        y si no hay key, SiliconFlow. Devuelve (bytes, proveedor_usado, error) —
        exactamente uno de (bytes, error) es no-None."""
        err_openai = err_sf = None
        ok = s.cfg.get_api_key("openai")
        if ok:
            try:
                r = requests.post(
                    "https://api.openai.com/v1/images/generations",
                    headers={"Authorization": f"Bearer {ok}", "Content-Type": "application/json"},
                    json={"model": "dall-e-3", "prompt": prompt, "size": size,
                          "n": 1, "response_format": "b64_json"},
                    timeout=90)
                if r.ok:
                    b64 = r.json()["data"][0]["b64_json"]
                    return base64.b64decode(b64), "OpenAI (dall-e-3)", None
                try:
                    detail = (r.json().get("error") or {}).get("message", r.text[:200])
                except ValueError:
                    detail = r.text[:200]
                err_openai = f"OpenAI: {detail}"
            except requests.RequestException as e:
                err_openai = f"OpenAI: {e}"
        sk = s.cfg.get_api_key("siliconflow")
        if sk:
            try:
                r = requests.post(
                    "https://api.siliconflow.com/v1/images/generations",
                    headers={"Authorization": f"Bearer {sk}", "Content-Type": "application/json"},
                    json={"model": "black-forest-labs/FLUX.1-schnell", "prompt": prompt, "image_size": size},
                    timeout=90)
                if r.ok:
                    d = (r.json().get("data") or [{}])[0]
                    if d.get("b64_json"):
                        return base64.b64decode(d["b64_json"]), "SiliconFlow", None
                    if d.get("url"):
                        img = requests.get(d["url"], timeout=60)
                        img.raise_for_status()
                        return img.content, "SiliconFlow", None
                    err_sf = "SiliconFlow: respuesta sin imagen"
                else:
                    try:
                        detail = (r.json().get("error") or {}).get("message", r.text[:200])
                    except ValueError:
                        detail = r.text[:200]
                    err_sf = f"SiliconFlow: {detail}"
            except requests.RequestException as e:
                err_sf = f"SiliconFlow: {e}"
        if not ok and not sk:
            return None, None, ("no hay API key de OpenAI ni de SiliconFlow cargada — "
                                 "agregá una en Configuración (⚙) para generar imágenes")
        return None, None, " · ".join(x for x in (err_openai, err_sf) if x) or "no se pudo generar la imagen"

    def _check_written(s):
        """Verifica la sintaxis de los archivos escritos por el agente en este turno.
        El harness NO confía en que el modelo escriba código válido: .py se compila,
        .js/.mjs/.cjs se chequean con `node --check` (si hay node), .json se parsea."""
        import shutil
        node = shutil.which("node")
        errs = []
        for p in dict.fromkeys(s._written):
            base = os.path.basename(p)
            try:
                if p.endswith(".py"):
                    src = Path(p).read_text(encoding="utf-8", errors="replace")
                    compile(src, p, "exec")
                elif p.endswith((".js", ".mjs", ".cjs")) and node:
                    r = subprocess.run([node, "--check", p], capture_output=True,
                                       text=True, timeout=15)
                    if r.returncode != 0:
                        det = (r.stderr or r.stdout).strip().splitlines()
                        errs.append(f"{base}: " + (det[0] if det else "error de sintaxis JS"))
                elif p.endswith(".json"):
                    json.loads(Path(p).read_text(encoding="utf-8", errors="replace"))
            except SyntaxError as e:
                linea = (e.text or "").strip()
                errs.append(f"{base} línea {e.lineno}: {e.msg}"
                            + (f"\n  {linea}" if linea else ""))
            except json.JSONDecodeError as e:
                errs.append(f"{base}: JSON inválido — {e.msg} (línea {e.lineno})")
            except (OSError, subprocess.SubprocessError):
                pass
        return "\n".join(errs)

    def _pick_entry(s):
        """Elige UN archivo .py de los escritos este turno para el smoke test.
        Prioriza puntos de entrada obvios; si no, uno con bloque __main__.
        Devuelve la ruta o None si no hay un candidato claro y seguro."""
        pys = [p for p in dict.fromkeys(s._written) if p.endswith(".py")]
        if not pys:
            return None
        names = {"main.py", "app.py", "__main__.py", "run.py", "manage.py",
                 "cli.py", "start.py"}
        for p in pys:
            if os.path.basename(p).lower() in names:
                return p
        for p in pys:
            try:
                if "__main__" in Path(p).read_text(encoding="utf-8", errors="replace"):
                    return p
            except OSError:
                pass
        # un único archivo suelto → probablemente es el que hay que correr
        return pys[0] if len(pys) == 1 else None

    def _check_runtime(s):
        """Verificación de EJECUCIÓN (no solo sintaxis): corre el punto de entrada
        .py escrito este turno con un timeout y, si revienta con un traceback,
        devuelve el error para que el modelo lo corrija. Desactivable con
        config agent.verify_runtime=false. Salta apps con ventana (pygame/tkinter…),
        que no se pueden correr capturadas, y trata el timeout como 'probablemente
        un server/loop, no lo marco como error'."""
        if not s.cfg.data.get("agent", {}).get("verify_runtime", True):
            return ""
        entry = s._pick_entry()
        if not entry:
            return ""
        try:
            src = Path(entry).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        if s.GUI_LIBS.search(src):
            return ""   # app con ventana: no se puede smoke-testear con timeout
        import shutil
        exe = shutil.which("python") or shutil.which("python3")
        if not exe:
            return ""
        base = os.path.basename(entry)
        try:
            s._push("sys", f"▶ Verificando que {base} corra sin errores…")
            r = subprocess.run([exe, entry], capture_output=True, text=True,
                               timeout=12, cwd=str(s._base()),
                               env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        except subprocess.TimeoutExpired:
            # no terminó en 12s: server, loop o input() → no lo tomo como falla
            return ""
        except (OSError, subprocess.SubprocessError):
            return ""
        if r.returncode == 0:
            return ""
        err = (r.stderr or r.stdout or "").strip()
        if "Traceback" not in err and "Error" not in err:
            return ""   # exit != 0 sin traceback claro (ej. sys.exit(1) intencional)
        # quedarse con la parte útil del traceback (las últimas líneas)
        tail = "\n".join(err.splitlines()[-12:])
        return f"{base} falla al ejecutarse:\n{tail}"

    def _run_model(s, ms, sp, temperature, max_tok, use_tools):
        """Llama al modelo con STREAMING real: empuja content y reasoning
        ('pensamiento') a la UI a medida que llegan. Devuelve el AIResponse final.
        `s._live` queda True si el texto de la respuesta se mostró en vivo."""
        tools = s._get_tools() if use_tools else None
        s._live = False
        if getattr(s.prov, "supports_stream", False):
            started = thinking = False
            r = None
            for ev in s.prov.chat_stream(ms, system_prompt=sp, temperature=temperature,
                                         max_tokens=max_tok, tools=tools):
                t = ev["type"]
                if t == "reasoning":
                    if not thinking:
                        s._push("think_start", {}); thinking = True
                    s._push("think_delta", ev["text"])
                elif t == "content":
                    if thinking:
                        s._push("think_end", {}); thinking = False
                    if not started:
                        s._push("agent_start", {}); started = True
                    s._push("agent_delta", ev["text"])
                elif t == "done":
                    r = ev["response"]
                if s._cancel:      # el usuario apretó detener → cortar el stream
                    break
            if thinking:
                s._push("think_end", {})
            if started:
                s._push("agent_end", {})
            s._live = started
            return r
        # provider sin streaming (Anthropic): una sola llamada bloqueante
        return s.prov.chat(ms, system_prompt=sp, temperature=temperature,
                           max_tokens=max_tok, tools=tools)

    def send_chat(s, msg, code, lang, image=None):
        r = None
        s._written = []
        s._checkpoint = {}   # arranca el checkpoint del turno
        s._cancel = False
        try:
            ctx = ""
            if code.strip() and not code.startswith("//"):
                ctx += f"Editor ({lang}):\n```{lang}\n{code[:3000]}\n```\n"
            if s.ws:
                cf = list(s._iter_files(Path(s.ws)))
                if cf:
                    ctx += "Proyecto:\n" + "\n".join(
                        f"  {f.relative_to(s.ws)}" for f in cf[:12]) + "\n"
            sp = (s.cfg.data.get("system_prompt") or "").strip() or DEFAULT_SP
            # Reflexion: re-inyectar las lecciones aprendidas de errores previos
            lessons = s._load_lessons()
            if lessons:
                sp += ("\n\nLECCIONES APRENDIDAS de errores previos (RESPETALAS estrictamente):\n"
                       + "\n".join(f"- {x['txt']}" for x in lessons[-12:]))
            # imagen adjunta (visión): arma el content multimodal formato OpenAI
            # ({"type":"image_url",...}); cada provider lo traduce si hace falta
            # (ver _msgs_to_anthropic). No se guarda en la memoria del turno para
            # no arrastrar el base64 (pesado) a los mensajes siguientes.
            user_text = ctx + msg
            if image and image.get("data"):
                user_content = [
                    {"type": "text", "text": user_text or "Describí esta imagen."},
                    {"type": "image_url", "image_url": {
                        "url": f"data:{image.get('mime', 'image/png')};base64,{image['data']}"}},
                ]
            else:
                user_content = user_text
            # memoria: incluir los últimos turnos para que el agente tenga contexto
            ms = list(s._mem[-s._mem_limit():]) + [{"role": "user", "content": user_content}]
            text = ""
            use_tools = True
            flubs = 0
            fixes = 0
            rt_fixes = 0      # correcciones pedidas por errores de EJECUCIÓN (runtime)
            max_tok = 8192   # se ajusta solo (413 lo baja, archivo cortado lo sube)
            seen_calls = {}   # (tool, args) -> veces repetida en este turno → detectar bucles
            stall = 0         # llamadas repetidas seguidas sin avance
            stalled_out = False
            hit_cap = False
            tool_runs = 0     # herramientas realmente ejecutadas en el turno (progreso)
            # cadena de failover: si el modelo actual se cae/agota, saltar al siguiente
            chain = s._chain()   # [(proveedor, modelo), ...]
            ci = 0
            if chain:
                s.prov = s._mk_provider(*chain[0])
            # Límites del agente: configurables desde ⚙ (config "agent"). La filosofía
            # de Fidel es NO ponerle techo al trabajo — el único freno real es que el
            # agente deje de AVANZAR (bucle) o el costo/límite de la API. max_steps =
            # rondas de tools por tramo; max_continuations = cuántas veces sigue solo.
            ag = s.cfg.data.get("agent", {})
            cfg_steps = int(ag.get("max_steps", 40) or 40)
            # el piso asegura suficientes intentos para agotar la cadena de failover
            max_attempts = max(cfg_steps, len(chain) * 3 + 4)
            continuations = 0
            MAX_AUTO_CONTINUATIONS = int(ag.get("max_continuations", 25) or 25)
            no_progress = 0            # tramos seguidos sin ningún avance → ahí sí paramos
            last_progress = (0, 0)     # (archivos escritos, herramientas ejecutadas)
            while True:
                hit_cap = False
                for attempt in range(max_attempts):
                    if s._cancel:
                        return {"text": "⏹ Detenido.", "status": "Detenido"}
                    try:
                        # temperatura baja: las llamadas a herramientas requieren
                        # JSON exacto y los Llama en Groq lo fallan con temp alta
                        r = s._run_model(ms, sp, 0.2, max_tok, use_tools)
                    except Exception as e:
                        err = str(e)
                        low = err.lower()
                        decom = "decommission" in low
                        # 413: el request excede el límite por minuto (típico free tier) →
                        # achicar la respuesta pedida y reintentar en el mismo modelo
                        if ("413" in err or "too large" in low or "reduce your message" in low) \
                                and max_tok > 1024:
                            max_tok = max(1024, max_tok // 2)
                            log(f"413 → reintento con max_tokens={max_tok}")
                            continue
                        if use_tools and "400" in err and not decom:
                            if "Failed to call a function" in err or "tool_use_failed" in err:
                                # el modelo armó mal el JSON de la tool call:
                                # es aleatorio, reintentar suele alcanzar
                                flubs += 1
                                log(f"tool call malformada (intento {flubs}): {err[:200]}")
                                if flubs <= 2:
                                    continue
                                use_tools = False
                                s._push("sys", "⚠ El modelo falló 3 veces armando la llamada a herramienta — respondo sin herramientas este mensaje")
                                continue
                            use_tools = False
                            log(f"tools deshabilitadas tras 400: {err[:200]}")
                            s._push("sys", "⚠ Este modelo no acepta herramientas — respondo sin ellas (no puede crear archivos)")
                            continue
                        # ── FAILOVER: modelo caído/agotado/dado de baja → siguiente ──
                        if (s._is_failover(err) or decom) and ci + 1 < len(chain):
                            prev = chain[ci][0]
                            ci += 1
                            nxt, nxt_model = chain[ci]
                            s.prov = s._mk_provider(nxt, nxt_model)
                            s._push("sys", f"⚠ {prev} no disponible ({err[:50].strip()}…) "
                                           f"→ cambiando automáticamente a {nxt} · {nxt_model or 'default'}")
                            log(f"failover {prev} → {nxt}/{nxt_model}: {err[:150]}")
                            use_tools = True
                            flubs = 0
                            continue
                        raise
                    # el usuario detuvo (o el stream se cortó sin respuesta)
                    if s._cancel or r is None:
                        return {"streamed": bool(getattr(s, "_live", False)),
                                "full": "", "text": "" if getattr(s, "_live", False) else "⏹ Detenido.",
                                "status": "Detenido"}
                    raw = r.raw or {}
                    msg_resp = raw.get("choices", [{}])[0].get("message", {})
                    tcs = msg_resp.get("tool_calls", [])
                    if not tcs:
                        text = msg_resp.get("content", "") or r.content
                        # verificación del harness: si escribió .py con sintaxis rota,
                        # devolverle el error para que lo corrija antes de terminar
                        errs = s._check_written()
                        if errs and use_tools and fixes < 2:
                            fixes += 1
                            # si el error pinta a corte por limite de tokens (archivo
                            # a medio escribir), subir el techo en vez de solo reintentar
                            # con el mismo limite — si no, va a cortarse igual de nuevo
                            trunc = any(h in errs.lower() for h in
                                        ("unexpected eof", "was never closed",
                                         "unterminated", "eol while scanning"))
                            if trunc and max_tok < 16384:
                                max_tok = min(16384, max_tok * 2)
                                s._push("sys", f"⚠ El archivo parece haberse cortado por el límite de tokens — subo a {max_tok} y pido que lo reescriba completo ({fixes}/2)…")
                            else:
                                s._push("sys", f"⚠ Verifiqué el código y tiene errores de sintaxis — pidiendo corrección ({fixes}/2)…")
                            ms.append({"role": "assistant", "content": text})
                            ms.append({"role": "user", "content":
                                       "Verifiqué los archivos que escribiste y tienen errores de sintaxis:\n"
                                       + errs +
                                       "\nCorregilos: si el archivo es grande preferi edit_file sobre el "
                                       "fragmento roto; si usas write_file escribi el archivo COMPLETO. "
                                       "Confirma en una linea."})
                            text = ""
                            continue
                        if errs:
                            s._push("sys", f"⚠ Quedaron errores de sintaxis sin resolver:\n{errs}")
                            s._reflect_and_learn(msg, f"dejaste código con errores de sintaxis: {errs[:200]}")
                            break
                        # sintaxis OK → verificación de EJECUCIÓN: correr el punto de
                        # entrada y, si revienta en runtime, pedir corrección con el
                        # traceback (no alcanza con que compile: tiene que ANDAR)
                        rt = s._check_runtime()
                        if rt and use_tools and rt_fixes < 2:
                            rt_fixes += 1
                            s._push("sys", f"⚠ Compila pero falla al ejecutarse — pidiendo corrección ({rt_fixes}/2)…")
                            ms.append({"role": "assistant", "content": text})
                            ms.append({"role": "user", "content":
                                       "Verifiqué ejecutando el código y falla en tiempo de ejecución:\n"
                                       + rt +
                                       "\nCorregí la causa real del error (leé el traceback) y dejalo "
                                       "andando. Usá edit_file para el cambio puntual. Confirmá en una línea."})
                            text = ""
                            continue
                        if rt:
                            s._push("sys", f"⚠ Quedó un error de ejecución sin resolver:\n{rt}")
                            s._reflect_and_learn(msg, f"dejaste código que compila pero falla al correr: {rt[:200]}")
                        break
                    asst = {"role": "assistant",
                            "content": msg_resp.get("content", ""), "tool_calls": tcs}
                    # Los modelos "thinking" de DeepSeek EXIGEN que se les devuelva su
                    # reasoning_content junto al mensaje con tool_calls, o responden
                    # 400 "The reasoning_content in the thinking mode must be passed
                    # back". El transport ya lo captura en raw → lo reinyectamos.
                    if msg_resp.get("reasoning_content"):
                        asst["reasoning_content"] = msg_resp["reasoning_content"]
                    ms.append(asst)
                    progressed = False
                    for tc in tcs:
                        fn = tc["function"]["name"]
                        try:
                            args = json.loads(tc["function"]["arguments"])
                        except (json.JSONDecodeError, TypeError):
                            args = {}
                        # bucle sin avance: la MISMA llamada (herramienta + argumentos)
                        # ya se ejecutó antes en este turno → no repetirla, avisar.
                        # exec_cmd/run_code quedan afuera: repetirlos SI puede tener
                        # sentido (ej. correr los tests de nuevo tras un fix).
                        sig = (fn, json.dumps(args, sort_keys=True, ensure_ascii=False))
                        dedupe = fn not in ("exec_cmd", "run_code")
                        seen_calls[sig] = seen_calls.get(sig, 0) + 1
                        if dedupe and seen_calls[sig] > 1:
                            res = ("⚠ Ya ejecutaste exactamente esta misma llamada antes en "
                                   "este turno — el resultado va a ser igual. No la repitas: "
                                   "cambia de enfoque o responde con lo que ya tenes.")
                        else:
                            res = s._exec_tool(fn, args, code, lang)
                            progressed = True
                            tool_runs += 1
                        ms.append({"role": "tool", "tool_call_id": tc.get("id", ""),
                                   "content": res})
                        # Enviar detalles más específicos de la herramienta
                        tool_info = {"name": fn, "res": str(res)[:150]}
                        if fn == "write_file" and "path" in args:
                            tool_info["file"] = args["path"]
                        elif fn == "edit_file" and "path" in args:
                            tool_info["file"] = args["path"]
                        elif fn == "read_file" and "path" in args:
                            tool_info["file"] = args["path"]
                        s._push("tool", tool_info)
                    stall = 0 if progressed else stall + 1
                    if stall >= 2:
                        stalled_out = True
                        s._push("sys", "⏹ El agente quedó repitiendo la misma acción sin avanzar — corté el turno.")
                        break
                else:
                    # se agotaron los pasos de herramientas sin llegar a una respuesta final
                    hit_cap = True
                # ¿hubo avance real en este tramo? (archivos nuevos o tools ejecutadas)
                marker = (len(dict.fromkeys(s._written)), tool_runs)
                if marker != last_progress:
                    no_progress = 0
                    last_progress = marker
                else:
                    no_progress += 1
                # Seguimos solos mientras el agente PROGRESE: solo paramos si se traba
                # (2 tramos sin ningún avance) o si tocamos el techo de seguridad
                # configurable (evita quemar tokens en un bucle infinito).
                if (hit_cap and not stalled_out and no_progress < 2
                        and continuations < MAX_AUTO_CONTINUATIONS):
                    continuations += 1
                    s._push("sys", f"↻ Sigo trabajando en la tarea (tramo {continuations})…")
                    ms.append({"role": "user", "content":
                               "Segui trabajando en la tarea desde donde quedaste, sin repetir "
                               "lo que ya hiciste ni resumir. Si ya terminaste, decilo en una linea."})
                    continue
                break
            # código propuesto → tarjeta Aceptar/Rechazar en el frontend
            for mr in reversed(ms):
                if mr.get("role") == "assistant" and mr.get("content"):
                    bs = re.findall(r"```(?:\w+)?\n(.+?)```", mr["content"], re.DOTALL)
                    if bs and bs[0].strip() != "// Nuevo archivo":
                        s._push("propose", {"code": bs[0].strip()})
                    break
            # los modelos razonadores a veces dejan content vacío o con <think>
            text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL).strip()
            if not text and stalled_out:
                n_esc = len(dict.fromkeys(s._written))
                text = ("⚠ Corté el turno: el agente repitió la misma llamada a "
                        "herramienta sin avanzar" +
                        (f" (llegó a escribir {n_esc} archivo(s) antes de trabarse)."
                         if n_esc else ".") +
                        " Probá pedir algo más chico y específico, o dividir la tarea en pasos.")
                s._reflect_and_learn(msg, "repetiste la misma llamada a herramienta ante un "
                                          "error en vez de corregir los argumentos o cambiar de enfoque")
            elif not text and hit_cap:
                n_esc = len(dict.fromkeys(s._written))
                toque = f" (toqué {n_esc} archivo(s))" if n_esc else ""
                if no_progress >= 2:
                    text = ("⏸ Paré porque el agente dejó de avanzar (repetía sin progreso)"
                            + toque + ". Escribí «segui» para reintentar, cambiá de modelo, "
                            "o dividí un poco el pedido.")
                    s._reflect_and_learn(msg, "dejaste de avanzar repitiendo acciones sin progreso")
                else:
                    text = ("↻ Vengo trabajando la tarea en varios tramos" + toque +
                            f" y llegué al tope de {continuations} tramos automáticos "
                            "(seguridad para no quemar tokens). La conversación recuerda el "
                            "contexto: escribí «segui» y continúo desde donde quedé. Si es una "
                            "tarea siempre grande, subí «tramos automáticos» en ⚙.")
            if not text:
                try:
                    rc = (r.raw or {}).get("choices", [{}])[0] \
                        .get("message", {}).get("reasoning_content") or ""
                except Exception:
                    rc = ""
                text = rc.strip()[:1500] or \
                    "⚠ El modelo no devolvió respuesta (se quedó razonando o cortó). " \
                    "Probá de nuevo o cambiá de modelo."
            status = f"✅ {r.tokens_used}t · ${r.cost:.4f} · {r.model}" if r else "Listo"
            # guardar el turno en memoria (solo texto limpio, robusto entre modelos)
            s._mem.append({"role": "user", "content": msg})
            s._mem.append({"role": "assistant", "content": text})
            s._mem = s._mem[-s._mem_limit():]
            # aviso de undo si el turno escribió archivos
            if s._checkpoint:
                n = len(s._checkpoint)
                files_list = ", ".join(Path(p).name for p in s._checkpoint.keys())
                s._push("sys", f"✍ Escribí {n} archivo(s): {files_list} · escribí /undo para revertir este turno")
            # si el texto ya se mostró en vivo por streaming, no re-renderizar
            if getattr(s, "_live", False) and text:
                return {"streamed": True, "full": text, "status": status}
            return {"text": text, "status": status}
        except Exception as e:
            import traceback
            log("send_chat fallo:\n" + traceback.format_exc())
            return {"text": f"❌ {e}", "status": "Error"}

    def undo_turn(s):
        """Revierte todos los archivos que el agente escribió en el último turno."""
        if not s._checkpoint:
            return {"msg": "No hay nada que deshacer del último turno"}
        n = 0
        for path, prev in s._checkpoint.items():
            try:
                p = Path(path)
                if prev is None:
                    if p.exists():
                        p.unlink()
                else:
                    p.write_text(prev, encoding="utf-8")
                n += 1
            except OSError:
                pass
        s._checkpoint = {}
        return {"msg": f"↩ Revertidos {n} archivo(s) del último turno", "tree": s._tree()}

    # ── comparar modelos: desafío de código verificado ────
    def compare(s, task, expected, models):
        """Misma consigna a cada modelo; el harness compila, ejecuta y
        verifica la salida. Ranking por funcionalidad, después velocidad."""
        provs = s.cfg.data.get("providers", {})
        models = [m for m in models if m in provs
                  and (provs[m].get("api_key") or m == "custom")]
        if not models:
            s._push("sys", "Sin proveedores con key")
            return
        task = (task or "").strip()
        if not task:
            task = DEFAULT_TASK
            expected = expected or DEFAULT_EXPECTED

        def norm(t):
            return " ".join((t or "").replace(",", " ").split())
        exp = norm(expected)
        results = []

        def funciona(x):
            return x.get("salida_ok") or (x.get("salida_ok") is None and x.get("corre"))

        def run_one(pn):
            res = {"prov": pn, "model": provs[pn].get("model", "?"), "lat_ms": 0,
                   "tokens": 0, "costo": 0.0, "sintaxis": False, "corre": False,
                   "salida_ok": None, "detalle": "", "icon": "❌"}
            try:
                kw = {"model": provs[pn].get("model", "") or None}
                if provs[pn].get("base_url"):
                    kw["base_url"] = provs[pn]["base_url"]
                p = get_provider(pn, api_key=provs[pn].get("api_key", ""), **kw)
                t0 = time.time()
                r = p.chat([{"role": "user", "content": task +
                             "\nResponde UNICAMENTE con un bloque de codigo Python completo."}],
                           system_prompt="Sos un programador experto. Respondes SOLO con codigo.",
                           temperature=0.2)
                res.update(lat_ms=int((time.time() - t0) * 1000),
                           tokens=r.tokens_used, costo=r.cost, model=r.model)
                bs = re.findall(r"```(?:\w+)?\n(.+?)```", r.content, re.DOTALL)
                code = (bs[0] if bs else r.content).strip()
                try:
                    compile(code, "<cmp>", "exec")
                    res["sintaxis"] = True
                except SyntaxError as e:
                    res["detalle"] = f"sintaxis rota: {e.msg} (línea {e.lineno})"
                if res["sintaxis"]:
                    out = CodeRunner.run(code, "python", timeout=15)
                    res["corre"] = bool(out.get("success"))
                    if not res["corre"]:
                        res["detalle"] = "falla al correr: " + \
                            (out.get("stderr") or out.get("error") or "?").strip()[-160:]
                    elif exp:
                        res["salida_ok"] = exp in norm(out.get("stdout", ""))
                        if not res["salida_ok"]:
                            res["detalle"] = "salida distinta: " + \
                                out.get("stdout", "").strip()[:120]
                res["icon"] = ("✅" if funciona(res) else
                               "🟡" if res["corre"] else
                               "⚠" if res["sintaxis"] else "❌")
                results.append(res)
                s._push("sys", f"{res['icon']} {pn} · {res['model']}: "
                               f"{res['lat_ms']}ms · {res['tokens']}t · ${res['costo']:.4f}"
                               + (f"\n   {res['detalle']}" if res["detalle"] else ""))
            except Exception as e:
                res["detalle"] = str(e)[:160]
                results.append(res)
                s._push("sys", f"❌ {pn}: {res['detalle']}")

        def worker():
            s._push("sys", f"⚖ Desafío de código para {len(models)} modelos:\n«{task[:140]}»")
            ts = [threading.Thread(target=run_one, args=(m,), daemon=True) for m in models]
            for th in ts:
                th.start()
            for th in ts:
                th.join(timeout=150)
            orden = sorted(results, key=lambda x: (not funciona(x), not x["corre"],
                                                   not x["sintaxis"], x["lat_ms"] or 9e9))
            podio = "\n".join(f"{i + 1}. {x['icon']} {x['prov']} · {x['model']} — "
                              f"{x['lat_ms']}ms · ${x['costo']:.4f}"
                              for i, x in enumerate(orden))
            s._push("sys", "🏆 Ranking (código que funciona primero, velocidad después):\n" + podio)
            cmp_dir = data_dir() / 'comparativas'
            cmp_dir.mkdir(parents=True, exist_ok=True)
            fp = cmp_dir / f"cmp_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            fp.write_text(json.dumps({"tarea": task, "esperado": expected,
                                      "resultados": results, "ts": time.time()},
                                     indent=2, ensure_ascii=False), encoding="utf-8")
            s._push("sys", f"💾 Guardado: {fp.name}")
        threading.Thread(target=worker, daemon=True).start()

    # ── historial de sesiones ─────────────────────────────
    def persist(s, role, content):
        try:
            s.ses_msgs.append({"role": role, "content": content,
                               "ts": datetime.datetime.now().isoformat()})
            (s.ses_dir / f"{s.ses_id}.json").write_text(
                json.dumps(s.ses_msgs, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def new_session(s):
        s.ses_id = datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        s.ses_msgs = []
        s._mem = []          # olvidar el contexto de conversación
        s._checkpoint = {}
        return s.ses_id

    def delete_session(s, sid):
        """Borra una conversación del historial (cerrar la solapa). Si es la
        activa, arranca una sesión nueva vacía. Devuelve el nuevo estado de
        solapas para que el frontend re-renderice."""
        try:
            f = s.ses_dir / f"{sid}.json"
            if f.exists():
                f.unlink()
        except OSError as e:
            log(f"delete_session({sid}) fallo: {e}")
            return {"error": str(e)}
        was_active = (sid == s.ses_id)
        if was_active:
            s.new_session()
        return {"deleted": sid, "was_active": was_active,
                "session_id": s.ses_id, "chats": s.history()}

    def leaderboard(s):
        """Ranking histórico agregando todas las comparativas guardadas."""
        cmp_dir = data_dir() / 'comparativas'
        stats = {}   # model -> dict
        n_desafios = 0
        for f in sorted(cmp_dir.glob("cmp_*.json")) if cmp_dir.exists() else []:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            res = data.get("resultados", [])
            if not res:
                continue
            n_desafios += 1

            def funciona(x):
                return x.get("salida_ok") or (x.get("salida_ok") is None and x.get("corre"))
            ganador = None
            orden = sorted(res, key=lambda x: (not funciona(x), not x.get("corre"),
                                               x.get("lat_ms") or 9e9))
            if orden and funciona(orden[0]):
                ganador = orden[0].get("model")
            for x in res:
                m = x.get("model", "?")
                d = stats.setdefault(m, {"model": m, "prov": x.get("prov", ""),
                                         "corridas": 0, "ok": 0, "wins": 0,
                                         "lat_total": 0, "lat_n": 0})
                d["corridas"] += 1
                if funciona(x):
                    d["ok"] += 1
                if x.get("lat_ms"):
                    d["lat_total"] += x["lat_ms"]
                    d["lat_n"] += 1
                if x.get("model") == ganador:
                    d["wins"] += 1
        tabla = []
        for d in stats.values():
            d["lat_prom"] = int(d["lat_total"] / d["lat_n"]) if d["lat_n"] else 0
            d["tasa"] = round(100 * d["ok"] / d["corridas"]) if d["corridas"] else 0
            tabla.append(d)
        tabla.sort(key=lambda d: (-d["wins"], -d["tasa"], d["lat_prom"] or 9e9))
        return {"n_desafios": n_desafios, "tabla": tabla}

    def ollama_models(s):
        """Detecta si Ollama corre localmente y devuelve sus modelos.
        Cachea el primer modelo para que el failover a 'custom' lo use."""
        base = s.cfg.data.get("providers", {}).get("custom", {}).get("base_url") \
            or "http://localhost:11434/v1"
        try:
            r = requests.get(f"{base.rstrip('/')}/models", timeout=2)
            if r.ok:
                ms = [m["id"] for m in r.json().get("data", [])]
                s._ollama = ms
                return ms
        except requests.RequestException:
            pass
        return []

    def history(s, limit=20):
        out = []
        try:
            for f in sorted(s.ses_dir.glob("*.json"), reverse=True)[:limit]:
                first, n = "(vacía)", 0
                try:
                    msgs = json.loads(f.read_text(encoding="utf-8"))
                    n = len(msgs)
                    # título = primer mensaje del usuario (los del sistema no describen)
                    um = next((m.get("content", "") for m in msgs
                               if m.get("role") == "user" and m.get("content")), "")
                    first = (um or (msgs[0].get("content", "") if msgs else ""))[:80] or "(vacía)"
                except Exception:
                    first = "(error)"
                out.append({"id": f.stem, "first": first, "n": n})
        except Exception:
            pass
        return out

    def resume(s, sid):
        f = s.ses_dir / f"{sid}.json"
        if not f.exists():
            return {"error": f"No existe: {sid}"}
        try:
            msgs = json.loads(f.read_text(encoding="utf-8"))
            s.ses_id = sid
            s.ses_msgs = msgs
            # Reconstruir _mem para que el modelo tenga contexto de la conversación.
            # OJO: el frontend guarda las respuestas del agente con rol "Fidel"
            # (no "assistant") — hay que mapearlo o el modelo pierde su propio
            # contexto al restaurar una conversación.
            s._mem = []
            for m in msgs:
                role = m.get("role")
                if role == "user":
                    s._mem.append({"role": "user", "content": m.get("content", "")})
                elif role in ("assistant", "Fidel"):
                    s._mem.append({"role": "assistant", "content": m.get("content", "")})
            # Mantener solo los últimos turnos para no saturar el contexto
            s._mem = s._mem[-s._mem_limit():]
            return msgs
        except Exception as e:
            return {"error": str(e)}

    # ── comandos slash ────────────────────────────────────
    def command(s, cmd, arg, full):
        def msgs(*texts):
            return {"msgs": [{"role": "system", "content": t} for t in texts]}
        try:
            if cmd in ("files", "ls"):
                if not s.ws:
                    return msgs("Abrí un workspace (ícono de carpeta)")
                cf = list(s._iter_files(Path(s.ws)))
                return msgs("\n".join(f"  {f.relative_to(s.ws)}" for f in cf[:25])
                            or "(vacío)")
            if cmd == "search" and arg:
                return msgs("🔎 " + arg + ":\n" +
                            s._exec_tool("search_code", {"query": arg}, "", "python"))
            if cmd == "read" and arg:
                fp = Path(s.ws if s.ws else ".") / arg
                if not fp.exists():
                    return msgs("No existe")
                return {"open": s._file_payload(fp)}
            if cmd == "write" and arg and " " in full[len(cmd):].strip():
                rest = full[len(cmd):].strip()
                fn, _, ct = rest.partition(" ")
                fp = Path(s.ws if s.ws else ".") / fn
                fp.parent.mkdir(parents=True, exist_ok=True)
                fp.write_text(ct, encoding="utf-8")
                return msgs(f"✅ {fp}")
            if cmd == "exec" and arg:
                r = subprocess.run(arg, shell=True, capture_output=True, text=True,
                                   timeout=30, cwd=s.ws)
                return msgs(f"$ {arg}\n{(r.stdout + r.stderr)[:2000]}")
            if cmd in ("lecciones", "lessons"):
                if arg.strip() in ("borrar", "clear", "reset", "olvidar"):
                    try:
                        s._lessons_path().unlink()
                    except OSError:
                        pass
                    return msgs("🧠 Lecciones borradas.")
                ls = s._load_lessons()
                if not ls:
                    return msgs("🧠 Todavía no aprendí lecciones — aparecen cuando algo falla. "
                                "(/lecciones borrar para reiniciar)")
                return msgs("🧠 Lecciones aprendidas (se le re-inyectan al agente):\n"
                            + "\n".join(f"• {x['txt']}" for x in ls[-20:]))
            if cmd == "git" and arg:
                return msgs(s._exec_tool("git", {"args": arg}, "", "python"))
            if cmd == "commit":
                m = arg.strip() or "update"
                s._exec_tool("git", {"args": "add -A"}, "", "python")
                return msgs(s._exec_tool("git", {"args": f'commit -m "{m}"'}, "", "python"))
            if cmd == "push":
                return msgs(s._exec_tool("git", {"args": "push " + arg}, "", "python"))
            if cmd == "ssh" and arg:
                # /ssh <alias|user@ip> <comando…>  — alias guardado o destino directo
                host, _, rest = arg.partition(" ")
                if rest.strip():
                    return msgs(s._exec_tool("ssh_exec",
                                             {"host": host, "command": rest.strip()},
                                             "", "python"))
                r = subprocess.run(f"ssh {arg}", shell=True, capture_output=True,
                                   text=True, timeout=60)
                return msgs("🔌\n" + (r.stdout + r.stderr)[:2000])
            if cmd == "upload" and arg:
                r = subprocess.run(f"scp {arg}", shell=True, capture_output=True,
                                   text=True, timeout=120)
                return msgs("📤\n" + (r.stdout + r.stderr)[:2000])
            if cmd == "browse" and arg:
                webbrowser.open(arg)
                return msgs(f"🌐 {arg}")
            if cmd == "form" and arg:
                parts = arg.split()
                url, data = parts[0], " ".join(parts[1:])
                d = dict(p.split("=", 1) for p in data.split() if "=" in p)
                r = requests.post(url, data=d, timeout=15)
                return msgs(f"📋 Form ({r.status_code})")
            if cmd == "scrape" and arg:
                r = requests.get(arg, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
                return msgs(f"📄 {arg[:60]} ({len(r.text)}b)")
            if cmd == "preview":
                serve_dir = s.ws or "."

                def serve():
                    # sirve el workspace SIN cambiar el cwd global del proceso
                    # (os.chdir rompía rutas relativas del resto de la app)
                    def handler(*a, **k):
                        return http.server.SimpleHTTPRequestHandler(
                            *a, directory=serve_dir, **k)
                    with socketserver.TCPServer(("", 0), handler) as h:
                        port = h.server_address[1]
                        s._push("sys", f"🌐 http://localhost:{port}")
                        webbrowser.open(f"http://localhost:{port}")
                        h.serve_forever()
                threading.Thread(target=serve, daemon=True).start()
                return msgs("🌐 Sirviendo el workspace…")
            return msgs(f"Comando desconocido: /{cmd}")
        except Exception as e:
            return msgs(f"❌ {e}")


def main():
    log("── arranque ──")
    api = Api()
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    ui = os.path.join(base, "ui", "index.html")
    window = webview.create_window(
        "Fidel", ui, js_api=api,
        width=1280, height=800, min_size=(980, 600), maximized=True,
        background_color="#0B0B0C",
    )
    api._window = window
    try:
        webview.start(debug="--debug" in sys.argv)
    except Exception:
        import traceback
        log("webview.start fallo:\n" + traceback.format_exc())
        raise


if __name__ == "__main__":
    main()
