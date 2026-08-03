#!/usr/bin/env bash
# Inyecta la versión del tag (vX.Y.Z) en LOW_VERSION de main.py y en VERSION,
# para que el footer de la app siempre coincida con el release publicado.
set -euo pipefail
VER="${GITHUB_REF_NAME#v}"
if [[ ! "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "tag '$GITHUB_REF_NAME' no es vX.Y.Z — no toco la versión"
  exit 0
fi
sed -i.bak -E "s/^LOW_VERSION = \"[0-9.]+\"/LOW_VERSION = \"$VER\"/" main.py
rm -f main.py.bak
echo "$VER" > VERSION
echo "LOW_VERSION → $VER"
grep -n '^LOW_VERSION' main.py
