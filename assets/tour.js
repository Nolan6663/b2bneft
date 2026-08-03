'use strict';

/* Тур по кабинету: подсветка элемента и карточка с пояснением.
   Движок ничего не знает про конкретные страницы — маршруты приходят данными
   из assets/app.js. Шаг без видимого якоря молча пропускается: на телефоне
   боковое меню превращается в нижнюю панель, часть элементов скрыта. */

(function () {
    const MOBILE_WIDTH = 720;
    let state = null;

    function findAnchor(selectors) {
        for (const sel of selectors || []) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null && el.getBoundingClientRect().width > 0) return el;
        }
        return null;
    }

    function visibleSteps(steps) {
        return (steps || []).filter(s => findAnchor(s.selectors));
    }

    function isTourAvailable(steps) {
        return visibleSteps(steps).length > 0;
    }

    function buildDom() {
        const overlay = document.createElement('div');
        overlay.className = 'tour-overlay';
        overlay.id = 'tourOverlay';

        const spot = document.createElement('div');
        spot.className = 'tour-spot';
        overlay.appendChild(spot);

        const card = document.createElement('div');
        card.className = 'tour-card';
        card.innerHTML = `
            <div class="tour-card-title" id="tourTitle"></div>
            <div class="tour-card-text" id="tourText"></div>
            <div class="tour-card-foot">
                <span class="tour-card-count" id="tourCount"></span>
                <div class="tour-card-actions">
                    <button type="button" class="tour-btn tour-btn-ghost" id="tourSkip">Пропустить</button>
                    <button type="button" class="tour-btn" id="tourNext">Далее</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        document.body.appendChild(card);
        return { overlay, spot, card };
    }

    /* Что уже занимает низ экрана: нижняя навигация и баннер «подтвердите email».
       Без этого карточка тура на телефоне ложится под них, и кнопки не нажать. */
    function bottomObstacleHeight() {
        let height = 0;
        ['#emailVerifyBanner', '.sidebar'].forEach((sel) => {
            const el = document.querySelector(sel);
            if (!el || el.offsetParent === null) return;
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed') return;
            const r = el.getBoundingClientRect();
            if (r.bottom >= window.innerHeight - 2) height = Math.max(height, r.height);
        });
        return height;
    }

    function placeCard(card, rect) {
        if (window.innerWidth <= MOBILE_WIDTH) {
            card.classList.add('tour-card-bottom');
            card.style.top = '';
            card.style.left = '';
            card.style.bottom = `${bottomObstacleHeight() + 16}px`;
            return;
        }
        card.style.bottom = '';
        card.classList.remove('tour-card-bottom');
        const cardRect = card.getBoundingClientRect();
        const gap = 12;
        let top = rect.bottom + gap;
        if (top + cardRect.height > window.innerHeight - gap) {
            top = Math.max(gap, rect.top - cardRect.height - gap);
        }
        let left = rect.left;
        if (left + cardRect.width > window.innerWidth - gap) {
            left = Math.max(gap, window.innerWidth - cardRect.width - gap);
        }
        card.style.top = `${Math.round(top)}px`;
        card.style.left = `${Math.round(left)}px`;
    }

    function paintStep() {
        if (!state) return;
        const step = state.steps[state.index];
        const anchor = findAnchor(step.selectors);
        if (!anchor) { next(); return; }

        const rect = anchor.getBoundingClientRect();
        const pad = 6;
        Object.assign(state.spot.style, {
            top: `${Math.round(rect.top - pad)}px`,
            left: `${Math.round(rect.left - pad)}px`,
            width: `${Math.round(rect.width + pad * 2)}px`,
            height: `${Math.round(rect.height + pad * 2)}px`,
        });

        document.getElementById('tourTitle').textContent = step.title;
        document.getElementById('tourText').textContent = step.text;
        document.getElementById('tourCount').textContent = `Шаг ${state.index + 1} из ${state.steps.length}`;
        document.getElementById('tourNext').textContent =
            state.index === state.steps.length - 1 ? 'Готово' : 'Далее';

        placeCard(state.card, rect);
        /* До первой отрисовки карточка пустая: между созданием и paintStep идёт
           прокрутка к якорю. Показываем её только с готовым содержимым. */
        state.card.classList.add('tour-card-ready');
    }

    function showStep() {
        const step = state.steps[state.index];
        const anchor = findAnchor(step.selectors);
        if (!anchor) { next(); return; }
        anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
        /* Позицию считаем после прокрутки, иначе подсветка встаёт по старым координатам */
        setTimeout(paintStep, 320);
    }

    function next() {
        if (!state) return;
        if (state.index >= state.steps.length - 1) { finish(); return; }
        state.index += 1;
        showStep();
    }

    function finish() {
        if (!state) return;
        const done = state.onFinish;
        state.overlay.remove();
        state.card.remove();
        window.removeEventListener('resize', paintStep);
        window.removeEventListener('scroll', paintStep, true);
        document.removeEventListener('keydown', onKey);
        state = null;
        if (typeof done === 'function') done();
    }

    function onKey(e) {
        if (e.key === 'Escape') finish();
    }

    function startTour(steps, options) {
        if (state) finish();
        const usable = visibleSteps(steps);
        if (!usable.length) return false;

        const dom = buildDom();
        state = {
            steps: usable,
            index: 0,
            overlay: dom.overlay,
            spot: dom.spot,
            card: dom.card,
            onFinish: (options || {}).onFinish,
        };

        document.getElementById('tourNext').onclick = next;
        document.getElementById('tourSkip').onclick = finish;
        dom.overlay.onclick = finish;
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', paintStep);
        window.addEventListener('scroll', paintStep, true);

        showStep();
        return true;
    }

    window.startTour = startTour;
    window.isTourAvailable = isTourAvailable;
    window.finishTour = finish;
})();
