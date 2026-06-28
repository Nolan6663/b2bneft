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
  if (navProposals) navProposals.style.display = role === 'customer' ? 'none' : '';
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

async function initSidebarBadges() {
  const role = localStorage.getItem('userRole');
  if (!hasSession()) return;
  try {
    const r = await apiFetch(`${SERVER_URL}/dashboard/counts`);
    if (!r.ok) return;
    const counts = await r.json();
    if (role === 'producer') {
      _setBadge('navBadgeOrders',    counts.activeOrders);
      _setBadge('navBadgeProposals', counts.pendingProposals);
    } else {
      _setBadge('navBadgeOrders',    counts.myActiveOrders);
      _setBadge('navBadgeProposals', counts.newResponses);
    }
    _setBadge('navBadgeMessages', counts.unreadMessages);
  } catch { /* сервер недоступен — тихо */ }
}

/* ---------------------------------------------------------------------
   Sidebar extras — промо-виджет, блок поддержки, кнопка сворачивания
   --------------------------------------------------------------------- */
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
}

function initSidebarExtra() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    sidebar.classList.add('collapsed');
  }
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

