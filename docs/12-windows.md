# 12. Windows build (MSYS2 / MSVC)

The Windows package is the same two pieces as the Linux `.deb`: the
dependency-free Rust launcher (`desktop/launcher`, serves the PWA on
loopback) plus the built web app — zipped with a `Nysiris.bat` entry point
instead of a `.deb`, because there is no system package manager to target.

```text
dist/nysiris_<version>_windows-x86_64.zip
├── nysiris-launcher.exe
├── Nysiris.bat            # double-click entry point (forwards extra args)
├── README.txt
└── web/               # built PWA, served on 127.0.0.1
```

## Option A — build on Windows with MSYS2 (recommended)

1. Install MSYS2 from https://www.msys2.org, then in a MINGW64 shell:
   ```bash
   pacman -Syu
   pacman -S --needed mingw-w64-x86_64-toolchain git zip
   ```
2. Install Rust (https://rustup.rs) and Node.js (https://nodejs.org).
   With `--install-tools`, the build adds the GNU target itself:
   ```bash
   rustup target add x86_64-pc-windows-gnu
   ```
3. From a MINGW64 shell in the repo root:
   ```bash
   ./build.sh windows --install-tools
   ```
   The target defaults to `x86_64-pc-windows-gnu` under MSYS2/MinGW,
   Cygwin, and Git Bash. Override with `--target <triple>`.

## Option B — MSVC / cross-compile

On a machine with the MSVC toolchain (or any host with the right linker),
pass the target explicitly:

```bash
./build.sh windows --target x86_64-pc-windows-msvc
./build.sh windows --target aarch64-pc-windows-msvc   # ARM64 Windows
```

Cross-compiling from Linux additionally needs a Windows linker for the
chosen target; the script says so and stops rather than failing obscurely.

## Browser requirement

The launcher opens the app in a Chromium app window. On Windows it looks
for, in order:

1. `--browser <path>` if you pass one,
2. `%PROGRAMFILES%` / `%PROGRAMFILES(X86)%` installs of Edge
   (`msedge.exe`), then Chrome (`chrome.exe`),
3. `msedge` / `chrome` / `chromium` / `brave` on `PATH` (with or without
   `.exe`),
4. last resort: the default browser via `cmd /C start`.

Edge ships with Windows 10/11, so a stock machine already qualifies.
Firefox has no `--app` mode and opens a plain window instead. The app
profile lives under `%LOCALAPPDATA%\nysiris\chrome-profile`, separate
from the personal browser profile.

## First-launch notes

- No install, no admin rights, no inbound ports: everything is loopback plus
  outbound gateway traffic. Windows Firewall may still prompt on first
  launch; loopback-only serving needs no exception.
- SmartScreen warns because release binaries are unsigned. Verify the
  download against `SHA256SUMS.txt` on the GitHub release page.
- `Nysiris.bat --port 8901` pins the loopback port; `--no-open` serves only
  (open the printed URL yourself); `--help` lists everything.

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`: checks, the Linux
`.deb`, and the Windows zip (built on `windows-latest` with MSYS2, same
`./build.sh windows` path as local builds), published as a GitHub release
with a `SHA256SUMS.txt`. Bump with `./build.sh bump <version>` first —
`VERSION` is the single source of truth.

## Limitations

- No auto-updates: re-download new releases (the PWA itself updates its
  cached assets on load; the launcher does not).
- No MSI installer: the zip is intentionally portable (runs from any folder,
  leaves only its profile dir behind).
- ARM64 builds need `--target aarch64-pc-windows-msvc` and are untested on
  device; the launcher itself is portable std-only Rust.
