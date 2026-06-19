'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const htmlFiles = fs.readdirSync(root).filter(file => file.endsWith('.html')).sort();
const jsFiles = ['server.js', 'db.js', 'assets/app.js'];

function fail(message) {
  throw new Error(message);
}

function checkJavaScriptSyntax() {
  for (const file of jsFiles) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
}

function checkInlineScripts() {
  let count = 0;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1]);
    scripts.forEach((script, index) => {
      new vm.Script(script, { filename: `${file}#script${index + 1}` });
    });
    count += scripts.length;
  }
  return count;
}

function checkLocalReferences() {
  const missing = [];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)=['"]([^'"]+)['"]/gi)].map(match => match[1]);
    for (const ref of refs) {
      if (ref.includes('${')) continue;
      if (/^(https?:|mailto:|tel:|#|javascript:|\/api\/|\/socket\.io\/)/i.test(ref)) continue;
      if (ref.startsWith('/')) continue;
      const clean = ref.split('#')[0].split('?')[0];
      if (!clean || clean === '#') continue;
      const resolved = path.resolve(root, path.dirname(file), clean);
      if (!fs.existsSync(resolved)) missing.push(`${file} -> ${ref}`);
    }
  }
  if (missing.length) fail(`Missing local references:\n${missing.join('\n')}`);
}

function checkCssBalance() {
  const css = fs.readFileSync(path.join(root, 'assets/theme-v2.css'), 'utf8');
  let depth = 0;
  let min = 0;
  for (const ch of css) {
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      min = Math.min(min, depth);
    }
  }
  if (depth !== 0 || min < 0) fail(`Unbalanced CSS braces in assets/theme-v2.css: depth=${depth}, min=${min}`);
}

function checkEncodingArtifacts() {
  const files = [...htmlFiles, ...jsFiles, 'assets/theme-v2.css'];
  const badTokens = [
    '\uFFFD',
    '\u0420\u045C',
    '\u0420\u040F',
    '\u0420\u0403',
    '\u0421\u201A',
    '\u0432\u0402',
    '\u0432\u045A',
    '\u0412\u00AB',
    '\u0412\u00BB',
  ];
  const hits = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const found = badTokens.filter(token => content.includes(token));
    if (found.length) hits.push(`${file}: ${found.join(', ')}`);
  }
  if (hits.length) fail(`Possible encoding artifacts:\n${hits.join('\n')}`);
}

function checkServerCanBeImported() {
  const before = process.listenerCount('uncaughtException');
  const mod = require(path.join(root, 'server.js'));
  if (!mod.app || !mod.start) fail('server.js must export app and start');
  if (process.listenerCount('uncaughtException') !== before) fail('server import should not install global exception handlers');
}

function checkProductionGuardrails() {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  if (server.includes('dev-jwt-secret-change-in-production')) {
    fail('Production JWT fallback is still present');
  }
  const db = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
  if (!db.includes('SEED_ADMIN') || !db.includes('SEED_DEMO_DATA')) {
    fail('Database seed flags are required for controlled production startup');
  }
}

function main() {
  checkJavaScriptSyntax();
  const inlineScripts = checkInlineScripts();
  checkLocalReferences();
  checkCssBalance();
  checkEncodingArtifacts();
  checkServerCanBeImported();
  checkProductionGuardrails();
  console.log(`Static checks passed: ${htmlFiles.length} HTML files, ${inlineScripts} inline scripts`);
}

main();
