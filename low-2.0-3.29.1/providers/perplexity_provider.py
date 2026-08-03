"""Perplexity Provider (multi-provider API with web search)."""
from providers.base import OpenAICompatProvider


class PerplexityProvider(OpenAICompatProvider):
    BASE_URL = "https://api.perplexity.ai/v1"
    MODELS = [
        "sonar-medium-online",
        "sonar-small-online",
        "sonar-medium-chat",
        "sonar-small-chat",
        "llama-3.1-sonar-small-128k-online",
        "llama-3.1-sonar-large-128k-online",
    ]

    @staticmethod
    def provider_name(): return "Perplexity"
    @staticmethod
    def default_model(): return "sonar-medium-online"
