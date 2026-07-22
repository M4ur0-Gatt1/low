@echo off
setlocal EnableDelayedExpansion

echo ============================================================
echo   LOW 2.0 - AUTO FIX, BUILD & DEPLOY SCRIPT
echo   Resolviendo conflictos, compilando C++ y generando EXE
echo ============================================================
echo.

:: 1. CONFIGURACION DEL ENTORNO
echo [1/6] Configurando entorno...
call npm config set msvs_version 2022
call npm config set python "C:\Python39\python.exe" 2>nul || echo Python no detectado en ruta estandar, se usara el del sistema.
echo.

:: 2. RESOLVER CONFLICTO DE .GITIGNORE AUTOMATICAMENTE
echo [2/6] Resolviendo conflicto en .gitignore...
if exist .gitignore (
    :: Crear version limpia del .gitignore
    (
        echo # Dependencies
        echo node_modules/
        echo package-lock.json
        echo yarn.lock
        echo pnpm-lock.yaml
        echo.
        echo # Build outputs
        echo dist/
        echo out/
        echo build/
        echo native/build/
        echo *.exe
        echo *.dll
        echo *.lib
        echo *.obj
        echo.
        echo # Logs and caches
        echo logs/
        echo *.log
        echo npm-debug.log*
        echo yarn-debug.log*
        echo yarn-error.log*
        echo .eslintcache
        echo.
        echo # OS files
        echo .DS_Store
        echo Thumbs.db
        echo Desktop.ini
        echo.
        echo # IDE
        echo .vscode/
        echo .idea/
        echo *.swp
        echo *.swo
        echo *~
        echo.
        echo # C++ intermediates
        echo native/**/*.tlog
        echo native/**/*.lastbuildstate
        echo native/**/*.opensdf
        echo native/**/*.ipdb
        echo native/**/*.pdb
        echo native/**/*.idb
    ) > .gitignore.fixed
    
    :: Reemplazar el archivo conflictivo
    move /Y .gitignore.fixed .gitignore > nul
    echo .gitignore reparado exitosamente.
) else (
    echo .gitignore no existe, creando uno nuevo...
    (
        echo node_modules/
        echo dist/
        echo native/build/
        echo *.log
    ) > .gitignore
)
echo.

:: 3. LIMPIEZA PROFUNDA DE DEPENDENCIAS ROTAS (CFFI ERROR)
echo [3/6] Limpiando dependencias rotas (cffi error fix)...
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del /q package-lock.json
call npm cache clean --force
echo Instalando dependencias limpias...
call npm install --ignore-scripts --no-optional
if %ERRORLEVEL% neq 0 (
    echo ERROR CRITICO: Fallo la instalacion de npm. Verifica tu conexion a internet.
    pause
    exit /b 1
)
echo.

:: 4. COMPILACION DEL MOTOR C++ (NATIVE)
echo [4/6] Compilando motor nativo C++ (LOW Core)...
if not exist native mkdir native
cd native
if not exist build mkdir build
cd build

echo Generando proyecto Visual Studio 2022...
cmake .. -G "Visual Studio 17 2022" -A x64
if %ERRORLEVEL% neq 0 (
    echo ADVERTENCIA: CMake no encontrado o fallo. ¿Instalaste CMake y lo agregaste al PATH?
    echo Si no tienes CMake, saltaremos este paso pero el EXE podria no tener las optimizaciones maximas.
    cd ../..
    goto SKIP_NATIVE
)

echo Compilando en modo Release...
cmake --build . --config Release --target INSTALL
if %ERRORLEVEL% neq 0 (
    echo ADVERTENCIA: La compilacion C++ fallo. Revisa que tengas Visual Studio 2022 instalado con "Desarrollo para el escritorio con C++".
    echo Continuando sin los binarios nativos...
) else (
    echo Compilacion C++ exitosa!
)
cd ../..

:SKIP_NATIVE
echo.

:: 5. GIT COMMIT Y PUSH AUTOMATICO
echo [5/6] Subiendo cambios a GitHub...
git status > nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: No se detecto un repositorio Git valido. Iniciando uno nuevo...
    git init
    git checkout -b main 2>nul || git checkout -b master
)

git add .
git commit -m "feat: LOW 2.0 Auto-Build - Resolved conflicts, added native core and installer config"
if %ERRORLEVEL% neq 0 (
    echo Sin cambios para commitear o error en git. Continuando...
)

:: Intentar hacer push (requiere que ya tengas remote configurado)
git remote -v | findstr origin > nul
if %ERRORLEVEL% equ 0 (
    echo Haciendo push a origen...
    git push -u origin main 2>nul || git push -u origin master 2>nul || echo Push fallido: Verifica tus credenciales de GitHub o usa un Token.
) else (
    echo No hay remoto configurado. Saltando push.
    echo Para subirlo manualmente: git remote add origin TU_URL && git push -u origin main
)
echo.

:: 6. GENERACION DEL INSTALADOR / EXE PORTABLE
echo [6/6] Empaquetando aplicacion final (EXE Portable)...
if exist package.json (
    call npm run dist
    if %ERRORLEVEL% equ 0 (
        echo.
        echo ============================================================
        echo   EXITO! LOW 2.0 ha sido construido correctamente.
        echo   Tu ejecutable esta en: dist/LOW Setup.exe (o similar)
        echo ============================================================
    ) else (
        echo.
        echo ============================================================
        echo   ADVERTENCIA: El empaquetado electronico tuvo errores.
        echo   Revisa si falta configurar 'electron-builder' en package.json
        echo ============================================================
    )
) else (
    echo ERROR: No se encontro package.json. Imposible construir el EXE.
)

echo.
echo Proceso finalizado. Presiona cualquier tecla para salir.
pause
