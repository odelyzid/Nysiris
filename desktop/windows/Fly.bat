@echo off
rem Launch the fly-protocol Nym mixnet client on Windows.
rem
rem Serves the bundled PWA on loopback and opens it in an Edge/Chrome app
rem window. Extra arguments are forwarded to the launcher (run with --help
rem to list them). Keep this file next to fly-protocol-launcher.exe and the
rem web\ directory.
setlocal
cd /d "%~dp0"
fly-protocol-launcher.exe --root "web" %*
