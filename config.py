"""Configuración de LOW: API keys, tema, zoom.

Vive en el directorio de datos del usuario según el sistema operativo:
Windows %APPDATA%/LOW · macOS ~/Library/Application Support/LOW ·
Linux ~/.config/LOW.
"""
import json
import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Directorio de datos de LOW según el SO (config, historial, log)."""
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home()))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME",
                                   Path.home() / ".config"))
    d = base / "LOW"
    d.mkdir(parents=True, exist_ok=True)
    return d


BASE = data_dir()
CONFIG_PATH = BASE / 'config.json'

DEFAULT_CONFIG = {
    "active_provider": "deepseek",
    "theme": "dark",
    "font_size": 12,
    # límites del agente — ajustables desde ⚙. La idea de LOW es NO ponerle
    # techos al trabajo salvo los que impone la API/costo. Subilos si querés
    # que insista más en tareas grandes; el único freno duro es que deje de
    # avanzar (repetir sin progreso) para no quemar tokens en un bucle.
    "agent": {
        "max_steps": 40,          # rondas de tool-calls por tramo antes de auto-continuar
        "max_continuations": 25,  # veces que sigue solo tras llegar al tope de pasos
        "memory_turns": 24,       # turnos de conversación que recuerda en la sesión
        "learn": True,            # Reflexion: aprende de sus errores y los recuerda
        # tool gating: qué tools se mandan (menos tokens/req). auto = detecta
        # code/design/animation por sesión; full = todos; code = sin imagen/video/anim;
        # design = todos; animation = modo animación con todas las tools de media.
        "tool_profile": "auto",
        # Modo de trabajo del editor: code | design | animation
        "editor_mode": "code",
        # auto-verificación antes de decir "listo":
        "verify_runtime": True,   # correr el código y corregir errores de ejecución
        "verify_design": True,    # rasterizar .svg y criticarlo con visión (vector iterativo)
    },
    # servidores SSH guardados (alias reutilizables para ssh_exec/scp_upload):
    # [{"name": "yungas", "user": "root", "host": "1.2.3.4", "port": "", "key": ""}]
    "ssh_hosts": [],
    "providers": {
        "deepseek": {"api_key": "", "model": "deepseek-v4-pro", "base_url": ""},
        "nvidia": {"api_key": "", "model": "meta/llama-3.3-70b-instruct", "base_url": ""},
        "groq": {"api_key": "", "model": "llama-3.3-70b-versatile", "base_url": ""},
        "siliconflow": {"api_key": "", "model": "deepseek-ai/DeepSeek-V3", "base_url": ""},
        "openai": {"api_key": "", "model": "gpt-4o", "base_url": ""},
        "anthropic": {"api_key": "", "model": "claude-sonnet-4-5", "base_url": ""},
        "custom": {"api_key": "", "model": "llama3", "base_url": "http://localhost:11434/v1"},
        "qwen": {"api_key": "", "model": "qwen-plus", "base_url": ""},
        "glm": {"api_key": "", "model": "glm-4", "base_url": ""},
        "xai": {"api_key": "", "model": "grok-2", "base_url": ""},
        # DigitalOcean GenAI Platform — Serverless Inference (compatible OpenAI).
        # Endpoint: https://inference.do-ai.run/v1  → da acceso a TODOS los modelos
        # con los que tengas acceso (Llama, DeepSeek, Mistral, OpenAI, Anthropic).
        # Key: token personal de DO o model access key
        #      (https://cloud.digitalocean.com/gen-ai/model-access-keys)
        "digitalocean": {"api_key": "", "model": "deepseek-v4-pro", "base_url": "https://inference.do-ai.run/v1"},
        # Cloudflare Workers AI — 10,000 Neurons por día gratis.
        # Endpoint: https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run
        # Key: API Token de Cloudflare (https://dash.cloudflare.com/profile/api-tokens)
        #      Requiere account_id en base_url o como parámetro
        "cloudflare": {"api_key": "", "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "base_url": ""},
        # Replicate — miles de modelos open-source con free tier de $0.005.
        # Endpoint: https://api.replicate.com/v1
        # Key: API Token de Replicate (https://replicate.com/account/api-tokens)
        "replicate": {"api_key": "", "model": "meta/meta-llama-3-70b-instruct", "base_url": ""},
        # LTX (Lightricks) — SOLO video (text→video / imagen→video con audio).
        # No es un modelo de chat: no entra en la cadena de failover del agente.
        # Key: https://console.ltx.video/api-keys
        "ltx": {"api_key": "", "model": "ltx-2-3-fast", "base_url": ""},
        # fal.ai — GATEWAY universal de imagen/video: una key para 1000+ modelos
        # (Seedance, Flux, Kling, Wan, Veo, Seedream...). SOLO media (no chatea).
        # Key: https://fal.ai/dashboard/keys. Cambiar de modelo = cambiar el model id
        # (ver fal.ai/models). model = video texto→video; i2v_model = imagen→video;
        # image_model = generación de imagen.
        "fal": {"api_key": "",
                "model": "bytedance/seedance-2.0/text-to-video",
                "i2v_model": "bytedance/seedance-2.0/image-to-video",
                "image_model": "fal-ai/flux/schnell",
                "colorize_model": "fal-ai/flux-kontext/dev",
                "base_url": ""},
    }
}


class Config:
    def __init__(self, path: Path = CONFIG_PATH):
        self.path = path
        self.data = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            # utf-8-sig tolera BOM (editores/PowerShell suelen agregarlo)
            with open(self.path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            merged = DEFAULT_CONFIG.copy()
            merged.update(data)
            # providers se mergea por clave: un config.json viejo no debe
            # ocultar providers agregados después en DEFAULT_CONFIG
            merged["providers"] = {**DEFAULT_CONFIG["providers"],
                                   **data.get("providers", {})}
            if self._migrate(merged):
                try:
                    with open(self.path, "w", encoding="utf-8") as f:
                        json.dump(merged, f, indent=2)
                except OSError:
                    pass
            return merged
        return DEFAULT_CONFIG.copy()

    # endpoints viejos que quedaron guardados en config.json y hay que corregir
    _OBSOLETE_BASE_URLS = {
        "digitalocean": ({"https://api.paperspace.io/v1",
                          "https://gateway.digitalocean.ai/v1",
                          "https://api.paperspace.io", ""},
                         "https://inference.do-ai.run/v1"),
    }
    # IDs de modelo que pusimos como default y NO andan en el tier base de DO
    # (formato viejo con puntos, o propietarios que dan 403 por tier). Se
    # reescriben a un modelo ABIERTO que sí funciona. OJO: NO incluimos
    # 'llama3.3-70b-instruct' acá porque ES un ID válido y abierto que anda.
    _OBSOLETE_MODELS = {
        "digitalocean": ({"llama-3.3-70b-instruct", "llama-3.1-8b-instruct",
                          "mixtral-8x7b-instruct", "openai-gpt-4o-mini",
                          "openai-gpt-4o"},
                         "deepseek-v4-pro"),
    }

    def _migrate(self, cfg: dict) -> bool:
        """Corrige config.json ya guardados: base_urls y IDs de modelo obsoletos
        (p.ej. DigitalOcean pasó de paperspace a inference.do-ai.run, y sus IDs de
        modelo no llevan puntos). Devuelve True si cambió algo."""
        changed = False
        provs = cfg.get("providers", {})
        for name, (olds, new) in self._OBSOLETE_BASE_URLS.items():
            p = provs.get(name)
            if p is not None and p.get("base_url", "") in olds:
                p["base_url"] = new
                changed = True
        for name, (olds, new) in self._OBSOLETE_MODELS.items():
            p = provs.get(name)
            if p is not None and p.get("model", "") in olds:
                p["model"] = new
                changed = True
        return changed

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2)

    def get_api_key(self, provider: str) -> str:
        return self.data.get("providers", {}).get(provider, {}).get("api_key", "")

    def set_api_key(self, provider: str, key: str):
        self.data.setdefault("providers", {}).setdefault(provider, {})["api_key"] = key
        self.save()

    def get_model(self, provider: str) -> str:
        return self.data.get("providers", {}).get(provider, {}).get("model", "")

    def set_model(self, provider: str, model: str):
        self.data.setdefault("providers", {}).setdefault(provider, {})["model"] = model
        self.save()

    def get_active_provider(self) -> str:
        return self.data.get("active_provider", "groq")

    def set_active_provider(self, provider: str):
        self.data["active_provider"] = provider
        self.save()

    @property
    def theme(self) -> str:
        return self.data.get("theme", "dark")

    @property
    def font_size(self) -> int:
        return self.data.get("font_size", 14)
