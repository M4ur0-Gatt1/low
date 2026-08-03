import os
from pydo import Client

# la key va por variable de entorno — NUNCA hardcodeada (quedó una expuesta en
# el historial de git hasta v3.19.0: revocarla en cloud.digitalocean.com)
client = Client(api_key=os.environ.get("DO_API_KEY", ""))

# Listar modelos
models = client.models.list()
print("=== MODELOS DISPONIBLES ===")
for m in models["data"]:
    print(f"  {m['id']}")

# Probar Fable 5
print("\n=== PROBANDO FABLE 5 ===")
try:
    resp = client.chat.completions.create(
        messages=[{"role": "user", "content": "Hola, decime algo corto"}],
        model="anthropic-claude-fable-5",
        max_tokens=50,
    )
    print("Respuesta:", resp.choices[0].message.content if resp.choices else "sin respuesta")
except Exception as e:
    print(f"ERROR: {e}")
