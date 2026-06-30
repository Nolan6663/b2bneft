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
        if (!total) return null;
        const { rows: won } = await pool.query("SELECT days FROM proposals WHERE company = $1 AND status = 'Выигран'", [companyName]);
        const avgDeliveryDays = won.length ? Math.round(won.reduce((s, p) => s + p.days, 0) / won.length) : null;
        return { completedOrders: won.length, avgDeliveryDays, totalProposals: total };
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
