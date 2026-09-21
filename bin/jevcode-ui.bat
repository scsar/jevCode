@echo off
rem Double-click to open the JevCode review screen. Closing this window stops the server.
title JevCode UI
node "%~dp0..\a0\jevcode.mjs" ui
if errorlevel 1 pause
