"""Test script para verificar la API de Qwen con la key activa."""
import requests
import json

API_KEY = "sk-sp-H.XYHL.aGG3.MEUCIQCMydmH4rv7cXraGmvJIq5-NTc-Wi4YCmqVQmxRGfhdbwIgO9mvggF-aCA18Pn_M1qQ5_MlrwcGpDcfz_WbmGqqJQA"
# URL correcta para Token Plan
BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"

def test_qwen():
    print(f"=== Probando con URL Token Plan: {BASE_URL} ===")
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    # Probar diferentes modelos
    models_to_test = ["qwen3.7-plus", "qwen3.7-max", "qwen3.6-flash", "qwen3.8-max-preview"]
    
    for model in models_to_test:
        print(f"\n--- Probando modelo: {model} ---")
        payload = {
            "model": model,
            "messages": [
                {"role": "user", "content": "Hola"}
            ],
            "max_tokens": 10
        }
        
        try:
            response = requests.post(f"{BASE_URL}/chat/completions", headers=headers, json=payload, timeout=30)
            print(f"Status: {response.status_code}")
            if response.ok:
                result = response.json()
                print(f"✅ EXITO con modelo {model}")
                print(f"Respuesta: {result.get('choices', [{}])[0].get('message', {}).get('content', 'Sin respuesta')}")
                return model  # Retornar el modelo que funcionó
            else:
                print(f"Error: {response.text[:100]}")
        except Exception as e:
            print(f"Exception: {e}")
    
    # Si ningún modelo funciona, intentar listar modelos disponibles
    print("\n--- Intentando listar modelos disponibles ---")
    try:
        response = requests.get(f"{BASE_URL}/models", headers=headers, timeout=10)
        print(f"Status: {response.status_code}")
        if response.ok:
            models = response.json()
            print("Modelos disponibles:")
            for m in models.get("data", [])[:10]:
                print(f"  - {m['id']}")
        else:
            print(f"Error: {response.text[:200]}")
    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    test_qwen()
