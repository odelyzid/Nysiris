nysiris for Windows
=======================

1. Unzip anywhere (e.g. Downloads\nysiris).
2. Double-click Nysiris.bat.
3. Edge (or Chrome) opens the app in its own window. Your personal browser
   profile is untouched: the app uses a dedicated profile under
   %LOCALAPPDATA%\nysiris.

Notes
-----
- No install, no admin rights, no inbound ports: the app only serves
  127.0.0.1 and dials out to its entry gateway.
- First launch may trigger a Windows Firewall prompt for loopback-only
  traffic; SmartScreen may warn because the binary is unsigned. The zip's
  SHA256SUMS.txt (next to the download) verifies the download itself.
- Command line: `nysiris-launcher.exe --help`. Pass extra flags after
  Nysiris.bat, e.g. `Nysiris.bat --port 8901`. `--no-open` serves only.
- Built from source? See docs/12-windows.md (MSYS2) in the repository.
