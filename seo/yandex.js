'use strict';

const TOKEN   = process.env.YANDEX_WEBMASTER_TOKEN;
const HOST_ID = process.env.YANDEX_WEBMASTER_HOST_ID;
const BASE    = 'https://api.webmaster.yandex.net/v4';

const enabled = !!(TOKEN && HOST_ID);

let _userId = null;

async function _getUserId() {
    if (_userId) return _userId;
    const res = await fetch(`${BASE}/user/`, {
        headers: { Authorization: `OAuth ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`[seo/yandex] user lookup HTTP ${res.status}`);
    const data = await res.json();
    _userId = data.user_id;
    return _userId;
}

async function fetchQueries(startDate, endDate) {
    if (!enabled) return [];
    const uid = await _getUserId();
    const all = [];
    const LIMIT = 500;
    let offset = 0;

    while (true) {
        const url = new URL(`${BASE}/user/${uid}/hosts/${HOST_ID}/search-queries/all-history`);
        url.searchParams.set('date_from', startDate);
        url.searchParams.set('date_to', endDate);
        url.searchParams.set('limit', String(LIMIT));
        url.searchParams.set('offset', String(offset));

        const res = await fetch(url.toString(), {
            headers: { Authorization: `OAuth ${TOKEN}` },
        });
        if (!res.ok) throw new Error(`[seo/yandex] queries HTTP ${res.status}`);

        const data = await res.json();
        const batch = data.queries || [];
        all.push(...batch);
        if (batch.length < LIMIT) break;
        offset += LIMIT;
    }

    return all.map(q => ({
        source: 'yandex',
        date: new Date().toISOString().slice(0, 10),
        query: q.query_text,
        page: HOST_ID,
        impressions: q.indicators?.IMPRESSIONS ?? 0,
        clicks: q.indicators?.CLICKS ?? 0,
        ctr: parseFloat((q.indicators?.CTR ?? 0).toFixed(4)),
        position: parseFloat((q.indicators?.POSITION ?? 0).toFixed(2)),
    }));
}

module.exports = { enabled, fetchQueries };
