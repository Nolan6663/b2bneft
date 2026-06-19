/* =====================================================================
   B2B НЕФТЕСЕРВИС — общие JS-утилиты (тема, уведомления, чат, select, auth)
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

/* ---------------------------------------------------------------------
   Светлая / тёмная тема
   --------------------------------------------------------------------- */
function applyStoredTheme() {
  const stored = localStorage.getItem('theme');
  const isDark = stored === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.documentElement.classList.toggle('light-mode', !isDark);
  syncThemeUI(!isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.documentElement.classList.toggle('light-mode', !isDark);
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  syncThemeUI(!isDark);
}

function syncThemeUI(isLight) {
  const checkbox = document.getElementById('themeCheckbox');
  if (checkbox) checkbox.checked = isLight;
  const label = document.getElementById('themeLabel');
  if (label) label.innerText = isLight ? '☀️ Светлая тема' : '🌙 Тёмная тема';
  const icon = document.getElementById('themeIcon');
  if (icon) icon.innerText = isLight ? '☀️' : '🌙';
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
  initNotifications();
  initSidebarBadges();
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
   Auth guard / logout
   --------------------------------------------------------------------- */
function authGuard(requiredRole) {
  const token = localStorage.getItem('authToken');
  const role = localStorage.getItem('userRole');
  const company = localStorage.getItem('userCompany');
  if (requiredRole && token && role !== requiredRole) {
    window.location.href = 'login.html';
    return null;
  }
  return { token, role, company, isGuest: !token };
}

async function logout() {
  const refreshToken = localStorage.getItem('refreshToken');
  if (refreshToken) {
    try {
      await fetch(`${SERVER_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
    } catch { /* тихо */ }
  }
  localStorage.clear();
  window.location.href = 'login.html';
}

async function apiFetch(url, options = {}) {
  if (!options.headers) options.headers = {};
  const token = localStorage.getItem('authToken');
  if (token) options.headers['Authorization'] = 'Bearer ' + token;

  let response = await fetch(url, options);

  if (response.status === 401) {
    const refreshToken = localStorage.getItem('refreshToken');
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${SERVER_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          localStorage.setItem('authToken', data.token);
          options.headers['Authorization'] = 'Bearer ' + data.token;
          response = await fetch(url, options);
        } else {
          localStorage.clear();
          window.location.href = 'login.html';
        }
      } catch {
        localStorage.clear();
        window.location.href = 'login.html';
      }
    }
  }

  return response;
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

if (typeof io === 'function') {
  try {
    socket = io(SERVER_URL.replace(/\/api$/, ''), { transports: ['websocket', 'polling'] });

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
  try {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    const response = await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
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
    const token = localStorage.getItem('authToken');
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const response = await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, { headers });
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

    await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}/read`, { method: 'POST', headers });
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
    const token = localStorage.getItem('authToken');
    await fetch(`${SERVER_URL}/notifications/${encodeURIComponent(currentCompanyName)}`, {
      method: 'DELETE',
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
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
      const msg = r.status === 403
        ? 'Чтобы начать чат — сначала отправьте предложение на эту закупку'
        : (err.error || 'Не удалось отправить сообщение');
      showToast(msg);
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
  const token = localStorage.getItem('authToken');
  const role  = localStorage.getItem('userRole');
  if (!token) return;
  try {
    const r = await fetch(`${SERVER_URL}/dashboard/counts`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
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

  sidebar.querySelectorAll('a').forEach(link => {
    Array.from(link.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        const span = document.createElement('span');
        span.className = 'nav-label';
        span.textContent = node.textContent;
        link.replaceChild(span, node);
      }
    });
  });

  const oldBottom = sidebar.querySelector('.sidebar-bottom');
  if (oldBottom) oldBottom.remove();

  const spacer = document.createElement('div');
  spacer.className = 'sidebar-spacer';
  sidebar.appendChild(spacer);

  const promo = document.createElement('div');
  promo.className = 'sidebar-promo';
  promo.innerHTML = `
    <div class="sidebar-promo-img"></div>
    <div class="sidebar-promo-text">Автоматизация закупок<br>для нефтегазовой отрасли</div>
    <a href="#" class="sidebar-promo-btn">Подробнее</a>`;
  sidebar.appendChild(promo);

  const support = document.createElement('div');
  support.className = 'sidebar-support';
  support.innerHTML = `
    <div class="sidebar-support-head">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Нужна помощь?
    </div>
    <div class="sidebar-support-sub">Служба поддержки 24/7</div>
    <div class="sidebar-support-phone">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.6a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 3h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 10.6a16 16 0 0 0 6 6l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.9 18z"/></svg>
      8 800 555-27-27
    </div>`;
  sidebar.appendChild(support);

  const colBtn = document.createElement('button');
  colBtn.className = 'sidebar-collapse-btn';
  colBtn.onclick = toggleSidebar;
  colBtn.innerHTML = `
    <svg class="sidebar-collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    <span class="sidebar-collapse-label">Свернуть меню</span>`;
  sidebar.appendChild(colBtn);

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
  const header = document.querySelector('.header') || document.querySelector('.msg-header');
  if (!header) return;

  const oldBell = header.querySelector('.bell-btn');
  if (oldBell) oldBell.remove();

  const company   = localStorage.getItem('userCompany') || '';
  const role      = localStorage.getItem('userRole') || '';
  const roleLabel = role === 'customer' ? 'Заказчик'
                  : role === 'producer' ? 'Производитель'
                  : role === 'admin'    ? 'Администратор' : '';

  const clean    = company.replace(/[«»""']/g, '').replace(/^(ООО|АО|ЗАО|ИП|ПАО)\s+/i, '').trim();
  const initials = (clean || company).slice(0, 2).toUpperCase() || 'ББ';

  const right = document.createElement('div');
  right.className = 'header-right';
  right.innerHTML = `
    <div class="theme-switch-wrap">
      <span class="theme-sun" aria-hidden="true">☀</span>
      <span class="theme-switch-label" id="themeLabelLight">Светлая</span>
      <div class="theme-switch" onclick="toggleTheme()" id="themeSwitch" title="Сменить тему">
        <div class="theme-switch-knob"></div>
      </div>
      <span class="theme-switch-label" id="themeLabelDark">Тёмная</span>
    </div>
    <button class="bell-btn" onclick="openNotificationsModal()">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <span class="bell-badge" id="bellBadge" style="display:none;"></span>
    </button>
    <div class="user-menu" id="userMenu" onclick="toggleUserMenu(event)">
      <div class="user-avatar-pill">${escapeHtml(initials)}</div>
      <div class="user-info-block">
        <div class="user-company-name">${escapeHtml(company || 'Гость')}</div>
        <div class="user-role-name">${escapeHtml(roleLabel || 'Иванов И.И.')}</div>
      </div>
      <svg class="user-menu-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      <div class="user-dropdown" id="userDropdown">
        <a href="settings.html" class="user-dropdown-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Настройки
        </a>
        <a href="company-profile.html" class="user-dropdown-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          Профиль компании
        </a>
        <div class="user-dropdown-sep"></div>
        <button class="user-dropdown-item danger" onclick="logout()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Выйти из аккаунта
        </button>
      </div>
    </div>`;

  header.appendChild(right);

  document.addEventListener('click', e => {
    const menu = document.getElementById('userMenu');
    if (menu && !menu.contains(e.target)) {
      const dd = document.getElementById('userDropdown');
      if (dd) dd.classList.remove('open');
    }
  });
}
