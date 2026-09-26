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
  Standby). A long-lived tunnel needs a **foreground service** with a visible
  notification. Otherwise treat the tunnel as foreground-only and reconnect on
  resume.
* **One-shot WASM tunnel.** The tunnel cannot be rebuilt without a page reload.
  Surface an explicit "Reconnect" action (`webView.reload()` / `location.reload()`)
  rather than silently retrying `setupMixTunnel`.
* **Network changes.** Wi-Fi↔cellular transitions drop the WSS to the entry
  gateway. Reconnect on `ConnectivityManager` callbacks.
* **Battery and data.** Cover traffic runs continuously while connected. Show an
  estimate and let the user disconnect. Only offer `disableCoverTraffic` with an
  explicit warning about the privacy cost.
* **Secure storage.** The messaging SDK keeps identity in IndexedDB (app-scoped,
  not hardware-backed). For higher assurance, manage keys via Android Keystore /
  `EncryptedSharedPreferences` through a Capacitor plugin, and document the
  threat model. Losing the keys means losing the address.
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
"App not installed". Signing is opt-in via environment variables, read
directly by `web/android/app/build.gradle`:

| Variable | Meaning | Default |
|---|---|---|
| `ANDROID_KEYSTORE_PATH` | path to the `.jks`/`.keystore` (absolute, or relative to `web/android/app`) | — (unsigned) |
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
three password/alias variables. With a keystore configured the release APK/AAB
is signed and verified with `apksigner` before upload.

Without one, `./build.sh android --release` also stages a **debug-signed**
fallback that is installable for sideloading:

```text
dist/nysiris_<version>_android-debug.apk
```

> Bare `./gradlew` / Android Studio builds (outside `./build.sh android`) stamp
> `versionCode 1` / `versionName "1.0"` — pass
> `-PandroidVersionCode=… -PandroidVersionName=…` to override
> (`web/android/app/build.gradle`).

For a Play Store upload, publish `assetlinks.json` and bump `versionCode`
monotonically — the script derives it from `VERSION`, so `./build.sh bump` is
all you need.

## What this cannot do

* Route other apps' traffic. That requires **NymVPN** (dVPN) or a device-level
  SOCKS/`VpnService` client, which is out of scope for a browser client.
* Run Chrome extensions (Chrome for Android does not support them).
