'use strict';

const express = require('express');
const ExcelJS = require('exceljs');
const { buildOrdersPdf, buildProposalsPdf, buildCompareKpPdf } = require('../export-pdf');

function createExportRouter(deps) {
    const {
        pool,
        requireAuth,
        requireRole,
        rowToOrder,
        rowToCompany,
        computeMatchScore,
        computePriceBenchmark,
        plainTitle,
        htmlEscape,
    } = deps;

    const router = express.Router();

    router.get('/orders.xlsx', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT o.id, o.title, o.category, o.status, o.created_at, o.deadline,
                        COUNT(p.id) AS proposals,
                        MIN(p.price) FILTER (WHERE p.status='Выигран') AS won_price,
                        MIN(p.company) FILTER (WHERE p.status='Выигран') AS won_supplier
                 FROM orders o LEFT JOIN proposals p ON p.order_id=o.id
                 WHERE o.company=$1
                 GROUP BY o.id ORDER BY o.created_at DESC`,
                [req.user.company]
            );

            const wb = new ExcelJS.Workbook();
            wb.creator = 'ТехЗаказ';
            const ws = wb.addWorksheet('Закупки');
            ws.columns = [
                { header:'№',                  key:'id',           width:8  },
                { header:'Наименование',        key:'title',        width:40 },
                { header:'Категория',           key:'category',     width:22 },
                { header:'Статус',              key:'status',       width:16 },
                { header:'Дедлайн',             key:'deadline',     width:14 },
                { header:'Откликов',            key:'proposals',    width:12 },
                { header:'Цена договора, ₽',   key:'won_price',    width:18 },
                { header:'Поставщик',           key:'won_supplier', width:32 },
                { header:'Дата создания',       key:'created_at',   width:18 },
            ];
            ws.getRow(1).font  = { bold:true, color:{ argb:'FFFFFFFF' } };
            ws.getRow(1).fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1E3A5F' } };
            ws.getRow(1).alignment = { vertical:'middle' };

            rows.forEach(r => ws.addRow({
                id:           r.id,
                title:        r.title,
                category:     r.category,
                status:       r.status,
                deadline:     r.deadline || '—',
                proposals:    Number(r.proposals),
                won_price:    r.won_price ? Number(r.won_price) : '',
                won_supplier: r.won_supplier || '—',
                created_at:   new Date(r.created_at).toLocaleDateString('ru-RU'),
            }));

            ws.getColumn('won_price').numFmt = '#,##0';

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''%D0%97%D0%B0%D0%BA%D1%83%D0%BF%D0%BA%D0%B8-${Date.now()}.xlsx`);
            await wb.xlsx.write(res);
            res.end();
        } catch (e) { next(e); }
    });

    router.get('/proposals.xlsx', requireAuth, async (req, res, next) => {
        try {
            const isProducer = req.user.role === 'producer';
            const { rows } = isProducer
                ? await pool.query(
                    `SELECT p.id, o.title AS order_title, o.category, p.price, p.days,
                            p.status, p.created_at, o.company AS customer
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE p.company=$1 ORDER BY p.created_at DESC`,
                    [req.user.company]
                  )
                : await pool.query(
                    `SELECT p.id, o.title AS order_title, o.category, p.company AS supplier,
                            p.price, p.days, p.status, p.created_at
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE o.company=$1 ORDER BY p.created_at DESC`,
                    [req.user.company]
                  );

            const wb = new ExcelJS.Workbook();
            wb.creator = 'ТехЗаказ';
            const ws = wb.addWorksheet('КП');
            ws.columns = isProducer ? [
                { header:'Заявка',      key:'order_title', width:40 },
                { header:'Категория',   key:'category',    width:22 },
                { header:'Заказчик',    key:'customer',    width:30 },
                { header:'Цена, ₽',    key:'price',       width:16 },
                { header:'Срок, дн',   key:'days',        width:12 },
                { header:'Статус',      key:'status',      width:18 },
                { header:'Дата',        key:'created_at',  width:16 },
            ] : [
                { header:'Заявка',      key:'order_title', width:40 },
                { header:'Категория',   key:'category',    width:22 },
                { header:'Поставщик',   key:'supplier',    width:30 },
                { header:'Цена, ₽',    key:'price',       width:16 },
                { header:'Срок, дн',   key:'days',        width:12 },
                { header:'Статус',      key:'status',      width:18 },
                { header:'Дата',        key:'created_at',  width:16 },
            ];
            ws.getRow(1).font = { bold:true, color:{ argb:'FFFFFFFF' } };
            ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFF6A00' } };

            rows.forEach(r => ws.addRow({
                ...r,
                price:      Number(r.price),
                created_at: new Date(r.created_at).toLocaleDateString('ru-RU'),
            }));
            ws.getColumn('price').numFmt = '#,##0';

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''%D0%9A%D0%9F-${Date.now()}.xlsx`);
            await wb.xlsx.write(res);
            res.end();
        } catch (e) { next(e); }
    });

    router.get('/orders.pdf', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT o.id, o.title, o.category, o.status, o.created_at, o.deadline,
                        COUNT(p.id) AS proposals,
                        MIN(p.price) FILTER (WHERE p.status='Выигран') AS won_price,
                        MIN(p.company) FILTER (WHERE p.status='Выигран') AS won_supplier
                 FROM orders o LEFT JOIN proposals p ON p.order_id=o.id
                 WHERE o.company=$1
                 GROUP BY o.id ORDER BY o.created_at DESC`,
                [req.user.company]
            );
            buildOrdersPdf(rows, res);
        } catch (e) { next(e); }
    });

    router.get('/proposals.pdf', requireAuth, async (req, res, next) => {
        try {
            const isProducer = req.user.role === 'producer';
            const { rows } = isProducer
                ? await pool.query(
                    `SELECT p.id, o.title AS order_title, o.category, p.price, p.days,
                            p.status, p.created_at, o.company AS customer
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE p.company=$1 ORDER BY p.created_at DESC`,
                    [req.user.company]
                  )
                : await pool.query(
                    `SELECT p.id, o.title AS order_title, o.category, p.company AS supplier,
                            p.price, p.days, p.status, p.created_at
                     FROM proposals p JOIN orders o ON o.id=p.order_id
                     WHERE o.company=$1 ORDER BY p.created_at DESC`,
                    [req.user.company]
                  );
            buildProposalsPdf(rows, res, isProducer);
        } catch (e) { next(e); }
    });

    router.get('/compare-kp.pdf', requireAuth, requireRole('customer'), async (req, res, next) => {
        try {
            const orderId = Number(req.query.orderId);
            if (!orderId) return res.status(400).json({ error: 'Укажите orderId' });
            const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
            if (!order) return res.status(404).json({ error: 'Закупка не найдена' });
            if (order.company !== req.user.company) return res.status(403).json({ error: 'Нет доступа' });

            const ids = String(req.query.ids || '')
                .split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
            const { rows } = ids.length
                ? await pool.query(
                    `SELECT p.company AS supplier, p.price, p.days, p.status, p.created_at
                     FROM proposals p WHERE p.order_id = $1 AND p.id = ANY($2::int[])
                     ORDER BY p.price ASC NULLS LAST`,
                    [orderId, ids]
                  )
                : await pool.query(
                    `SELECT p.company AS supplier, p.price, p.days, p.status, p.created_at
                     FROM proposals p WHERE p.order_id = $1 ORDER BY p.price ASC NULLS LAST`,
                    [orderId]
                  );
            if (rows.length < 2) return res.status(400).json({ error: 'Нужно минимум 2 КП для сравнения' });

            const orderObj = rowToOrder(order);
            const benchmark = await computePriceBenchmark(orderObj.category, orderId);
            const { rows: producers } = await pool.query("SELECT * FROM companies WHERE role = 'producer'");
            const producerMap = new Map(producers.map(r => [r.company, rowToCompany(r)]));
            const enriched = rows.map(r => ({
                ...r,
                match_score: producerMap.has(r.supplier) ? computeMatchScore(orderObj, producerMap.get(r.supplier)) : null,
            }));

            buildCompareKpPdf(
                { orderId, orderTitle: plainTitle(order.title), benchmark },
                enriched,
                res
            );
        } catch (e) { next(e); }
    });

    router.get('/1c/:proposalId', requireAuth, async (req, res, next) => {
        try {
            const { rows: [row] } = await pool.query(`
                SELECT p.*, o.title AS order_title, o.quantity, o.description, o.deadline, o.company AS customer
                FROM proposals p
                JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1
            `, [Number(req.params.proposalId)]);

            if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
            if (row.customer !== req.user.company && req.user.role !== 'admin')
                return res.status(403).json({ error: 'Нет доступа' });

            const now     = new Date().toISOString();
            const dateStr = now.split('T')[0];
            const price   = Number(row.price) || 0;
            const qty     = Number(row.quantity) || 1;

            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация xmlns="urn:1C.ru:commerceml_2" ВерсияСхемы="2.09" ДатаФормирования="${now}">
  <Документ>
    <Ид>TZ-${row.id}</Ид>
    <Номер>${row.id}</Номер>
    <Дата>${dateStr}</Дата>
    <ХозОперация>Заказ товара</ХозОперация>
    <Роль>Покупатель</Роль>
    <Валюта>RUB</Валюта>
    <Курс>1</Курс>
    <Сумма>${price.toFixed(2)}</Сумма>
    <Комментарий>${htmlEscape(row.description || '')}</Комментарий>
    ${row.deadline ? `<СрокПоставки>${row.deadline}</СрокПоставки>` : ''}
    <Контрагенты>
      <Контрагент>
        <Наименование>${htmlEscape(row.company)}</Наименование>
        <Роль>Продавец</Роль>
      </Контрагент>
      <Контрагент>
        <Наименование>${htmlEscape(row.customer)}</Наименование>
        <Роль>Покупатель</Роль>
      </Контрагент>
    </Контрагенты>
    <Товары>
      <Товар>
        <Ид>ITEM-${row.order_id}</Ид>
        <Наименование>${htmlEscape(row.order_title)}</Наименование>
        <Количество>${qty}</Количество>
        <Цена>${(price / qty).toFixed(2)}</Цена>
        <Сумма>${price.toFixed(2)}</Сумма>
        <ЕдиницаИзмерения>шт</ЕдиницаИзмерения>
        <СтавкаНДС>Без НДС</СтавкаНДС>
      </Товар>
    </Товары>
  </Документ>
</КоммерческаяИнформация>`;

            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="order-${row.id}.xml"`);
            res.send(xml);
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createExportRouter;
