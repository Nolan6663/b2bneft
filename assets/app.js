/* =====================================================================
   ТЕХЗАКАЗ — общие JS-утилиты (тема, уведомления, чат, select, auth)
   Подключается на каждой странице ДО page-specific <script>:
   <script src="assets/app.js"></script>
   ===================================================================== */

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
  if (label) label.innerText = isDark ? '🌙 Тёмная тема' : '☀️ Светлая тема';
  const icon = document.getElementById('themeIcon');
  if (icon) icon.innerHTML = isDark ? _SUN_SVG : _MOON_SVG;
}

function initSidebarRole() {
  const role = localStorage.getItem('userRole');
  const mainLink = document.getElementById('mainCabinetLink');
  if (mainLink) mainLink.href = role === 'producer' ? 'producer.html' : 'index.html';
  const navProposals = document.getElementById('navProposals');
  if (navProposals) navProposals.style.display = role === 'producer' ? '' : 'none';
  // Show profile link immediately from cache — avoids async flash
  const companyId = localStorage.getItem('_myCompanyId');
  if (companyId && (role === 'customer' || role === 'producer')) {
    const spl = document.getElementById('sidebarProfileLink');
    if (spl) { spl.href = `company-profile.html?id=${companyId}`; spl.style.display = ''; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyStoredTheme();
  initSidebarRole();
  initSidebarExtra();
  initHeaderRight();
  if (hasSession()) {
    showEmailVerificationBanner();
    initNotifications();
    initSidebarBadges();
  }
  if (hasSession() && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/assets/sw.js').catch(e =>
      console.warn('[SW] registration failed:', e.message)
    );
  }
  initSpaRouter();
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
function showToast(text, type) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  // Deduplicate: skip if same message already visible
  for (const el of container.querySelectorAll('.toast-text')) {
    if (el.textContent === text) return;
  }
  const icon = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : '🔔';
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' toast-' + type : '');
  toast.innerHTML = `<div class="toast-icon">${icon}</div><div class="toast-text">${escapeHtml(text)}</div><button class="toast-close" aria-label="Закрыть">✕</button>`;
  const dismiss = () => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 220);
  };
  toast.querySelector('.toast-close').onclick = dismiss;
  container.appendChild(toast);
  setTimeout(dismiss, 5000);
}

/* ---------------------------------------------------------------------
   Живые обновления через Socket.IO — чат и уведомления приходят мгновенно,
   без ожидания следующего тика поллинга. Поллинг ниже остаётся как
   подстраховка (если соединение оборвалось/не успело переподключиться).
   --------------------------------------------------------------------- */
const currentCompanyName = localStorage.getItem('userCompany') || 'Гость';
let socket = null;

if (typeof io === 'function' && hasSession()) {
  try {
    socket = io(SERVER_URL.replace(/\/api$/, ''), {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      if (currentCompanyName !== 'Гость') socket.emit('join-company', currentCompanyName);
      if (activeChatOrderId != null) socket.emit('join-chat', { orderId: activeChatOrderId, company: activeChatCompany });
    });

    socket.on('notification', (entry) => {
      if (entry.company !== currentCompanyName) return;
      showToast(entry.text);
      refreshNotificationBadge();
    });

    socket.on('message', (msg) => {
      if (activeChatOrderId != null && msg.orderId === activeChatOrderId && msg.company === activeChatCompany) {
        renderChatHistory();
      }
    });
  } catch { /* socket.io недоступен — поллинг */ }
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
  notifPollInterval = setInterval(refreshNotificationBadge, 25000);
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
  const btn = document.querySelector('.bell-btn');
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
      listEl.innerHTML = '<div class="notif-empty"><div class="notif-empty-icon">🔔</div>Уведомлений пока нет</div>';
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
  const btn = document.querySelector('.bell-btn');
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
  chatPollInterval = setInterval(renderChatHistory, 15000);
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
  return `<span style="display:inline-flex;align-items:center;gap:3px;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600;${style}" title="${escapeHtml(tip)}">🧩 ${score}%</span>`;
}

function normalizeProposalForCompare(p) {
  return {
    ...p,
    _name: p.company || p.companyName || p.supplier || '—',
    _price: Number(p.price) || 0,
    _days: Number(p.leadTime != null ? p.leadTime : p.days) || 0,
    _match: p.matchScore != null ? Number(p.matchScore) : null,
    _matchReasons: Array.isArray(p.matchReasons) ? p.matchReasons : [],
  };
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

  const scored = props.map(p => {
    const ps = maxP > minP ? (p._price - minP) / (maxP - minP) : 0;
    const ds = maxD > minD ? (p._days - minD) / (maxD - minD) : 0;
    return { ...p, _rankScore: ps * 0.5 + ds * 0.5 };
  }).sort((a, b) => a._rankScore - b._rankScore);

  const bestPrice = scored.find(p => p._price === minP)?._name || '—';
  const fastest = scored.find(p => p._days === minD)?._name || '—';
  const summaryHtml = [
    { icon: '💰', label: 'Лучшая цена', val: escapeHtml(bestPrice), color: '#12A866' },
    { icon: '⚡', label: 'Быстрее всех', val: escapeHtml(fastest), color: '#3B82F6' },
    { icon: '🏆', label: 'Рекомендуем', val: escapeHtml(scored[0]?._name || '—'), color: '#FF6A00' },
  ].map(b => `<div style="background:var(--inner-bg);border:1px solid var(--card-border);border-radius:10px;padding:10px 14px;flex:1;min-width:140px;">
    <div style="font-size:11px;color:var(--text-secondary);font-weight:600;margin-bottom:4px;">${b.icon} ${b.label}</div>
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
    const stars = rank === 0 ? '★★★' : rank === 1 ? '★★☆' : '★☆☆';
    const starColor = rank === 0 ? '#FF6A00' : rank === 1 ? '#F59E0B' : '#94A3B8';
    const priceBg = isBP ? 'background:rgba(18,168,102,.1);' : isWP ? 'background:rgba(224,112,112,.07);' : '';
    const daysBg = isBD ? 'background:rgba(59,130,246,.1);' : isWD ? 'background:rgba(224,112,112,.07);' : '';
    const acceptCell = showAccept
      ? `<button class="btn-primary" style="font-size:12px;padding:6px 12px;" onclick="${acceptFn}(${p.id || 0}, ${JSON.stringify(p._name)})">Выбрать</button>`
      : '';
    return `<tr style="${rank === 0 ? 'background:rgba(255,106,0,.04);' : ''}border-bottom:1px solid var(--inner-border);">
      <td style="padding:11px 12px;font-weight:700;color:var(--text-secondary);">${rank + 1}</td>
      <td style="padding:11px 12px;">
        <div style="font-weight:600;color:var(--text-primary);">${escapeHtml(p._name)}</div>
        ${rank === 0 ? '<div style="font-size:11px;color:#FF6A00;font-weight:600;margin-top:2px;">✓ Рекомендуется</div>' : ''}
      </td>
      ${showMatch ? `<td style="padding:11px 12px;">${matchScoreBadge(p._match, p._matchReasons)}</td>` : ''}
      <td style="padding:11px 12px;font-weight:700;font-family:'JetBrains Mono',monospace;${priceBg}">${priceFmt(p._price)}${isBP ? '<span style="color:#12A866;font-size:11px;"> лучшая</span>' : pDev}</td>
      <td style="padding:11px 12px;${daysBg}">${p._days ? p._days + ' дн.' : '—'}${isBD ? '<span style="color:#3B82F6;font-size:11px;"> быстрее</span>' : dDev}</td>
      <td style="padding:11px 12px;color:${starColor};font-size:14px;letter-spacing:2px;">${stars}</td>
      ${showAccept ? `<td style="padding:11px 12px;">${acceptCell}</td>` : ''}
    </tr>`;
  }).join('');

  return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;">${summaryHtml}</div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:var(--inner-bg);">
          <th style="${thStyle}">#</th>
          <th style="${thStyle}">Поставщик</th>
          ${showMatch ? `<th style="${thStyle}">Профиль</th>` : ''}
          <th style="${thStyle}">Цена</th>
          <th style="${thStyle}">Срок</th>
          <th style="${thStyle}">Рейтинг</th>
          ${showAccept ? `<th style="${thStyle}">Действие</th>` : ''}
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:14px;margin-top:14px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);"><div style="width:10px;height:10px;border-radius:2px;background:rgba(18,168,102,.15);border:1px solid #12A866;"></div>Лучшая цена</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);"><div style="width:10px;height:10px;border-radius:2px;background:rgba(59,130,246,.15);border:1px solid #3B82F6;"></div>Лучший срок</div>
      ${showMatch ? '<div style="font-size:11px;color:var(--text-secondary);">🧩 — совпадение специализации с закупкой</div>' : ''}
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
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function subscribeToPush() {
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await apiFetch(`${SERVER_URL}/push/vapid-key`).then(r => r.json());
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await apiFetch(`${SERVER_URL}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  return sub;
}

async function unsubscribeFromPush() {
  const sub = await getPushSubscription();
  if (sub) await sub.unsubscribe();
  await apiFetch(`${SERVER_URL}/push/subscribe`, { method: 'DELETE' });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/* ---------------------------------------------------------
   SPA-роутер: подменяет только #spa-content при навигации,
   сайдбар остаётся нетронутым.
--------------------------------------------------------- */
const SPA_EXCLUDE = ['/login', '/login.html', '/landing', '/landing.html'];

function isSpaUrl(url) {
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) return false;
    if (SPA_EXCLUDE.some(p => u.pathname === p || u.pathname === p.replace('.html', ''))) return false;
    if (/\/(api|uploads|assets)\//.test(u.pathname)) return false;
    return true;
  } catch { return false; }
}

let _spaNavigating = false;

async function spaNavigate(url) {
  if (_spaNavigating) return;
  _spaNavigating = true;

  const target = new URL(url, location.origin);

  // Close mobile sidebar before navigating
  const _sb = document.querySelector('.sidebar');
  const _ov = document.getElementById('sidebarOverlay');
  if (_sb) _sb.classList.remove('open');
  if (_ov) _ov.classList.remove('visible');

  if (typeof window.__pageCleanup === 'function') {
    try { window.__pageCleanup(); } catch {}
    window.__pageCleanup = null;
  }
  window.__pageInit = null;

  let html;
  try {
    const res = await fetch(target.href, { credentials: 'include' });
    if (!res.ok) { _spaNavigating = false; location.href = url; return; }
    html = await res.text();
  } catch {
    _spaNavigating = false; location.href = url;
    return;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const newContent = doc.getElementById('spa-content');
  const currentContent = document.getElementById('spa-content');
  if (!newContent || !currentContent) {
    _spaNavigating = false; location.href = url;
    return;
  }

  currentContent.innerHTML = newContent.innerHTML;
  document.title = doc.title || document.title;
  history.pushState({ spaUrl: url }, '', target.pathname + target.search);

  document.querySelectorAll('.sidebar a, aside a').forEach(a => {
    a.classList.toggle('active', a.pathname === target.pathname);
  });

  const scripts = doc.querySelectorAll('script:not([src])');
  for (const script of scripts) {
    const code = script.textContent || '';
    if (!code.includes('__pageInit') && !code.includes('__pageCleanup')) continue;
    try {
      const s = document.createElement('script');
      s.textContent = code;
      document.head.appendChild(s);
      document.head.removeChild(s);
    } catch (e) { console.error('[spa] script error:', e); }
  }

  if (typeof window.__pageInit === 'function') {
    try { window.__pageInit(); } catch (e) { console.error('[spa] pageInit error:', e); }
  }

  _spaNavigating = false;
}

window.__spaNavigate = spaNavigate;

function initSpaRouter() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank') return;
    if (!isSpaUrl(href)) return;
    if (!a.closest('aside, .sidebar, nav, .nav')) return;
    e.preventDefault();
    spaNavigate(href);
  });

  window.addEventListener('popstate', (e) => {
    if (e.state?.spaUrl || document.getElementById('spa-content')) {
      spaNavigate(location.pathname + location.search);
    }
  });
}

