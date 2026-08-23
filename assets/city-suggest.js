'use strict';

/* Подсказки городов для полей адреса.
 *
 * Зачем: companies.city — свободный текст, и люди пишут туда «СПб»,
 * «г. Санкт-Петербург», «Санкт-Петербург, Ленинградская обл». Для перевозчика
 * это три разные строки, а расчёт доставки спотыкается ещё и на названиях-
 * двойниках: «Белый Яр» есть под Абаканом и под Сургутом, и угадывать за
 * человека нельзя.
 *
 * Подсказки берутся из справочника перевозчиков (/api/logistics/cities) —
 * то есть предлагается ровно то, что они потом смогут посчитать.
 *
 * Свободный ввод НЕ запрещается. Поле остаётся обычным текстовым: если города
 * нет в справочнике, человек всё равно должен суметь сохранить профиль.
 * Подсказка помогает, а не сторожит.
 *
 * Самостоятельный файл без зависимостей: подключается и там, где есть app.js
 * (профиль компании), и в гостевом мастере завода, где его нет.
 */

(function () {
    const DEBOUNCE_MS = 250;
    const MIN_QUERY = 2;

    function apiBase() {
        const host = window.location.hostname;
        const isLocal = window.location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1';
        return isLocal ? 'http://localhost:5000/api' : '/api';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.innerText = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function buildDropdown() {
        const box = document.createElement('div');
        box.className = 'city-suggest-list';
        box.style.cssText = [
            'position:absolute', 'left:0', 'right:0', 'top:100%', 'z-index:60',
            'margin-top:2px', 'max-height:220px', 'overflow-y:auto',
            'background:var(--card-bg, #fff)', 'border:1px solid var(--card-border, #d8dee6)',
            'border-radius:8px', 'display:none',
        ].join(';');
        return box;
    }

    function attachCitySuggest(input, options) {
        if (!input || input.dataset.citySuggest === '1') return;
        input.dataset.citySuggest = '1';
        input.setAttribute('autocomplete', 'off');

        const opts = options || {};

        // Оборачиваем поле, чтобы выпадающий список позиционировался по нему и
        // не зависел от вёрстки страницы вокруг.
        const wrap = document.createElement('div');
        wrap.style.position = 'relative';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);

        const list = buildDropdown();
        wrap.appendChild(list);

        let items = [];
        let active = -1;
        let timer = null;
        let controller = null;

        function close() {
            list.style.display = 'none';
            active = -1;
        }

        function paint() {
            list.innerHTML = items.map((c, i) => {
                // Уточнение района уже сидит в названии в скобках — показываем
                // его один раз, отдельно и приглушённо, иначе получается
                // «Екатериновка (Екатериновский р-н) Екатериновский р-н».
                const plain = String(c.name || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
                const hint = c.qualifier ? ` <span style="color:var(--text-muted,#8b95a5);">${escapeHtml(c.qualifier)}</span>` : '';
                const bg = i === active ? 'background:var(--inner-bg, #f1f4f8);' : '';
                return `<div data-i="${i}" style="padding:7px 10px;cursor:pointer;font-size:13px;${bg}">${escapeHtml(plain)}${hint}</div>`;
            }).join('');
            list.style.display = items.length ? 'block' : 'none';
        }

        function pick(i) {
            const city = items[i];
            if (!city) return;
            input.value = city.name;
            input.dataset.cityId = String(city.id);
            close();
            if (typeof opts.onPick === 'function') opts.onPick(city);
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        async function search(query) {
            if (controller) controller.abort();
            controller = new AbortController();
            try {
                const res = await fetch(`${apiBase()}/logistics/cities?q=${encodeURIComponent(query)}`, {
                    credentials: 'include',
                    signal: controller.signal,
                });
                if (!res.ok) { items = []; close(); return; }
                items = await res.json();
                active = -1;
                paint();
            } catch {
                // Отменённый или неудавшийся запрос — просто не показываем список.
                // Поле остаётся рабочим, человек допишет город руками.
            }
        }

        input.addEventListener('input', () => {
            // Ручная правка отменяет ранее выбранный город: иначе в профиле
            // останется id одного города, а в тексте другой.
            delete input.dataset.cityId;
            const query = input.value.trim();
            clearTimeout(timer);
            if (query.length < MIN_QUERY) { items = []; close(); return; }
            timer = setTimeout(() => search(query), DEBOUNCE_MS);
        });

        input.addEventListener('keydown', (e) => {
            if (list.style.display === 'none' || !items.length) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
            else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
            else if (e.key === 'Escape') close();
        });

        /* Выбор делаем на click, а закрытие поля от потери фокуса — через
           preventDefault на mousedown.
           Раньше выбор происходил прямо на mousedown, и список исчезал между
           нажатием и отпусканием кнопки: элемент, по которому шёл клик,
           переставал существовать на середине жеста. Живой браузер такой клик
           доводит, а всё, что проверяет состояние между шагами, спотыкается.
           preventDefault не даёт полю потерять фокус, поэтому список доживает
           до click, и жест остаётся целым. */
        list.addEventListener('mousedown', (e) => {
            if (e.target.closest('[data-i]')) e.preventDefault();
        });

        list.addEventListener('click', (e) => {
            const target = e.target.closest('[data-i]');
            if (target) pick(Number(target.dataset.i));
        });

        input.addEventListener('blur', () => setTimeout(close, 120));
    }

    window.attachCitySuggest = attachCitySuggest;
    /* Подсказки полного адреса — для расчёта доставки.
     *
     * Тот же механизм, что и у городов, отличаются источник и то, что
     * запоминается при выборе. Город из выбранного адреса кладётся в
     * dataset.city: расчёт по-прежнему идёт по городу, потому что перевозчики
     * считают забор и доставку по городской зоне, а не по расстоянию до точки.
     * Сам адрес едет отдельным полем в заявку и в документы.
     *
     * Подсказок нет (ключ не настроен, сервис не ответил) — поле остаётся
     * обычным текстовым и расчёт по городу работает как раньше.
     */
    function attachAddressSuggest(input, options) {
        if (!input || input.dataset.addressSuggest === "1") return;
        input.dataset.addressSuggest = "1";
        input.setAttribute("autocomplete", "off");

        const opts = options || {};
        const wrap = document.createElement("div");
        wrap.style.position = "relative";
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);

        const list = buildDropdown();
        wrap.appendChild(list);

        let items = [];
        let active = -1;
        let timer = null;
        let controller = null;

        function close() { list.style.display = "none"; active = -1; }

        function paint() {
            list.innerHTML = items.map((a, i) => {
                const bg = i === active ? "background:var(--inner-bg, #f1f4f8);" : "";
                const hint = a.region && !a.value.includes(a.region)
                    ? " <span style=\"color:var(--text-muted,#8b95a5);\">" + escapeHtml(a.region) + "</span>"
                    : "";
                return "<div data-i=\"" + i + "\" style=\"padding:7px 10px;cursor:pointer;font-size:13px;line-height:1.35;" + bg + "\">" + escapeHtml(a.value) + hint + "</div>";
            }).join("");
            list.style.display = items.length ? "block" : "none";
        }

        function pick(i) {
            const a = items[i];
            if (!a) return;
            input.value = a.value;
            input.dataset.city = a.city || "";
            close();
            if (typeof opts.onPick === "function") opts.onPick(a);
            input.dispatchEvent(new Event("change", { bubbles: true }));
        }

        async function search(query) {
            if (controller) controller.abort();
            controller = new AbortController();
            try {
                const res = await fetch(apiBase() + "/logistics/addresses?q=" + encodeURIComponent(query), {
                    credentials: "include",
                    signal: controller.signal,
                });
                if (!res.ok) { items = []; close(); return; }
                items = await res.json();
                active = -1;
                paint();
            } catch { /* отменённый или неудавшийся запрос — просто без списка */ }
        }

        input.addEventListener("input", () => {
            // Правка руками отменяет ранее выбранный адрес: иначе в расчёт
            // уедет город от прошлого выбора, а в документ — новый текст.
            delete input.dataset.city;
            const query = input.value.trim();
            clearTimeout(timer);
            if (query.length < 3) { items = []; close(); return; }
            timer = setTimeout(() => search(query), DEBOUNCE_MS);
        });

        input.addEventListener("keydown", (e) => {
            if (list.style.display === "none" || !items.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
            else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
            else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
            else if (e.key === "Escape") close();
        });

        // Тот же приём, что и у городов: mousedown не даёт полю потерять фокус,
        // поэтому список доживает до click и жест остаётся целым.
        list.addEventListener("mousedown", (e) => { if (e.target.closest("[data-i]")) e.preventDefault(); });
        list.addEventListener("click", (e) => {
            const target = e.target.closest("[data-i]");
            if (target) pick(Number(target.dataset.i));
        });
        input.addEventListener("blur", () => setTimeout(close, 120));
    }

    window.attachAddressSuggest = attachAddressSuggest;
})();
