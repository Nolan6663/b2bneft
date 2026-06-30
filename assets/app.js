/* build: 2026-06-29-page-loader */

// View Transitions (navigation: auto): fast clicks cancel the transition — harmless AbortError
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason?.name === 'AbortError' && /transition/i.test(String(reason.message || ''))) {
    event.preventDefault();
  }
});

const SIDEBAR_SCROLL_KEY = 'tzSidebarScroll';

const SERVER_URL = (
  window.location.protocol === 'file:' ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
)
  ? 'http://localhost:5000/api'
  : (window.location.origin + '/api');

function shouldUseMockData() {
  return (
    window.location.protocol === 'file:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    localStorage.getItem('allowMockData') === '1'
  );
}

function showDataLoadError(message = 'Не удалось загрузить данные. Обновите страницу или попробуйте позже.') {
  if (typeof showToast === 'function') showToast(message, 'error');
  else console.error(message);
}

/* ---------------------------------------------------------------------
   Светлая / тёмная тема
   --------------------------------------------------------------------- */
function applyStoredTheme() {
  const isDark = localStorage.getItem('theme') === 'dark';
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  syncThemeUI(isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }
  syncThemeUI(!isDark);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { isDark: !isDark } }));
}

const _MOON_SVG = '<path d="M21 13A8.5 8.5 0 1 1 11 3a6.5 6.5 0 0 0 10 10z"/>';
const _SUN_SVG  = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';

function syncThemeUI(isDark) {
  const checkbox = document.getElementById('themeCheckbox');
  if (checkbox) checkbox.checked = isDark;
  const label = document.getElementById('themeLabel');
  if (label) label.innerText = isDark ? 'Тёмная тема' : 'Светлая тема';
  const icon = document.getElementById('themeIcon');
  if (icon) icon.innerHTML = isDark ? _SUN_SVG : _MOON_SVG;
}

function initSidebarRole() {
  const role = localStorage.getItem('userRole');
  const mainLink = document.getElementById('mainCabinetLink');
  if (mainLink) mainLink.href = role === 'producer' ? 'producer.html' : 'index.html';
  const navProposals = document.getElementById('navProposals');
  if (navProposals) navProposals.style.display = role === 'producer' ? '' : 'none';
  const companyId = localStorage.getItem('_myCompanyId');
  if (companyId) {
    const spl = document.getElementById('sidebarProfileLink');
    if (spl) spl.href = `company-profile.html?id=${companyId}`;
  }
}

async function initSidebarProfileLink() {
  const role = localStorage.getItem('userRole');
  if (role !== 'customer' && role !== 'producer') return;
  const spl = document.getElementById('sidebarProfileLink');
  if (!spl) return;

  const cachedId = localStorage.getItem('_myCompanyId');
  if (cachedId) {
    spl.href = `company-profile.html?id=${cachedId}`;
    return;
  }
  if (!hasSession()) return;

  try {
    const r = await apiFetch(`${SERVER_URL}/auth/me`);
    if (!r.ok) return;
    const me = await r.json();
    if (me.companyId) {
      localStorage.setItem('_myCompanyId', String(me.companyId));
      spl.href = `company-profile.html?id=${me.companyId}`;
    }
  } catch { /* ссылка останется # до следующей загрузки */ }
}

document.addEventListener('DOMContentLoaded', () => {
  applyStoredTheme();
  initPageTransitionLoader();
  initSidebarRole();
  initSidebarExtra();
  initSidebarScrollPersist();
  initSidebarPrefetch();
  initHeaderRight();
  if (hasSession()) {
    showEmailVerificationBanner();
    initNotifications();
    initSidebarBadges();
    initSidebarProfileLink();
    initOnboarding();
  }
  if (hasSession() && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/assets/sw.js').catch(e =>
      console.warn('[SW] registration failed:', e.message)
    );
  }
  /* SPA отключён — полная перезагрузка страницы; иначе ломались стили, скрипты и адаптив */
});

/* View Transitions AbortError — штатно при быстрой навигации, не логировать */
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof DOMException && e.reason.name === 'AbortError') {
    e.preventDefault();
  }
});

/* ---------------------------------------------------------------------
   Универсальное закрытие модалок: клик по фону или Escape
   --------------------------------------------------------------------- */
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal')) {
    e.target.style.display = 'none';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal').forEach(m => {
      if (getComputedStyle(m).display !== 'none') m.style.display = 'none';
    });
  }
});

/* ---------------------------------------------------------------------
   Auth session (httpOnly cookies) / logout
   --------------------------------------------------------------------- */
function applyAuthSession(data) {
  localStorage.setItem('isLoggedIn', '1');
  localStorage.setItem('userRole', data.role || '');
  localStorage.setItem('userCompany', data.company || '');
  if (data.emailVerified != null) {
    localStorage.setItem('emailVerified', data.emailVerified ? '1' : '0');
  }
  localStorage.removeItem('authToken');
  localStorage.removeItem('refreshToken');
}

function hasSession() {
  return localStorage.getItem('isLoggedIn') === '1';
}

function clearAuthSession() {
  const theme = localStorage.getItem('theme');
  localStorage.removeItem('isLoggedIn');
  localStorage.removeItem('authToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('userRole');
  localStorage.removeItem('userCompany');
  localStorage.removeItem('emailVerified');
  localStorage.removeItem('_myCompanyId');
  if (theme) localStorage.setItem('theme', theme);
}

function authGuard(requiredRole) {
  const role = localStorage.getItem('userRole');
  const company = localStorage.getItem('userCompany');
  if (!hasSession()) {
    if (!requiredRole) return { role, company, isGuest: true, emailVerified: false };
    window.location.href = 'login.html';
    return null;
  }
  if (requiredRole && role !== requiredRole) {
    window.location.href = 'login.html';
    return null;
  }
  return {
    role,
    company,
    isGuest: false,
    emailVerified: localStorage.getItem('emailVerified') === '1',
  };
}

async function logout() {
  try {
    await fetch(`${SERVER_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch { /* тихо */ }
  clearAuthSession();
  window.location.href = 'login.html';
}

async function apiFetch(url, options = {}) {
  options.credentials = 'include';
  if (!options.headers) options.headers = {};

  let response = await fetch(url, options);

  if (response.status === 401) {
    try {
      const refreshRes = await fetch(`${SERVER_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (refreshRes.ok) {
        const data = await refreshRes.json().catch(() => ({}));
        if (data.emailVerified != null) {
          localStorage.setItem('emailVerified', data.emailVerified ? '1' : '0');
        }
        response = await fetch(url, options);
      } else {
        clearAuthSession();
        window.location.href = 'login.html';
      }
    } catch {
      clearAuthSession();
      window.location.href = 'login.html';
    }
  }

  return response;
}

async function resendVerificationEmail() {
  const r = await apiFetch(`${SERVER_URL}/auth/resend-verification`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (r.ok) showToast(data.message || 'Письмо отправлено');
  else showToast(data.error || 'Не удалось отправить письмо', 'error');
  return r.ok;
}

function showEmailVerificationBanner() {
  if (localStorage.getItem('emailVerified') === '1') return;
  if (document.getElementById('emailVerifyBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'emailVerifyBanner';
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999;background:rgba(245,158,11,.95);border-top:1px solid rgba(245,158,11,.5);padding:10px 20px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;color:#7c4a00;';
  bar.innerHTML = '<span>Подтвердите email, чтобы размещать заявки и откликаться на закупки.</span>'
    + '<button type="button" class="btn-secondary" style="font-size:12px;padding:6px 12px;">Отправить письмо повторно</button>';
  bar.querySelector('button').addEventListener('click', resendVerificationEmail);
  document.body.prepend(bar);
}

/* ---------------------------------------------------------------------
   Custom select dropdown
   --------------------------------------------------------------------- */
function initCustomSelect(wrapperId, hiddenInputId, callback) {
  const wrapper = document.getElementById(wrapperId);
  const hiddenInput = document.getElementById(hiddenInputId);
  if (!wrapper || !hiddenInput) return;
  const trigger = wrapper.querySelector('.custom-select-trigger');
  const options = wrapper.querySelectorAll('.custom-option');

  trigger.addEventListener('click', (e) => { e.stopPropagation(); wrapper.classList.toggle('open'); });

  options.forEach(option => {
    option.addEventListener('click', function () {
      options.forEach(opt => opt.classList.remove('selected'));
      this.classList.add('selected');
      hiddenInput.value = this.getAttribute('data-value');
      const span = trigger.querySelector('span');
      if (span) span.textContent = this.textContent;
      wrapper.classList.remove('open');
      if (callback) callback(hiddenInput.value);
    });
  });
}

document.addEventListener('click', () => {
  document.querySelectorAll('.custom-select').forEach(el => el.classList.remove('open'));
});

/* ---------------------------------------------------------------------
   CSV-экспорт
   --------------------------------------------------------------------- */
function exportToCSV(filename, headers, rows) {
  const BOM = '﻿';
  const escape = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [headers, ...rows].map(row => row.map(escape).join(';')).join('\n');
  const blob = new Blob([BOM + lines], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

/* ---------------------------------------------------------------------
   Защита от XSS при вставке пользовательского текста в innerHTML
   --------------------------------------------------------------------- */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str == null ? '' : String(str);
  return div.innerHTML;
}

/* Inline SVG icons (Feather-style, matches nav icons) */
const _UI_ICON_PATHS = {
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  coin: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  puzzle: '<path d="M12 2a2 2 0 0 1 2 2v1h1a3 3 0 0 1 3 3v1h1a2 2 0 0 1 0 4h-1v1a3 3 0 0 1-3 3h-1v1a2 2 0 0 1-4 0v-1H9a3 3 0 0 1-3-3v-1H5a2 2 0 0 1 0-4h1V8a3 3 0 0 1 3-3h1V4a2 2 0 0 1 2-2z"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  truck: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  square: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
};

function uiIcon(name, size = 16, className = '') {
  const paths = _UI_ICON_PATHS[name];
  if (!paths) return '';
  const cls = 'ui-icon' + (className ? ' ' + className : '');
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function uiIconLabel(iconName, text, iconSize = 14) {
  return `<span class="ui-icon-label">${uiIcon(iconName, iconSize)}<span>${escapeHtml(text)}</span></span>`;
}

function setAuctionBtnLabel(btn, text) {
  if (!btn) return;
  btn.innerHTML = uiIconLabel('zap', text, 14);
}

function kpFileLinkHtml(url, label = 'Файл КП') {
  return `<a href="${url}" target="_blank" class="kp-file-link" style="color:var(--accent-bright);font-size:11px;text-decoration:underline;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;">${uiIcon('paperclip', 12)}${escapeHtml(label)}</a>`;
}

/* ── Empty state helper ─────────────────────────────────────────────── */
function createEmptyState({ icon, title, desc, ctaText, ctaAction, ctaHref }) {
  const el = document.createElement('div');
  el.className = 'empty-state';
  const ctaEl = ctaText
    ? ctaHref
      ? `<a href="${ctaHref}" class="empty-state-cta">${ctaText}</a>`
      : `<button class="empty-state-cta" onclick="${ctaAction}">${ctaText}</button>`
    : '';
  el.innerHTML = `
    <div class="empty-state-icon">${icon}</div>
    <div class="empty-state-title">${title}</div>
    ${desc ? `<p class="empty-state-desc">${desc}</p>` : ''}
    ${ctaEl}`;
  return el;
}

/* ── Skeleton helpers ────────────────────────────────────────────────── */
function showProcSkeleton(container, rows = 4) {
  container.innerHTML = '';
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('div');
    row.className = 'skel-row proc-grid-cols';
    row.innerHTML = Array(6).fill(null).map((_, j) => {
      const w = [60, 40, 30, 15, 30, 20][j];
      return `<div class="skel-cell skel-pulse" style="width:${w}%;max-width:${w}%;opacity:${1 - i * 0.15}"></div>`;
    }).join('');
    container.appendChild(row);
  }
}
function hideSkeleton(container) {
  container.querySelectorAll('.skel-row').forEach(r => r.remove());
}

/* ---------------------------------------------------------------------
   Форматирование дедлайна — поддерживает оба формата хранения:
   старый DD.MM.YYYY и новый YYYY-MM-DD (ISO date input)
   --------------------------------------------------------------------- */
function formatDeadline(str) {
  if (!str) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-');
    return `${d}.${m}.${y}`;
  }
  return str;
}

/* Конвертирует DD.MM.YYYY или YYYY-MM-DD в значение для <input type="date"> */
function deadlineToInputValue(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parts = str.split('.');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return '';
}

/* ---------------------------------------------------------------------
   Toast-уведомления (всплывающие карточки в углу экрана)
   --------------------------------------------------------------------- */
function showToast(text, type, opts = {}) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  for (const el of container.querySelectorAll('.toast-text')) {
    if (el.textContent === text) return;
  }
  const icons = { error: 'close', warn: 'warn', success: 'check', info: 'info' };
  const icon = uiIcon(icons[type] || 'info', 15);
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' toast-' + type : '');
  const actionHtml = opts.action
    ? `<button class="toast-action">${escapeHtml(opts.action.label)}</button>`
    : '';
  toast.innerHTML = `<div class="toast-icon">${icon}</div><div class="toast-text">${escapeHtml(text)}</div>${actionHtml}<button class="toast-close" aria-label="Закрыть">${uiIcon('close', 14)}</button>`;
  const dismiss = () => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 220);
  };
  if (opts.action) {
    toast.querySelector('.toast-action').onclick = () => { opts.action.onClick(); dismiss(); };
  }
  toast.querySelector('.toast-close').onclick = dismiss;
  container.appendChild(toast);
  setTimeout(dismiss, opts.duration || 5000);
}

/* ---------------------------------------------------------------------
   Живые обновления через Socket.IO — чат и уведомления приходят мгновенно,
   без ожидания следующего тика поллинга. Поллинг ниже остаётся как
   подстраховка (если соединение оборвалось/не успело переподключиться).
   --------------------------------------------------------------------- */
const currentCompanyName = localStorage.getItem('userCompany') || 'Гость';
let socket = null;
let socketConnectWarned = false;
let sidebarBadgePoll = null;

if (typeof io === 'function' && hasSession()) {
  try {
    socket = io(SERVER_URL.replace(/\/api$/, ''), {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    window.socket = socket;

    socket.on('connect', () => {
      if (currentCompanyName !== 'Гость') socket.emit('join-company', currentCompanyName);
      if (activeChatOrderId != null) socket.emit('join-chat', { orderId: activeChatOrderId, company: activeChatCompany });
      document.dispatchEvent(new CustomEvent('tz:socket:connect'));
    });

    socket.on('disconnect', () => {
      document.dispatchEvent(new CustomEvent('tz:socket:disconnect'));
    });

    socket.on('connect_error', (err) => {
      if (!socketConnectWarned) {
        socketConnectWarned = true;
        console.warn('[socket] connect error:', err.message);
      }
    });

    socket.on('notification', (entry) => {
      if (entry.company !== currentCompanyName) return;
      showToast(entry.text);
      refreshNotificationBadge();
    });

    socket.on('dashboard:refresh', () => {
      refreshNotificationBadge();
      initSidebarBadges();
    });

    socket.on('order:new', (detail) => {
      showToast(`Новая закупка: «${detail.title || 'заявка'}»`, 'success');
      document.dispatchEvent(new CustomEvent('tz:order:new', { detail }));
    });

    socket.on('proposal:new', (detail) => {
      showToast(`Новый отклик на «${detail.orderTitle || 'закупку'}»`, 'success');
      document.dispatchEvent(new CustomEvent('tz:proposal:new', { detail }));
    });

    socket.on('deal:status', (detail) => {
      const title = detail?.orderTitle || 'сделке';
      const stage = detail?.stage || 'обновлён';
      showToast(`Статус сделки «${title}»: ${stage}`, 'info');
      document.dispatchEvent(new CustomEvent('tz:deal:status', { detail }));
      refreshNotificationBadge();
      initSidebarBadges();
    });

    socket.on('conversation:update', (detail) => {
      document.dispatchEvent(new CustomEvent('tz:conversation:update', { detail }));
      if (activeChatOrderId != null
          && Number(detail?.orderId) === Number(activeChatOrderId)
          && detail?.company === activeChatCompany) {
        renderChatHistory();
      }
    });

    socket.on('message', (msg) => {
      document.dispatchEvent(new CustomEvent('tz:message', { detail: msg }));
      const onMessagesPage = /messages\.html/i.test(window.location.pathname);
      const inActiveChat = activeChatOrderId != null
          && Number(msg.orderId) === Number(activeChatOrderId)
          && msg.company === activeChatCompany;
      if (!onMessagesPage && !inActiveChat && msg.sender !== currentCompanyName) {
        const preview = (msg.text || '').slice(0, 60);
        showToast(`Новое сообщение от ${msg.sender || 'контрагента'}${preview ? ': ' + preview : ''}`, 'info', {
          action: {
            label: 'Открыть',
            onClick: () => {
              window.location.href = `messages.html?orderId=${msg.orderId}&company=${encodeURIComponent(msg.company || '')}`;
            },
          },
        });
      }
      if (activeChatOrderId != null
          && Number(msg.orderId) === Number(activeChatOrderId)
          && msg.company === activeChatCompany) {
        renderChatHistory();
      }
    });
  } catch { /* socket.io недоступен — поллинг */ }
}

if (hasSession()) {
  if (sidebarBadgePoll) clearInterval(sidebarBadgePoll);
  sidebarBadgePoll = setInterval(initSidebarBadges, 20000);
}

/* ---------------------------------------------------------------------
   Центр уведомлений — дропдаун под колокольчиком
   --------------------------------------------------------------------- */
let notifPollInterval = null;
let notifDropdown = null;

function initNotifications() {
  if (currentCompanyName === 'Гость') return;
  refreshNotificationBadge();
  if (notifPollInterval) clearInterval(notifPollInterval);
  notifPollInterval = setInterval(refreshNotificationBadge, 12000);
}

async function refreshNotificationBadge() {
  const badgeEl = document.getElementById('bellBadge');
  if (!badgeEl) return;
  if (!hasSession()) return;
  try {
    const response = await apiFetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`);
    const list = await response.json();
    const unreadCount = list.filter(n => !n.read).length;
    badgeEl.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    if (unreadCount > 0) badgeEl.innerText = unreadCount;
  } catch { /* тихо */ }
}

function _getOrCreateDropdown() {
  if (notifDropdown) return notifDropdown;
  notifDropdown = document.createElement('div');
  notifDropdown.className = 'notif-dropdown';
  notifDropdown.innerHTML = `
    <div class="notif-dropdown-header">
      <span class="notif-dropdown-title">Уведомления</span>
      <button class="notif-clear-btn" onclick="clearNotifications()">Очистить всё</button>
    </div>
    <div class="notif-list" id="notifList"></div>`;
  document.body.appendChild(notifDropdown);
  return notifDropdown;
}

function _positionDropdown(dropdown) {
  const btn = document.querySelector('.bell-btn:not(.hdr-search-btn)');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  dropdown.style.top   = (rect.bottom + 8) + 'px';
  dropdown.style.right = (window.innerWidth - rect.right) + 'px';
}

async function openNotificationsModal() {
  const dropdown = _getOrCreateDropdown();

  if (dropdown.classList.contains('open')) {
    dropdown.classList.remove('open');
    return;
  }

  _positionDropdown(dropdown);
  dropdown.classList.add('open');

  const listEl = document.getElementById('notifList');
  listEl.innerHTML = '<div class="notif-empty">Загрузка...</div>';

  try {
    const response = await apiFetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`);
    const items = await response.json();

    if (items.length === 0) {
      listEl.innerHTML = `<div class="notif-empty"><div class="notif-empty-icon">${uiIcon('bell', 28)}</div>Уведомлений пока нет</div>`;
      return;
    }

    listEl.innerHTML = '';
    items.forEach(n => {
      const el = document.createElement('div');
      el.className = 'notif-item' + (n.read ? '' : ' unread');
      const time = new Date(n.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `
        <div class="notif-dot"></div>
        <div>
          <div class="notif-item-text">${escapeHtml(n.text)}</div>
          <div class="notif-item-time">${time}</div>
        </div>`;
      listEl.appendChild(el);
    });

    await apiFetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}/read`, { method: 'POST' });
    refreshNotificationBadge();
  } catch {
    listEl.innerHTML = '<div class="notif-empty">Не удалось загрузить уведомления</div>';
  }
}

function closeNotificationsModal() {
  if (notifDropdown) notifDropdown.classList.remove('open');
}

async function clearNotifications() {
  try {
    await apiFetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, { method: 'DELETE' });
  } catch { /* ignore */ }
  if (notifDropdown) notifDropdown.classList.remove('open');
  openNotificationsModal();
}

document.addEventListener('click', (e) => {
  if (!notifDropdown || !notifDropdown.classList.contains('open')) return;
  const btn = document.querySelector('.bell-btn:not(.hdr-search-btn)');
  if (btn && btn.contains(e.target)) return;
  if (!notifDropdown.contains(e.target)) notifDropdown.classList.remove('open');
});

/* ---------------------------------------------------------------------
   Чат по закупке — сообщения хранятся на сервере (тред = orderId + company
   производителя), обновляется поллингом, пока модалка открыта.
   --------------------------------------------------------------------- */
let activeChatOrderId = null;
let activeChatCompany = null;
let chatPollInterval = null;

function openGlobalChat(orderId, orderTitle, company) {
  activeChatOrderId = orderId;
  activeChatCompany = company;

  const titleEl = document.getElementById('chatModalTitle');
  if (titleEl) titleEl.innerText = orderTitle || 'Обсуждение закупки';

  const companyEl = document.getElementById('chatModalCompany');
  if (companyEl) companyEl.innerText = company || '';

  const avatarEl = document.getElementById('chatModalAvatar');
  if (avatarEl && company) {
    const words = company.replace(/[«»"']/g, '').trim().split(/\s+/);
    avatarEl.innerText = words.length >= 2
      ? (words[0][0] + words[1][0]).toUpperCase()
      : company.slice(0, 2).toUpperCase();
  }

  const modal = document.getElementById('chatModal');
  if (modal) modal.style.display = 'flex';
  if (socket) socket.emit('join-chat', { orderId, company });
  renderChatHistory();
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(() => {
    if (window.socket?.connected) return;
    renderChatHistory();
  }, 3000);
}

function goToFullChat() {
  if (activeChatOrderId == null) return;
  const title = document.getElementById('chatModalTitle')?.innerText || '';
  closeChatModal();
  window.location.href = `messages.html?orderId=${activeChatOrderId}&company=${encodeURIComponent(activeChatCompany)}&title=${encodeURIComponent(title)}`;
}

function closeChatModal() {
  const modal = document.getElementById('chatModal');
  if (modal) modal.style.display = 'none';
  if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
}

async function renderChatHistory() {
  const container = document.getElementById('chatModalMessages');
  if (!container || activeChatOrderId == null) return;

  try {
    const response = await apiFetch(`${SERVER_URL}/messages/${activeChatOrderId}/${encodeURIComponent(activeChatCompany)}`);
    if (!response.ok) return;
    const history = await response.json();
    const myRole = localStorage.getItem('userRole');
    const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;

    container.innerHTML = '';
    if (history.length === 0) {
      container.innerHTML = `<div class="cmp-empty-state">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Начните переписку — напишите первое сообщение</span>
      </div>`;
    } else {
      history.forEach(msg => {
        const bubble = document.createElement('div');
        bubble.className = `cmp-bubble ${msg.sender === myRole ? 'cmp-bubble-me' : 'cmp-bubble-them'}`;
        bubble.innerText = msg.text;
        container.appendChild(bubble);
      });
    }
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
  } catch (error) { /* поллинг — тихо пробуем снова на следующем тике */ }
}

async function sendGlobalChatMessage() {
  const input = document.getElementById('chatModalInput');
  if (!input || !input.value.trim() || activeChatOrderId == null) return;
  const text = input.value.trim();
  input.value = '';
  try {
    const r = await apiFetch(`${SERVER_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: activeChatOrderId, company: activeChatCompany, text })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      input.value = text;
      showToast(err.error || 'Не удалось отправить сообщение');
      return;
    }
  } catch (error) {
    input.value = text;
    showToast('Сервер недоступен');
    return;
  }
  renderChatHistory();
}

/* ---------------------------------------------------------------------
   Бейджи-счётчики на пунктах сайдбара
   --------------------------------------------------------------------- */
function _setBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.style.display = 'inline-block'; }
  else el.style.display = 'none';
}

function _applyBadgeCounts(counts, role) {
  if (role === 'producer') {
    _setBadge('navBadgeOrders',    counts.activeOrders);
    _setBadge('navBadgeProposals', counts.pendingProposals);
  } else {
    _setBadge('navBadgeOrders',    counts.myActiveOrders);
    _setBadge('navBadgeProposals', counts.newResponses);
  }
  _setBadge('navBadgeMessages', counts.unreadMessages);
}

async function initSidebarBadges() {
  const role = localStorage.getItem('userRole');
  if (!hasSession()) return;

  // Показываем прошлые значения из кеша мгновенно — без ожидания API
  const cached = localStorage.getItem('_badgeCache');
  if (cached) {
    try { _applyBadgeCounts(JSON.parse(cached), role); } catch { /* ignore */ }
  }

  try {
    const r = await apiFetch(`${SERVER_URL}/dashboard/counts`);
    if (!r.ok) return;
    const counts = await r.json();
    localStorage.setItem('_badgeCache', JSON.stringify(counts));
    _applyBadgeCounts(counts, role);
  } catch { /* сервер недоступен — тихо */ }
}

/* ---------------------------------------------------------------------
   Sidebar extras — промо-виджет, блок поддержки, кнопка сворачивания
   --------------------------------------------------------------------- */
function _closeMobileSidebar() {
  const sb = document.querySelector('.sidebar');
  const ov = document.getElementById('sidebarOverlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('visible');
}

function _openMobileSidebar() {
  const sb = document.querySelector('.sidebar');
  if (!sb) return;
  let ov = document.getElementById('sidebarOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'sidebar-overlay';
    ov.id = 'sidebarOverlay';
    ov.addEventListener('click', _closeMobileSidebar);
    document.body.appendChild(ov);
  }
  sb.classList.add('open');
  ov.classList.add('visible');
}

// Called from burger button (onclick="toggleMobileSidebar()")
function toggleMobileSidebar() {
  const sb = document.querySelector('.sidebar');
  if (sb && sb.classList.contains('open')) {
    _closeMobileSidebar();
  } else {
    _openMobileSidebar();
  }
}

// Desktop sidebar collapse (only runs on desktop — mobile CSS hides this button)
function toggleSidebar() {
  if (window.innerWidth <= 768) return; // no-op on mobile
  const root = document.documentElement;
  root.classList.add('sidebar-resizing');
  const collapsed = root.getAttribute('data-sidebar-collapsed') === '1';
  if (collapsed) {
    root.removeAttribute('data-sidebar-collapsed');
    localStorage.setItem('sidebarCollapsed', '0');
  } else {
    root.setAttribute('data-sidebar-collapsed', '1');
    localStorage.setItem('sidebarCollapsed', '1');
  }
  clearTimeout(toggleSidebar._t);
  toggleSidebar._t = setTimeout(() => root.classList.remove('sidebar-resizing'), 220);
}

function initSidebarExtra() {
  // collapsed state restored via inline script in <head>
}

function initSidebarScrollPersist() {
  const sb = document.querySelector('.sidebar');
  if (!sb || window.innerWidth <= 720) return;

  const saved = sessionStorage.getItem(SIDEBAR_SCROLL_KEY);
  if (saved != null) {
    const top = parseInt(saved, 10);
    if (!Number.isNaN(top)) sb.scrollTop = top;
  }

  window.addEventListener('pagehide', () => {
    sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(sb.scrollTop));
  });
}

function initSidebarPrefetch() {
  document.querySelectorAll('.sidebar a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || href === '#' || href.startsWith('javascript:')) return;
    let url;
    try { url = new URL(href, location.origin); } catch { return; }
    if (url.origin !== location.origin) return;

    a.addEventListener('mouseenter', () => {
      if (document.querySelector(`link[rel="prefetch"][href="${url.pathname}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = url.pathname + url.search;
      document.head.appendChild(link);
    }, { once: true, passive: true });
  });
}

/* ---------------------------------------------------------------------
   Загрузочный экран при переходах между страницами (MPA)
   --------------------------------------------------------------------- */
function ensurePageLoader() {
  if (document.getElementById('tz-page-loader')) return;
  const el = document.createElement('div');
  el.id = 'tz-page-loader';
  el.className = 'tz-page-loader';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="tz-page-loader-card"><div class="tz-page-loader-spinner" aria-hidden="true"></div><div class="tz-page-loader-text">Загрузка…</div></div>';
  document.body.appendChild(el);
}

function showPageLoader(message) {
  ensurePageLoader();
  const el = document.getElementById('tz-page-loader');
  const text = el?.querySelector('.tz-page-loader-text');
  if (text && message) text.textContent = message;
  el?.classList.add('is-active');
  document.documentElement.classList.add('tz-nav-loading');
}

function hidePageLoader() {
  const el = document.getElementById('tz-page-loader');
  el?.classList.remove('is-active');
  document.documentElement.classList.remove('tz-nav-loading');
}

function shouldShowLoaderForLink(a) {
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return false;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return false;
  let url;
  try { url = new URL(href, location.href); } catch { return false; }
  if (url.origin !== location.origin) return false;
  if (url.pathname === location.pathname && url.search === location.search && !url.hash) return false;
  return true;
}

function initPageTransitionLoader() {
  ensurePageLoader();
  hidePageLoader();
  window.addEventListener('pageshow', hidePageLoader);

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!shouldShowLoaderForLink(a)) return;
    showPageLoader();
  }, true);
}

/* ---------------------------------------------------------------------
   Header right section — тема, колокол, пользователь
   --------------------------------------------------------------------- */
function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('userDropdown');
  if (dd) dd.classList.toggle('open');
}

function initHeaderRight() {
  const company   = localStorage.getItem('userCompany') || '';
  const role      = localStorage.getItem('userRole') || '';
  const roleLabel = role === 'customer' ? 'Заказчик'
                  : role === 'producer' ? 'Производитель'
                  : role === 'admin'    ? 'Администратор' : '';
  const clean    = company.replace(/[«»""']/g, '').replace(/^(ООО|АО|ЗАО|ИП|ПАО)\s+/i, '').trim();
  const initials = (clean || company).slice(0, 2).toUpperCase() || 'ТЗ';

  const elInitials = document.getElementById('headerInitials');
  const elCompany  = document.getElementById('headerCompany');
  const elRole     = document.getElementById('headerRole');
  if (elInitials) elInitials.textContent = initials;
  if (elCompany)  elCompany.textContent  = company || 'Гость';
  if (elRole)     elRole.textContent     = roleLabel;

  /* Inject search button before bell */
  const headerRight = document.querySelector('.header-right');
  const bellBtn = headerRight?.querySelector('.bell-btn');
  if (headerRight && bellBtn && !document.getElementById('cpTriggerBtn')) {
    const btn = document.createElement('button');
    btn.id = 'cpTriggerBtn';
    btn.className = 'bell-btn hdr-search-btn';
    btn.title = 'Поиск (Ctrl+K)';
    btn.setAttribute('aria-label', 'Открыть поиск');
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    btn.onclick = () => typeof window.openCommandPalette === 'function' && window.openCommandPalette();
    headerRight.insertBefore(btn, bellBtn);
  }

  document.addEventListener('click', e => {
    const menu = document.getElementById('userMenu');
    if (menu && !menu.contains(e.target)) {
      const dd = document.getElementById('userDropdown');
      if (dd) dd.classList.remove('open');
    }
  });
}

/* ---------------------------------------------------------------------
   Просмотр чертежей (PDF, PNG, JPG) в модальном окне
   --------------------------------------------------------------------- */
const DRAWING_PREVIEW_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

function drawingFileExt(fileName) {
  if (!fileName) return '';
  const i = String(fileName).lastIndexOf('.');
  return i >= 0 ? String(fileName).slice(i).toLowerCase() : '';
}

function isDrawingPreviewable(fileName) {
  return DRAWING_PREVIEW_EXT.has(drawingFileExt(fileName));
}

function drawingDownloadUrl(orderId) {
  return `${SERVER_URL}/orders/${orderId}/drawing`;
}

function drawingPreviewUrl(orderId) {
  return `${drawingDownloadUrl(orderId)}?inline=1`;
}

function buildDrawingLinksHtml(orderId, drawing) {
  if (!drawing || !drawing.originalName) return '';
  const rawName = drawing.originalName;
  const name = /^[\x20-\x7E\u0400-\u04FF\s._\-()]+$/.test(rawName) ? rawName : 'Вложение';
  const safeName = escapeHtml(name);
  const previewable = isDrawingPreviewable(name);
  const previewBtn = previewable
    ? `<button type="button" class="drawing-link-btn drawing-link-btn-primary" onclick="openDrawingPreview(${orderId}, ${JSON.stringify(name)})">Просмотр</button>`
    : '';
  const hint = previewable ? '' : '<span style="font-size:11px;color:var(--text-secondary);">Просмотр в браузере: PDF или изображение</span>';
  return `<div class="drawing-links" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;color:var(--accent-cyan);"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <span style="font-size:12px;font-weight:600;color:var(--text-primary);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${safeName}">${safeName}</span>
    ${previewBtn}
    <a href="${drawingDownloadUrl(orderId)}" class="drawing-link-btn" target="_blank" rel="noopener">Скачать</a>
    ${hint}
  </div>`;
}

function ensureDrawingPreviewModal() {
  if (document.getElementById('drawingPreviewModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'drawingPreviewModal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;z-index:10050;background:rgba(15,23,42,.72);align-items:center;justify-content:center;padding:20px 12px;';
  wrap.onclick = (e) => { if (e.target === wrap) closeDrawingPreview(); };
  wrap.innerHTML = `
    <div style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:14px;width:min(960px,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:var(--shadow-modal);overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--inner-border);">
        <div id="drawingPreviewTitle" style="font-size:14px;font-weight:700;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Чертёж</div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <a id="drawingPreviewDownload" href="#" target="_blank" rel="noopener" class="drawing-link-btn">Скачать</a>
          <button type="button" onclick="closeDrawingPreview()" style="background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:var(--text-secondary);padding:0 4px;">×</button>
        </div>
      </div>
      <div id="drawingPreviewBody" style="flex:1;min-height:320px;background:var(--inner-bg);display:flex;align-items:center;justify-content:center;overflow:auto;"></div>
    </div>`;
  document.body.appendChild(wrap);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawingPreview();
  });
}

function openDrawingPreview(orderId, fileName) {
  if (!hasSession()) {
    showToast('Войдите, чтобы просмотреть чертёж', 'warn');
    return;
  }
  if (!isDrawingPreviewable(fileName)) {
    window.open(drawingDownloadUrl(orderId), '_blank', 'noopener');
    return;
  }
  ensureDrawingPreviewModal();
  const modal = document.getElementById('drawingPreviewModal');
  const body = document.getElementById('drawingPreviewBody');
  const title = document.getElementById('drawingPreviewTitle');
  const download = document.getElementById('drawingPreviewDownload');
  if (!modal || !body || !title || !download) return;

  title.textContent = fileName || 'Чертёж';
  download.href = drawingDownloadUrl(orderId);
  body.innerHTML = '<div style="padding:40px;color:var(--text-secondary);font-size:13px;">Загрузка…</div>';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const url = drawingPreviewUrl(orderId);
  const ext = drawingFileExt(fileName);
  if (ext === '.pdf') {
    body.innerHTML = `<iframe src="${url}" title="${escapeHtml(fileName)}" style="width:100%;height:min(75vh,720px);border:none;background:#fff;"></iframe>`;
  } else {
    body.innerHTML = `<img src="${url}" alt="${escapeHtml(fileName)}" style="max-width:100%;max-height:min(75vh,720px);object-fit:contain;display:block;margin:0 auto;">`;
  }
}

function closeDrawingPreview() {
  const modal = document.getElementById('drawingPreviewModal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
  const body = document.getElementById('drawingPreviewBody');
  if (body) body.innerHTML = '';
}

/* ---------------------------------------------------------------------
   Match-score и сравнение КП
   --------------------------------------------------------------------- */
function matchScoreBadge(score, reasons) {
  if (score == null || score <= 0) return '';
  const style = score >= 70
    ? 'background:rgba(5,150,105,.12);color:#059669;border:1px solid rgba(5,150,105,.25);'
    : score >= 40
      ? 'background:rgba(255,106,0,.1);color:#C45000;border:1px solid rgba(255,106,0,.25);'
      : 'background:var(--inner-bg);color:var(--text-secondary);border:1px solid var(--inner-border);';
  const tip = Array.isArray(reasons) && reasons.length
    ? reasons.join(' · ')
    : 'Совпадение профиля поставщика с закупкой';
  const iconName = score >= 70 ? 'flame' : 'puzzle';
  return `<span style="display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600;${style}" title="${escapeHtml(tip)}">${uiIcon(iconName, 12)} ${score}%</span>`;
}

function normalizeProposalForCompare(p) {
  return {
    ...p,
    _name: p.company || p.companyName || p.supplier || '—',
    _price: Number(p.price) || 0,
    _days: Number(p.leadTime != null ? p.leadTime : p.days) || 0,
    _match: p.matchScore != null ? Number(p.matchScore) : null,
    _matchReasons: Array.isArray(p.matchReasons) ? p.matchReasons : [],
    _status: p.status || '—',
    _verifiedPlatform: Boolean(p.verifiedByPlatform || p.verified_by_platform),
    _verifiedEgrul: Boolean(p.verifiedEgrul || p.verified_egrul),
    _rating: p.rating || p.supplierRating || null,
  };
}

function verificationBadgeHtml(p) {
  const norm = p._verifiedPlatform != null ? p : normalizeProposalForCompare(p);
  if (norm._verifiedPlatform) {
    return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#059669;background:rgba(5,150,105,.1);border:1px solid rgba(5,150,105,.25);border-radius:6px;padding:2px 8px;">✓ Верифицирован</span>';
  }
  if (norm._verifiedEgrul) {
    return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#2563eb;background:rgba(37,99,235,.1);border:1px solid rgba(37,99,235,.2);border-radius:6px;padding:2px 8px;">ЕГРЮЛ</span>';
  }
  return '<span style="font-size:11px;color:var(--text-muted);">—</span>';
}

function proposalStatusBadgeHtml(status) {
  let icon = '⏱', cls = 'waiting', label = status || '—';
  if (status === 'Выигран' || status === 'Победитель') { icon = '✓'; cls = 'win'; }
  else if (status === 'Отклонен' || status === 'Отклонено') { icon = '✗'; cls = 'loose'; }
  else if (status === 'Отозвана заказчиком') { icon = '⊘'; cls = 'muted'; }
  else if (status === 'Ожидает ответа' || status === 'На рассмотрении') { icon = '⏱'; cls = 'waiting'; }
  return `<span class="status-icon ${cls}" style="font-size:11.5px;white-space:nowrap;">${icon} ${escapeHtml(label)}</span>`;
}

const _kpCompareSelected = new Set();

function resetKpCompareSelection() {
  _kpCompareSelected.clear();
  document.querySelectorAll('.kp-compare-cb').forEach(cb => { cb.checked = false; });
  updateKpCompareBar();
}

function toggleKpCompare(id, checked) {
  const numId = Number(id);
  if (checked) {
    if (_kpCompareSelected.size >= 4) {
      showToast('Максимум 4 КП для сравнения', 'warn');
      const cb = document.querySelector(`.kp-compare-cb[data-id="${numId}"]`);
      if (cb) cb.checked = false;
      return;
    }
    _kpCompareSelected.add(numId);
  } else {
    _kpCompareSelected.delete(numId);
  }
  updateKpCompareBar();
}

function updateKpCompareBar() {
  let bar = document.getElementById('kpCompareBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'kpCompareBar';
    bar.className = 'kp-compare-bar';
    bar.innerHTML = `
      <span class="kp-compare-bar-text" id="kpCompareBarText">Выбрано: 0</span>
      <button type="button" class="btn-primary kp-compare-bar-btn" id="kpCompareBarBtn" onclick="openSelectedKpCompare()">Сравнить</button>
      <button type="button" class="btn-secondary kp-compare-bar-btn" onclick="resetKpCompareSelection()">Сбросить</button>`;
    document.body.appendChild(bar);
  }
  const n = _kpCompareSelected.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  const textEl = document.getElementById('kpCompareBarText');
  if (textEl) textEl.textContent = `Выбрано: ${n} из 4`;
  const btn = document.getElementById('kpCompareBarBtn');
  if (btn) btn.disabled = n < 2;
}

function getSelectedKpFromList(list) {
  const arr = list || [];
  if (_kpCompareSelected.size >= 2) {
    return arr.filter(p => _kpCompareSelected.has(Number(p.id)));
  }
  return arr;
}

function openSelectedKpCompare() {
  if (typeof openKpCompareWithList === 'function') {
    openKpCompareWithList();
  } else if (typeof compareKp === 'function') {
    compareKp();
  }
}

function kpRankBadge(rank) {
  const tier = rank === 0 ? 'gold' : rank === 1 ? 'silver' : 'bronze';
  const label = rank === 0 ? 'Лучший выбор' : `Место ${rank + 1}`;
  if (rank === 0) {
    return `<span class="kp-rank-badge kp-rank-${tier}" title="${label}" aria-label="${label}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
    </span>`;
  }
  return `<span class="kp-rank-badge kp-rank-${tier}" title="${label}" aria-label="${label}"><span>${rank + 1}</span></span>`;
}

function _kpRatingNorm(p) {
  const raw = p.supplierRating ?? p.rating ?? p.producerRating;
  if (typeof raw === 'number' && raw > 0) {
    return raw <= 5 ? raw / 5 : Math.min(1, raw / 100);
  }
  const letter = String(raw || '').toUpperCase();
  const map = { 'A+': 1, 'A': 0.85, 'B+': 0.65, 'B': 0.45, 'C': 0.25 };
  return map[letter] ?? 0.5;
}

/** Weighted score: price 40%, delivery 25%, verification 15%, rating 10%, match 10%. */
function scoreProposalForRecommendation(p, context = {}) {
  const norm = p._price != null ? p : normalizeProposalForCompare(p);
  const all = (context.all || [norm]).map(x => x._price != null ? x : normalizeProposalForCompare(x));
  const prices = all.map(x => x._price).filter(v => v > 0);
  const days = all.map(x => x._days).filter(v => v > 0);
  const minP = prices.length ? Math.min(...prices) : 0;
  const maxP = prices.length ? Math.max(...prices) : 0;
  const minD = days.length ? Math.min(...days) : 0;
  const maxD = days.length ? Math.max(...days) : 0;

  const ps = maxP > minP && norm._price > 0 ? (maxP - norm._price) / (maxP - minP) : 1;
  const ds = maxD > minD && norm._days > 0 ? (maxD - norm._days) / (maxD - minD) : 1;
  const vs = norm._verifiedPlatform ? 1 : (norm._verifiedEgrul ? 0.55 : 0);
  const rs = _kpRatingNorm(norm);
  const ms = norm._match != null && norm._match > 0 ? norm._match / 100 : 0.5;
  return ps * 0.40 + ds * 0.25 + vs * 0.15 + rs * 0.10 + ms * 0.10;
}

function _kpRecReasons(p, all) {
  const prices = all.map(x => x._price).filter(v => v > 0);
  const days = all.map(x => x._days).filter(v => v > 0);
  const minP = prices.length ? Math.min(...prices) : 0;
  const minD = days.length ? Math.min(...days) : 0;
  const avgP = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const avgD = days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  const reasons = [];

  if (minP > 0 && p._price === minP) {
    reasons.push('Лучшая цена среди всех КП');
  } else if (avgP > 0 && p._price < avgP) {
    const pct = Math.round((1 - p._price / avgP) * 100);
    if (pct >= 3) reasons.push(`Цена на ${pct}% ниже остальных`);
  }
  if (p._verifiedPlatform) reasons.push('Верифицирован платформой');
  else if (p._verifiedEgrul) reasons.push('Проверен по ЕГРЮЛ');
  if (p._days > 0 && p._days <= minD && minD > 0) {
    reasons.push(`Срок ${p._days} дней — быстрее среднего`);
  } else if (p._days > 0 && avgD > 0 && p._days < avgD) {
    reasons.push(`Срок ${p._days} дней — быстрее среднего`);
  }
  if (p._match >= 70) reasons.push(`Совпадение профиля ${p._match}%`);

  return reasons.slice(0, 3);
}

function computeKpRecommendation(proposals) {
  const props = (proposals || []).map(normalizeProposalForCompare);
  if (props.length < 2) return null;
  const ctx = { all: props };
  const scored = props.map(p => ({ proposal: p, score: scoreProposalForRecommendation(p, ctx) }))
    .sort((a, b) => b.score - a.score);
  const winner = scored[0].proposal;
  return { proposal: winner, score: scored[0].score, reasons: _kpRecReasons(winner, props) };
}

function renderKpRecommendationCard(proposals, options = {}) {
  if (!proposals || !Array.isArray(proposals) || proposals.length < 2) return '';
  const rec = computeKpRecommendation(proposals);
  if (!rec) return '';

  const acceptFn = options.acceptFn || 'acceptProposalFromCompare';
  const compareFn = options.compareFn;
  const compact = options.compact;
  const p = rec.proposal;
  const priceFmt = v => v ? new Intl.NumberFormat('ru-RU').format(v) + ' ₽' : '—';
  const reasons = rec.reasons || [];

  return `<div class="kp-rec-card${compact ? ' kp-rec-card--compact' : ''}">
    <div class="kp-rec-accent" aria-hidden="true"></div>
    <div class="kp-rec-inner">
      <div class="kp-rec-head">${uiIcon('trophy', 14)} Рекомендация платформы</div>
      <div class="kp-rec-company">${escapeHtml(p._name)}</div>
      <div class="kp-rec-metrics">
        <span class="kp-rec-price">${priceFmt(p._price)}</span>
        ${p._days ? `<span class="kp-rec-days">${p._days} дн.</span>` : ''}
      </div>
      ${reasonsHtml ? `<ul class="kp-rec-reasons">${reasons.map(r => `<li class="kp-rec-reasons-item">${uiIcon('check', 13)}<span>${escapeHtml(r)}</span></li>`).join('')}</ul>` : ''}
      <div class="kp-rec-actions">
        <button type="button" class="btn-primary kp-rec-btn-primary" onclick="${acceptFn}(${p.id || 0}, ${JSON.stringify(p._name)})">Выбрать этого поставщика</button>
        ${compareFn ? `<button type="button" class="kp-rec-btn-ghost" onclick="${compareFn}()">${uiIcon('grid', 14)} Сравнить все КП</button>` : ''}
      </div>
    </div>
  </div>`;
}

function renderKpCompareTable(proposals, options = {}) {
  const props = (proposals || []).map(normalizeProposalForCompare);
  if (props.length < 2) {
    return '<p style="color:var(--text-secondary);font-size:13px;margin:0;">Нужно минимум 2 КП для сравнения.</p>';
  }

  const priceFmt = v => v ? new Intl.NumberFormat('ru-RU').format(v) + ' ₽' : '—';
  const prices = props.map(p => p._price).filter(v => v > 0);
  const days = props.map(p => p._days).filter(v => v > 0);
  const minP = prices.length ? Math.min(...prices) : 0;
  const maxP = prices.length ? Math.max(...prices) : 0;
  const minD = days.length ? Math.min(...days) : 0;
  const maxD = days.length ? Math.max(...days) : 0;
  const showMatch = props.some(p => p._match > 0);
  const acceptFn = options.acceptFn || 'acceptProposalFromCompare';
  const showAccept = options.showAccept !== false;
  const showStatus = options.showStatus !== false;
  const showVerified = options.showVerified !== false;

  const scored = props.map(p => {
    const ps = maxP > minP ? (p._price - minP) / (maxP - minP) : 0;
    const ds = maxD > minD ? (p._days - minD) / (maxD - minD) : 0;
    return { ...p, _rankScore: ps * 0.5 + ds * 0.5 };
  }).sort((a, b) => a._rankScore - b._rankScore);

  const recommendation = computeKpRecommendation(props);
  const recCardHtml = recommendation
    ? renderKpRecommendationCard(proposals, { acceptFn, compareFn: 'compareKp', compact: true })
    : '';
  const recWinner = recommendation?.proposal;

  const bestPrice = scored.find(p => p._price === minP)?._name || '—';
  const fastest = scored.find(p => p._days === minD)?._name || '—';
  const summaryHtml = [
    { icon: 'coin', label: 'Лучшая цена', val: escapeHtml(bestPrice), color: '#12A866' },
    { icon: 'zap', label: 'Быстрее всех', val: escapeHtml(fastest), color: '#3B82F6' },
    { icon: 'trophy', label: 'Рекомендуем', val: escapeHtml(scored[0]?._name || '—'), color: '#FF6A00' },
  ].map(b => `<div style="background:var(--inner-bg);border:1px solid var(--card-border);border-radius:10px;padding:10px 14px;flex:1;min-width:140px;">
    <div style="font-size:11px;color:var(--text-secondary);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:5px;">${uiIcon(b.icon, 13)} ${b.label}</div>
    <div style="font-size:13px;font-weight:700;color:${b.color};">${b.val}</div>
  </div>`).join('');

  const thStyle = 'padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--text-secondary);border-bottom:2px solid var(--card-border);white-space:nowrap;';
  const rowsHtml = scored.map((p, rank) => {
    const isBP = p._price === minP && minP > 0;
    const isWP = p._price === maxP && props.length > 1 && maxP > minP;
    const isBD = p._days === minD && minD > 0;
    const isWD = p._days === maxD && props.length > 1 && maxD > minD;
    const pDev = minP > 0 && !isBP ? `<span style="color:#e07070;font-size:11px;"> +${Math.round((p._price - minP) / minP * 100)}%</span>` : '';
    const dDev = minD > 0 && !isBD ? `<span style="color:#94A3B8;font-size:11px;"> +${Math.round((p._days - minD) / minD * 100)}%</span>` : '';
    const priceBg = isBP ? 'background:rgba(18,168,102,.1);' : isWP ? 'background:rgba(224,112,112,.07);' : '';
    const daysBg = isBD ? 'background:rgba(59,130,246,.1);' : isWD ? 'background:rgba(224,112,112,.07);' : '';
    const acceptCell = showAccept
      ? `<button class="btn-primary" style="font-size:12px;padding:6px 12px;" onclick="${acceptFn}(${p.id || 0}, ${JSON.stringify(p._name)})">Выбрать</button>`
      : '';
    const isRec = recWinner && (p.id === recWinner.id || p._name === recWinner._name);
    return `<tr style="${isRec ? 'background:rgba(255,106,0,.04);' : ''}border-bottom:1px solid var(--inner-border);">
      <td style="padding:11px 12px;font-weight:700;color:var(--text-secondary);">${rank + 1}</td>
      <td style="padding:11px 12px;">
        <div style="font-weight:600;color:var(--text-primary);">${escapeHtml(p._name)}</div>
        ${isRec ? `<div style="font-size:11px;color:#FF6A00;font-weight:600;margin-top:2px;display:flex;align-items:center;gap:4px;">${uiIcon('check', 11)} Рекомендуется</div>` : ''}
      </td>
      ${showVerified ? `<td style="padding:11px 12px;">${verificationBadgeHtml(p)}</td>` : ''}
      ${showMatch ? `<td style="padding:11px 12px;">${matchScoreBadge(p._match, p._matchReasons)}</td>` : ''}
      <td style="padding:11px 12px;font-weight:700;font-family:'JetBrains Mono',monospace;${priceBg}">${priceFmt(p._price)}${isBP ? '<span style="color:#12A866;font-size:11px;"> лучшая</span>' : pDev}</td>
      <td style="padding:11px 12px;${daysBg}">${p._days ? p._days + ' дн.' : '—'}${isBD ? '<span style="color:#3B82F6;font-size:11px;"> быстрее</span>' : dDev}</td>
      ${showStatus ? `<td style="padding:11px 12px;">${proposalStatusBadgeHtml(p._status)}</td>` : ''}
      <td style="padding:11px 12px;">${kpRankBadge(rank)}</td>
      ${showAccept ? `<td style="padding:11px 12px;">${acceptCell}</td>` : ''}
    </tr>`;
  }).join('');

  return `
    ${recCardHtml}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;">${summaryHtml}</div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:var(--inner-bg);">
          <th style="${thStyle}">#</th>
          <th style="${thStyle}">Поставщик</th>
          ${showVerified ? `<th style="${thStyle}">Верификация</th>` : ''}
          ${showMatch ? `<th style="${thStyle}">Профиль</th>` : ''}
          <th style="${thStyle}">Цена</th>
          <th style="${thStyle}">Срок</th>
          ${showStatus ? `<th style="${thStyle}">Статус</th>` : ''}
          <th style="${thStyle}">Рейтинг</th>
          ${showAccept ? `<th style="${thStyle}">Действие</th>` : ''}
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:14px;margin-top:14px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);"><div style="width:10px;height:10px;border-radius:2px;background:rgba(18,168,102,.15);border:1px solid #12A866;"></div>Лучшая цена</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);"><div style="width:10px;height:10px;border-radius:2px;background:rgba(59,130,246,.15);border:1px solid #3B82F6;"></div>Лучший срок</div>
      ${showMatch ? `<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-secondary);">${uiIcon('puzzle', 12)} совпадение специализации с закупкой</div>` : ''}
    </div>`;
}

function renderMatchedSuppliersList(items) {
  if (!items || !items.length) {
    return '<div style="font-size:12px;color:var(--text-secondary);">Пока нет подходящих поставщиков в каталоге</div>';
  }
  return items.map(m => {
    const reasonsHtml = Array.isArray(m.reasons) && m.reasons.length
      ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;line-height:1.35;">${m.reasons.map(r => escapeHtml(r)).join(' · ')}</div>`
      : '';
    return `
    <div style="padding:8px 0;border-bottom:1px solid var(--inner-border);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;">
        <span style="font-weight:600;color:var(--text-primary);">${escapeHtml(m.company)}</span>
        ${matchScoreBadge(m.score, m.reasons)}
      </div>
      ${reasonsHtml}
    </div>`;
  }).join('');
}

function renderPriceBenchmark(b) {
  if (!b || !b.enough) {
    const n = b && b.sampleSize ? b.sampleSize : 0;
    return `<div style="font-size:12px;color:var(--text-secondary);line-height:1.45;">Недостаточно закрытых сделок в категории «${escapeHtml(b?.category || '—')}» для бенчмарка (нужно ≥3, сейчас ${n}).</div>`;
  }
  const fmt = v => new Intl.NumberFormat('ru-RU').format(v);
  let current = '';
  if (b.currentMin != null && b.currentMax != null) {
    current = `<div style="margin-top:8px;font-size:12px;color:var(--text-primary);">Ваши КП: <strong>${fmt(b.currentMin)}–${fmt(b.currentMax)} ₽</strong></div>`;
  }
  return `
    <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">
      За ${b.periodMonths || 6} мес. по категории «${escapeHtml(b.category)}» (${b.sampleSize} сделок):
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size:12.5px;">
      <div><span style="color:var(--text-secondary);">Медиана</span><br><strong style="font-family:'JetBrains Mono',monospace;color:var(--accent-green);">${fmt(b.median)} ₽</strong></div>
      <div><span style="color:var(--text-secondary);">Диапазон</span><br><strong style="font-family:'JetBrains Mono',monospace;">${fmt(b.min)}–${fmt(b.max)} ₽</strong></div>
    </div>
    ${current}
    <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">Анонимная статистика по закрытым прямым закупкам на платформе</div>`;
}

function renderProducerPriceHint(price, benchmark) {
  if (!benchmark?.enough || !price || price <= 0) return '';
  const fmt = v => new Intl.NumberFormat('ru-RU').format(v);
  const pct = Math.round((price - benchmark.median) / benchmark.median * 100);
  if (pct <= -5) {
    return `<div style="margin-top:8px;font-size:12px;color:var(--accent-green);">На ${Math.abs(pct)}% ниже медианы (${fmt(benchmark.median)} ₽) — конкурентное предложение</div>`;
  }
  if (pct <= 10) {
    return `<div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">Около медианы рынка (${fmt(benchmark.median)} ₽)</div>`;
  }
  return `<div style="margin-top:8px;font-size:12px;color:#e07070;">На ${pct}% выше медианы (${fmt(benchmark.median)} ₽) — может снизить шансы</div>`;
}

const DEAL_TIMELINE_ICONS = {
  order: 'clipboard',
  proposal: 'mail',
  proposal_other: 'undo',
  delivery: 'truck',
  chat: 'message',
  complete: 'checkCircle',
  review: 'star',
  status: 'edit',
};

function renderDealTimeline(events) {
  if (!events || !events.length) {
    return '<div style="font-size:12px;color:var(--text-secondary);">Событий пока нет</div>';
  }
  const fmtDate = (iso) => {
    try {
      return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  };
  return `<div class="deal-timeline">${events.map((ev, i) => {
    const isLast = i === events.length - 1;
    const icon = DEAL_TIMELINE_ICONS[ev.type] ? uiIcon(DEAL_TIMELINE_ICONS[ev.type], 13) : '•';
    return `<div class="deal-tl-item${isLast ? ' is-last' : ''}">
      <div class="deal-tl-dot">${icon}</div>
      <div class="deal-tl-body">
        <div class="deal-tl-title">${escapeHtml(ev.title)}</div>
        ${ev.detail ? `<div class="deal-tl-detail">${escapeHtml(ev.detail)}</div>` : ''}
        <div class="deal-tl-time">${fmtDate(ev.at)}</div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

(function applySidebarBadgesEarly() {
  if (!hasSession()) return;
  const cached = localStorage.getItem('_badgeCache');
  if (!cached) return;
  try { _applyBadgeCounts(JSON.parse(cached), localStorage.getItem('userRole')); } catch (_) {}
})();

/* ---------------------------------------------------------
   Web Push подписка
--------------------------------------------------------- */
async function getPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      reg = await Promise.race([
        navigator.serviceWorker.register('/assets/sw.js'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SW register timeout')), 5000)),
      ]);
    }
    if (!reg?.pushManager) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

async function getServiceWorkerRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    reg = await Promise.race([
      navigator.serviceWorker.register('/assets/sw.js'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SW register timeout')), 8000)),
    ]).catch(() => null);
  }
  return reg;
}

async function fetchVapidPublicKey() {
  const r = await apiFetch(`${SERVER_URL}/push/vapid-key`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.publicKey) {
    throw new Error(data.error || 'Push-уведомления не настроены на сервере');
  }
  return data.publicKey;
}

async function subscribeToPush() {
  const reg = await getServiceWorkerRegistration();
  if (!reg?.pushManager) throw new Error('Service Worker недоступен');
  const publicKey = await fetchVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const saveRes = await apiFetch(`${SERVER_URL}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!saveRes.ok) {
    await sub.unsubscribe().catch(() => {});
    const err = await saveRes.json().catch(() => ({}));
    throw new Error(err.error || 'Не удалось сохранить подписку');
  }
  return sub;
}

async function unsubscribeFromPush() {
  const sub = await getPushSubscription();
  if (sub) await sub.unsubscribe();
  await apiFetch(`${SERVER_URL}/push/subscribe`, { method: 'DELETE' });
}

function urlBase64ToUint8Array(base64String) {
  if (!base64String || typeof base64String !== 'string') {
    throw new Error('Некорректный VAPID-ключ');
  }
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/* SPA отключён — полная перезагрузка страницы (см. комментарий в DOMContentLoaded) */
window.__spaNavigate = (url) => { location.assign(url); };

/* =====================================================================
   ОНБОРДИНГ — welcome-модалка + чеклист «Начало работы»
   ===================================================================== */

const _OB_WELCOME_KEY = 'ob_welcome_v2';
const _OB_CHECKLIST_KEY = 'ob_checklist_v2';
const _OB_CHECKLIST_LEGACY = 'ob_checklist';
const _OB_COLLAPSED_KEY = 'ob_collapsed';

function _obMigrateChecklist() {
  if (localStorage.getItem(_OB_CHECKLIST_KEY)) return;
  const legacy = localStorage.getItem(_OB_CHECKLIST_LEGACY);
  if (legacy) localStorage.setItem(_OB_CHECKLIST_KEY, legacy);
}

function _obSteps(role) {
  if (role === 'producer') {
    return [
      { id: 'profile',   label: 'Заполните профиль компании',    desc: 'Специализация и оборудование влияют на match-score',  href: `company-profile.html?id=${localStorage.getItem('_myCompanyId')||''}` },
      { id: 'browse',    label: 'Просмотрите актуальные заявки', desc: 'Найдите закупки, подходящие по вашей специализации',  href: 'producer.html' },
      { id: 'proposal',  label: 'Подайте первое КП',             desc: 'Прикрепите файл и укажите цену прямо в платформе',    href: 'producer.html' },
      { id: 'settings',  label: 'Подключите интеграцию',         desc: '1С, Bitrix24, AmoCRM — автоматически при принятии КП', href: 'settings.html' },
    ];
  }
  return [
    { id: 'order',    label: 'Разместите первую закупку',   desc: 'Опишите потребность — поставщики найдут вас сами',     href: 'index.html?create=1', action: 'openModal' },
    { id: 'catalog',  label: 'Изучите каталог поставщиков', desc: 'Более 100 верифицированных производителей РФ',          href: 'catalog.html' },
    { id: 'profile',  label: 'Заполните профиль компании',  desc: 'ИНН, реквизиты, контакты — для доверия поставщиков',   href: `company-profile.html?id=${localStorage.getItem('_myCompanyId')||''}` },
    { id: 'settings', label: 'Настройте уведомления',       desc: 'Email-дайджест и интеграции с вашей CRM',              href: 'settings.html' },
  ];
}

function _obDoneMap() {
  try { return JSON.parse(localStorage.getItem(_OB_CHECKLIST_KEY) || '{}'); } catch { return {}; }
}

function _obSaveDone(id) {
  const done = _obDoneMap();
  if (done[id]) return false;
  done[id] = true;
  localStorage.setItem(_OB_CHECKLIST_KEY, JSON.stringify(done));
  return true;
}

/** Mark an onboarding checklist step complete — call from pages after user actions. */
function markOnboardingStep(id) {
  if (!_obSaveDone(id)) {
    _obRefreshChecklist();
    return;
  }
  _obRefreshChecklist();
  const role = localStorage.getItem('userRole') || '';
  const steps = _obSteps(role);
  const done = _obDoneMap();
  const doneCount = steps.filter(s => done[s.id]).length;
  if (doneCount === steps.length) {
    const w = document.getElementById('obChecklist');
    if (w) {
      w.classList.add('ob-cl-complete');
      setTimeout(() => dismissObChecklist(), 3200);
    }
  }
}
window.markOnboardingStep = markOnboardingStep;
window.obCompleteStep = markOnboardingStep;

async function _obAutoCompleteFromPage() {
  const page = location.pathname.split('/').pop() || 'index.html';
  if (page === 'catalog.html') markOnboardingStep('catalog');
  if (page === 'settings.html') markOnboardingStep('settings');
  if (page === 'producer.html') markOnboardingStep('browse');

  if (page === 'company-profile.html') {
    try {
      const id = new URLSearchParams(location.search).get('id') || localStorage.getItem('_myCompanyId');
      if (id) {
        const r = await apiFetch(`${SERVER_URL}/companies/${id}`);
        if (r.ok) {
          const c = await r.json();
          if (c.inn) markOnboardingStep('profile');
        }
      }
    } catch { /* тихо */ }
  }

  const role = localStorage.getItem('userRole') || '';
  if (role === 'producer' && (page === 'producer.html' || page === 'proposals.html')) {
    try {
      const r = await apiFetch(`${SERVER_URL}/proposals`);
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list) && list.length > 0) markOnboardingStep('proposal');
      }
    } catch { /* тихо */ }
  }

  if (role === 'customer') {
    try {
      const r = await apiFetch(`${SERVER_URL}/orders`);
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list) && list.length > 0) markOnboardingStep('order');
      }
    } catch { /* тихо */ }
  }
}

function initOnboarding() {
  _obMigrateChecklist();
  const page = location.pathname.split('/').pop() || 'index.html';
  const role = localStorage.getItem('userRole') || '';
  if (role !== 'customer' && role !== 'producer') return;

  const mainPage = role === 'producer' ? 'producer.html' : 'index.html';
  const onMainPage = page === mainPage || page === '';

  _obAutoCompleteFromPage();
  _initObChecklist(role);

  if (onMainPage && !localStorage.getItem(_OB_WELCOME_KEY)) {
    _showObWelcome(role);
  }
}

function _obStepHrefAttr(s) {
  if (s.action === 'openModal') {
    return `href="#" onclick="event.preventDefault();closeObWelcome();if(typeof openModal==='function')openModal();"`;
  }
  return `href="${escapeHtml(s.href)}" onclick="closeObWelcome()"`;
}

function _showObWelcome(role) {
  const company = localStorage.getItem('userCompany') || '';
  const steps = _obSteps(role);
  const isProducer = role === 'producer';

  const greeting = company ? `Добро пожаловать,<br><span class="ob-company">${escapeHtml(company)}</span>!` : 'Добро пожаловать<br>в ТехЗаказ!';
  const subtitle = isProducer
    ? 'Находите заявки, подавайте КП и выигрывайте контракты напрямую с заказчиками'
    : 'Размещайте закупки и получайте КП от проверенных поставщиков нефтесервисной отрасли';

  const stepsHtml = steps.map((s, i) => `
    <a class="ob-step" ${_obStepHrefAttr(s)}>
      <div class="ob-step-num">${i + 1}</div>
      <div class="ob-step-body">
        <strong>${escapeHtml(s.label)}</strong>
        <span>${escapeHtml(s.desc)}</span>
      </div>
      <svg class="ob-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </a>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'ob-overlay';
  overlay.id = 'obOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="ob-modal">
      <div class="ob-header">
        <div class="ob-logo-row">
          <div class="sidebar-logo-mark" aria-hidden="true"><span>Т</span></div>
          <span class="ob-logo-text">ТЕХ<b class="tz-accent">ЗАКАЗ</b></span>
        </div>
        <h2 class="ob-title">${greeting}</h2>
        <p class="ob-sub">${subtitle}</p>
      </div>
      <div class="ob-steps ob-steps-grid">${stepsHtml}</div>
      <div class="ob-footer">
        <button class="btn-primary ob-cta" onclick="closeObWelcome()">Начать работу →</button>
        <button class="ob-skip" onclick="closeObWelcome()">Пропустить</button>
      </div>
    </div>`;

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeObWelcome(); });
  document.addEventListener('keydown', _obEscHandler);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { requestAnimationFrame(() => overlay.classList.add('ob-visible')); });
}

function _obEscHandler(e) {
  if (e.key === 'Escape') { closeObWelcome(); document.removeEventListener('keydown', _obEscHandler); }
}

function closeObWelcome() {
  localStorage.setItem(_OB_WELCOME_KEY, '1');
  document.removeEventListener('keydown', _obEscHandler);
  const overlay = document.getElementById('obOverlay');
  if (!overlay) return;
  overlay.classList.remove('ob-visible');
  setTimeout(() => overlay.remove(), 280);
}

/* ---------- Чеклист «Начало работы» (виджет нижний правый) ---------- */

function _obRefreshChecklist() {
  const role = localStorage.getItem('userRole') || '';
  if (role !== 'customer' && role !== 'producer') return;
  const existing = document.getElementById('obChecklist');
  if (existing) existing.remove();
  _initObChecklist(role);
}

function _initObChecklist(role) {
  const steps = _obSteps(role);
  const done = _obDoneMap();
  const doneCount = steps.filter(s => done[s.id]).length;

  if (doneCount === steps.length) return;

  const collapsed = localStorage.getItem(_OB_COLLAPSED_KEY) === '1';
  const percent = Math.round((doneCount / steps.length) * 100);

  const itemsHtml = steps.map(s => {
    const isDone = !!done[s.id];
    const actionAttr = s.action ? ` data-action="${s.action}"` : '';
    return `
      <a class="ob-cl-item${isDone ? ' ob-cl-done' : ''}" href="${escapeHtml(s.href)}"${actionAttr}
         data-ob-id="${s.id}">
        <div class="ob-cl-check">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="2 6 5 9 10 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <span>${escapeHtml(s.label)}</span>
      </a>`;
  }).join('');

  const widget = document.createElement('div');
  widget.className = `ob-checklist${collapsed ? ' ob-cl-collapsed' : ''}`;
  widget.id = 'obChecklist';
  widget.innerHTML = `
    <div class="ob-cl-head" onclick="toggleObChecklist()">
      <div class="ob-cl-head-left">
        <div class="ob-cl-ring" style="--pct:${percent}">
          <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="var(--inner-border)" stroke-width="3"/><circle class="ob-cl-arc" cx="18" cy="18" r="14" fill="none" stroke="url(#obGrad)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${Math.round(percent * 0.879)} 100" transform="rotate(-90 18 18)"/><defs><linearGradient id="obGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF6A00"/><stop offset="100%" stop-color="#0B8FCE"/></linearGradient></defs></svg>
          <span>${doneCount}/${steps.length}</span>
        </div>
        <span class="ob-cl-title">Начало работы</span>
      </div>
      <svg class="ob-cl-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
    </div>
    <div class="ob-cl-body">
      <div class="ob-cl-items">${itemsHtml}</div>
      <button class="ob-cl-dismiss" onclick="dismissObChecklist()">Скрыть</button>
    </div>`;

  widget.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item || item.classList.contains('ob-cl-done')) return;
    const action = item.dataset.action;
    if (!action) return;
    e.preventDefault();
    markOnboardingStep(item.dataset.obId || 'order');
    if (action === 'openModal') {
      if (typeof window.openModal === 'function') window.openModal();
      else location.href = item.getAttribute('href') || 'index.html?create=1';
    }
  });

  document.body.appendChild(widget);
}

function toggleObChecklist() {
  const w = document.getElementById('obChecklist');
  if (!w) return;
  const isCollapsed = w.classList.toggle('ob-cl-collapsed');
  localStorage.setItem(_OB_COLLAPSED_KEY, isCollapsed ? '1' : '0');
}

function dismissObChecklist() {
  localStorage.setItem(_OB_CHECKLIST_KEY, JSON.stringify(
    Object.fromEntries(_obSteps(localStorage.getItem('userRole') || '').map(s => [s.id, true]))
  ));
  const w = document.getElementById('obChecklist');
  if (w) { w.classList.add('ob-cl-hiding'); setTimeout(() => w.remove(), 300); }
}

/* =====================================================================
   COMMAND PALETTE  — Ctrl/Cmd+K
   ===================================================================== */
(function initCommandPalette() {
  if (!hasSession()) return;

  const role = localStorage.getItem('userRole') || '';

  /* ── SVG icons (match sidebar exactly) ──────────────────────────── */
  const _svg = p => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const CP_ICONS = {
    home:     _svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    catalog:  _svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    proposal: _svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
    deals:    _svg('<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 12 2 2 4-4"/>'),
    delivery: _svg('<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>'),
    partners: _svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    analytics:_svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
    messages: _svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    favorites:_svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
    profile:  _svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    company:  _svg('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 16 0v1"/>'),
    settings: _svg('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
    map:     _svg('<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>'),
    create:  _svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    order:    _svg('<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>'),
  };

  /* ── Static navigation items ─────────────────────────────────────── */
  const NAV_ITEMS = [
    { title: 'Главная',         sub: 'Кабинет заказчика',       href: 'index.html',           icon: CP_ICONS.home,      roles: ['customer'] },
    { title: 'Кабинет',         sub: 'Активные заявки',          href: 'producer.html',        icon: CP_ICONS.home,      roles: ['producer'] },
    { title: 'Каталог',         sub: 'Поиск поставщиков',        href: 'catalog.html',         icon: CP_ICONS.catalog,   roles: ['customer','producer'] },
    { title: 'Мои КП',          sub: 'Коммерческие предложения', href: 'proposals.html',       icon: CP_ICONS.proposal,  roles: ['producer'] },
    { title: 'Сделки',          sub: 'Активные и завершённые',   href: 'deals.html',           icon: CP_ICONS.deals,     roles: ['customer','producer'] },
    { title: 'Доставки',        sub: 'Отслеживание доставок',    href: 'deliveries.html',      icon: CP_ICONS.delivery,  roles: ['customer','producer'] },
    { title: 'Контрагенты',     sub: 'Поставщики и заказчики',   href: 'partners.html',        icon: CP_ICONS.partners,  roles: ['customer','producer'] },
    { title: 'Аналитика',       sub: 'Статистика и отчёты',      href: 'analytics.html',       icon: CP_ICONS.analytics, roles: ['customer','producer'] },
    { title: 'Сообщения',       sub: 'Чаты с контрагентами',     href: 'messages.html',        icon: CP_ICONS.messages,  roles: ['customer','producer'] },
    { title: 'Избранное',       sub: 'Сохранённые компании',     href: 'favorites.html',       icon: CP_ICONS.favorites, roles: ['customer','producer'] },
    { title: 'Карта',           sub: 'Производства на карте',    href: 'map.html',             icon: CP_ICONS.map,       roles: ['customer','producer'] },
    { title: 'Профиль компании',sub: 'Реквизиты и настройки',    href: 'company-profile.html', icon: CP_ICONS.company,   roles: ['customer','producer'] },
    { title: 'Настройки',       sub: 'Профиль, уведомления',     href: 'settings.html',        icon: CP_ICONS.settings,  roles: ['customer','producer'] },
  ].filter(it => it.roles.includes(role) || it.roles.includes('all'));

  const ACTION_ITEMS = role === 'customer' ? [
    { title: 'Создать закупку', sub: 'Новая прямая закупка', href: 'index.html?create=1', icon: CP_ICONS.create },
  ] : [];

  /* ── Build DOM ───────────────────────────────────────────────────── */
  const backdrop = document.createElement('div');
  backdrop.className = 'cp-backdrop';
  backdrop.id = 'cpBackdrop';
  backdrop.innerHTML = `
    <div class="cp-box" id="cpBox">
      <div class="cp-input-row">
        <svg class="cp-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="cp-input" id="cpInput" placeholder="Поиск по разделам, закупкам…" autocomplete="off" spellcheck="false">
        <kbd class="cp-kbd">Esc</kbd>
      </div>
      <div class="cp-results" id="cpResults"></div>
      <div class="cp-footer">
        <span><kbd class="cp-kbd">↑↓</kbd> навигация</span>
        <span><kbd class="cp-kbd">↵</kbd> открыть</span>
        <span><kbd class="cp-kbd">Esc</kbd> закрыть</span>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) cpClose(); });

  const input = document.getElementById('cpInput');
  const results = document.getElementById('cpResults');
  let selectedIdx = -1;
  let _ordersCache = [];
  let _ordersLoaded = false;

  /* ── Fetch orders for search ─────────────────────────────────────── */
  async function cpLoadOrders() {
    if (_ordersLoaded) return;
    _ordersLoaded = true;
    try {
      const r = await apiFetch(`${SERVER_URL}/orders`);
      if (r.ok) _ordersCache = await r.json();
    } catch {}
  }

  /* ── Highlight match ─────────────────────────────────────────────── */
  function highlight(text, q) {
    if (!q) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx))
      + `<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`
      + escapeHtml(text.slice(idx + q.length));
  }

  /* ── Render results ──────────────────────────────────────────────── */
  function cpRender(q) {
    selectedIdx = -1;
    results.innerHTML = '';
    const ql = (q || '').toLowerCase().trim();

    /* Action shortcuts */
    const actionMatches = ACTION_ITEMS.filter(it =>
      !ql || it.title.toLowerCase().includes(ql) || it.sub.toLowerCase().includes(ql)
    );

    /* Navigation matches */
    const navMatches = NAV_ITEMS.filter(it =>
      !ql || it.title.toLowerCase().includes(ql) || it.sub.toLowerCase().includes(ql)
    );

    /* Order matches (only if logged in as customer) */
    const orderMatches = ql
      ? _ordersCache.filter(o =>
          (o.title || '').toLowerCase().includes(ql) ||
          (o.category || '').toLowerCase().includes(ql) ||
          ('зк-' + String(o.id).padStart(5,'0')).includes(ql)
        ).slice(0, 5)
      : [];

    if (!actionMatches.length && !navMatches.length && !orderMatches.length) {
      results.innerHTML = `<div class="cp-empty">Ничего не найдено по запросу «${escapeHtml(q)}»</div>`;
      return;
    }

    const frag = document.createDocumentFragment();

    if (actionMatches.length) {
      const lbl = document.createElement('div');
      lbl.className = 'cp-section-label';
      lbl.textContent = 'Действия';
      frag.appendChild(lbl);
      actionMatches.forEach(it => {
        const a = document.createElement('a');
        a.className = 'cp-item';
        a.href = it.href;
        a.innerHTML = `
          <div class="cp-item-icon cp-item-icon-svg">${it.icon}</div>
          <div class="cp-item-body">
            <div class="cp-item-title">${highlight(it.title, q)}</div>
            <div class="cp-item-sub">${escapeHtml(it.sub)}</div>
          </div>`;
        frag.appendChild(a);
      });
    }

    if (navMatches.length) {
      const lbl = document.createElement('div');
      lbl.className = 'cp-section-label';
      lbl.textContent = 'Разделы';
      frag.appendChild(lbl);
      navMatches.forEach(it => {
        const a = document.createElement('a');
        a.className = 'cp-item';
        a.href = it.href;
        a.innerHTML = `
          <div class="cp-item-icon cp-item-icon-svg">${it.icon}</div>
          <div class="cp-item-body">
            <div class="cp-item-title">${highlight(it.title, q)}</div>
            <div class="cp-item-sub">${escapeHtml(it.sub)}</div>
          </div>`;
        frag.appendChild(a);
      });
    }

    if (orderMatches.length) {
      const lbl = document.createElement('div');
      lbl.className = 'cp-section-label';
      lbl.textContent = 'Закупки';
      frag.appendChild(lbl);
      orderMatches.forEach(o => {
        const a = document.createElement('a');
        a.className = 'cp-item';
        a.href = 'index.html';
        a.dataset.orderId = o.id;
        a.innerHTML = `
          <div class="cp-item-icon cp-item-icon-svg">${CP_ICONS.order}</div>
          <div class="cp-item-body">
            <div class="cp-item-title">${highlight(o.title || '', q)}</div>
            <div class="cp-item-sub">ЗК-${String(o.id).padStart(5,'0')} · ${escapeHtml(o.category || '')} · ${escapeHtml(o.status || '')}</div>
          </div>`;
        frag.appendChild(a);
      });
    }

    results.appendChild(frag);
  }

  /* ── Keyboard navigation ─────────────────────────────────────────── */
  function cpMoveSelection(dir) {
    const items = results.querySelectorAll('.cp-item');
    if (!items.length) return;
    items[selectedIdx]?.classList.remove('cp-selected');
    selectedIdx = Math.max(0, Math.min(items.length - 1, selectedIdx + dir));
    items[selectedIdx].classList.add('cp-selected');
    items[selectedIdx].scrollIntoView({ block: 'nearest' });
  }

  /* ── Open / close ────────────────────────────────────────────────── */
  function cpOpen() {
    backdrop.classList.add('cp-open');
    input.value = '';
    cpRender('');
    requestAnimationFrame(() => input.focus());
    if (role === 'customer') cpLoadOrders();
  }
  function cpClose() {
    backdrop.classList.remove('cp-open');
  }

  /* ── Events ──────────────────────────────────────────────────────── */
  input.addEventListener('input', () => cpRender(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); cpMoveSelection(1); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); cpMoveSelection(-1); }
    if (e.key === 'Escape')     { cpClose(); }
    if (e.key === 'Enter') {
      const sel = results.querySelector('.cp-selected') || results.querySelector('.cp-item');
      if (sel) { sel.click(); cpClose(); }
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      backdrop.classList.contains('cp-open') ? cpClose() : cpOpen();
    }
  });

  /* Expose to header search button if any */
  window.openCommandPalette = cpOpen;
})();

