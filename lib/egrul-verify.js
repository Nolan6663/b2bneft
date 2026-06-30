'use strict';

const https = require('https');

const INN_RE = /^\d{10}$|^\d{12}$/;
const MIN_AGE_MONTHS = 6;

function fetchEgrulData(inn) {
    return new Promise((resolve) => {
        const body = `query=${encodeURIComponent(inn)}&page=1&cnt=&vpagesz=10`;
        const options = {
            hostname: 'egrul.nalog.ru',
            path: '/search.do',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 8000,
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const row = (json.rows || [])[0];
                    if (!row) return resolve(null);
                    const isLiquidated = !!(row.e || (row.g && row.g !== ''));
                    const regDate = row.r ? row.r.split('.').reverse().join('-') : null;
                    resolve({
                        name: row.n,
                        active: !isLiquidated,
                        regDate,
                        ogrn: row.o ? String(row.o) : '',
                    });
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
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
    evaluateAutoVerification,
    isAnyVerified,
    INN_RE,
    MIN_AGE_MONTHS,
};
