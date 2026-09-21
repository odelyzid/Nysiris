// Diagnostic: drive a running nysiris app over Chrome DevTools Protocol,
// click "Connect", and report console output + tunnel status over time. Use it
// when the tunnel hangs with no visible error.
//
//   1. serve the app:      cargo run -p nysiris-launcher -- --root web/dist --no-open --port 8760
//   2. start Chrome with:  google-chrome --headless=new --disable-gpu --no-sandbox \
//                            --remote-debugging-port=9222 --user-data-dir=/tmp/fp-probe \
//                            http://127.0.0.1:8760/ &
//   3. run this:           node scripts/probe-tunnel.mjs http://127.0.0.1:9222 127.0.0.1
//
// Expected output ends with `[smolmix] tunnel ready` and the UI showing
// "Connected — mixnet tunnel ready". A `CompileError ... Content Security Policy`
// here means `script-src` is missing 'wasm-unsafe-eval'.

const base = process.argv[2] ?? 'http://127.0.0.1:9222';
const urlMatch = process.argv[3] ?? '127.0.0.1';

const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find((t) => t.type === 'page' && (t.url ?? '').includes(urlMatch));
if (!page) {
  console.error('no matching page target. targets:', targets.map((t) => t.url));
  process.exit(1);
}
console.log('attached to', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    console.log(`[console.${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log(`[exception] ${d.text} ${d.exception?.description ?? ''}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    console.log(`[log.${e.level}] ${e.text}${e.url ? ' ' + e.url : ''}`);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const click = await send('Runtime.evaluate', {
  expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => /connect/i.test(x.textContent || '')); if (!b) return 'no Connect button'; b.click(); return 'clicked'; })()`,
  returnByValue: true,
});
console.log('click:', click.result?.value);

const seconds = Number(process.argv[4] ?? 60);
for (let elapsed = 10; elapsed <= seconds; elapsed += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  const status = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('*')].map(e=>e.childElementCount?null:e.textContent).filter(Boolean).filter(t=>/Status|bringing|tunnel|error|Connected|Failed|Connecting|ready/i.test(t)).slice(0,4).join(' | ')`,
    returnByValue: true,
  });
  console.log(`t+${elapsed}s: ${status.result?.value}`);
}
process.exit(0);
