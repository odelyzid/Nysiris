// Check that every relative Markdown link in docs/ and the root README/AGENTS
// points at a file that exists. Used by ./build.sh check.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sources = [];
const docsDir = join(root, 'docs');
for (const name of readdirSync(docsDir)) {
  if (name.endsWith('.md')) sources.push(join(docsDir, name));
}
for (const name of ['README.md', 'AGENTS.md']) {
  const path = join(root, name);
  if (existsSync(path)) sources.push(path);
}

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
let checked = 0;
let broken = 0;

for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    target = target.split('#')[0];
    if (!target) continue;
    checked += 1;
    const absolute = resolve(dirname(file), target);
    if (!existsSync(absolute)) {
      console.error(`broken link: ${file.replace(`${root}/`, '')} -> ${target}`);
      broken += 1;
    }
  }
}

if (broken > 0) {
  console.error(`${broken} broken link(s) among ${checked} checked`);
  process.exit(1);
}
console.log(`doc links ok (${checked} links across ${sources.length} files)`);
