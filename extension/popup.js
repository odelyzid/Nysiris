// Popup controller. The actual tunnel runs in the offscreen document, not here.
const hostsInput = document.getElementById('hosts');
const failClosedInput = document.getElementById('failClosed');
const statusEl = document.getElementById('status');

async function load() {
  const config = await chrome.runtime.sendMessage({ type: 'get-config' });
  hostsInput.value = (config?.routedHosts ?? []).join(', ');
  failClosedInput.checked = Boolean(config?.failClosed);
}

document.getElementById('save').addEventListener('click', async () => {
  const routedHosts = String(hostsInput.value)
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  await chrome.runtime.sendMessage({
    type: 'set-config',
    routedHosts,
    failClosed: failClosedInput.checked,
  });
  statusEl.textContent = 'Saved. Reload routed tabs to apply.';
});

load();
