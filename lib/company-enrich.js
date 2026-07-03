'use strict';

function createCompanyEnricher({ pool, storage }) {
    async function computeProducerRating(companyName) {
        const { rows: resolved } = await pool.query(
            "SELECT status FROM proposals WHERE company = $1 AND status IN ('Выигран', 'Отклонен')",
            [companyName]
        );
        if (!resolved.length) return null;
        const won = resolved.filter(p => p.status === 'Выигран').length;
        const rate = won / resolved.length;
        let rating, ratingLabel;
        if (rate >= 0.7 && won >= 3) { rating = 'A+'; ratingLabel = 'Высокий'; }
        else if (rate >= 0.5)        { rating = 'A';  ratingLabel = 'Высокий'; }
        else if (rate >= 0.3)        { rating = 'B+'; ratingLabel = 'Средний'; }
        else if (rate >= 0.15 || won > 0) { rating = 'B'; ratingLabel = 'Средний'; }
        else                         { rating = 'C';  ratingLabel = 'Низкий'; }
        return { status: won > 0 ? 'Верифицирован' : 'На проверке', rating, ratingLabel, ratingStats: { won, resolved: resolved.length } };
    }

    async function computeCustomerStatus(companyName) {
        const { rows: [{ n: total }] } = await pool.query('SELECT COUNT(*) AS n FROM orders WHERE company = $1', [companyName]);
        if (!total) return null;
        const { rows: [{ n: closed }] } = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE company = $1 AND status = 'Закрыта'", [companyName]);
        return { status: closed > 0 ? 'Верифицирован' : 'На проверке' };
    }

    async function computeProducerStats(companyName) {
        const { rows: [{ n: total }] } = await pool.query('SELECT COUNT(*) AS n FROM proposals WHERE company = $1', [companyName]);
        if (!Number(total)) return null;
        const { rows: won } = await pool.query("SELECT days FROM proposals WHERE company = $1 AND status = 'Выигран'", [companyName]);
        const avgDeliveryDays = won.length ? Math.round(won.reduce((s, p) => s + p.days, 0) / won.length) : null;

        // SLA: среднее время от публикации закупки до КП этого поставщика (6 мес, минимум 2 отклика)
        const { rows: [resp] } = await pool.query(
            `SELECT COUNT(*) AS n,
                    AVG(EXTRACT(EPOCH FROM (p.created_at - o.created_at))) AS avg_sec
             FROM proposals p
             JOIN orders o ON o.id = p.order_id
             WHERE p.company = $1
               AND p.created_at >= NOW() - INTERVAL '6 months'
               AND p.created_at >= o.created_at`,
            [companyName]
        );
        const avgFirstResponseHours = Number(resp.n) >= 2 && resp.avg_sec != null
            ? Math.max(1, Math.round(Number(resp.avg_sec) / 3600))
            : null;

        // Доля выигранных среди решённых КП (минимум 3 решённых — иначе не показываем)
        const { rows: [wr] } = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE status = 'Выигран')                 AS won,
                    COUNT(*) FILTER (WHERE status IN ('Выигран', 'Отклонен')) AS resolved
             FROM proposals WHERE company = $1`,
            [companyName]
        );
        const winRate = Number(wr.resolved) >= 3
            ? Math.round(Number(wr.won) / Number(wr.resolved) * 100)
            : null;

        return { completedOrders: won.length, avgDeliveryDays, totalProposals: Number(total), avgFirstResponseHours, winRate };
    }

    async function computeCustomerStats(companyName) {
        const { rows } = await pool.query('SELECT status FROM orders WHERE company = $1', [companyName]);
        if (!rows.length) return null;
        return { postedOrders: rows.length, closedOrders: rows.filter(o => o.status === 'Закрыта').length };
    }

    async function enrichCompany(c, ownerCompany) {
        let enriched;
        if (c.role === 'producer') {
            const rating = await computeProducerRating(c.company);
            enriched = { ...c, ...(rating || {}), stats: await computeProducerStats(c.company) };
        } else {
            const status = await computeCustomerStatus(c.company);
            enriched = { ...c, ...(status || {}), stats: await computeCustomerStats(c.company) };
        }
        if (ownerCompany) {
            const { rows: [fav] } = await pool.query('SELECT 1 FROM favorites WHERE owner_company = $1 AND company_id = $2', [ownerCompany, c.id]);
            enriched.isFavorite = Boolean(fav);
        } else {
            enriched.isFavorite = false;
        }
        const { rows: photos } = await pool.query('SELECT id, stored_name, original_name FROM company_photos WHERE company_id = $1 ORDER BY created_at ASC', [c.id]);
        enriched.photos = photos.map(p => ({
            id: p.id,
            storedName: p.stored_name,
            originalName: p.original_name,
            url: storage.photoPublicUrl(p.stored_name),
        }));
        return enriched;
    }

    return { enrichCompany };
}

module.exports = createCompanyEnricher;
