'use strict';

const https = require('https');

const INN_RE = /^\d{10}$|^\d{12}$/;
const MIN_AGE_MONTHS = 6;

const HOST = 'egrul.nalog.ru';
const RESULT_ATTEMPTS = 6;
const RESULT_DELAY_MS = 700;

function request(options, body) {
    return new Promise((resolve) => {
        const req = https.request({ hostname: HOST, timeout: 8000, ...options }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        if (body) req.write(body);
        req.end();
    });
}

/** Из выдачи реестра берём действующую запись: по одному ИНН их бывает несколько
 *  (например, ИП после смены фамилии — старая прекращена, новая действует). */
function pickRegistryRow(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.find(row => !row.e) || rows[0];
}

/** Прекращение деятельности реестр отдаёт полем `e` (дата). Поле `g` — руководитель
 *  («ПРЕЗИДЕНТ...: Греф Герман Оскарович»), признаком ликвидации оно не является:
 *  прежняя проверка на `g` отклоняла любое ООО с указанным директором. */
function mapRegistryRow(row) {
    if (!row) return null;
    return {
        name: row.n,
        active: !row.e,
        regDate: row.r ? row.r.split('.').reverse().join('-') : null,
        ogrn: row.o ? String(row.o) : '',
    };
}

/**
 * Поиск в ЕГРЮЛ/ЕГРИП: POST / отдаёт токен, GET /search-result/<токен> — сами данные.
 * Прежний одношаговый /search.do ФНС убрала (404), из-за чего верификация молча
 * деградировала в ручную для всех компаний.
 */
async function fetchEgrulData(inn) {
    const form = `vyp3CaptchaToken=&page=&query=${encodeURIComponent(inn)}&region=&PreventChromeAutocomplete=`;
    const started = await request({
        path: '/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form),
            'User-Agent': 'Mozilla/5.0',
        },
    }, form);
    if (!started || started.status !== 200) return null;

    let token = null;
    try {
        const json = JSON.parse(started.body);
        if (json.captchaRequired) return null;
        token = json.t;
    } catch {
        return null;
    }
    if (!token) return null;

    // Результат готовится асинхронно: пустой rows означает «ещё не готово».
    for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, RESULT_DELAY_MS));
        const res = await request({
            path: `/search-result/${token}`,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!res || res.status !== 200) return null;
        try {
            const row = pickRegistryRow(JSON.parse(res.body).rows);
            if (row) return mapRegistryRow(row);
        } catch {
            return null;
        }
    }
    return null;
}

function companyAgeMonths(regDate) {
    if (!regDate) return null;
    const ms = Date.now() - new Date(regDate).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms / (1000 * 60 * 60 * 24 * 30.44);
}

function normalizeDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

/**
 * Автоверификация по ЕГРЮЛ (бесплатно, без платного API).
 * @returns {{ pass: boolean, manual: boolean, reason: string|null, checks: object[], egrul: object|null }}
 */
function evaluateAutoVerification(company, user, egrul) {
    const checks = [];

    if (!user?.email_verified) {
        return {
            pass: false,
            manual: false,
            reason: 'Подтвердите email перед верификацией компании',
            checks,
            egrul: null,
        };
    }

    const inn = String(company?.inn || '').trim();
    if (!INN_RE.test(inn)) {
        return {
            pass: false,
            manual: false,
            reason: 'Укажите корректный ИНН (10 или 12 цифр) в профиле компании',
            checks,
            egrul: null,
        };
    }
    checks.push({ ok: true, label: 'ИНН', detail: inn });

    const hasProfile = Boolean(String(company.city || '').trim() || String(company.specialization || '').trim());
    if (!hasProfile) {
        return {
            pass: false,
            manual: false,
            reason: 'Заполните город или специализацию в профиле',
            checks,
            egrul: null,
        };
    }

    if (!egrul) {
        return {
            pass: false,
            manual: true,
            reason: null,
            checks,
            egrul: null,
        };
    }

    if (!egrul.active) {
        return {
            pass: false,
            manual: false,
            reason: 'По данным ЕГРЮЛ компания не действует (ликвидирована или в процессе ликвидации)',
            checks,
            egrul,
        };
    }
    checks.push({ ok: true, label: 'ЕГРЮЛ', detail: 'Компания действующая' });

    const profileOgrn = normalizeDigits(company.ogrn);
    const egrulOgrn = normalizeDigits(egrul.ogrn);
    if (profileOgrn && egrulOgrn && profileOgrn !== egrulOgrn) {
        return {
            pass: false,
            manual: false,
            reason: 'ОГРН в профиле не совпадает с данными ФНС — исправьте реквизиты',
            checks,
            egrul,
        };
    }
    if (egrulOgrn) checks.push({ ok: true, label: 'ОГРН', detail: 'Совпадает с ЕГРЮЛ' });

    const ageMonths = companyAgeMonths(egrul.regDate);
    if (ageMonths != null) {
        if (ageMonths < MIN_AGE_MONTHS) {
            return {
                pass: false,
                manual: true,
                reason: `Компания моложе ${MIN_AGE_MONTHS} мес. — отправлено на ручную проверку`,
                checks,
                egrul,
            };
        }
        const years = Math.floor(ageMonths / 12);
        const detail = years >= 1 ? `${years} лет на рынке` : `${Math.floor(ageMonths)} мес. на рынке`;
        checks.push({ ok: true, label: 'Возраст', detail });
    }

    if (egrul.name) {
        checks.push({ ok: true, label: 'Реестр', detail: egrul.name.slice(0, 120) });
    }

    return { pass: true, manual: false, reason: null, checks, egrul };
}

function isAnyVerified(company) {
    return Boolean(company?.verified_by_platform || company?.verified_egrul);
}

module.exports = {
    fetchEgrulData,
    pickRegistryRow,
    mapRegistryRow,
    evaluateAutoVerification,
    isAnyVerified,
    INN_RE,
    MIN_AGE_MONTHS,
};
