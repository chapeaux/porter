#!/usr/bin/env -S deno run --allow-all
/**
 * build-static.ts -- Build a standalone static dist/ of Porter's UI
 *
 * Copies UI assets into dist/ with index.html rewritten for
 * runtime-configured deployment to any static host
 * (GitHub Pages, Cloudflare Pages, Netlify, S3, etc.).
 *
 * Usage:  deno task build:static
 *    or:  deno run --allow-all tools/build-static.ts
 */

import { join, dirname, relative } from "jsr:@std/path@^1";

const ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const SRC_UI = join(ROOT, "src", "ui");
const SRC_GRAPH = join(ROOT, "src", "graph");
const DIST = join(ROOT, "dist");

// ── helpers ────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function copyFile(src: string, dest: string): Promise<void> {
  await ensureDir(dirname(dest));
  await Deno.copyFile(src, dest);
  const rel = relative(ROOT, dest);
  console.log(`  ${rel}`);
}

/** Copy an entire directory tree, preserving structure. */
async function copyDir(src: string, dest: string): Promise<void> {
  if (!(await exists(src))) return;
  for await (const entry of Deno.readDir(src)) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile) {
      await copyFile(srcPath, destPath);
    }
  }
}

// ── 1. Clean & create dist/ ────────────────────────────────────────

console.log("Cleaning dist/ ...");
if (await exists(DIST)) {
  await Deno.remove(DIST, { recursive: true });
}
await ensureDir(DIST);

// ── 2. Copy root UI files ──────────────────────────────────────────

console.log("\nCopying root UI files ...");
const ROOT_FILES = [
  "app.js",
  "porter.css",
  "porter.svg",
  "sw.js",
  "manifest.json",
  "cpx-store.js",
  "cpx-model-config.js",
  "solid-auth.js",
  "porter-dialog.js",
  "flipboard.js",
  "constants.js",
  "dom.js",
];

for (const file of ROOT_FILES) {
  const src = join(SRC_UI, file);
  if (await exists(src)) {
    await copyFile(src, join(DIST, file));
  } else {
    console.log(`  [skip] ${file} (not found)`);
  }
}

// PNG assets (optional)
for (const png of ["porter-192.png", "porter-512.png"]) {
  const src = join(SRC_UI, png);
  if (await exists(src)) {
    await copyFile(src, join(DIST, png));
  } else {
    console.log(`  [skip] ${png} (not found)`);
  }
}

// Additional HTML pages
console.log("\nCopying HTML pages ...");
for (const html of [
  "auth-choose.html",
  "loading.html",
  "logged-out.html",
  "mcp-auth-result.html",
]) {
  const src = join(SRC_UI, html);
  if (await exists(src)) {
    await copyFile(src, join(DIST, html));
  } else {
    console.log(`  [skip] ${html} (not found)`);
  }
}

// ── 2b. Copy subdirectories ────────────────────────────────────────

console.log("\nCopying subdirectories ...");
for (const sub of [
  "dialogs",
  "features",
  "stores",
  "sync",
  "render",
  "connection",
  "lib",
]) {
  const srcDir = join(SRC_UI, sub);
  if (await exists(srcDir)) {
    await copyDir(srcDir, join(DIST, sub));
  } else {
    console.log(`  [skip] ${sub}/ (not found)`);
  }
}

// ── 3. Copy linked-data vocab assets ───────────────────────────────

console.log("\nCopying vocab assets ...");
const VOCAB_DIR = join(DIST, "vocab");
await ensureDir(VOCAB_DIR);

const vocabFiles: [string, string][] = [
  [join(SRC_GRAPH, "porter.ttl"), join(VOCAB_DIR, "porter.ttl")],
  [join(SRC_GRAPH, "shapes.ttl"), join(VOCAB_DIR, "shapes.ttl")],
  [join(SRC_GRAPH, "context.jsonld"), join(VOCAB_DIR, "context.jsonld")],
];

for (const [src, dest] of vocabFiles) {
  if (await exists(src)) {
    await copyFile(src, dest);
  } else {
    console.log(`  [skip] ${relative(ROOT, src)} (not found)`);
  }
}

// ── 4. Rewrite index.html ──────────────────────────────────────────

console.log("\nRewriting index.html ...");
let html = await Deno.readTextFile(join(SRC_UI, "index.html"));

// 4a. Replace bus-url meta tag value with empty string (runtime-configured)
html = html.replace(
  /(<meta\s+name="bus-url"\s+content=")([^"]*)(")/,
  '$1$3',
);

// 4b. Add porter-mode meta tag and runtime config script after bus-url line
const CONFIG_SCRIPT = `
  <meta name="porter-mode" content="browser">
  <script>
    // Runtime configuration for static deployment
    (function() {
      var mode = document.querySelector('meta[name="porter-mode"]');
      var api  = document.querySelector('meta[name="porter-api"]');
      window.__PORTER_CONFIG__ = {
        mode: mode ? mode.content : 'browser',
        apiUrl: api ? api.content : '',
      };
    })();
  </script>`;

html = html.replace(
  /(<meta\s+name="bus-url"\s+content=""[^>]*>)/,
  `$1\n${CONFIG_SCRIPT}`,
);

await Deno.writeTextFile(join(DIST, "index.html"), html);
console.log("  dist/index.html (rewritten)");

// ── 5. SPA redirect rules ──────────────────────────────────────────

console.log("\nGenerating SPA routing files ...");
// Netlify / Cloudflare Pages
await Deno.writeTextFile(join(DIST, "_redirects"), "/*  /index.html  200\n");
console.log("  dist/_redirects");

// ── Summary ────────────────────────────────────────────────────────

let fileCount = 0;
async function countFiles(dir: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile) fileCount++;
    else if (entry.isDirectory) await countFiles(join(dir, entry.name));
  }
}
await countFiles(DIST);

console.log(`\nDone. ${fileCount} files written to dist/`);
