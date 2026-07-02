# Воксельная карта: реальная плотность + интерактив — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Высота/акценты столбиков воксельной карты — из реальной плотности поставщиков по координатам БД; наклон сцены за курсором; пины-ссылки на публичный реестр; честная подпись о данных.

**Architecture:** Новый публичный агрегат-эндпоинт `/api/public/geo-density` (кэш в памяти 1 час, лёгкий GROUP BY по округлённым координатам). Клиент буст-ит высоты ячеек вокруг «горячих» точек с falloff; при недоступности данных — прежний псевдорельеф (карта не ломается никогда). Параллакс — поворот THREE.Group за курсором с lerp, рендер-цикл живёт только пока есть движение.

**Tech Stack:** существующие three.js-модуль, server.js (pg pool), без новых зависимостей.

## Global Constraints

- Подпись про данные показывается ТОЛЬКО когда density реально применена (не врать).
- `/api/map` и map.html не трогать.
- reduced-motion: без параллакса и анимаций (как сейчас).
- Фолбэки не деградируют: нет density → псевдорельеф; нет WebGL → .lp-industrial.
- После каждой задачи `npm run check`; коммиты локально; push по команде пользователя (выкат уже одобрен фразой «Делай» в рамках схемы «ветка → скриншоты → показ → выкат» — но финальный push только после визуальной проверки контролёром).

---

### Task 1: Эндпоинт /api/public/geo-density

**Files:** Modify: `server.js` (рядом с `/api/public/stats`).

**Interfaces:** Produces: `GET /api/public/geo-density` → `{ points: [{lon, lat, n}, ...] }`, координаты округлены до 1°, только producer с координатами; in-memory кэш 1 час.

- [ ] **Step 1: Найти `/api/public/stats`** — `grep -n "public/stats" server.js`, вставить ПОСЛЕ его обработчика:

```js
// Плотность поставщиков по регионам (для воксельной карты лендинга). Кэш 1 час.
let _geoDensityCache = { ts: 0, data: null };
app.get('/api/public/geo-density', async (req, res, next) => {
    try {
        if (_geoDensityCache.data && Date.now() - _geoDensityCache.ts < 3600 * 1000) {
            return res.json(_geoDensityCache.data);
        }
        const { rows } = await pool.query(`
            SELECT ROUND(lng::numeric, 0)::float AS lon,
                   ROUND(lat::numeric, 0)::float AS lat,
                   COUNT(*)::int AS n
            FROM companies
            WHERE role = 'producer' AND lat IS NOT NULL AND lng IS NOT NULL
            GROUP BY 1, 2
        `);
        const data = { points: rows };
        _geoDensityCache = { ts: Date.now(), data };
        res.json(data);
    } catch (e) { next(e); }
});
```

- [ ] **Step 2:** `npm run check` → passed; `node --check server.js` → тихо.
- [ ] **Step 3:** Commit `feat(api): /api/public/geo-density — агрегат плотности поставщиков (кэш 1ч)`.

---

### Task 2: Density → высоты и акценты, параллакс, пины-ссылки

**Files:** Modify: `assets/lp-voxel-map.js`, `landing.html` (вызов initVoxelMap, CSS пинов, подпись).

**Interfaces:** `initVoxelMap` получает новые опции `densityUrl` (string) и `pinHref` (string); возвращает `{ ok: true, live: boolean }` вместо `true` (live = density применена). Вызов в landing.html обновить соответственно.

- [ ] **Step 1: lp-voxel-map.js — density**

После загрузки grid добавить (внутри initVoxelMap, до создания mesh):

```js
    // Реальная плотность поставщиков; при ошибке — псевдорельеф (карта живёт всегда)
    let density = null;
    if (densityUrl) {
        try {
            const d = await fetch(densityUrl).then(r => r.ok ? r.json() : null);
            if (d && Array.isArray(d.points) && d.points.length) density = d.points;
        } catch { /* остаёмся на псевдорельефе */ }
    }
    // Буст на ячейку: сумма вкладов точек с falloff по расстоянию (в ячейках)
    const boost = new Float32Array(grid.cells.length);
    if (density) {
        const maxN = Math.max(...density.map(p => p.n));
        grid.cells.forEach((c, i) => {
            const cellLon = grid.lonMin + (c[0] + 0.5) / grid.cols * (grid.lonMax - grid.lonMin);
            const cellLat = grid.latMin + (c[1] + 0.5) / grid.rows * (grid.latMax - grid.latMin);
            let b = 0;
            for (const p of density) {
                let plon = p.lon < 0 ? p.lon + 360 : p.lon;
                const dLon = (plon - cellLon) / (grid.lonMax - grid.lonMin) * grid.cols;
                const dLat = (p.lat - cellLat) / (grid.latMax - grid.latMin) * grid.rows;
                const dist2 = dLon * dLon + dLat * dLat;
                if (dist2 < 16) b += (p.n / maxN) * Math.exp(-dist2 / 5);
            }
            boost[i] = Math.min(b, 1);
        });
    }
```

Высота и цвет в цикле по ячейкам заменить на:

```js
        const pseudo = heightsPseudo(i); // прежняя hash-высота, вынесенная в функцию
        heights[i] = density ? Math.min(0.7 + pseudo * 0.45 + boost[i] * 2.1, 3.2) : pseudo;
        ...
        // при density: вероятность акцента растёт с плотностью
        const roll = (i * 2654435761 >>> 0) % 100;
        const hot = density ? boost[i] : 0;
        const isOrange = density ? (hot > 0.55 && roll < 35) : roll >= 97;
        const isBlue = density ? (!isOrange && hot > 0.2 && roll < 30) : (roll >= 90 && roll < 97);
        color.set(isOrange ? ORANGE : isBlue ? BLUE : (roll % 2 ? PAPER : PAPER_LIGHT));
```

(`heightsPseudo(i)` — прежняя формула `1 + 2*hash`, оформить функцией, чтобы использовать в обеих ветках.)

- [ ] **Step 2: Параллакс**

Обернуть base+mesh в `const world = new THREE.Group()`; `scene.add(world)`. После запуска:

```js
    // Наклон за курсором (не в reduced-motion)
    if (!reducedMotion) {
        let tx = 0, tz = 0, running = false;
        const panel = canvas.parentElement;
        function tick() {
            world.rotation.x += (tx - world.rotation.x) * 0.08;
            world.rotation.z += (tz - world.rotation.z) * 0.08;
            renderer.render(scene, camera);
            if (Math.abs(tx - world.rotation.x) > 0.0005 || Math.abs(tz - world.rotation.z) > 0.0005) {
                requestAnimationFrame(tick);
            } else { running = false; }
        }
        function kick() { if (!running) { running = true; requestAnimationFrame(tick); } }
        panel.addEventListener('pointermove', e => {
            const r = panel.getBoundingClientRect();
            tx = ((e.clientY - r.top) / r.height - 0.5) * 0.10;
            tz = ((e.clientX - r.left) / r.width - 0.5) * -0.08;
            kick();
        });
        panel.addEventListener('pointerleave', () => { tx = 0; tz = 0; kick(); });
    }
```

Внимание: анимация «сборки» уже рендерит в своём цикле — конфликтов нет (оба цикла просто рендерят кадр; сборка завершится, параллакс продолжит по требованию).

- [ ] **Step 3: Пины-ссылки**

В `placePins`: элемент `document.createElement(pinHref ? 'a' : 'div')`; если `pinHref` — `el.href = pinHref; el.title = p.name + ' — смотреть закупки';`. CSS в landing.html: `.lp-vox-pin { pointer-events: auto; text-decoration: none; cursor: pointer; transition: transform .15s; } .lp-vox-pin:hover { transform: translate(-50%, -5px) scale(1.12); } .lp-vox-pin--alt:hover { transform: translate(-50%, calc(-100% + 5px)) scale(1.12); }` (базовые transform уже есть — hover повторяет их со scale).

- [ ] **Step 4: Возврат и подпись**

`return true` → `return { ok: true, live: Boolean(density) }`. В landing.html после канваса:

```html
<div id="lp-voxel-caption" hidden style="margin-top:8px; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:1.5px; color:rgba(255,255,255,0.45);">ВЫСОТА СТОЛБИКА — ПЛОТНОСТЬ ПОСТАВЩИКОВ В РЕГИОНЕ</div>
```

В init-скрипте: `const res = await initVoxelMap({ ..., densityUrl: '/api/public/geo-density', pinHref: '/zakupki.html' }); if (!res || !res.ok) { panel.classList.remove('lp-vox-on'); } else if (res.live) { document.getElementById('lp-voxel-caption').hidden = false; }`

- [ ] **Step 5:** синтаксис (`cp` в tmp .mjs + `node --check`), `npm run check`, commit `feat(landing): воксельная карта — реальная плотность, параллакс, пины-ссылки`.

---

### Task 3: Верификация

- [ ] **Step 1:** `node scripts/voxel-screenshot.js` — карта живая; density на локалке БЕЗ сервера вернёт 404 → проверяется фолбэк: карта с псевдорельефом, подпись скрыта. Скриншот смотрит контролёр.
- [ ] **Step 2:** Расширить scripts/voxel-screenshot.js моком density: перед `page.goto` добавить

```js
    await page.route('**/api/public/geo-density', route => route.fulfill({ json: { points: [
        { lon: 38, lat: 56, n: 40 }, { lon: 49, lat: 56, n: 18 }, { lon: 66, lat: 57, n: 25 },
        { lon: 73, lat: 61, n: 15 }, { lon: 77, lat: 66, n: 10 }, { lon: 73, lat: 55, n: 12 },
    ] } }));
```

(мок только в тест-скрипте, НЕ в продукте). Прогнать: подпись видна, вокруг Москвы/Тюмени рельеф выше и больше оранжевого. Скриншот смотрит контролёр.
- [ ] **Step 3:** `NO_WEBGL=1 node scripts/voxel-screenshot.js` → `panel visible: false`.
- [ ] **Step 4:** commit `test(landing): мок density в скриншот-проверке`.

---

### Task 4: README

- [ ] Блок в «ПОСЛЕДНИЕ ОБНОВЛЕНИЯ»: /api/public/geo-density (кэш 1ч, ROUND до 1°), density→высоты/акценты с фолбэком на псевдорельеф, подпись честности только при live-данных, параллакс за курсором (кроме reduced-motion), пины → /zakupki.html. Commit `docs: readme — живые данные воксельной карты`.
