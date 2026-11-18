@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later - Copyright (C) 2026 Kevin Varela
cd /d "%~dp0"
where node >nul 2>nul || (echo Necesitas instalar Node.js 18 o superior: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias... & call npm install --omit=dev --no-audit --no-fund)
start "" http://localhost:8080
node server.js %*
pause
