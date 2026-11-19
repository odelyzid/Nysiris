// Verify the standalone service crates stay in lockstep and on the audited
// dependency baseline. Used by ./build.sh check.
//
// The services/* crates are excluded from the Cargo workspace (heavy nym-sdk
// toolchain) and are not compiled by the fast check loop, so drift here would
// otherwise surface only at deploy time. This fails fast on:
//   - differing or wrong version requirements across service manifests,
//   - a missing Cargo.lock (./build.sh services builds --locked),
//   - locked versions that disagree with the audited baseline.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const services = ['acceptance', 'echo-provider', 'hybrid-bridge', 'nysiris-cli', 'portal-provider', 'shop', 'social'];

// Single source of truth for the audited baseline. Update every lockfile
// together (and this table) when the Nym SDK stack is genuinely upgraded.
const EXPECTED_REQ = {
  'nym-sdk': '1.21',
  'nym-bin-common': '1.22.0',
  'ed25519-dalek': '3',
  rusqlite: '0.32',
};
const EXPECTED_LOCK = {
  'nym-sdk': '1.21.6',
  'nym-bin-common': '1.22.0',
  'nym-client-core': '1.22.0',
  'nym-service-providers-common': '1.22.0',
  'ed25519-dalek': '3.0.0',
  rusqlite: '0.32.1',
};

let failures = 0;
const fail = (msg) => {
  console.error(msg);
  failures += 1;
};

/** Manifest dependency version, whether written as "1.2" or { version = "1.2" }. */
function manifestReq(text, name) {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(?:"([^"]+)"|\\{\\s*version\\s*=\\s*"([^"]+)"\\s*\\})`, 'm');
  return text.match(re)?.slice(1).find(Boolean);
}

/** All versions locked for a package name (ed25519-dalek legitimately has two). */
function lockVersions(text, name) {
  const re = /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g;
  const versions = [];
  for (const m of text.matchAll(re)) if (m[1] === name) versions.push(m[2]);
  return versions;
}

const reqs = new Map();
const locked = new Map();

for (const svc of services) {
  const manifest = join(root, 'services', svc, 'Cargo.toml');
  const lock = join(root, 'services', svc, 'Cargo.lock');
  let text;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch {
    fail(`missing manifest: services/${svc}/Cargo.toml`);
    continue;
  }

  for (const [name, expected] of Object.entries(EXPECTED_REQ)) {
    const req = manifestReq(text, name);
    if (req === undefined) continue; // not every service uses dalek or sqlite
    if (req !== expected) fail(`services/${svc}/Cargo.toml: ${name} "${req}", expected "${expected}"`);
  }
  const sdkReq = manifestReq(text, 'nym-sdk');
  if (!sdkReq) {
    fail(`services/${svc}/Cargo.toml declares no nym-sdk dependency`);
    continue;
  }
  reqs.set(svc, sdkReq);

  if (!existsSync(lock)) {
    fail(`missing lockfile: services/${svc}/Cargo.lock (services build --locked)`);
    continue;
  }
  const lockText = readFileSync(lock, 'utf8');
  for (const [name, expected] of Object.entries(EXPECTED_LOCK)) {
    const declared = manifestReq(text, name) !== undefined;
    const versions = lockVersions(lockText, name);
    if (versions.length === 0) {
      if (!declared && (name === 'ed25519-dalek' || name === 'rusqlite')) continue;
      fail(`services/${svc}/Cargo.lock pins no ${name} version`);
      continue;
    }
    // ed25519-dalek 2.2.0 also arrives transitively via nym, and rusqlite is
    // only used by the sqlite-backed services: check the baseline only where
    // the service actually depends on them.
    if (name === 'ed25519-dalek') {
      if (declared && !versions.includes(expected)) {
        fail(`services/${svc}/Cargo.lock: ${name} ${versions.join(', ')}, expected ${expected}`);
      }
    } else if (versions.some((v) => v !== expected)) {
      fail(`services/${svc}/Cargo.lock: ${name} ${versions.join(', ')}, expected ${expected}`);
    }
  }
  locked.set(svc, lockVersions(lockText, 'nym-sdk')[0]);
}

if (new Set(reqs.values()).size > 1) {
  fail('nym-sdk requirement drift:');
  for (const [svc, req] of [...reqs.entries()].sort()) console.error(`  ${svc}: "${req}"`);
}
if (new Set(locked.values()).size > 1) {
  fail('locked nym-sdk version drift:');
  for (const [svc, version] of [...locked.entries()].sort()) console.error(`  ${svc}: ${version}`);
}

if (failures > 0) {
  console.error(`${failures} service pin failure(s)`);
  process.exit(1);
}
const [req, lockedVersion] = [reqs.values().next().value, locked.values().next().value];
console.log(`service pins ok (${services.length} crates, nym-sdk "${req}", locked ${lockedVersion}, baseline verified)`);
