'use strict';
// Фаза C: сбор email с сайтов заводов из реестра (у которых ГИСП email не дал).
// Берёт site из registry-gisp-enrich.json, качает главную + страницы контактов,
// вытаскивает email (regex + mailto), кладёт обратно в enrich-файл с пометкой
// emailSource='site'. Госсайты не трогает — VPN не мешает, можно запускать откуда угодно.
//   node scripts/fetch-site-emails.js [--limit N]
// Чекпойнт каждые 50 сайтов, повторный запуск продолжает (пропускает уже обработанные).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ENRICH = path.join(__dirname, 'data', 'registry-gisp-enrich.json');
const CONCURRENCY = 8;
const TIMEOUT_MS = 12000;
const MAX_BODY = 600 * 1024;
const MAX_CONTACT_PAGES = 2;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10}/g;
const JUNK_RE = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$|example\.|sentry|wixpress|schema\.org|your-?email|@(sample|test|email|mail)\.(com|ru)$|^u[0-9a-f]{8,}@/i;
const GOOD_LOCAL = /^(info|mail|office|sales|zakaz|market|otdel|contact|priem|secretar|kanc|adm|reception|op|commerce|kom)/i;
const RU_FREEMAIL = /@(mail\.ru|yandex\.ru|ya\.ru|bk\.ru|inbox\.ru|list\.ru|rambler\.ru|gmail\.com)$/i;
const CONTACT_HREF = /kontakt|contact|svyaz|feedback|about|o-kompanii|o_kompanii|company/i;

function fetchPage(url, redirects) {
    redirects = redirects == null ? 4 : redirects;
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch { return resolve(null); }
        if (!/^https?:$/.test(u.protocol)) return resolve(null);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.get(u, {
            timeout: TIMEOUT_MS,
            rejectUnauthorized: false, // у заводов сплошь самоподписанные и российские CA
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9',
            },
        }, res => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, u).href; } catch { return resolve(null); }
                return resolve(fetchPage(next, redirects - 1));
            }
            if (code !== 200) { res.resume(); return resolve(null); }
            const chunks = [];
            let size = 0;
            res.on('data', d => {
                size += d.length;
                if (size > MAX_BODY) { req.destroy(); return; }
                chunks.push(d);
            });
            res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('latin1'), url: u.href }));
            res.on('error', () => resolve(chunks.length ? { html: Buffer.concat(chunks).toString('latin1'), url: u.href } : null));
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

function extractEmails(html) {
    // mailto: часто URL-кодированы
    const decoded = html.replace(/mailto:([^"'\s>]+)/gi, (m, e) => 'mailto:' + decodeURIComponent(e) + ' ');
    const found = decoded.match(EMAIL_RE) || [];
    return [...new Set(found.map(e => e.toLowerCase().replace(/^2f|^40/, '')))].filter(e => !JUNK_RE.test(e));
}

function pickBest(emails, siteHost) {
    if (!emails.length) return '';
    const host = siteHost.replace(/^www\./, '');
    const score = e => {
        const [local, dom] = e.split('@');
        let s = 0;
        if (dom === host || dom.endsWith('.' + host)) s += 100;
        if (RU_FREEMAIL.test('@' + dom)) s += 40;
        if (GOOD_LOCAL.test(local)) s += 20;
        if (dom.endsWith('.ru') || dom.endsWith('.su') || dom.endsWith('.рф')) s += 10;
        return s;
    };
    const best = emails.map(e => ({ e, s: score(e) })).sort((a, b) => b.s - a.s)[0];
    return best.s > 0 ? best.e : ''; // совсем чужие домены без признаков — не берём
}

function findContactLinks(html, baseUrl) {
    const links = new Set();
    const re = /href=["']([^"'#]+)["']/gi;
    let m;
    while ((m = re.exec(html)) && links.size < 30) {
        if (CONTACT_HREF.test(m[1]) && !/\.(pdf|jpg|png|zip|doc)/i.test(m[1])) {
            try { links.add(new URL(m[1], baseUrl).href); } catch {}
        }
    }
    return [...links].filter(l => { try { return new URL(l).host === new URL(baseUrl).host; } catch { return false; } }).slice(0, MAX_CONTACT_PAGES);
}

async function processSite(site) {
    let url = site.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let page = await fetchPage(url);
    if (!page && url.startsWith('https://')) page = await fetchPage(url.replace('https://', 'http://'));
    if (!page) return { email: '', status: 'unreachable' };
    let host;
    try { host = new URL(page.url).host; } catch { host = ''; }
    let emails = extractEmails(page.html);
    let best = pickBest(emails, host);
    if (!best) {
        for (const link of findContactLinks(page.html, page.url)) {
            const cp = await fetchPage(link);
            if (!cp) continue;
            emails = extractEmails(cp.html);
            best = pickBest(emails, host);
            if (best) break;
        }
    }
    return { email: best, status: best ? 'ok' : 'no-email' };
}

(async () => {
    const limitIdx = process.argv.indexOf('--limit');
    const limit = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
    const state = JSON.parse(fs.readFileSync(ENRICH, 'utf8'));
    if (!state.siteEmails) state.siteEmails = {}; // inn -> { email, status }
    const save = () => fs.writeFileSync(ENRICH, JSON.stringify(state));

    const targets = Object.entries(state.contacts)
        .filter(([inn, c]) => c.site && !c.email && !(inn in state.siteEmails))
        .slice(0, limit);
    console.log(`Сайтов к обходу: ${targets.length}`);

    let done = 0, found = 0, dead = 0;
    const queue = [...targets];
    async function worker() {
        while (queue.length) {
            const [inn, c] = queue.shift();
            let r;
            try { r = await processSite(c.site); } catch (e) { r = { email: '', status: 'error' }; }
            state.siteEmails[inn] = r;
            if (r.email) { state.contacts[inn].email = r.email; state.contacts[inn].emailSource = 'site'; found++; }
            if (r.status === 'unreachable') dead++;
            done++;
            if (done % 50 === 0) { save(); console.log(`  ${done}/${targets.length} · email: ${found} · недоступно: ${dead}`); }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    save();
    console.log(`Готово: обработано ${done}, найдено email: ${found}, сайтов недоступно: ${dead}`);
    const total = Object.values(state.contacts).filter(x => x.email).length;
    console.log(`Всего контактов с email теперь: ${total}`);
    console.log('Дальше: node scripts/import-enrich.js --dry-run (и реальный запуск на VPS)');
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
