"""Fetch Agnes AI main page and look for API endpoint hints."""
import urllib.request
import ssl
import re

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request("https://agnes-ai.com",
                             headers={"User-Agent": "Mozilla/5.0"})
resp = urllib.request.urlopen(req, timeout=10, context=ssl_ctx)
html = resp.read().decode("utf-8", errors="replace")

# Look for API-related strings
for pattern in [r'api[^"]*', r'base.?url[^"]*', r'endpoint[^"]*', r'v1[^"]*']:
    matches = re.findall(pattern, html, re.IGNORECASE)
    for m in matches:
        if len(m) > 3:
            print(f"Found: {m}")

# Print any URLs containing 'api'
urls = re.findall(r'https?://[^"\'<> ]+', html)
for u in urls:
    if 'api' in u.lower():
        print(f"URL: {u}")

print("---HTML snippet---")
# Print around where 'api' appears
idx = html.lower().find('api')
if idx > 0:
    print(html[max(0,idx-200):idx+300])
else:
    print(html[:2000])
