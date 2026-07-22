"""Fetch platform page and look for API URLs in JS."""
import urllib.request
import ssl
import re

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

# Try platform page
req = urllib.request.Request("https://platform.agnes-ai.com",
                             headers={"User-Agent": "Mozilla/5.0"})
resp = urllib.request.urlopen(req, timeout=10, context=ssl_ctx)
html = resp.read().decode("utf-8", errors="replace")

# Find all JS files
js_urls = re.findall(r'src="([^"]+\.js[^"]*)"', html)
for js in js_urls:
    if not js.startswith('http'):
        js = 'https://platform.agnes-ai.com' + js if js.startswith('/') else 'https://platform.agnes-ai.com/' + js
    print(f"JS: {js}")
    try:
        jr = urllib.request.urlopen(js, timeout=5, context=ssl_ctx)
        js_content = jr.read().decode("utf-8", errors="replace")
        # Look for api endpoints in the JS
        api_urls = re.findall(r'https?://[^"\'` ]*api[^"\'` ]*', js_content)
        for au in api_urls:
            print(f"  API URL in JS: {au}")
        # Also look for baseURL patterns
        base_urls = re.findall(r'baseURL["\']?\s*[:=]\s*["\']([^"\']+)["\']', js_content)
        for bu in base_urls:
            print(f"  baseURL: {bu}")
        # Print first 100 chars
        if api_urls or base_urls:
            print(f"  (found in JS chunk)")
    except Exception as e:
        print(f"  Error: {e}")

# Also look in HTML for any API endpoints
api_hints = re.findall(r'[aA][pP][iI][^"\'<> ]*["\']([^"\']+)["\']', html)
for h in api_hints:
    if 'http' in h:
        print(f"API hint in HTML: {h}")

# Search for /v1/ in HTML
v1_urls = re.findall(r'https?://[^"\'<> ]+/v1/[^"\'<> ]*', html)
for v in v1_urls:
    print(f"V1 URL: {v}")

print("---")
# Print any URL with agnes-ai.com in HTML
all_urls = re.findall(r'https?://[^"\'<>\s]+', html)
for u in all_urls:
    if 'agnes' in u.lower() and 'api' in u.lower():
        print(f"Agnes API URL: {u}")
