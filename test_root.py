import urllib.request, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Try root of api subdomain
req = urllib.request.Request("https://api.agnes-ai.com/", 
                             headers={"User-Agent": "Mozilla/5.0"})
try:
    resp = urllib.request.urlopen(req, timeout=5, context=ctx)
    print("OK", resp.status)
    body = resp.read().decode()[:500]
    print(body)
except urllib.request.HTTPError as e:
    print("ERR", e.code)
    print(e.read().decode()[:300])
except Exception as e:
    print("SKP", type(e).__name__, str(e)[:100])
