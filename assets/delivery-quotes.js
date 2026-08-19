'use strict';

/* Отрисовка расчёта доставки: перевозчик, способ, цена, срок.
 *
 * Отдельным файлом, потому что блок нужен в трёх местах: список откликов и
 * карточка сделки в кабинете, и публичный калькулятор. Публичная страница не
 * должна тянуть ради этого весь assets/app.js, а второй копии кода быть не
 * должно — расчёт и оговорки обязаны выглядеть одинаково везде.
 *
 * Показываем варианты, а не одно число: у одного перевозчика авто и авиа
 * отличаются в разы, и выбор — дело заказчика.
 *
 * Оговорка снизу обязательна. Мы не сторона сделки и цену от своего лица не
 * обещаем: это публичный тариф перевозчика, без обрешётки, негабарита и класса
 * груза. Без этой строки первый же разошедшийся счёт станет претензией к
 * платформе.
 */

(function () {
    function esc(str) {
        const div = document.createElement('div');
        div.innerText = str == null ? '' : String(str);
        return div.innerHTML;
    }

    const SERVICE = { auto: 'авто', avia: 'авиа', express: 'экспресс' };
    const fmt = (v) => new Intl.NumberFormat('ru-RU').format(v);

    /* Два размера одного блока.
       В кабинете он живёт в строке таблицы среди других данных и должен быть
       компактным. На собственной странице он — главное, ради чего пришли, и
       мелкий шрифт там читается как черновик. Формат и оговорки при этом
       одинаковые: меняется только масштаб. */
    const SIZES = {
        compact: { carrier: 12.5, meta: 11.5, small: 10.5, price: 13, link: 11.5, pad: 8, note: 10 },
        page: { carrier: 15, meta: 13, small: 12, price: 22, link: 13, pad: 14, note: 11.5 },
    };

    function renderDeliveryQuotes(data, proposalId, options) {
        const opts = options || {};
        const s = SIZES[opts.variant === 'page' ? 'page' : 'compact'];
        // В кабинете блок живёт в ячейке таблицы, которая шире модалки, поэтому
        // там нужен жёсткий потолок. На отдельной странице он только мешает.
        const maxWidth = opts.maxWidth || 'min(620px, calc(100vw - 72px))';

        if (!data) {
            return '<div style="font-size:12px;color:var(--text-secondary);">Не удалось рассчитать доставку</div>';
        }
        if (data.error) {
            return `<div style="font-size:12px;color:var(--text-secondary);line-height:1.45;">${esc(data.error)}</div>`;
        }

        // Куда именно едет груз, если забор или доставку сняли: без этой пометки
        // упавшая цена выглядит просто дешевле, а не «до терминала».
        const ends = [];
        if (data.doorFrom === false) ends.push('от терминала');
        if (data.doorTo === false) ends.push('до терминала');
        const endsNote = ends.length ? ` · ${ends.join(', ')}` : '';

        // Никто не ответил и никто не посчитал — честно говорим об этом, а не
        // показываем пустую таблицу.
        if (!data.quotes || data.quotes.length === 0) {
            if (data.failed && data.failed.length) {
                const who = `${data.failed.join(', ')} не ответил${data.failed.length > 1 ? 'и' : ''}`;
                return `<div style="font-size:12px;color:var(--text-secondary);">${esc(who)}. Попробуйте позже.</div>`;
            }
            // Никто не отказал — просто никто не возит. Просить повторить
            // бессмысленно: со второй попытки справочник не изменится.
            return '<div style="font-size:12px;color:var(--text-secondary);">'
                + 'Ни один из перевозчиков не считает этот маршрут — пункта нет в их справочниках. '
                + 'Попробуйте ближайший крупный город.</div>';
        }

        /* Строками, а не таблицей. Таблица из пяти колонок на 390px требует
           горизонтальной прокрутки, и человек видит один столбец с названиями
           перевозчиков — то есть ровно не ту колонку, ради которой пришёл.
           Здесь цена и срок держатся рядом с перевозчиком на любой ширине. */
        const rows = data.quotes.map((q, i) => {
            const days = q.days ? `${q.days.min}–${q.days.max} сут.` : 'срок уточняется';
            const best = i === 0
                ? '<span style="margin-left:6px;font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(5,150,105,.12);color:var(--accent-green);font-weight:700;">Дешевле</span>'
                : '';
            const parts = [];
            if (q.price.pickup) parts.push(`забор ${fmt(q.price.pickup)}`);
            if (q.price.delivery) parts.push(`доставка ${fmt(q.price.delivery)}`);
            const breakdown = parts.length
                ? `<div style="font-size:${s.small}px;color:var(--text-muted);margin-top:3px;">плечо ${fmt(q.price.line)}, ${parts.join(', ')}</div>`
                : '';
            /* Страхование стоит отдельной строкой и в итог не входит: перевозчики
               считают его по-разному — ПЭК от объявленной стоимости, Деловые Линии
               по своим правилам. В общей сумме это выглядело бы как сравнение,
               которым не является, а по итогу ещё и сортируется список. */
            const insurance = q.price.insurance
                ? `<div style="font-size:${s.small}px;color:var(--text-muted);margin-top:3px;">+ страхование ${fmt(q.price.insurance)} ₽ по расчёту перевозчика</div>`
                : '';

            /* На отдельной странице самый дешёвый вариант помечаем оранжевой
               чертой слева: значка «Дешевле» в длинном списке недостаточно,
               глаз цепляется за цену, а не за подпись. В кабинете строк мало
               и лишний акцент там только шумит. */
            const mark = opts.variant === 'page' && i === 0
                ? 'border-left:2px solid #FF6A00;padding-left:16px;'
                : (opts.variant === 'page' ? 'padding-left:18px;' : '');

            return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;justify-content:space-between;padding:${s.pad}px 0;border-top:1px solid var(--inner-border);${mark}">
      <div style="flex:1 1 170px;min-width:0;">
        <div style="font-size:${s.carrier}px;font-weight:700;">${esc(q.carrierName)}${best}</div>
        <div style="font-size:${s.meta}px;color:var(--text-secondary);margin-top:2px;">${esc(SERVICE[q.service] || q.service)} · ${esc(days)}${esc(endsNote)}</div>
        ${breakdown}
        ${insurance}
      </div>
      <div style="text-align:right;white-space:nowrap;">
        <div style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:${s.price}px;letter-spacing:-.5px;">${fmt(q.price.total)} ₽</div>
        <a href="${esc(q.url)}" target="_blank" rel="noopener" style="font-size:${s.link}px;color:var(--accent-blue);font-weight:600;">Оформить</a>
      </div>
    </div>`;
        }).join('');

        const route = data.from && data.to
            ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${esc(data.from.name)} → ${esc(data.to.name)}</div>`
            : '';

        /* Забор и доставка включены по умолчанию, но их можно снять: завод нередко
           сам везёт на терминал, а заказчик сам забирает. На Москве —
           Екатеринбурге это около пяти тысяч, поэтому выбор виден, а не спрятан.

           Флажки рисуются только там, где есть за что зацепиться — то есть по
           конкретному КП. На публичной странице они часть формы, и второй
           комплект был бы путаницей. */
        const doors = proposalId == null ? '' : `
    <div style="display:flex;flex-wrap:wrap;gap:14px;margin:2px 0 8px;font-size:11.5px;color:var(--text-secondary);">
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
        <input type="checkbox" ${data.doorFrom === false ? '' : 'checked'} style="width:13px;height:13px;cursor:pointer;"
               onchange="setDeliveryDoor(${proposalId}, 'from', this.checked)">
        Забор от завода
      </label>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
        <input type="checkbox" ${data.doorTo === false ? '' : 'checked'} style="width:13px;height:13px;cursor:pointer;"
               onchange="setDeliveryDoor(${proposalId}, 'to', this.checked)">
        Доставка до адреса
      </label>
    </div>`;

        /* Кого нет в списке и почему.
           «Не ответили» и «не считают этот маршрут» — разные вещи, и человеку
           важна вторая: он видел один вариант из трёх и не понимал, отказались
           остальные или их вообще не спросили. Спрашивать имеет смысл только в
           первом случае — во втором ждать нечего. */
        const missing = [];
        if (data.failed && data.failed.length) {
            missing.push(`Не ответили: ${esc(data.failed.join(', '))} — попробуйте позже`);
        }
        if (data.silent && data.silent.length) {
            missing.push(`Не считают этот маршрут: ${esc(data.silent.join(', '))} — этого пункта нет в их справочнике`);
        }
        const failed = missing.length
            ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.5;">${missing.join('<br>')}</div>`
            : '';

        return `
    <div style="max-width:${maxWidth};text-align:left;">
      ${route}
      ${doors}
      ${rows}
      ${failed}
      <div style="font-size:${s.note}px;color:var(--text-muted);margin-top:10px;line-height:1.5;border-top:1px solid var(--inner-border);padding-top:10px;">
        Цена — за перевозку с забором и доставкой. Страхование показано отдельно и в сумму
        не входит: перевозчики считают его по-разному. Ориентировочный расчёт по публичному
        тарифу, без обрешётки, негабарита и класса груза. Итог подтверждает перевозчик.
      </div>
    </div>`;
    }

    window.renderDeliveryQuotes = renderDeliveryQuotes;
})();
