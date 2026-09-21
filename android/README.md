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

The generated manifest lives at `android/app/src/main/AndroidManifest.xml`.
Merge the settings from `AndroidManifest.xml` in this directory:

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
The release APK/AAB is **unsigned** unless you configure signing. For a
Play Store upload, create an upload key and add a `signingConfigs.release`
block (or pass the keystore via `ANDROID_KEYSTORE_*` env vars in CI), then
publish `assetlinks.json` / bump `versionCode` monotonically — the script
derives it from `VERSION`, so `./build.sh bump` is all you need.

## What this cannot do

* Route other apps' traffic. That requires **NymVPN** (dVPN) or a device-level
  SOCKS/`VpnService` client, which is out of scope for a browser client.
* Run Chrome extensions (Chrome for Android does not support them).
