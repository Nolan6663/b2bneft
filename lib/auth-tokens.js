'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-development';

if (IS_PRODUCTION && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production');
}
const ACCESS_COOKIE = 'b2b_access';
const REFRESH_COOKIE = 'b2b_refresh';

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function getAccessToken(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[ACCESS_COOKIE]) return cookies[ACCESS_COOKIE];
    const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
}

function getRefreshToken(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[REFRESH_COOKIE]) return cookies[REFRESH_COOKIE];
    return req.body?.refreshToken || null;
}

function setAuthCookies(res, accessToken, refreshToken) {
    const base = { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/' };
    res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: 60 * 60 * 1000 });
    res.cookie(REFRESH_COOKIE, refreshToken, { ...base, maxAge: 30 * 24 * 60 * 60 * 1000 });
}

function clearAuthCookies(res) {
    const base = { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/' };
    res.clearCookie(ACCESS_COOKIE, base);
    res.clearCookie(REFRESH_COOKIE, base);
}

function generateTokens(user) {
    const payload = { userId: user.id, role: user.role, company: user.company };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = crypto.randomBytes(48).toString('hex');
    return { accessToken, refreshToken };
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(input, stored) {
    if (!stored || !stored.includes(':')) return input === stored;
    const [salt, hash] = stored.split(':');
    try {
        const derived = crypto.scryptSync(input, salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
    } catch { return false; }
}

module.exports = {
    IS_PRODUCTION,
    JWT_SECRET,
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    parseCookies,
    getAccessToken,
    getRefreshToken,
    setAuthCookies,
    clearAuthCookies,
    generateTokens,
    hashPassword,
    verifyPassword,
};
