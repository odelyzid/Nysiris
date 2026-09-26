package app.example.nysiris;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    public MainActivity() {
        super();
        // Hardware-backed secret storage for the WebView
        // (JS: web/src/adapters/driven/keystore.mjs, identity: web/src/application/identityStore.ts).
        registerPlugin(NysirisKeystorePlugin.class);
    }
}
