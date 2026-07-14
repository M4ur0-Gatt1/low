"""AI Provider Factory - register all providers here."""
from providers.base import AIProvider
from providers.groq_provider import GroqProvider
from providers.openai_provider import OpenAIProvider
from providers.anthropic_provider import AnthropicProvider
from providers.custom_provider import CustomProvider
from providers.deepseek_provider import DeepSeekProvider
from providers.qwen_provider import QwenProvider
from providers.glm_provider import GLMProvider, XAIProvider
from providers.nvidia_provider import NVIDIAProvider
from providers.siliconflow_provider import SiliconFlowProvider
from providers.digitalocean_provider import DigitalOceanProvider
from providers.ltx_provider import LTXProvider
from providers.fal_provider import FALProvider
from providers.aimlapi_provider import AIMLAPIProvider

PROVIDERS = {
    "groq": GroqProvider, "openai": OpenAIProvider, "anthropic": AnthropicProvider,
    "deepseek": DeepSeekProvider, "qwen": QwenProvider, "glm": GLMProvider,
    "xai": XAIProvider, "nvidia": NVIDIAProvider, "siliconflow": SiliconFlowProvider,
    "digitalocean": DigitalOceanProvider, "ltx": LTXProvider, "fal": FALProvider,
    "aimlapi": AIMLAPIProvider, "custom": CustomProvider,
}

def get_provider(name, api_key=None, **kwargs):
    cls = PROVIDERS.get(name)
    if not cls:
        raise ValueError(f"Provider '{name}' not found. Available: {list(PROVIDERS.keys())}")
    return cls(api_key=api_key, **kwargs)
