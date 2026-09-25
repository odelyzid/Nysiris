// Verify the standalone service crates stay in lockstep. Used by ./build.sh check.
//
// The services/* crates are excluded from the Cargo workspace (heavy nym-sdk
// toolchain) and are not compiled by the fast check loop, so drift here would
// otherwise surface only at deploy time. This fails fast on:
//   - differing nym-sdk version requirements across services,
//   - a missing Cargo.lock (./build.sh services builds --locked),
//   - a locked nym-sdk version that disagrees between services.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const services = ['acceptance', 'echo-provider', 'hybrid-bridge', 'nysiris-cli', 'portal-provider', 'social'];

let failures = 0;

const reqs = new Map();
const locked = new Map();

for (const svc of services) {
  const manifest = join(root, 'services', svc, 'Cargo.toml');
  const lock = join(root, 'services', svc, 'Cargo.lock');
  let text;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch (err) {
    console.error(`missing manifest: services/${svc}/Cargo.toml`);
    failures += 1;
    continue;
  }
  const req = text.match(/^\s*nym-sdk\s*=\s*"([^"]+)"/m)?.[1];
  if (!req) {
    console.error(`services/${svc}/Cargo.toml declares no nym-sdk dependency`);
    failures += 1;
    continue;
  }
  reqs.set(svc, req);

  if (!existsSync(lock)) {
    console.error(`missing lockfile: services/${svc}/Cargo.lock (services build --locked)`);
    failures += 1;
    continue;
  }
  const lockText = readFileSync(lock, 'utf8');
  const version = lockText.match(/name = "nym-sdk"\nversion = "([^"]+)"/)?.[1];
  if (!version) {
    console.error(`services/${svc}/Cargo.lock pins no nym-sdk version`);
    failures += 1;
    continue;
  }
  locked.set(svc, version);
}

if (new Set(reqs.values()).size > 1) {
  console.error('nym-sdk requirement drift:');
  for (const [svc, req] of [...reqs.entries()].sort()) console.error(`  ${svc}: "${req}"`);
  failures += 1;
}
if (new Set(locked.values()).size > 1) {
  console.error('locked nym-sdk version drift:');
  for (const [svc, version] of [...locked.entries()].sort()) console.error(`  ${svc}: ${version}`);
  failures += 1;
}

if (failures > 0) {
  console.error(`${failures} service pin failure(s)`);
  process.exit(1);
}
const [req, lockedVersion] = [reqs.values().next().value, locked.values().next().value];
console.log(`service pins ok (${services.length} crates, nym-sdk "${req}", locked ${lockedVersion})`);
