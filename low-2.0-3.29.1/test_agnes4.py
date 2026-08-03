"""Quick check: what API endpoint does the platform page reference?"""
import urllib.request
import ssl
import re

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request("https://platform.agnes-ai.com",
                             headers={"User-Agent": "Mozilla/5.0"})
resp = urllib.request.urlopen(req, timeout=10, context=ssl_ctx)
html = resp.read().decode("utf-8", errors="replace")

# Find all URLs in the HTML
urls = re.findall(r'https?://[a-zA-Z0-9./_-]+', html)
for u in set(urls):
    # Skip image, font, css
    if any(ext in u for ext in ['.jpg', '.png', '.svg', '.woff', '.css', '.ico']):
        continue
    if 'agnes' in u or 'api' in u.lower():
        print(f"  {u}")

print("---")
# Search for the NEXT_DATA or similar
if '__NEXT_DATA__' in html:
    m = re.search(r'__NEXT_DATA__[^>]*>({.*?})<', html, re.DOTALL)
    if m:
        import json
        try:
            data = json.loads(m.group(1))
            print("Next data found")
            # Look for buildId
            print(f"buildId: {data.get('buildId', 'N/A')}")
        except:
            pass

# Check for any fetch/XHR references
fetch_urls = re.findall(r'fetch\(["\']([^"\']+)["\']', html)
for f in fetch_urls:
    print(f"fetch: {f}")

# Look for axios or similar
axios_urls = re.findall(r'\.(?:get|post|put|delete)\(["\']([^"\']+)["\']', html)
for a in axios_urls:
    print(f"api call: {a}")
