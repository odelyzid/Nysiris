// Validate the repository's JSON manifests. Used by ./build.sh check.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  'web/package.json',
  'web/tsconfig.json',
  'web/public/manifest.webmanifest',
  'extension/manifest.json',
  'desktop/electron/package.json',
];

let failures = 0;
for (const rel of files) {
  const path = join(root, rel);
  try {
    JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`invalid JSON: ${rel}: ${err.message}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`${failures} invalid JSON file(s)`);
  process.exit(1);
}
console.log(`json ok (${files.length} files)`);

// VERSION is the single source of truth; the JS manifests must match it.
// (`./build.sh bump` keeps these in step, including the lockfiles.)
const expected = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const versioned = [
  'web/package.json',
  'web/package-lock.json',
  'desktop/electron/package.json',
  'desktop/electron/package-lock.json',
];
for (const rel of versioned) {
  try {
    const data = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    const got = data.packages?.['']?.version ?? data.version;
    if (got !== expected) {
      console.error(`version drift: ${rel} is ${got}, VERSION is ${expected} (run ./build.sh bump ${expected})`);
      failures += 1;
    }
  } catch (err) {
    console.error(`unreadable: ${rel}: ${err.message}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`versions ok (${expected})`);
