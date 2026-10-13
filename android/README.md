# Android packaging for the mixnet client

Two supported routes. Both use the **same** `web/` build.

| Route | When | Tool |
|---|---|---|
| **TWA** (recommended) | You have a hosted HTTPS PWA and want a Play Store app | `@bubblewrap/cli` |
| **Capacitor** | You need native plugins (secure storage, foreground service, share) | `@capacitor/android` |

## TWA (Trusted Web Activity)

```sh
npm --prefix ../web run build
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://your.app/manifest.webmanifest
bubblewrap build          # app-release-signed.apk / .aab
```

Requirements:

* PWA served over HTTPS with a valid certificate.
* `manifest.webmanifest` with `display: standalone`, real icons, `start_url`.
* `/.well-known/assetlinks.json` published for the signing key, otherwise the
  app shows a URL bar instead of running standalone.

## Capacitor

```sh
npm --prefix ../web run build
npm --prefix ../web i @capacitor/core @capacitor/android
npm --prefix ../web i -D @capacitor/cli
npm --prefix ../web run android:add
npm --prefix ../web run android:sync
npm --prefix ../web run android:open
```

The generated manifest lives at `web/android/app/src/main/AndroidManifest.xml`
(this repo ships that project under `web/android/`). Merge the settings from
`AndroidManifest.xml` in this directory:

* `INTERNET` permission.
* `android:usesCleartextTraffic="false"`.
* `android:networkSecurityConfig="@xml/network_security_config"`.

Then copy `network_security_config.xml` to
`android/app/src/main/res/xml/network_security_config.xml`.

## Runtime realities on Android

* **Background execution.** Android suspends background work (Doze, App
  Standby). The app ships a **foreground service** (`NysirisForegroundService`,
  started/stopped from `web/src/adapters/driven/foreground.mjs` while the tunnel
  is up) with an ongoing notification, which raises process priority so the
  WebView — and the tunnel inside it — stays alive. Without it the tunnel would
  be foreground-only.
* **One-shot WASM tunnel.** The tunnel cannot be rebuilt without a page reload.
  Surface an explicit "Reconnect" action (`webView.reload()` / `location.reload()`)
  rather than silently retrying `setupMixTunnel`.
* **Network changes.** Wi-Fi↔cellular transitions drop the WSS to the entry
  gateway. Reconnect on `ConnectivityManager` callbacks.
* **Battery and data.** Cover traffic runs continuously while connected. Show an
  estimate and let the user disconnect. Only offer `disableCoverTraffic` with an
  explicit warning about the privacy cost.
* **Secure storage.** The social identity is Keystore-backed (the
  `NysirisKeystore` plugin). The **messaging** SDK (`@nymproject/sdk-full-fat`)
  keeps *its* identity in IndexedDB internally and exposes no export/import API,
  so it cannot be moved into the Keystore from app code — a documented
  limitation (see `docs/05-security.md`). `android:allowBackup="false"` keeps it
  out of device backups.
* **Release.** Sign with an upload key, target a recent `compileSdk`, and test
  on both a physical device and an emulator image with Google Play services.

## Release build (tagged releases)

`./build.sh android --release` stamps `versionName`/`versionCode` from the
`VERSION` file (`versionCode = major*1000000 + minor*1000 + patch`), runs
`assembleRelease` + `bundleRelease`, and stages versioned artifacts:

```text
dist/nysiris_<version>_android.apk
dist/nysiris_<version>_android.aab
```

Without `--release` it builds a debug APK only (no `dist/` staging).

### Signing

An unsigned APK **cannot be installed** — Android rejects it with
"App not installed / package appears to be invalid". Therefore:

* **No secrets configured** (the default): the build produces *only* the
  **debug-signed** APK and attaches it as
  `dist/nysiris_<version>_android.apk`. It installs fine, but CI's debug key
  is ephemeral — **each release is signed by a different key**, so uninstall
  the old app before updating.
* **Secrets configured**: the release APK **and** AAB are signed with your
  stable key (updates install over each other) and the APK signature is
  verified with `apksigner` before upload.

Signing is read directly by `web/android/app/build.gradle` from the
environment:

| Variable | Meaning | Default |
|---|---|---|
| `ANDROID_KEYSTORE_PATH` | path to the `.jks`/`.keystore` (absolute, or relative to `web/android/app`) | — (debug-signed only) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password | required with a keystore |
| `ANDROID_KEY_ALIAS` | key alias | `nysiris` |
| `ANDROID_KEY_PASSWORD` | key password | keystore password |

Create a key once:

```sh
keytool -genkeypair -v -keystore nysiris.keystore -alias nysiris \
  -keyalg RSA -keysize 2048 -validity 10000
```

CI (`.github/workflows/release.yml`) reads the same values from repository
secrets: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 nysiris.keystore`) plus the
three password/alias variables.

> Bare `./gradlew` / Android Studio builds (outside `./build.sh android`) stamp
> `versionCode 1` / `versionName "1.0"` — pass
> `-PandroidVersionCode=… -PandroidVersionName=…` to override
> (`web/android/app/build.gradle`).

## Distribution

Nysiris is Apache-2.0 and ships **no proprietary dependencies**: there is no
Google Play Services / Firebase SDK in the build (the `com.google.gms`
google-services plugin was removed), so it is eligible for **F-Droid** and other
free-software stores. This is the preferred channel over Google Play.

### F-Droid (preferred)

F-Droid builds the app **from source** on its own server and signs the result
with the F-Droid key — you do not upload a binary.

* The recipe lives in the [`fdroiddata`](https://gitlab.com/fdroid/fdroiddata)
  repo as `metadata/com.tribewarez.nysiris.yml`. A ready-to-submit template
  is kept in this repo at
  [`fdroiddata/com.tribewarez.nysiris.yml`](fdroiddata/com.tribewarez.nysiris.yml);
  it points at a git tag of this project with `subdir: web/android`.
* Build steps are `npm ci` + `npm run build` in `web/`, then
  `npx cap sync android`, then gradle `assembleRelease`. Without
  `ANDROID_KEYSTORE_*` that produces an **unsigned** release APK, which is
  exactly what F-Droid signs — no secrets are needed on the build server.
* Keep `versionCode` monotonic (derived from `VERSION`); F-Droid's
  `UpdateCheckMode: Tags` reads the `vX.Y.Z` tags.
* Store listing text/screenshots can live in the app repo under
  `web/android/fastlane/metadata/android/en-US/` (F-Droid reads `fastlane`
  metadata). The launcher, adaptive and splash icons are generated from the
  mixnet motif with `python3 scripts/gen-android-icons.py` (and the PWA icons
  with `python3 scripts/gen-icons.py`); real device screenshots still need to be
  captured for the listing.

### F-Droid policy notes

* **Native enhancement, not a bare web wrapper.** The `NysirisKeystore`
  Capacitor plugin seals secrets with AES-256-GCM keys in the hardware-backed
  Android Keystore — native value the PWA cannot provide.
* **No proprietary deps, no anti-features.** No Google Play Services / Firebase
  (google-services removed), no ads, no trackers or analytics; only `INTERNET`
  is requested.
* **Distinct id.** `com.tribewarez.nysiris`, based on the project's domain
  `tribewarez.com` (F-Droid's recommended developer-owned-domain scheme).
* **Actively maintained.** Tagged `vX.Y.Z` releases built by CI; the recipe uses
  `UpdateCheckMode: Tags`.
* **Be honest about the network.** The client depends on the public Nym mixnet
  and a hardcoded Nym API endpoint; a reviewer may raise `TetheredNet` /
  `NonFreeNet`, which is a judgement call — see the recipe's MaintainerNotes.

### Direct APK (sideload / other stores)

```sh
./build.sh android --release   # with ANDROID_KEYSTORE_* set for a signed APK/AAB
```

`assembleRelease` + `bundleRelease` stage `dist/nysiris_<version>_android.apk`
and `..._android.aab`. Google Play still accepts the AAB (this project now
targets **`targetSdk 36`**, meeting Play's requirement for new apps since
2026-08-31), but Play is not the primary channel and there is no automated Play
upload.

## What this cannot do

* Route other apps' traffic. That requires **NymVPN** (dVPN) or a device-level
  SOCKS/`VpnService` client, which is out of scope for a browser client.
* Run Chrome extensions (Chrome for Android does not support them).
