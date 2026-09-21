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
