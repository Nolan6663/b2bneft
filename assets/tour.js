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

    /* Элемент внутри фиксированного блока прокруткой не достать: если он сейчас
       за краем экрана, значит он там и останется. Так на телефоне отсеиваются
       пункты бокового меню, уехавшего вниз, — иначе счётчик обещал бы шаги,
       которых человек не увидит. */
    function insideFixed(el) {
        for (let node = el; node && node !== document.body; node = node.parentElement) {
            if (getComputedStyle(node).position === 'fixed') return true;
        }
        return false;
    }

    function reachable(el) {
        if (!el) return false;
        if (reallyVisible(el)) return true;
        return !insideFixed(el);
    }

    function visibleSteps(steps) {
        return (steps || []).filter(s => reachable(findAnchor(s.selectors)));
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
            card.style.left = '';
            /* Карточка прижата к низу, но подсвечиваемый элемент может быть там
               же — например, «Сообщения» в нижней панели. Тогда уводим карточку
               наверх, иначе она закрывает ровно то, что показывает. */
            const cardHeight = card.getBoundingClientRect().height || 180;
            const bottomZone = window.innerHeight - bottomObstacleHeight() - cardHeight - 32;
            if (rect.top > bottomZone) {
                card.style.bottom = 'auto';
                card.style.top = '16px';
            } else {
                card.style.top = 'auto';
                card.style.bottom = `${bottomObstacleHeight() + 16}px`;
            }
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

    /* Виден ли элемент человеку на самом деле. offsetParent врёт: на телефоне
       боковое меню уезжает за нижний край, ссылки в нём формально «видимы», и
       тур подсвечивал пустое место. Проверяем по точке: что лежит в центре
       элемента, не считая слоёв самого тура. */
    function reallyVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
        if (r.right <= 0 || r.left >= window.innerWidth) return false;

        const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
        const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
        const stack = typeof document.elementsFromPoint === 'function'
            ? document.elementsFromPoint(x, y)
            : [document.elementFromPoint(x, y)];
        const top = stack.filter(e => e && !e.closest('.tour-overlay, .tour-card'))[0];
        return Boolean(top && (top === el || el.contains(top) || top.contains(el)));
    }

    function paintStep() {
        if (!state) return;
        const step = state.steps[state.index];
        const anchor = findAnchor(step.selectors);
        if (!anchor || !reallyVisible(anchor)) {
            /* Шаг выбрасываем из маршрута, а не просто перескакиваем: иначе
               счётчик обещал бы «Шаг 3 из 4», когда шагов осталось два. */
            state.steps.splice(state.index, 1);
            if (!state.steps.length || state.index >= state.steps.length) { finish(); return; }
            showStep();
            return;
        }

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

    /* Ждём, пока прокрутка действительно закончится: на iOS плавный скролл
       длится дольше фиксированной паузы, и подсветка вставала по устаревшим
       координатам — вырез оказывался в стороне от элемента. Считаем позицию
       стабильной, когда она не менялась два кадра подряд. */
    function whenSettled(anchor, done) {
        let prev = null;
        let same = 0;
        const started = Date.now();
        const tick = () => {
            if (!state) return;
            const top = Math.round(anchor.getBoundingClientRect().top);
            same = (prev !== null && top === prev) ? same + 1 : 0;
            prev = top;
            if (same >= 2 || Date.now() - started > 1500) { done(); return; }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    function showStep() {
        const step = state.steps[state.index];
        const anchor = findAnchor(step.selectors);
        if (!anchor) { next(); return; }
        anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
        whenSettled(anchor, paintStep);
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
