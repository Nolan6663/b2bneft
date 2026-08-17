'use strict';

const ExcelJS = require('exceljs');
const {
    DISCLAIMER, quoteRows, cargoLabel, itemLabels, totalsLabel, scopeNote, doorsLabel, routeLabel,
} = require('./quote-doc');

/* Тот же расчёт в Excel.
 *
 * PDF идёт в папку и на почту, Excel — в чужую таблицу: у снабженцев расчёт
 * доставки обычно ложится в общий лист сравнения поставщиков. Поэтому цены
 * здесь настоящие числа с денежным форматом, а не строки «18 740 ₽»: строку
 * пришлось бы чистить руками, и первое же СУММ дало бы ноль.
 */
function buildQuotesWorkbook(data) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ТехЗаказ';
    wb.created = new Date();
    const ws = wb.addWorksheet('Доставка');

    ws.columns = [
        { key: 'n', width: 5 },
        { key: 'carrier', width: 28 },
        { key: 'service', width: 12 },
        { key: 'days', width: 16 },
        { key: 'breakdown', width: 38 },
        { key: 'insurance', width: 14 },
        { key: 'total', width: 14 },
    ];

    const title = ws.addRow(['Расчёт доставки']);
    title.font = { bold: true, size: 14 };
    ws.addRow([routeLabel(data)]).font = { size: 12 };
    const items = itemLabels(data.items);
    if (items.length) {
        ws.addRow(['Груз:']);
        for (const line of items) ws.addRow([line]);
        ws.addRow([`Всего: ${totalsLabel(data.items)}`]);
    } else {
        ws.addRow([`Груз: ${cargoLabel(data.cargo)}`]);
    }
    if (data.declaredValue) ws.addRow([`Объявленная стоимость: ${data.declaredValue} ₽`]);
    ws.addRow([`Условия: ${doorsLabel(data.doorFrom, data.doorTo)}`]);
    ws.addRow([`Расчёт от ${new Date().toLocaleDateString('ru-RU')}`]);
    ws.addRow([]);

    const head = ws.addRow(['№', 'Перевозчик', 'Способ', 'Срок', 'Из чего сложилось', 'Страхование', 'Итого, ₽']);
    head.font = { bold: true };
    head.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    for (const r of quoteRows(data.quotes)) {
        const row = ws.addRow([
            r.n,
            r.carrier + (r.cheapest ? ' (дешевле)' : ''),
            r.service,
            r.days,
            r.breakdown,
            r.insurance,
            r.total,
        ]);
        // Страхование в итог не входит — как и на экране. Складывать эти две
        // колонки нельзя, и формат об этом молчит, поэтому подпись ниже.
        row.getCell(6).numFmt = '# ##0';
        row.getCell(7).numFmt = '# ##0';
        if (r.cheapest) row.font = { bold: true };
    }

    if (data.failed && data.failed.length) {
        ws.addRow([]);
        ws.addRow([`Не ответили на запрос: ${data.failed.join(', ')}`]);
    }

    ws.addRow([]);
    const scope = scopeNote(data);
    if (scope) {
        const row = ws.addRow([scope]);
        row.font = { size: 9, color: { argb: 'FF666666' } };
        ws.mergeCells(`A${row.number}:G${row.number}`);
    }
    const note = ws.addRow([DISCLAIMER]);
    note.font = { size: 9, color: { argb: 'FF666666' } };
    note.alignment = { wrapText: true, vertical: 'top' };
    ws.mergeCells(`A${note.number}:G${note.number}`);
    ws.getRow(note.number).height = 46;

    return wb;
}

module.exports = { buildQuotesWorkbook };
