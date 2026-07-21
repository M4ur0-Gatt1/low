import urllib.request, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Test the models endpoint
req = urllib.request.Request("https://api.agnes-ai.com/api/v1/models",
                             headers={"User-Agent": "Mozilla/5.0",
                                      "Authorization": "Bearer test"})
try:
    resp = urllib.request.urlopen(req, timeout=5, context=ctx)
    print("OK", resp.status)
    print(resp.read().decode()[:500])
except urllib.request.HTTPError as e:
    print("ERR", e.code)
    print(e.read().decode()[:300])
except Exception as e:
    print("SKP", type(e).__name__, str(e)[:100])
