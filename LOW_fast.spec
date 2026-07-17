# -*- mode: python ; coding: utf-8 -*-
# LOW_fast.spec — build RAPIDO (--onedir, sin UPX, ~30-60s)
# Uso: python build_exe.py fast

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[('providers', 'providers'), ('code_runner', 'code_runner'), ('config.py', '.'),
           ('low.ico', '.'), ('ui', 'ui'), ('tools', 'tools'), ('low_anim.py', '.'),
           ('self_improvement.py', '.'), ('animation_engine', 'animation_engine')],
    hiddenimports=['providers', 'providers.transport', 'providers.nvidia_provider',
                   'code_runner', 'webview.platforms.winforms',
                   'webview.platforms.edgechromium', 'webview.platforms.cocoa',
                   'webview.platforms.qt',
                   'low_anim', 'self_improvement',
                   'animation_engine', 'animation_engine.nodes',
                   'animation_engine.project', 'animation_engine.renderer',
                   'animation_engine.rigging', 'animation_engine.storyboard',
                   'tools', 'tools.animation', 'tools.animation.core',
                   'tools.animation.timeline', 'tools.animation.exporter',
                   'tools.animation.rigging', 'tools.animation.nodes',
                   'tools.animation.ai_pipeline', 'vtracer'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Modulos pesados que LOW no usa
        'matplotlib', 'numpy', 'scipy', 'pandas',
        'tkinter', 'tcl', 'tk',
        'unittest', 'test', 'pydoc',
        'distutils', 'setuptools',
        'sqlite3', 'sqlalchemy',
        'pytest', 'coverage', 'tox',
        'Cython', 'cffi',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='LOW',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,              # sin UPX = mucho mas rapido
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='low.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='LOW',
)
