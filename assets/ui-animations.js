/* ui-animations.js — живая анимация и кастомные контролы */

// ── Custom select ────────────────────────────────────────────────────────
function buildCustomSelect(sel) {
    if (sel._csInit) return;
    sel._csInit = true;

    // Hide original but keep in DOM so onchange / value reads still work
    sel.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;overflow:hidden;';

    const wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    const trigger = document.createElement('div');
    trigger.className = 'cs-trigger';
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('role', 'combobox');
    trigger.innerHTML =
        '<span class="cs-val"></span>' +
        '<svg class="cs-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="6 9 12 15 18 9"/></svg>';
    wrap.appendChild(trigger);

    const menu = document.createElement('div');
    menu.className = 'cs-menu';
    menu.style.display = 'none';
    wrap.appendChild(menu);

    function syncLabel() {
        const opt = sel.options[sel.selectedIndex];
        trigger.querySelector('.cs-val').textContent = opt ? opt.text : '';
        menu.querySelectorAll('.cs-opt').forEach(o =>
            o.classList.toggle('cs-opt-active', o.dataset.v === sel.value));
    }

    function buildMenu() {
        menu.innerHTML = '';
        [...sel.options].forEach(opt => {
            const item = document.createElement('div');
            item.className = 'cs-opt' + (opt.value === sel.value ? ' cs-opt-active' : '');
            item.dataset.v = opt.value;
            item.textContent = opt.text;
            item.addEventListener('mousedown', e => {
                e.preventDefault();
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                syncLabel();
                close();
            });
            menu.appendChild(item);
        });
    }

    let isOpen = false;

    function open() {
        if (isOpen) return;
        _closeAll();   // close others before setting isOpen, so close() early-returns for this wrap
        isOpen = true;
        wrap.classList.add('cs-open');
        menu.style.display = 'block';
        buildMenu();
        syncLabel();
        // Flip up if not enough room below
        const rect = wrap.getBoundingClientRect();
        if (window.innerHeight - rect.bottom < 200 && rect.top > 200) {
            menu.style.top = 'auto';
            menu.style.bottom = 'calc(100% + 5px)';
        } else {
            menu.style.top = 'calc(100% + 5px)';
            menu.style.bottom = 'auto';
        }
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        wrap.classList.remove('cs-open');
        menu.style.display = 'none';
    }

    wrap._csClose = close;

    trigger.addEventListener('click', e => { e.stopPropagation(); isOpen ? close() : open(); });
    trigger.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isOpen ? close() : open(); }
        if (e.key === 'Escape') close();
    });

    // Sync label when external code changes select.value
    sel.addEventListener('change', syncLabel);

    // Watch for dynamically added options
    new MutationObserver(() => { buildMenu(); syncLabel(); }).observe(sel, { childList: true });

    syncLabel();
}

function _closeAll() {
    document.querySelectorAll('.cs-wrap').forEach(w => w._csClose?.());
}

function initCustomSelects(root) {
    root = root || document;
    root.querySelectorAll('select:not([data-no-custom])').forEach(sel => {
        if (!sel._csInit) buildCustomSelect(sel);
    });
}

document.addEventListener('click', _closeAll);

// ── Button ripple ────────────────────────────────────────────────────────
function addRipple(e) {
    const btn = e.currentTarget;
    const r = document.createElement('span');
    r.className = 'btn-ripple';
    const rect = btn.getBoundingClientRect();
    const d = Math.max(btn.offsetWidth, btn.offsetHeight) * 2;
    r.style.cssText = 'width:' + d + 'px;height:' + d + 'px;' +
        'left:' + (e.clientX - rect.left - d / 2) + 'px;' +
        'top:'  + (e.clientY - rect.top  - d / 2) + 'px;';
    btn.appendChild(r);
    r.addEventListener('animationend', () => r.remove());
}

function initRipple(root) {
    root = root || document;
    root.querySelectorAll('.btn-primary, .btn-secondary, .mf-apply-btn').forEach(btn => {
        if (btn._rippleInit) return;
        btn._rippleInit = true;
        btn.addEventListener('click', addRipple);
    });
}

// Pill-indicator отключён: дублировал border-left у .sidebar a.active
function initSidebarIndicator() {}

// ── Modal pop-in animation ───────────────────────────────────────────────
function initModalAnimations() {
    // Observe all overlay-like elements for display changes
    const targets = document.querySelectorAll(
        '[class*="modal-overlay"], [class*="overlay"], [id*="modal"]'
    );

    const obs = new MutationObserver(muts => {
        for (const m of muts) {
            if (m.attributeName !== 'style') continue;
            const el = m.target;
            const visible = el.style.display && el.style.display !== 'none';
            if (!visible) continue;
            // Animate the first child panel
            const panel = el.querySelector('div');
            if (panel) {
                panel.style.animation = 'none';
                void panel.offsetWidth; // reflow
                panel.style.animation = 'modalPopIn .22s cubic-bezier(.2,.8,.3,1)';
            }
        }
    });

    targets.forEach(el => obs.observe(el, { attributes: true }));
}

// ── Stagger items on grid/list changes ──────────────────────────────────
function initStagger() {
    const selectors = [
        '.producers-grid',
        '.kpi-row',
        '.mcp-list',
        '.deals-list',
        '.deliveries-list',
    ];

    selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(container => {
            function animateNew() {
                container.querySelectorAll(':scope > *:not([data-sa])').forEach((el, i) => {
                    el.setAttribute('data-sa', '1');
                    el.style.opacity = '0';
                    el.style.animation = 'fadeSlideUp .3s ease ' + (i * 0.045) + 's forwards';
                });
            }
            new MutationObserver(animateNew).observe(container, { childList: true });
            animateNew(); // animate existing items on load
        });
    });
}

// ── Skeleton helpers (exposed globally) ──────────────────────────────────
window.showSkeleton = function(container, rows, type) {
    rows = rows || 4;
    type = type || 'card';
    if (type === 'card') {
        container.innerHTML = Array.from({ length: rows }, () =>
            '<div class="skeleton-card">' +
            '  <div style="display:flex;gap:12px;align-items:flex-start">' +
            '    <div class="skeleton-avatar" style="width:44px;height:44px"></div>' +
            '    <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding-top:4px">' +
            '      <div class="skeleton-line" style="width:62%"></div>' +
            '      <div class="skeleton-line" style="width:38%"></div>' +
            '    </div>' +
            '  </div>' +
            '  <div class="skeleton-line" style="width:90%"></div>' +
            '  <div class="skeleton-line" style="width:70%"></div>' +
            '</div>'
        ).join('');
    } else if (type === 'row') {
        container.innerHTML = Array.from({ length: rows }, (_, i) =>
            '<tr><td colspan="10" style="padding:12px 16px">' +
            '  <div class="skeleton-line" style="width:' + (55 + (i % 3) * 16) + '%"></div>' +
            '</td></tr>'
        ).join('');
    }
};

window.hideSkeleton = function(container) {
    container.querySelectorAll('.skeleton-card').forEach(el => el.remove());
};

// ── Number counter animation ─────────────────────────────────────────────
window.animateCounter = function(el, endVal, suffix, duration) {
    suffix   = suffix   || '';
    duration = duration || 700;

    const raw = parseFloat(String(endVal).replace(/[^0-9.]/g, ''));
    if (isNaN(raw) || raw === 0) return;

    el.setAttribute('data-counting', '1');
    const startTime = performance.now();

    function step(now) {
        const p = Math.min((now - startTime) / duration, 1);
        // cubic ease-out
        const ease = 1 - Math.pow(1 - p, 3);
        const cur = Math.round(raw * ease);
        el.textContent = cur + suffix;
        if (p < 1) {
            requestAnimationFrame(step);
        } else {
            el.textContent = endVal; // exact final value
            el.removeAttribute('data-counting');
        }
    }
    requestAnimationFrame(step);
};

// ── Proc-row stagger (called after render) ───────────────────────────────
window.staggerProcRows = function(container) {
    const rows = container ? container.querySelectorAll('.proc-row') : [];
    rows.forEach((row, i) => {
        row.classList.remove('proc-row-enter');
        void row.offsetWidth; // force reflow to restart animation
        row.style.animationDelay = (i * 0.04) + 's';
        row.classList.add('proc-row-enter');
    });
};

// ── Init all ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    initCustomSelects();
    initRipple();
    initSidebarIndicator();
    initModalAnimations();
    initStagger();
});
