"""Test script para verificar los nuevos proveedores (Kimi, Grok, Perplexity)."""
import sys
sys.path.insert(0, '.')

from providers import get_provider

def test_provider_imports():
    """Verificar que los nuevos proveedores se importan correctamente."""
    print("=== Test de importación de proveedores ===")
    
    new_providers = ["kimi", "grok", "perplexity"]
    
    for provider_name in new_providers:
        try:
            provider = get_provider(provider_name, api_key="test_key")
            print(f"✅ {provider_name}: {provider.provider_name()}")
            print(f"   Default model: {provider.default_model()}")
            print(f"   Base URL: {provider.base_url}")
            print(f"   Models: {provider.MODELS[:3]}...")  # Mostrar solo los primeros 3
        except Exception as e:
            print(f"❌ {provider_name}: {e}")
    
    print("\n=== Test de lista de proveedores disponibles ===")
    from providers import PROVIDERS
    print(f"Proveedores disponibles: {list(PROVIDERS.keys())}")
    
    print("\n=== Verificación de config.py ===")
    from config import DEFAULT_CONFIG
    print(f"Proveedores en config: {list(DEFAULT_CONFIG['providers'].keys())}")
    print(f"Failover order: {DEFAULT_CONFIG['failover_order']}")

if __name__ == "__main__":
    test_provider_imports()
