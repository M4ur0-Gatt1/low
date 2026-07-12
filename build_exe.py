"""Build de LOW para Windows: icono -> LOW.exe -> instalador.
Uso: python build_exe.py

Genera:
  dist/LOW.exe                (PyInstaller, onefile, con icono)
  Output/LOWSetup-<ver>.exe   (Inno Setup, si ISCC esta instalado)

Consejo: correr desde una copia local del proyecto, no desde el NAS
(PyInstaller sobre UNC es lento y a veces falla).
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# 1. icono (requiere Pillow)
if not os.path.exists("low.ico"):
    subprocess.check_call([sys.executable, "make_icon.py"])

# 2. exe
subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pyinstaller"])
subprocess.check_call([sys.executable, "-m", "PyInstaller", "LOW.spec",
                       "--noconfirm", "--clean"])
print("\nOK: dist/LOW.exe")

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
