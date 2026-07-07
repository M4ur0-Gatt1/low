"""Configuración de Fidel: API keys, tema, zoom.

Vive en el directorio de datos del usuario según el sistema operativo:
Windows %APPDATA%/Fidel · macOS ~/Library/Application Support/Fidel ·
Linux ~/.config/Fidel.
"""
import json
import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Directorio de datos de Fidel según el SO (config, historial, log)."""
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home()))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME",
                                   Path.home() / ".config"))
    d = base / "Fidel"
    d.mkdir(parents=True, exist_ok=True)
    return d


BASE = data_dir()
CONFIG_PATH = BASE / 'config.json'

DEFAULT_CONFIG = {
    "active_provider": "deepseek",
    "theme": "dark",
    "font_size": 12,
    # límites del agente — ajustables desde ⚙. La idea de Fidel es NO ponerle
    # techos al trabajo salvo los que impone la API/costo. Subilos si querés
    # que insista más en tareas grandes; el único freno duro es que deje de
    # avanzar (repetir sin progreso) para no quemar tokens en un bucle.
    "agent": {
        "max_steps": 40,          # rondas de tool-calls por tramo antes de auto-continuar
        "max_continuations": 25,  # veces que sigue solo tras llegar al tope de pasos
        "memory_turns": 24,       # turnos de conversación que recuerda en la sesión
        "learn": True,            # Reflexion: aprende de sus errores y los recuerda
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
            return merged
        return DEFAULT_CONFIG.copy()

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
