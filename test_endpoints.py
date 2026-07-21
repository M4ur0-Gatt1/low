import urllib.request, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

urls = [
    "https://api.agnes-ai.com/v1/models",
    "https://api.agnes-ai.com/models",
    "https://platform.agnes-ai.com/api/models",
    "https://agnes-ai.com/api/models",
    "https://agnes-ai.com/v1/models",
]
for url in urls:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=5, context=ctx)
        print("OK", url, "->", resp.status)
        print(resp.read().decode()[:200])
    except urllib.request.HTTPError as e:
        print("ERR", url, "->", e.code)
    except Exception as e:
        print("SKP", url, "->", type(e).__name__)
