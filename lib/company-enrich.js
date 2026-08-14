'use strict';

/* Обогащение карточек компаний: рейтинг, статистика, фото, «в избранном».
 *
 * Считается пачкой, а не по одной карточке. Раньше на каждую компанию уходило
 * семь запросов, а GET /api/companies отдаёт список всех компаний целиком —
 * то есть один заход в настройки, тариф или сделки поднимал больше тридцати
 * тысяч запросов к базе. Теперь их фиксированное число, пять на всю пачку,
 * независимо от её размера.
 *
 * enrichCompany оставлен обёрткой над пачкой из одной карточки: две
 * реализации одного и того же разошлись бы при первой же правке, а карточка
 * компании и список обязаны показывать одинаковые цифры.
 */

function ratingFromResolved(won, resolved) {
    if (!resolved) return null;
    const rate = won / resolved;
    let rating, ratingLabel;
    if (rate >= 0.7 && won >= 3) { rating = 'A+'; ratingLabel = 'Высокий'; }
    else if (rate >= 0.5)        { rating = 'A';  ratingLabel = 'Высокий'; }
    else if (rate >= 0.3)        { rating = 'B+'; ratingLabel = 'Средний'; }
    else if (rate >= 0.15 || won > 0) { rating = 'B'; ratingLabel = 'Средний'; }
    else                         { rating = 'C';  ratingLabel = 'Низкий'; }
    return {
        status: won > 0 ? 'Верифицирован' : 'На проверке',
        rating,
        ratingLabel,
        ratingStats: { won, resolved },
    };
}

function createCompanyEnricher({ pool, storage }) {
    async function enrichCompanies(companies, ownerCompany) {
        if (!companies.length) return [];

        const producerNames = [...new Set(companies.filter(c => c.role === 'producer').map(c => c.company))];
        const customerNames = [...new Set(companies.filter(c => c.role !== 'producer').map(c => c.company))];
        const ids = companies.map(c => c.id).filter(id => id != null);

        const empty = () => Promise.resolve({ rows: [] });

        const [proposalRows, responseRows, orderRows, favoriteRows, photoRows] = await Promise.all([
            producerNames.length ? pool.query(
                `SELECT company,
                        COUNT(*)                                                 AS total,
                        COUNT(*) FILTER (WHERE status = 'Выигран')               AS won,
                        COUNT(*) FILTER (WHERE status IN ('Выигран','Отклонен')) AS resolved,
                        AVG(days) FILTER (WHERE status = 'Выигран')              AS avg_days
                   FROM proposals
                  WHERE company = ANY($1::text[])
                  GROUP BY company`,
                [producerNames]
            ) : empty(),

            // SLA: среднее время от публикации закупки до КП этого поставщика
            // (6 месяцев, минимум 2 отклика — иначе цифра случайная).
            producerNames.length ? pool.query(
                `SELECT p.company,
                        COUNT(*) AS n,
                        AVG(EXTRACT(EPOCH FROM (p.created_at - o.created_at))) AS avg_sec
                   FROM proposals p
                   JOIN orders o ON o.id = p.order_id
                  WHERE p.company = ANY($1::text[])
                    AND p.created_at >= NOW() - INTERVAL '6 months'
                    AND p.created_at >= o.created_at
                  GROUP BY p.company`,
                [producerNames]
            ) : empty(),

            customerNames.length ? pool.query(
                `SELECT company,
                        COUNT(*)                                   AS total,
                        COUNT(*) FILTER (WHERE status = 'Закрыта') AS closed
                   FROM orders
                  WHERE company = ANY($1::text[])
                  GROUP BY company`,
                [customerNames]
            ) : empty(),

            ownerCompany && ids.length ? pool.query(
                'SELECT company_id FROM favorites WHERE owner_company = $1 AND company_id = ANY($2::int[])',
                [ownerCompany, ids]
            ) : empty(),

            ids.length ? pool.query(
                `SELECT company_id, id, stored_name, original_name
                   FROM company_photos
                  WHERE company_id = ANY($1::int[])
                  ORDER BY created_at ASC`,
                [ids]
            ) : empty(),
        ]);

        const byProposals = new Map(proposalRows.rows.map(r => [r.company, r]));
        const byResponses = new Map(responseRows.rows.map(r => [r.company, r]));
        const byOrders = new Map(orderRows.rows.map(r => [r.company, r]));
        const favorites = new Set(favoriteRows.rows.map(r => r.company_id));
        const photosByCompany = new Map();
        for (const p of photoRows.rows) {
            if (!photosByCompany.has(p.company_id)) photosByCompany.set(p.company_id, []);
            photosByCompany.get(p.company_id).push({
                id: p.id,
                storedName: p.stored_name,
                originalName: p.original_name,
                url: storage.photoPublicUrl(p.stored_name),
            });
        }

        return companies.map((c) => {
            let enriched;
            if (c.role === 'producer') {
                const agg = byProposals.get(c.company);
                const total = Number(agg?.total || 0);
                const won = Number(agg?.won || 0);
                const resolved = Number(agg?.resolved || 0);
                const rating = ratingFromResolved(won, resolved);

                let stats = null;
                if (total) {
                    const resp = byResponses.get(c.company);
                    const avgFirstResponseHours = Number(resp?.n || 0) >= 2 && resp?.avg_sec != null
                        ? Math.max(1, Math.round(Number(resp.avg_sec) / 3600))
                        : null;
                    // Долю выигранных не показываем, пока решённых меньше трёх:
                    // на двух КП это не показатель, а случайность.
                    const winRate = resolved >= 3 ? Math.round((won / resolved) * 100) : null;
                    stats = {
                        completedOrders: won,
                        avgDeliveryDays: agg?.avg_days != null ? Math.round(Number(agg.avg_days)) : null,
                        totalProposals: total,
                        avgFirstResponseHours,
                        winRate,
                    };
                }
                enriched = { ...c, ...(rating || {}), stats };
            } else {
                const agg = byOrders.get(c.company);
                const total = Number(agg?.total || 0);
                const closed = Number(agg?.closed || 0);
                enriched = {
                    ...c,
                    ...(total ? { status: closed > 0 ? 'Верифицирован' : 'На проверке' } : {}),
                    stats: total ? { postedOrders: total, closedOrders: closed } : null,
                };
            }
            enriched.isFavorite = ownerCompany ? favorites.has(c.id) : false;
            enriched.photos = photosByCompany.get(c.id) || [];
            return enriched;
        });
    }

    async function enrichCompany(c, ownerCompany) {
        const [enriched] = await enrichCompanies([c], ownerCompany);
        return enriched;
    }

    return { enrichCompany, enrichCompanies };
}

module.exports = createCompanyEnricher;
