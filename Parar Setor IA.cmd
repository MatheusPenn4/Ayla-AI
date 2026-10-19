@echo off
rem Duplo clique: encerra o executor local e a interface do Setor IA.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\iniciar-setor-ia.ps1" -Parar
