# Воксельная 3D-карта России в hero лендинга — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Изометрическая воксельная карта России (three.js, палитра «Чертёжный цех») как визуал правой колонки hero на landing.html, с пинами ключевых нефтесервисных регионов и полным фолбэком на текущую панель.

**Architecture:** Оффлайн-генератор растеризует GeoJSON России в сетку ячеек (JSON, коммитится); браузерный ES-модуль рисует InstancedMesh-столбики с ортографической изо-камерой; пины — HTML-оверлей, спроецированный статичной камерой. Существующая панель `.lp-industrial` остаётся в DOM как фолбэк (нет WebGL / ошибка загрузки) — карта показывается только при успешной инициализации.

**Tech Stack:** three.js (self-hosted ES-module, без записи в package.json), Node-скрипты без зависимостей (генератор + ассерты), Playwright (уже в devDeps) для скриншот-верификации.

## Global Constraints

- three.js — self-hosted файл в `assets/vendor/three/` (CDN запрещён: RU-пользователи). Получать через `npm pack three@0.166.1` (registry на этой машине работает), НЕ добавлять в dependencies.
- Никаких выдуманных чисел на карте: пины — только названия регионов, высоты столбиков — декоративный рельеф. (Урок FAKE_COMPANIES: не фабрикуем данные.)
- Палитра только из брендовых значений: панель `#071B2A` (ink-navy), столбики `#E2E8F0`/`#F8FAFC` (paper), акценты `#0B8FCE` (blueprint) и `#FF6A00` (stamp-orange) — точечно.
- `prefers-reduced-motion: reduce` → карта статична (без анимации появления).
- ≤900px hero-right уже скрыт (`landing.html:734`) — мобильных правок не требуется.
- Фолбэк обязателен: `.lp-industrial` не удалять; при отсутствии WebGL или ошибке — карта скрыта, панель видна.
- После каждой задачи: `npm run check` → `Static checks passed`.
- Коммиты локальные, `git push` только по явной команде пользователя (push в main автодеплоит прод).

---

### Task 1: Vendor three.js

**Files:**
- Create: `assets/vendor/three/three.module.min.js`
- Create: `assets/vendor/three/LICENSE`

**Interfaces:**
- Produces: браузерный импорт `import * as THREE from '/assets/vendor/three/three.module.min.js'`.

- [ ] **Step 1: Скачать пакет и извлечь файлы (Bash, из корня репо)**

```bash
mkdir -p assets/vendor/three /tmp/three-pack
cd /tmp/three-pack && npm pack three@0.166.1 --silent
tar -xzf three-0.166.1.tgz
cd - >/dev/null
cp /tmp/three-pack/package/build/three.module.min.js assets/vendor/three/
cp /tmp/three-pack/package/LICENSE assets/vendor/three/
ls -la assets/vendor/three
```

Expected: `three.module.min.js` ~460КБ (не <100КБ), LICENSE (MIT).

- [ ] **Step 2: Смоук импорта в Node**

Run: `node --input-type=module -e "import('./assets/vendor/three/three.module.min.js').then(m => console.log('THREE ok, rev', m.REVISION))"`
Expected: `THREE ok, rev 166`.

- [ ] **Step 3: Commit**

```bash
git add assets/vendor/three
git commit -m "chore(vendor): three.js 0.166.1 (self-hosted ES module) для воксельной карты"
```

---

### Task 2: Генератор сетки России + данные

**Files:**
- Create: `scripts/data/RUS.geo.json` (исходник, коммитится)
- Create: `scripts/gen-voxel-grid.js`
- Create: `scripts/test-voxel-grid.js` (ассерты — пишется ПЕРВЫМ)
- Create: `assets/data/russia-voxel-grid.json` (сгенерированный, коммитится)

**Interfaces:**
- Produces: `assets/data/russia-voxel-grid.json` формата `{ "cols": 96, "rows": 40, "lonMin": 19, "lonMax": 191, "latMin": 41, "latMax": 82, "cells": [[col,row,height], ...] }`; height ∈ [1, 3]. Функция `lonLatToCell(lon, lat)` описана формулой в Task 3 (проекция линейная по этим границам; lon < 0 нормализуется как lon+360).

- [ ] **Step 1: Скачать GeoJSON России**

```bash
mkdir -p scripts/data assets/data
curl -L -o scripts/data/RUS.geo.json https://raw.githubusercontent.com/johan/world.geo.json/master/countries/RUS.geo.json
node -e "const g=require('./scripts/data/RUS.geo.json'); console.log(g.features[0].geometry.type)"
```

Expected: `MultiPolygon` (если `Polygon` — генератор ниже обрабатывает оба).

- [ ] **Step 2: Написать ассерты (красный тест)**

`scripts/test-voxel-grid.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'assets', 'data', 'russia-voxel-grid.json');
if (!fs.existsSync(p)) { console.error('FAIL: grid json not generated'); process.exit(1); }
const g = JSON.parse(fs.readFileSync(p, 'utf8'));

function cellAt(lon, lat) {
    if (lon < 0) lon += 360;
    const col = Math.floor((lon - g.lonMin) / (g.lonMax - g.lonMin) * g.cols);
    const row = Math.floor((lat - g.latMin) / (g.latMax - g.latMin) * g.rows);
    return g.cells.some(c => c[0] === col && c[1] === row);
}

const checks = [
    ['cells count 1200..6000', g.cells.length >= 1200 && g.cells.length <= 6000],
    ['heights in [1,3]', g.cells.every(c => c[2] >= 1 && c[2] <= 3)],
    ['Москва на суше', cellAt(37.6, 55.75)],
    ['Казань на суше', cellAt(49.1, 55.8)],
    ['Тюмень на суше', cellAt(65.5, 57.15)],
    ['Чукотка есть (антимеридиан)', cellAt(-173, 65)],
    ['Чёрное море пустое', !cellAt(31.0, 43.5)],
    ['Северный Ледовитый океан пустой', !cellAt(75.0, 80.5)],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
```

Run: `node scripts/test-voxel-grid.js`
Expected СЕЙЧАС: `FAIL: grid json not generated`, exit 1.

- [ ] **Step 3: Написать генератор**

`scripts/gen-voxel-grid.js`:

```js
'use strict';
// Растеризует GeoJSON России в сетку ячеек для воксельной карты лендинга.
// Запуск: node scripts/gen-voxel-grid.js  → пишет assets/data/russia-voxel-grid.json
const fs = require('fs');
const path = require('path');

const COLS = 96, ROWS = 40;
const LON_MIN = 19, LON_MAX = 191;   // lon<0 (Чукотка за антимеридианом) нормализуется +360
const LAT_MIN = 41, LAT_MAX = 82;

const geo = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'RUS.geo.json'), 'utf8'));

// Собираем все кольца (внешние и дырки) — even-odd правило обрабатывает дырки само.
const rings = [];
for (const f of geo.features) {
    const geom = f.geometry;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) for (const ring of poly) {
        rings.push(ring.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]));
    }
}

function insideEvenOdd(lon, lat) {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
    }
    return inside;
}

// Детерминированная «случайная» высота 1..3 — рельеф, не данные.
function height(col, row) {
    let h = (col * 73856093) ^ (row * 19349663);
    h = (h >>> 0) % 1000 / 1000;
    return Math.round((1 + 2 * h) * 100) / 100;
}

const cells = [];
for (let col = 0; col < COLS; col++) {
    const lon = LON_MIN + (col + 0.5) * (LON_MAX - LON_MIN) / COLS;
    for (let row = 0; row < ROWS; row++) {
        const lat = LAT_MIN + (row + 0.5) * (LAT_MAX - LAT_MIN) / ROWS;
        if (insideEvenOdd(lon, lat)) cells.push([col, row, height(col, row)]);
    }
}

const out = { cols: COLS, rows: ROWS, lonMin: LON_MIN, lonMax: LON_MAX, latMin: LAT_MIN, latMax: LAT_MAX, cells };
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'data', 'russia-voxel-grid.json'), JSON.stringify(out));
console.log('cells:', cells.length);
```

- [ ] **Step 4: Сгенерировать и прогнать ассерты (зелёный)**

Run: `node scripts/gen-voxel-grid.js && node scripts/test-voxel-grid.js`
Expected: `cells: <число 1200-6000>`, затем все `PASS`, exit 0. Если «Чукотка» FAIL — проверить нормализацию lon в генераторе и тесте (обе стороны должны прибавлять 360 к отрицательным долготам).

- [ ] **Step 5: Commit**

```bash
git add scripts/data/RUS.geo.json scripts/gen-voxel-grid.js scripts/test-voxel-grid.js assets/data/russia-voxel-grid.json
git commit -m "feat(landing): генератор воксельной сетки России из GeoJSON + данные"
```

---

### Task 3: Браузерный модуль карты

**Files:**
- Create: `assets/lp-voxel-map.js`

**Interfaces:**
- Consumes: `assets/vendor/three/three.module.min.js` (Task 1), `assets/data/russia-voxel-grid.json` (Task 2).
- Produces: ES-модуль с экспортом `initVoxelMap({ canvas, pinsEl, pins, reducedMotion })` → Promise<boolean> (true = карта построена; false/reject = включить фолбэк). `pins` — массив `{ name, lon, lat }`.

- [ ] **Step 1: Написать модуль**

`assets/lp-voxel-map.js` (полностью):

```js
// Воксельная карта России для hero лендинга. Палитра «Чертёжный цех».
import * as THREE from '/assets/vendor/three/three.module.min.js';

const INK = 0x071B2A, PAPER = 0xE2E8F0, PAPER_LIGHT = 0xF8FAFC,
      BLUE = 0x0B8FCE, ORANGE = 0xFF6A00, BASE = 0x0B2233;
const Y_SCALE = 1.6;   // широтное «утолщение», карта иначе слишком плоская
const UNIT = 1;        // размер ячейки в мировых координатах

export async function initVoxelMap({ canvas, pinsEl, pins = [], reducedMotion = false }) {
    const grid = await fetch('/assets/data/russia-voxel-grid.json').then(r => {
        if (!r.ok) throw new Error('grid http ' + r.status);
        return r.json();
    });

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const W = grid.cols * UNIT, H = grid.rows * UNIT * Y_SCALE;

    // Изометрическая ортокамера
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    const dist = Math.max(W, H);
    camera.position.set(dist, dist * 0.82, dist);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-0.6, 1, 0.4);
    scene.add(sun);

    // Плита-основание («лист чертежа»)
    const base = new THREE.Mesh(
        new THREE.BoxGeometry(W + 6, 1.6, H + 6),
        new THREE.MeshLambertMaterial({ color: BASE })
    );
    base.position.y = -0.8;
    scene.add(base);

    // Столбики
    const box = new THREE.BoxGeometry(UNIT * 0.86, 1, UNIT * 0.86 * Y_SCALE);
    box.translate(0, 0.5, 0); // растём из плиты вверх — scale.y анимируется от 0
    const mat = new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(box, mat, grid.cells.length);
    const color = new THREE.Color();
    const dummy = new THREE.Object3D();
    const heights = new Float32Array(grid.cells.length);

    grid.cells.forEach((c, i) => {
        const [col, row, h] = c;
        dummy.position.set(
            (col + 0.5) / grid.cols * W - W / 2,
            0,
            H / 2 - (row + 0.5) / grid.rows * H   // север — «вглубь» сцены
        );
        heights[i] = h;
        dummy.scale.set(1, reducedMotion ? h : 0.001, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // 90% бумага, 7% blueprint, 3% orange — детерминированно от индекса
        const roll = (i * 2654435761 >>> 0) % 100;
        color.set(roll < 90 ? (roll % 2 ? PAPER : PAPER_LIGHT) : roll < 97 ? BLUE : ORANGE);
        mesh.setColorAt(i, color);
    });
    mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);

    function lonLatToWorld(lon, lat) {
        if (lon < 0) lon += 360;
        const x = (lon - grid.lonMin) / (grid.lonMax - grid.lonMin) * W - W / 2;
        const z = H / 2 - (lat - grid.latMin) / (grid.latMax - grid.latMin) * H;
        return new THREE.Vector3(x, 3.6, z);
    }

    function resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        const aspect = w / h;
        const half = Math.max(W, H * aspect) * 0.62;
        camera.left = -half; camera.right = half;
        camera.top = half / aspect * 0.92; camera.bottom = -half / aspect * 0.92;
        camera.updateProjectionMatrix();
        placePins();
    }

    function placePins() {
        if (!pinsEl) return;
        pinsEl.innerHTML = '';
        const w = canvas.clientWidth, h = canvas.clientHeight;
        for (const p of pins) {
            const v = lonLatToWorld(p.lon, p.lat).project(camera);
            const el = document.createElement('div');
            el.className = 'lp-vox-pin';
            el.innerHTML = '<span class="lp-vox-pin-dot"></span><span class="lp-vox-pin-name"></span>';
            el.querySelector('.lp-vox-pin-name').textContent = p.name;
            el.style.left = ((v.x + 1) / 2 * w) + 'px';
            el.style.top = ((1 - (v.y + 1) / 2) * h) + 'px';
            pinsEl.appendChild(el);
        }
    }

    let disposed = false;
    let built = reducedMotion;
    const t0 = performance.now();
    function frame(now) {
        if (disposed) return;
        if (!built) {
            // «Стройка» столбиков волной с юго-запада, ~1.4с
            const t = (now - t0) / 1400;
            let all = true;
            for (let i = 0; i < heights.length; i++) {
                const delay = (grid.cells[i][0] / grid.cols) * 0.55;
                const k = Math.min(Math.max((t - delay) / 0.45, 0.001), 1);
                if (k < 1) all = false;
                mesh.getMatrixAt(i, dummy.matrix);
                dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
                dummy.scale.y = heights[i] * (1 - Math.pow(1 - k, 3));
                dummy.updateMatrix();
                mesh.setMatrixAt(i, dummy.matrix);
            }
            mesh.instanceMatrix.needsUpdate = true;
            built = all;
        }
        renderer.render(scene, camera);
        if (!built) requestAnimationFrame(frame);
    }

    // Пауза вне вьюпорта не нужна: после сборки рендерим только по resize.
    resize();
    window.addEventListener('resize', resize);
    if (reducedMotion) {
        renderer.render(scene, camera);
    } else {
        requestAnimationFrame(frame);
    }

    return true;
}
```

- [ ] **Step 2: Синтаксис-проверка**

ВНИМАНИЕ: `node --check` парсит .js как CommonJS и упадёт на `import` — это НЕ ошибка модуля. Проверять так:

Run: `node --input-type=module -e "import('./assets/lp-voxel-map.js').then(() => console.log('module ok'))"`
Expected: `module ok` (top-level модуля не трогает window — импорт в Node безопасен).

Затем `npm run check` → `Static checks passed`. Если static-checks гоняет `node --check` по assets/*.js и падает на этом файле — добавить `assets/lp-voxel-map.js` в исключения списка JS-файлов в scripts/static-checks.js (по аналогии с тем, как исключён deals-page.css из node --check), НЕ отключая проверку остальных.

- [ ] **Step 3: Commit**

```bash
git add assets/lp-voxel-map.js
git commit -m "feat(landing): модуль воксельной карты (three.js, изометрия, InstancedMesh)"
```

---

### Task 4: Интеграция в hero landing.html

**Files:**
- Modify: `landing.html` (правая колонка hero `#lp-hero-right`, ~строка 856; CSS рядом с `.lp-industrial`, ~строка 218)

**Interfaces:**
- Consumes: `initVoxelMap` из Task 3.

- [ ] **Step 1: CSS (в `<style>` лендинга, после блока `.lp-industrial`)**

```css
/* Воксельная карта России (hero). Фолбэк — .lp-industrial ниже. */
#lp-voxel-panel {
    position: relative; display: none;
    border-radius: 16px; overflow: hidden;
    background: #071B2A;
    padding: 18px 20px 14px;
}
#lp-voxel-panel.lp-vox-on { display: block; }
#lp-voxel-panel.lp-vox-on ~ .lp-industrial { display: none; }
#lp-voxel-canvas { display: block; width: 100%; height: 320px; }
#lp-voxel-pins { position: absolute; inset: 0; pointer-events: none; }
.lp-vox-pin { position: absolute; transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center; gap: 3px; }
.lp-vox-pin-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #FF6A00; border: 2px solid rgba(255,255,255,0.85);
    box-shadow: 0 0 0 3px rgba(255,106,0,0.25);
}
.lp-vox-pin-name {
    font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700;
    letter-spacing: 1px; text-transform: uppercase;
    color: rgba(255,255,255,0.85); background: rgba(7,27,42,0.72);
    padding: 2px 6px; border-radius: 3px; white-space: nowrap;
}
```

- [ ] **Step 2: Разметка — вставить ПЕРЕД `.lp-industrial` внутри `#lp-hero-right` (строка ~857)**

```html
<div id="lp-voxel-panel" class="lp-rise" style="--d:2;">
    <div style="position:relative; display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
        <span style="font-family:'JetBrains Mono',monospace; font-size:10.5px; letter-spacing:2px; color:rgba(255,255,255,0.55);">ГЕОГРАФИЯ ПОСТАВЩИКОВ · РОССИЯ</span>
        <span style="display:inline-flex; align-items:center; gap:7px; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:1.5px; color:#0B8FCE;">
            <span class="lp-dot-pulse" style="width:6px; height:6px; border-radius:50%; background:#0B8FCE;"></span>1200+ ЗАВОДОВ
        </span>
    </div>
    <canvas id="lp-voxel-canvas" aria-hidden="true"></canvas>
    <div id="lp-voxel-pins"></div>
</div>
```

Примечание: «1200+ заводов» — существующая цифра платформы (уже в hero-штампе и SEO-мета), не новая выдумка.

- [ ] **Step 3: Инициализация — inline `<script type="module">` в конце body landing.html**

```html
<script type="module">
(async () => {
    const panel = document.getElementById('lp-voxel-panel');
    const canvas = document.getElementById('lp-voxel-canvas');
    if (!panel || !canvas || window.innerWidth <= 900) return;
    try {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return; // фолбэк: остаётся .lp-industrial
        const { initVoxelMap } = await import('/assets/lp-voxel-map.js');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        panel.classList.add('lp-vox-on'); // показать до init, чтобы canvas получил размеры
        const ok = await initVoxelMap({
            canvas,
            pinsEl: document.getElementById('lp-voxel-pins'),
            reducedMotion,
            pins: [
                { name: 'Москва', lon: 37.62, lat: 55.75 },
                { name: 'Казань', lon: 49.11, lat: 55.80 },
                { name: 'Уфа', lon: 55.97, lat: 54.73 },
                { name: 'Пермь', lon: 56.25, lat: 58.01 },
                { name: 'Тюмень', lon: 65.53, lat: 57.15 },
                { name: 'Сургут', lon: 73.42, lat: 61.25 },
                { name: 'Новый Уренгой', lon: 76.63, lat: 66.08 },
                { name: 'Омск', lon: 73.37, lat: 54.99 },
            ],
        });
        if (!ok) panel.classList.remove('lp-vox-on');
    } catch (e) {
        console.warn('voxel map disabled:', e);
        panel.classList.remove('lp-vox-on');
    }
})();
</script>
```

Внимание: canvas берёт контекст в проверке `gl` — three.js создаст свой контекст на ТОМ ЖЕ canvas; WebGLRenderer при существующем контексте не конфликтует (тот же тип). Если при скриншот-проверке канвас чёрный — убрать пробную проверку `gl` и вместо неё try/catch вокруг `new THREE.WebGLRenderer`.

- [ ] **Step 4: Проверка**

Run: `npm run check`
Expected: `Static checks passed` (inline-скриптов станет на 1 больше — это нормально, счётчик в выводе просто вырастет).

- [ ] **Step 5: Commit**

```bash
git add landing.html
git commit -m "feat(landing): воксельная карта России в hero с фолбэком на индустриальную панель"
```

---

### Task 5: Скриншот-верификация (Playwright) и доводка

**Files:**
- Create: `scripts/voxel-screenshot.js`

**Interfaces:**
- Consumes: собранный landing.html; `@playwright/test` из devDependencies.

- [ ] **Step 1: Скрипт скриншота**

`scripts/voxel-screenshot.js`:

```js
'use strict';
// Скриншот hero лендинга с воксельной картой. Пишет PNG в системный tmp.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('@playwright/test');

const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let f = path.join(root, urlPath === '/' ? 'landing.html' : urlPath);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const out = path.join(os.tmpdir(), 'voxel-hero.png');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/landing.html`);
    await page.waitForTimeout(2500); // дождаться анимации сборки
    const panel = page.locator('#lp-voxel-panel');
    const visible = await panel.isVisible();
    if (visible) await panel.screenshot({ path: out });
    else await page.screenshot({ path: out });
    console.log('panel visible:', visible, '→', out);
    await browser.close();
    server.close();
    process.exit(visible ? 0 : 1);
});
```

- [ ] **Step 2: Прогнать и посмотреть глазами**

Run: `node scripts/voxel-screenshot.js`
Expected: `panel visible: true → <tmp>/voxel-hero.png`, exit 0. Открыть PNG (исполнитель-агент: приложить файл контролёру; контролёр смотрит визуально): силуэт России узнаваем (Крым/Кавказ юго-запад, Камчатка/Чукотка восток), столбики бело-серые с редкими синими/оранжевыми, пины с названиями городов на своих местах (Москва — запад, Сургут — центр-север), низ — тёмная плита. Если силуэт «лежит на боку»/зеркален — проверить знак Z в `lonLatToWorld` и порядок row.

- [ ] **Step 3: Доводка по скриншоту**

Разрешённые крутилки (менять только их): `Y_SCALE` (1.4–1.8), высота canvas в CSS (300–360px), множитель `0.62`/`0.92` в `resize()` (кадрирование), доли цветов (90/7/3), позиция камеры `dist * 0.82`. После каждой правки — повторить Step 2. Критерий стоп: Россия целиком в кадре, пины не наползают друг на друга, композиция не обрезает Камчатку.

- [ ] **Step 4: Commit**

```bash
git add scripts/voxel-screenshot.js landing.html assets/lp-voxel-map.js
git commit -m "feat(landing): скриншот-проверка воксельной карты + доводка композиции"
```

---

### Task 6: README

- [ ] **Step 1: Дополнить readme.txt**

Новый блок сверху «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ» (формат соседних, дата 02.07.2026): воксельная 3D-карта России в hero лендинга (three.js self-hosted в assets/vendor/three, БЕЗ записи в package.json); данные — assets/data/russia-voxel-grid.json из scripts/gen-voxel-grid.js (исходник scripts/data/RUS.geo.json, перегенерация: node scripts/gen-voxel-grid.js, ассерты: node scripts/test-voxel-grid.js); фолбэк .lp-industrial при отсутствии WebGL/≤900px; reduced-motion — статичный кадр; скриншот-проверка: node scripts/voxel-screenshot.js; пины без выдуманных чисел.

- [ ] **Step 2: Commit**

```bash
git add readme.txt
git commit -m "docs: readme — воксельная карта России в hero лендинга"
```

---

## Проверка всего плана перед сдачей

1. `npm run check` → `Static checks passed`.
2. `node scripts/test-voxel-grid.js` → все PASS.
3. `node scripts/voxel-screenshot.js` → exit 0; PNG осмотрен контролёром/пользователем.
4. Фолбэк: в screenshot-скрипте временно `chromium.launch({ args: ['--disable-webgl', '--disable-webgl2'] })` → `panel visible: false`, страница целая (панель .lp-industrial на месте) — вернуть args обратно после проверки.
5. `git log --oneline` — 6 коммитов. Не пушить без команды пользователя.
