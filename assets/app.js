/* =====================================================================
   B2B НЕФТЕСЕРВИС — общие JS-утилиты (тема, уведомления, чат, select, auth)
   Подключается на каждой странице ДО page-specific <script>:
   <script src="assets/app.js"></script>
   ===================================================================== */

const SERVER_URL = 'http://localhost:5000/api';

/* ---------------------------------------------------------------------
   Auth guard / logout
   --------------------------------------------------------------------- */
// Вызвать на защищённых страницах: const session = authGuard('producer');
// requiredRole === null -> просто вернуть текущую сессию без редиректа.
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

function logout() {
  localStorage.clear();
  window.location.href = 'login.html';
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
   Mock-скачивание файла (вложения, экспорт реестра)
   --------------------------------------------------------------------- */
function downloadMockFile(filename, content) {
  const blob = new Blob([content || ('Файл: ' + filename)], { type: 'application/octet-stream' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

/* ---------------------------------------------------------------------
   Центр уведомлений
   --------------------------------------------------------------------- */
const currentCompanyName = localStorage.getItem('userCompany') || 'Гость';
const B2B_NOTIF_KEY = `b2b_notif_${currentCompanyName}`;

function initNotifications() {
  renderNotificationsCount();
  setTimeout(() => {
    const role = localStorage.getItem('userRole');
    const text = role === 'customer'
      ? 'Заказчик: Получен новый отклик с ценовым предложением.'
      : `Организация ${currentCompanyName} успешно прошла автоматическую верификацию по ИНН.`;
    addNotification(text);
  }, 6000);
}

function addNotification(text) {
  let list = JSON.parse(localStorage.getItem(B2B_NOTIF_KEY)) || [];
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (list.length > 0 && list[0].text === text) return;
  list.unshift({ text, time: timeStr, read: false });
  localStorage.setItem(B2B_NOTIF_KEY, JSON.stringify(list));
  renderNotificationsCount();
}

function renderNotificationsCount() {
  const list = JSON.parse(localStorage.getItem(B2B_NOTIF_KEY)) || [];
  const unreadCount = list.filter(n => !n.read).length;
  const badgeEl = document.getElementById('bellBadge');
  if (!badgeEl) return;
  badgeEl.style.display = unreadCount > 0 ? 'inline-block' : 'none';
  if (unreadCount > 0) badgeEl.innerText = unreadCount;
}

function openNotificationsModal() {
  const modal = document.getElementById('notificationModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const container = document.getElementById('notificationsList');
  let list = JSON.parse(localStorage.getItem(B2B_NOTIF_KEY)) || [];
  if (list.length === 0) {
    container.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-secondary);font-size:14px;">История уведомлений пуста</div>';
    return;
  }
  container.innerHTML = '';
  list.forEach(n => {
    const item = document.createElement('div');
    item.className = 'notification-item';
    item.innerHTML = `<div>${n.text}</div><div class="time">⏱ ${n.time}</div>`;
    container.appendChild(item);
    n.read = true;
  });
  localStorage.setItem(B2B_NOTIF_KEY, JSON.stringify(list));
  renderNotificationsCount();
}

function closeNotificationsModal() {
  const modal = document.getElementById('notificationModal');
  if (modal) modal.style.display = 'none';
}

function clearNotifications() {
  localStorage.removeItem(B2B_NOTIF_KEY);
  openNotificationsModal();
}

/* ---------------------------------------------------------------------
   Чат по закупке
   --------------------------------------------------------------------- */
let activeChatKey = null;

function openGlobalChat(orderId, orderTitle, company) {
  activeChatKey = `b2b_chat_${orderId}_${company}`;
  const titleEl = document.getElementById('chatModalTitle');
  if (titleEl) titleEl.innerText = `Чат по закупке: ${orderTitle}`;
  const modal = document.getElementById('chatModal');
  if (modal) modal.style.display = 'flex';
  renderChatHistory();
}

function closeChatModal() {
  const modal = document.getElementById('chatModal');
  if (modal) modal.style.display = 'none';
}

function renderChatHistory() {
  const container = document.getElementById('chatModalMessages');
  if (!container || !activeChatKey) return;
  container.innerHTML = '';
  let history = JSON.parse(localStorage.getItem(activeChatKey)) || [];
  if (history.length === 0) {
    history = [{ sender: 'system', text: 'Чат открыт. Обсудите технические параметры ТЗ напрямую с контрагентом.' }];
    localStorage.setItem(activeChatKey, JSON.stringify(history));
  }
  const myRole = localStorage.getItem('userRole');
  history.forEach(msg => {
    const bubble = document.createElement('div');
    if (msg.sender === 'system') {
      bubble.className = 'chat-bubble';
      bubble.style.background = 'transparent';
      bubble.style.color = 'var(--text-secondary)';
      bubble.style.textAlign = 'center';
      bubble.style.maxWidth = '100%';
      bubble.style.fontSize = '12px';
      bubble.style.fontStyle = 'italic';
      bubble.style.alignSelf = 'center';
    } else {
      bubble.className = msg.sender === myRole ? 'chat-bubble me' : 'chat-bubble partner';
    }
    bubble.innerText = msg.text;
    container.appendChild(bubble);
  });
  container.scrollTop = container.scrollHeight;
}

function sendGlobalChatMessage() {
  const input = document.getElementById('chatModalInput');
  if (!input || !input.value.trim() || !activeChatKey) return;
  let history = JSON.parse(localStorage.getItem(activeChatKey)) || [];
  history.push({ sender: localStorage.getItem('userRole'), text: input.value.trim() });
  localStorage.setItem(activeChatKey, JSON.stringify(history));
  input.value = '';
  renderChatHistory();
}
