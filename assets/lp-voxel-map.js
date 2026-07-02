// Воксельная карта России для hero лендинга. Палитра «Чертёжный цех».
import * as THREE from '/assets/vendor/three/three.module.min.js';

const PAPER = 0xE2E8F0, PAPER_LIGHT = 0xF8FAFC,
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
        renderer.render(scene, camera);
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
        if (!built) requestAnimationFrame(frame);
    }

    // После сборки статичный кадр: рендерим только по resize.
    resize();
    window.addEventListener('resize', resize);
    if (reducedMotion) {
        renderer.render(scene, camera);
    } else {
        requestAnimationFrame(frame);
    }

    return true;
}
