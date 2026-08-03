"""Test various Agnes AI API endpoints to find the correct one."""
import urllib.request
import json
import ssl

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

urls_to_try = [
    "https://platform.agnes-ai.com/api/v1/chat/completions",
    "https://platform.agnes-ai.com/api/chat/completions",
    "https://platform.agnes-ai.com/v1/chat/completions",
    "https://api.agnes-ai.com/v1/chat/completions",
    "https://agnes-ai.com/api/v1/chat/completions",
    "https://agnes-ai.com/v1/chat/completions",
    "https://api.agnes.ai/v1/chat/completions",
]

for url in urls_to_try:
    try:
        req = urllib.request.Request(url, method="POST",
                                     data=b'{}',
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer test"})
        resp = urllib.request.urlopen(req, timeout=5, context=ssl_ctx)
        print(f"OK {url} -> {resp.status}")
        print(resp.read().decode()[:200])
    except urllib.request.HTTPError as e:
        print(f"ERR {url} -> {e.code} {e.reason}")
    except Exception as e:
        print(f"SKP {url} -> {type(e).__name__}: {e}")
