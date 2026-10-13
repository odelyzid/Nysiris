package com.tribewarez.nysiris;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    public MainActivity() {
        super();
        // Hardware-backed secret storage for the WebView
        // (JS: web/src/adapters/driven/keystore.mjs, identity: web/src/application/identityStore.ts).
        registerPlugin(NysirisKeystorePlugin.class);
        // Foreground service so the tunnel survives backgrounding
        // (JS: web/src/adapters/driven/foreground.mjs).
        registerPlugin(NysirisForegroundPlugin.class);
    }
}
