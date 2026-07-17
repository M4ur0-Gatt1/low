"""Build de LOW para Windows: icono -> LOW.exe -> instalador.
Uso: python build_exe.py [fast|clean|release]

  fast    = --onedir, sin UPX, sin clean (30-60s, para pruebas)
  clean   = --clean + --onefile (borra cache, build fresco)
  release = --onefile + UPX + clean (lento pero .exe final optimo)

Genera:
  dist/LOW.exe                (PyInstaller, onefile o onedir, con icono)
  Output/LOWSetup-<ver>.exe   (Inno Setup, si ISCC esta instalado)

Consejo: correr desde una copia local del proyecto, no desde el NAS
(PyInstaller sobre UNC es lento y a veces falla).
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

MODE = sys.argv[1] if len(sys.argv) > 1 else "fast"

# 1. icono (requiere Pillow)
if not os.path.exists("low.ico"):
    subprocess.check_call([sys.executable, "make_icon.py"])

# 2. PyInstaller (solo instalar si falta)
try:
    import PyInstaller
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pyinstaller"])

# 3. Armar flags segun modo
if MODE == "fast":
    # --onedir: no comprime en un solo archivo, MUCHO mas rapido
    # sin UPX, sin clean -> usa cache de builds anteriores
    spec = "LOW_fast.spec"
    extra = ["--noconfirm"]
    print("⚡ Modo FAST: --onedir, sin comprimir (30-60s)")
elif MODE == "clean":
    spec = "LOW.spec"
    extra = ["--noconfirm", "--clean"]
    print("🧹 Modo CLEAN: --onefile, sin cache (3-5 min)")
else:  # release
    spec = "LOW.spec"
    extra = ["--noconfirm", "--clean"]
    print("📦 Modo RELEASE: --onefile + UPX + clean (5-10 min)")

subprocess.check_call([sys.executable, "-m", "PyInstaller", spec] + extra)
print(f"\n✅ OK: dist/LOW.exe (modo={MODE})")

# 3. instalador (opcional: necesita Inno Setup -> winget install JRSoftware.InnoSetup)
iscc_paths = [
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"),
    r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    r"C:\Program Files\Inno Setup 6\ISCC.exe",
]
iscc = next((p for p in iscc_paths if os.path.exists(p)), None)
if iscc:
    subprocess.check_call([iscc, "low_installer.iss"])
    print("\nOK: Output/LOWSetup-*.exe")
else:
    print("\nAviso: Inno Setup no encontrado; instalador omitido.")
    print("Instalarlo con: winget install JRSoftware.InnoSetup")
