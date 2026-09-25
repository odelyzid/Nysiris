#!/usr/bin/env node
// Publish the numbered docs under docs/ to this project's GitHub wiki.
//
//   node scripts/publish-wiki.mjs            # render to dist/wiki/ for review
//   node scripts/publish-wiki.mjs --push     # render + clone/commit/push the wiki
//   node scripts/publish-wiki.mjs --out DIR  # render somewhere else
//
// Why a transform instead of copying: the wiki is a separate git repository, so
// repo-relative links (`../web/...`, `../crates/...`) can't work there. We
// rewrite doc-to-doc links to wiki page names and everything else to absolute
// GitHub URLs, and generate Home/_Sidebar/_Footer.
//
// Stdlib only; no npm dependencies. The wiki must be enabled once in
// Settings -> Features before `--push` can work.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = 'odelyzid/Nysiris';
const BRANCH = 'main';
const WIKI_URL = `https://github.com/${REPO}.wiki.git`;

const argv = process.argv.slice(2);
const push = argv.includes('--push');
const outIdx = argv.indexOf('--out');
const outDir = resolve(ROOT, outIdx >= 0 ? argv[outIdx + 1] : 'dist/wiki');

const DOC_DIR = join(ROOT, 'docs');

/** Wiki page name for a doc file: the basename without `.md`. */
const pageName = (file) => file.replace(/\.md$/, '');

/** First `# heading`, with any leading "N. " counter stripped for display. */
function titleOf(text, fallback) {
  const line = text.split('\n').find((l) => /^#\s+/.test(l));
  const raw = line ? line.replace(/^#\s+/, '').trim() : fallback;
  return raw.replace(/^\d+\.\s*/, '');
}

/**
 * Rewrite one markdown link/image target for the wiki.
 * `fromRepoRel` is the source file path relative to the repo root. Repo images
 * use raw.githubusercontent.com so they render inside the wiki (a `blob/` URL
 * would render as an HTML page, not an image).
 */
function transformTarget(target, fromRepoRel, isImage = false) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const hashAt = target.indexOf('#');
  const path = hashAt >= 0 ? target.slice(0, hashAt) : target;
  const anchor = hashAt >= 0 ? target.slice(hashAt) : '';
  if (!path) return target;

  // doc-to-doc: `01-architecture.md`, `./02-.md`, or `docs/05-security.md`
  const doc = /^(?:\.\/)?(?:docs\/)?(\d{2}-[a-z0-9-]+)\.md$/.exec(path);
  if (doc) return doc[1] + anchor;

  // anything else is a repo file/dir: link to it absolutely on GitHub
  const resolved = posix.normalize(posix.join(posix.dirname(fromRepoRel), path));
  const repoPath = resolved.replace(/^\.\//, '').replace(/^\/+/, '');
  const abs = join(ROOT, ...repoPath.split('/'));
  const isDir = repoPath.endsWith('/') || (existsSync(abs) && statSync(abs).isDirectory());
  const clean = repoPath.replace(/\/+$/, '');
  if (isImage && !isDir) return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${clean}${anchor}`;
  return `https://github.com/${REPO}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${clean}${anchor}`;
}

function withTrimmedTarget(target, fromRepoRel, isImage) {
  const t = target.trim();
  const at = target.indexOf(t);
  if (at < 0) return target;
  return target.slice(0, at) + transformTarget(t, fromRepoRel, isImage) + target.slice(at + t.length);
}

/**
 * Rewrite every markdown link in `text`. Bracket-aware (not a regex) so nested
 * constructs such as `[![badge](img)](LICENSE)` are handled as one outer link.
 */
function rewriteLinks(text, fromRepoRel) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '[' && text[i - 1] !== '\\') {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '[') depth += 1;
        else if (text[j] === ']') depth -= 1;
        j += 1;
      }
      if (depth === 0 && text[j] === '(') {
        let parens = 1;
        let k = j + 1;
        while (k < text.length && parens > 0) {
          if (text[k] === '(') parens += 1;
          else if (text[k] === ')') parens -= 1;
          k += 1;
        }
        if (parens === 0) {
          const label = text.slice(i, j);
          const target = text.slice(j + 1, k - 1);
          const isImage = i > 0 && text[i - 1] === '!';
          out += `${label}(${withTrimmedTarget(target, fromRepoRel, isImage)})`;
          i = k;
          continue;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function write(rel, text) {
  const path = join(outDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// ---------------------------------------------------------------- render

const docs = readdirSync(DOC_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

const pages = docs.map((file) => {
  const text = readFileSync(join(DOC_DIR, file), 'utf8');
  return { file, name: pageName(file), title: titleOf(text, pageName(file)), text };
});

for (const page of pages) {
  write(`${page.name}.md`, rewriteLinks(page.text, `docs/${page.file}`));
}

// Home is the README with the same link rewrites (docs/* -> wiki pages).
write('Home.md', rewriteLinks(readFileSync(join(ROOT, 'README.md'), 'utf8'), 'README.md'));

const sidebar = [
  '**Nysiris docs**',
  '',
  '- [Home](Home)',
  ...pages.map((p, i) => `- [${i + 1}. ${p.title}](${p.name})`),
  '',
  '---',
  '',
  `- [Source code](https://github.com/${REPO})`,
  `- [Issues](https://github.com/${REPO}/issues)`,
].join('\n');
write('_Sidebar.md', sidebar + '\n');

const footer = [
  '> ⚠️ **Experimental / pre-audit.** The `crates/` Sphinx core is a reference',
  '> implementation, never production crypto.',
  `> [Apache-2.0](https://github.com/${REPO}/blob/${BRANCH}/LICENSE) © 2026 odelyzid (tribewarez).`,
  `> [Report a security issue](https://github.com/${REPO}/security/policy).`,
].join('\n');
write('_Footer.md', footer + '\n');

console.log(`rendered ${pages.length} docs + Home/_Sidebar/_Footer -> ${outDir.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '')}`);

// ---------------------------------------------------------------- push

if (push) {
  const token = (process.env.WIKI_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  const cloneDir = mkdtempSync(join(tmpdir(), 'nysiris-wiki-'));
  rmSync(cloneDir, { recursive: true, force: true });
  try {
    // Public repo -> the wiki is readable without auth; the token is only
    // needed for the push below (and keeps us off anonymous rate limits).
    execFileSync('git', ['clone', '--depth', '1', WIKI_URL, cloneDir], { stdio: 'inherit' });
  } catch {
    console.error(
      [
        '',
        `Could not clone ${WIKI_URL}.`,
        'Enable the wiki once: GitHub repo -> Settings -> Features -> Wikis, then create the first page.',
        'Then re-run: node scripts/publish-wiki.mjs --push',
      ].join('\n'),
    );
    process.exit(1);
  }
  for (const name of readdirSync(outDir)) {
    if (name.endsWith('.md')) {
      writeFileSync(join(cloneDir, name), readFileSync(join(outDir, name)));
    }
  }
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: cloneDir, stdio: 'inherit' });
  execFileSync('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], {
    cwd: cloneDir,
    stdio: 'inherit',
  });
  execFileSync('git', ['add', '-A'], { cwd: cloneDir, stdio: 'inherit' });

  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: cloneDir, encoding: 'utf8' }).trim();
  if (!dirty) {
    console.log('wiki already up to date; nothing to push');
    process.exit(0);
  }

  execFileSync('git', ['commit', '-m', 'docs: publish docs/ wiki mirror'], { cwd: cloneDir, stdio: 'inherit' });
  // Inject the token as an HTTP header (never in the remote URL / logs).
  const pushArgs = token
    ? [
        '-c',
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        'push',
        'origin',
        'HEAD',
      ]
    : ['push', 'origin', 'HEAD'];
  execFileSync('git', pushArgs, { cwd: cloneDir, stdio: 'inherit' });
  console.log(`pushed wiki: https://github.com/${REPO}/wiki`);
}
