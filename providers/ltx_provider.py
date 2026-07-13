"""LTX (Lightricks) — proveedor SOLO de video (text→video, image→video).

NO es un modelo de chat: está marcado media-only en main.py, así que no entra
en la cadena de failover del agente ni se ofrece en el selector de modelo. La
generación de video real la hace main.py `_ltx_video` (POST directo a
api.ltx.video). Esta clase existe para que el proveedor esté REGISTRADO
—`get_provider('ltx')` ya no rompe— y para listar sus modelos en ⚙.

Docs: https://docs.ltx.video · key: https://console.ltx.video/api-keys
"""
from providers.base import AIProvider, AIResponse


class LTXProvider(AIProvider):
    MODELS = ["ltx-2-3-fast", "ltx-2-3-pro", "ltx-2-3"]

    @staticmethod
    def provider_name() -> str:
        return "LTX (video)"

    @staticmethod
    def default_model() -> str:
        return "ltx-2-3-fast"

    @staticmethod
    def requires_api_key() -> bool:
        return True

    def chat(self, messages, system_prompt="", temperature=0.7,
             max_tokens=4096, tools=None) -> AIResponse:
        # LTX no chatea: devolver un mensaje claro en vez de romper el agente
        return AIResponse(
            content="⚠ LTX es un proveedor de VIDEO, no de chat. Pedí un video "
                    "(p. ej. «hacé un video de…») y el agente lo usa solo; no lo "
                    "elijas como modelo del agente.",
            model=self.model, finish_reason="stop")

    def list_models(self) -> list:
        return list(self.MODELS)
