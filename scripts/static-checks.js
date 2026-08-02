'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const htmlFiles = fs.readdirSync(root).filter(file => file.endsWith('.html')).sort();
const jsFiles = [
  'server.js', 'db.js', 'storage.js', 'export-pdf.js', 'telegram-bot.js', 'assets/app.js',
  ...fs.readdirSync(path.join(root, 'routes')).filter(f => f.endsWith('.js')).map(f => 'routes/' + f),
  ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f),
  'scripts/static-checks.js', 'scripts/mvp-api-smoke.js', 'scripts/import-registry.js', 'scripts/fetch-gisp.js',
  'scripts/legal-data.js', 'scripts/sync-legal.js',
  'scripts/sync-category-pages.js', 'seo/categories-data.js',
];
const cssFiles = ['assets/theme-v2.css', 'assets/deals-page.css', 'assets/css/tokens.css'];

function fail(message) {
  throw new Error(message);
}

function checkJavaScriptSyntax() {
  for (const file of jsFiles) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
}

function isExecutableScript(openTag) {
  const typeMatch = openTag.match(/\btype\s*=\s*["']([^"']+)["']/i);
  if (!typeMatch) return true;
  const type = typeMatch[1].trim().toLowerCase();
  return type === 'text/javascript'
    || type === 'application/javascript'
    || type === 'module';
}

function normalizeInlineScript(code) {
  // Server-rendered placeholders (supplier-public.html) are valid in prod, not in vm.Script.
  return code.replace(/<!--[A-Z0-9_]+-->/g, '0');
}

function checkInlineScripts() {
  let count = 0;
  const scriptRe = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    let match;
    let index = 0;
    while ((match = scriptRe.exec(html)) !== null) {
      if (!isExecutableScript(match[1])) continue;
      index += 1;
      new vm.Script(normalizeInlineScript(match[2]), { filename: `${file}#script${index}` });
      count += 1;
    }
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
      if (/^<!--[A-Z0-9_]+-->$/.test(ref)) continue;
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
  for (const file of cssFiles) {
    const css = fs.readFileSync(path.join(root, file), 'utf8');
    let depth = 0;
    let min = 0;
    for (const ch of css) {
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        min = Math.min(min, depth);
      }
    }
    if (depth !== 0 || min < 0) fail(`Unbalanced CSS braces in ${file}: depth=${depth}, min=${min}`);
  }
}

function checkEncodingArtifacts() {
  const files = [...htmlFiles, ...jsFiles, ...cssFiles];
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

function checkAccessGuardrails() {
  const routeFiles = ['server.js', 'routes/orders.js', 'routes/proposals.js', 'routes/messages.js'];
  const combined = routeFiles
    .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  const requiredSnippets = [
    'function canAccessProposal',
    'async function canAccessOrderThread',
    'async function canAccessOrderDrawing',
    'if (!canAccessProposal(req.user, row))',
    'await canAccessOrderThread(req.user, orderId, company)',
    'await canAccessOrderDrawing(req.user, orderId)',
    'Чат доступен только с поставщиком, подавшим КП',
  ];
  const missing = requiredSnippets.filter(snippet => !combined.includes(snippet));
  if (missing.length) fail(`Missing access guardrails:\n${missing.join('\n')}`);
}

function checkMpaPageStyles() {
  const appPages = htmlFiles.filter(file => {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    return html.includes('id="spa-content"');
  });
  const missing = [];
  for (const file of appPages) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const hasInline = /<style[^>]*data-spa-page/i.test(html);
    const hasPageCss = /data-spa-page-css/i.test(html);
    if (!hasInline && !hasPageCss) {
      missing.push(`${file}: no data-spa-page style or data-spa-page-css link`);
    }
  }
  const appJs = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
  if (!appJs.includes('window.__spaNavigate')) {
    fail('MPA navigate stub missing in assets/app.js');
  }
  if (missing.length) fail(`App pages missing page style markers:\n${missing.join('\n')}`);
}

function checkLegalFooterSynced() {
  const { renderFooter, applyFooter, footerPages, normalizeEol, hasFooterAnchor } = require('./sync-legal');
  const { LEGAL, DOC_YEAR } = require('./legal-data');
  const template = fs.readFileSync(path.join(root, 'partials', 'footer.html'), 'utf8');
  const footer = renderFooter(template, LEGAL, DOC_YEAR);
  const stale = [];
  const anchorless = [];
  for (const page of footerPages(root)) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    // Без маркеров и без </body> applyFooter вернёт вход как есть — страница выглядела бы
    // синхронной, хотя футера на ней нет вовсе.
    if (!hasFooterAnchor(html)) { anchorless.push(page); continue; }
    // Сравнение на нормализованных переводах строк: рабочая копия может быть в CRLF.
    if (normalizeEol(applyFooter(html, footer)) !== normalizeEol(html)) stale.push(page);
  }
  if (anchorless.length) {
    fail(`Страницам негде разместить футер — нет ни маркеров, ни </body>:\n${anchorless.join('\n')}`);
  }
  if (stale.length) {
    fail(`Футер разошёлся с partials/footer.html — прогони "npm run sync:legal":\n${stale.join('\n')}`);
  }
}

function checkCategoryPagesSynced() {
  const { renderCategoryPage, stripLegalBlock } = require('./sync-category-pages');
  const { CATEGORIES } = require('../seo/categories-data');
  const stale = [];
  for (const category of CATEGORIES) {
    const rel = path.join('zakupki', `${category.slug}.html`);
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) { stale.push(rel + ' (файла нет)'); continue; }
    // Сравниваем без юридического блока: его вставляет sync-legal.js, у него свой гейт.
    // Нормализуем переводы строк ДО вырезания блока: stripLegalBlock съедает ровно один '\n'
    // сразу после маркера конца, а на CRLF-чекауте (core.autocrlf=true, .gitattributes нет)
    // там стоит '\r\n' — после '\r\n'.replace(/\r\n/g,'\n') остаётся '\n', как и ожидает strip.
    // Обратный порядок (сначала strip, потом replace) на CRLF ничего не съедает и оставляет
    // лишнюю пустую строку — гейт тогда считает байт-корректные страницы устаревшими.
    const actual = stripLegalBlock(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    const expected = stripLegalBlock(renderCategoryPage(category).replace(/\r\n/g, '\n'));
    if (actual !== expected) stale.push(rel);
  }
  if (stale.length) {
    fail(`Категорийные страницы разошлись с seo/categories-data.js — прогони "npm run sync:categories":\n${stale.join('\n')}`);
  }
}

/** Кавычки внутри onclick="..." обрывают атрибут. Так молча умерла кнопка
 *  «Просмотр» у чертежа: JSON.stringify(name) вставлял двойные кавычки прямо в
 *  атрибут, и браузер получал `onclick="openDrawingPreview(9, "`. Ловим шаблон,
 *  где в двойных кавычках атрибута-обработчика стоит невыэкранированная
 *  подстановка со строкой. */
function checkInlineHandlerQuoting() {
  const suspects = [];
  const files = [...jsFiles, ...htmlFiles];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const re = /on[a-z]+\s*=\s*"[^"]*\$\{\s*JSON\.stringify\(/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Экранирование бывает и вручную: `JSON.stringify(x).replace(/"/g, '&quot;')`.
      // Смотрим хвост подстановки — если кавычки уже заменены, вопросов нет.
      const tail = text.slice(m.index, m.index + 260);
      // escapeHtml здесь не годится: он не трогает кавычки (innerText → innerHTML).
      // Кавычки закрывает только escapeAttr или ручная замена на &quot;.
      if (/escapeAttr\(\s*JSON\.stringify/.test(tail)) continue;
      if (/replace\(\s*\/"\s*\/g\s*,\s*['"]&quot;['"]\s*\)/.test(tail)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      suspects.push(`${rel}:${line}`);
    }
  }
  if (suspects.length) {
    fail(
      'Подстановка JSON.stringify прямо в onclick="..." рвёт атрибут кавычками — '
      + 'оберни в escapeHtml(...):\n' + suspects.join('\n')
    );
  }
}

function main() {
  checkJavaScriptSyntax();
  checkInlineHandlerQuoting();
  const inlineScripts = checkInlineScripts();
  checkLocalReferences();
  checkCssBalance();
  checkEncodingArtifacts();
  checkServerCanBeImported();
  checkProductionGuardrails();
  checkAccessGuardrails();
  checkMpaPageStyles();
  checkLegalFooterSynced();
  checkCategoryPagesSynced();
  console.log(`Static checks passed: ${htmlFiles.length} HTML files, ${inlineScripts} inline scripts`);
}

main();
