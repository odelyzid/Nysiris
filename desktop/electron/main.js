// Electron shell for the fly-protocol PWA.
//
// ALTERNATIVE to the system-Chromium .deb. Use this when you want a
// self-contained package that does not depend on the user having Chromium
// installed. It bundles Chromium (large: ~150 MB installed) but guarantees the
// Chromium engine the Nym WASM client targets.
//
// Run `npm install && npm run dist` in this directory to produce .deb/AppImage.
// The web build must exist at desktop/electron/web (copy web/dist there).

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEB_ROOT = path.join(__dirname, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const relative = urlPath.replace(/^\/+/, '') || 'index.html';
      // Refuse traversal.
      if (relative.split('/').includes('..') || relative.includes('\0')) {
        res.writeHead(400).end('bad request');
        return;
      }
      let file = path.join(WEB_ROOT, relative);
      if (!file.startsWith(WEB_ROOT)) {
        res.writeHead(400).end('bad request');
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(WEB_ROOT, 'index.html'); // SPA fallback
      }
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // Cross-origin isolation for SharedArrayBuffer, matching the Rust launcher.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      };
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

async function main() {
  const { url } = await startServer();
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'fly-protocol',
    backgroundColor: '#0b0d12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  await window.loadURL(url);
}

app.whenReady().then(main);

app.on('window-all-closed', () => {
  app.quit();
});
