import urllib.request, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

endpoints = [
    ("POST", "https://api.agnes-ai.com/v1/chat/completions"),
    ("POST", "https://api.agnes-ai.com/openai/v1/chat/completions"),
    ("POST", "https://api.agnes-ai.com/api/v1/chat/completions"),
    ("POST", "https://api.agnes-ai.com/chat/completions"),
    ("GET", "https://api.agnes-ai.com/v1/models"),
    ("POST", "https://api.agnes-ai.com/proxy/v1/chat/completions"),
]

for method, url in endpoints:
    try:
        data = b'{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
        req = urllib.request.Request(url, method=method,
                                     data=data if method == "POST" else None,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer test"})
        resp = urllib.request.urlopen(req, timeout=5, context=ctx)
        print("OK", url, "->", resp.status)
        print(resp.read().decode()[:200])
    except urllib.request.HTTPError as e:
        body = e.read().decode()[:200]
        print("ERR", url, "->", e.code, body)
    except Exception as e:
        print("SKP", url, "->", type(e).__name__, str(e)[:100])
