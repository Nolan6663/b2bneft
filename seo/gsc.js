'use strict';

let googleLib;
try { googleLib = require('googleapis').google; } catch { googleLib = null; }

const SA_JSON  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SITE_URL = process.env.GOOGLE_SITE_URL;

const enabled = !!(googleLib && SA_JSON && SITE_URL);

let _auth = null;
if (enabled) {
    try {
        const credentials = JSON.parse(SA_JSON);
        _auth = new googleLib.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        });
    } catch (e) {
        console.error('[seo/gsc] Failed to init auth:', e.message);
    }
}

async function fetchSearchAnalytics(startDate, endDate) {
    if (!enabled || !_auth) return [];
    const sc = googleLib.searchconsole({ version: 'v1', auth: _auth });
    const rows = [];
    const ROW_LIMIT = 25000;
    let startRow = 0;

    while (true) {
        const res = await sc.searchanalytics.query({
            siteUrl: SITE_URL,
            requestBody: {
                startDate,
                endDate,
                dimensions: ['query', 'page'],
                rowLimit: ROW_LIMIT,
                startRow,
            },
        });
        const batch = res.data.rows || [];
        rows.push(...batch);
        if (batch.length < ROW_LIMIT) break;
        startRow += ROW_LIMIT;
    }

    return rows.map(r => ({
        source: 'google',
        date: new Date().toISOString().slice(0, 10),
        query: r.keys[0],
        page: r.keys[1],
        impressions: Math.round(r.impressions || 0),
        clicks: Math.round(r.clicks || 0),
        ctr: parseFloat((r.ctr || 0).toFixed(4)),
        position: parseFloat((r.position || 0).toFixed(2)),
    }));
}

module.exports = { enabled, fetchSearchAnalytics };
