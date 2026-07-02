// Воксельная карта России для hero лендинга. Палитра «Чертёжный цех».
import * as THREE from '/assets/vendor/three/three.module.min.js';

const PAPER = 0xE2E8F0, PAPER_LIGHT = 0xF8FAFC,
      BLUE = 0x0B8FCE, ORANGE = 0xFF6A00, BASE = 0x0B2233;
const Y_SCALE = 1.6;   // широтное «утолщение», карта иначе слишком плоская
const UNIT = 1;        // размер ячейки в мировых координатах

export async function initVoxelMap({ canvas, pinsEl, pins = [], reducedMotion = false, densityUrl = null, pinHref = null }) {
    const grid = await fetch('/assets/data/russia-voxel-grid.json').then(r => {
        if (!r.ok) throw new Error('grid http ' + r.status);
        return r.json();
    });

    // Реальная плотность поставщиков; при ошибке — псевдорельеф (карта живёт всегда)
    let density = null;
    if (densityUrl) {
        try {
            const d = await fetch(densityUrl).then(r => r.ok ? r.json() : null);
            if (d && Array.isArray(d.points) && d.points.length) density = d.points;
        } catch { /* остаёмся на псевдорельефе */ }
    }

    // Буст на ячейку: сумма вкладов точек плотности с falloff по расстоянию (в ячейках)
    const boost = new Float32Array(grid.cells.length);
    if (density) {
        const maxN = Math.max(...density.map(p => p.n));
        grid.cells.forEach((c, i) => {
            const cellLon = grid.lonMin + (c[0] + 0.5) / grid.cols * (grid.lonMax - grid.lonMin);
            const cellLat = grid.latMin + (c[1] + 0.5) / grid.rows * (grid.latMax - grid.latMin);
            let b = 0;
            for (const p of density) {
                const plon = p.lon < 0 ? p.lon + 360 : p.lon;
                const dLon = (plon - cellLon) / (grid.lonMax - grid.lonMin) * grid.cols;
                const dLat = (p.lat - cellLat) / (grid.latMax - grid.latMin) * grid.rows;
                const dist2 = dLon * dLon + dLat * dLat;
                if (dist2 < 16) b += (p.n / maxN) * Math.exp(-dist2 / 5);
            }
            boost[i] = Math.min(b, 1);
        });
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const W = grid.cols * UNIT, H = grid.rows * UNIT * Y_SCALE;

    // Изометрическая ортокамера
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    const dist = Math.max(W, H);
    camera.position.set(dist * 0.85, dist * 1.55, dist * 0.85); // выше — ближе к «карте с наклоном», как на референсе
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-0.6, 1, 0.4);
    scene.add(sun);

    // Группа мира — параллакс наклоняет её, не камеру (пины проецируются камерой)
    const world = new THREE.Group();
    scene.add(world);

    // Плита-основание («лист чертежа»)
    const base = new THREE.Mesh(
        new THREE.BoxGeometry(W + 6, 1.6, H + 6),
        new THREE.MeshLambertMaterial({ color: BASE })
    );
    base.position.y = -0.8;
    world.add(base);

    // Столбики
    const box = new THREE.BoxGeometry(UNIT * 0.86, 1, UNIT * 0.86 * Y_SCALE);
    box.translate(0, 0.5, 0); // растём из плиты вверх — scale.y анимируется от 0
    const mat = new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(box, mat, grid.cells.length);
    const color = new THREE.Color();
    const dummy = new THREE.Object3D();
    const heights = new Float32Array(grid.cells.length);

    // Детерминированный псевдорельеф (когда живых данных нет)
    const pseudoHeight = i => grid.cells[i][2];

    grid.cells.forEach((c, i) => {
        const [col, row] = c;
        dummy.position.set(
            (col + 0.5) / grid.cols * W - W / 2,
            0,
            H / 2 - (row + 0.5) / grid.rows * H   // север — «вглубь» сцены
        );
        heights[i] = density
            ? Math.min(0.7 + pseudoHeight(i) * 0.45 + boost[i] * 2.1, 3.2)
            : pseudoHeight(i);
        dummy.scale.set(1, reducedMotion ? heights[i] : 0.001, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Акценты: с живыми данными вероятность растёт с плотностью, иначе — редкие вкрапления
        const roll = (i * 2654435761 >>> 0) % 100;
        const hot = density ? boost[i] : 0;
        // Оранжевый — маркер реальной плотности; синий — базовая «жизнь» карты (декор)
        const isOrange = density ? (hot > 0.45 && roll < 45) : roll >= 97;
        const isBlue = !isOrange && (density ? (hot > 0.15 && roll < 28) || roll >= 94 : roll >= 90);
        color.set(isOrange ? ORANGE : isBlue ? BLUE : (roll % 2 ? PAPER : PAPER_LIGHT));
        mesh.setColorAt(i, color);
    });
    mesh.instanceColor.needsUpdate = true;
    world.add(mesh);

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
        const half = Math.max(W, H * aspect) * 0.54;
        camera.left = -half; camera.right = half;
        camera.top = half / aspect * 0.88; camera.bottom = -half / aspect * 0.88;
        camera.updateProjectionMatrix();
        placePins();
        renderer.render(scene, camera);
    }

    function placePins() {
        if (!pinsEl) return;
        camera.updateMatrixWorld(true); // до первого рендера матрица камеры не собрана — project() врёт
        pinsEl.innerHTML = '';
        const w = canvas.clientWidth, h = canvas.clientHeight;
        pins.forEach(p => {
            const v = lonLatToWorld(p.lon, p.lat).project(camera);
            const el = document.createElement(pinHref ? 'a' : 'div');
            if (pinHref) { el.href = pinHref; el.title = p.name + ' — смотреть закупки'; }
            el.className = 'lp-vox-pin' + (p.labelAbove ? ' lp-vox-pin--alt' : '');
            el.innerHTML = '<span class="lp-vox-pin-dot"></span>' + (p.label === false ? '' : '<span class="lp-vox-pin-name"></span>');
            const nameEl = el.querySelector('.lp-vox-pin-name');
            if (nameEl) nameEl.textContent = p.name;
            el.style.left = ((v.x + 1) / 2 * w) + 'px';
            el.style.top = ((1 - (v.y + 1) / 2) * h) + 'px';
            pinsEl.appendChild(el);
        });
    }

    let built = reducedMotion;
    const t0 = performance.now();
    function buildFrame(now) {
        if (!built) {
            // «Стройка» столбиков волной с запада, ~1.4с
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
        if (!built) requestAnimationFrame(buildFrame);
    }

    // После сборки статичный кадр: рендерим по resize и при параллаксе.
    resize();
    window.addEventListener('resize', resize);
    if (reducedMotion) {
        renderer.render(scene, camera);
    } else {
        requestAnimationFrame(buildFrame);
    }

    // Наклон за курсором (не в reduced-motion)
    if (!reducedMotion) {
        let tx = 0, tz = 0, running = false;
        const host = canvas.parentElement;
        function tick() {
            world.rotation.x += (tx - world.rotation.x) * 0.08;
            world.rotation.z += (tz - world.rotation.z) * 0.08;
            renderer.render(scene, camera);
            if (Math.abs(tx - world.rotation.x) > 0.0005 || Math.abs(tz - world.rotation.z) > 0.0005) {
                requestAnimationFrame(tick);
            } else { running = false; }
        }
        function kick() { if (!running) { running = true; requestAnimationFrame(tick); } }
        host.addEventListener('pointermove', e => {
            const r = host.getBoundingClientRect();
            tx = ((e.clientY - r.top) / r.height - 0.5) * 0.10;
            tz = ((e.clientX - r.left) / r.width - 0.5) * -0.08;
            kick();
        });
        host.addEventListener('pointerleave', () => { tx = 0; tz = 0; kick(); });
    }

    return { ok: true, live: Boolean(density) };
}
