"""Digital Ocean (Paperspace) Provider — API compatible OpenAI.

Digital Ocean adquirió Paperspace y ofrece modelos open-source a través de
su gateway de inferencia: https://docs.digitalocean.ai/

Endpoint base por defecto: https://api.paperspace.io/v1
(compatible OpenAI — /chat/completions, /models, etc.)

Modelos típicos: llama-3.3-70b-instruct, mixtral-8x7b-instruct, etc.
La lista real se trae en vivo de /models.
"""
from providers.base import OpenAICompatProvider


class DigitalOceanProvider(OpenAICompatProvider):
    BASE_URL = "https://api.paperspace.io/v1"
    MODELS = ["llama-3.3-70b-instruct", "llama-3.1-8b-instruct",
              "mixtral-8x7b-instruct", "qwen2.5-72b-instruct",
              "deepseek-r1-distill-llama-70b"]

    @staticmethod
    def provider_name(): return "DigitalOcean"

    @staticmethod
    def default_model(): return "llama-3.3-70b-instruct"
