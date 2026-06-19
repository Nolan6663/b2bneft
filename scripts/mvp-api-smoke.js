'use strict';

const assert = require('assert');

const baseUrl = (process.env.MVP_SMOKE_BASE_URL || '').replace(/\/+$/, '');
const shouldRun = process.env.MVP_SMOKE_RUN === '1';

if (!shouldRun || !baseUrl) {
  console.log('Skipped MVP API smoke. Set MVP_SMOKE_RUN=1 and MVP_SMOKE_BASE_URL=https://.../api to run it.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const password = 'MvpTest2026!';
const customer = {
  email: `mvp.customer.${stamp}@example.com`,
  company: `MVP Test Customer ${stamp}`,
  inn: `77${stamp}`,
  role: 'customer',
};
const producer = {
  email: `mvp.producer.${stamp}@example.com`,
  company: `MVP Test Producer ${stamp}`,
  inn: `78${stamp}`,
  role: 'producer',
};
const outsider = {
  email: `mvp.outsider.${stamp}@example.com`,
  company: `MVP Test Outsider ${stamp}`,
  inn: `79${stamp}`,
  role: 'producer',
};

async function request(path, { method = 'GET', token, body, expected = [200] } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const expectedList = Array.isArray(expected) ? expected : [expected];
  assert(
    expectedList.includes(response.status),
    `${method} ${path} expected ${expectedList.join('/')} got ${response.status}: ${text}`
  );
  return { status: response.status, data };
}

async function register(user) {
  const { data } = await request('/auth/register', {
    method: 'POST',
    expected: 201,
    body: { ...user, password },
  });
  assert(data.token, `Registration did not return token for ${user.email}`);
  return data;
}

async function main() {
  const health = await request('/health');
  assert.strictEqual(health.data.ok, true, 'health must be ok');
  assert.strictEqual(health.data.db, true, 'database health must be ok');

  const customerSession = await register(customer);
  const producerSession = await register(producer);
  const outsiderSession = await register(outsider);

  const order = await request('/orders', {
    method: 'POST',
    token: customerSession.token,
    expected: 201,
    body: {
      title: `MVP smoke order ${stamp}`,
      category: 'РТИ',
      deadline: '30.06.2026',
      quantity: 12,
      description: 'Automated MVP API smoke order.',
    },
  });

  const proposal = await request('/proposals', {
    method: 'POST',
    token: producerSession.token,
    expected: 201,
    body: {
      orderId: order.data.id,
      orderTitle: order.data.title,
      price: 123456,
      days: 7,
    },
  });

  const customerProposals = await request(`/order-proposals/${order.data.id}`, { token: customerSession.token });
  assert.strictEqual(customerProposals.data.length, 1, 'customer must see one proposal');

  const producerProposals = await request(`/order-proposals/${order.data.id}`, { token: producerSession.token });
  assert.strictEqual(producerProposals.data.length, 1, 'producer must see own proposal');

  const outsiderProposals = await request(`/order-proposals/${order.data.id}`, { token: outsiderSession.token });
  assert.strictEqual(outsiderProposals.data.length, 0, 'outsider must not see proposals');

  await request('/messages', {
    method: 'POST',
    token: producerSession.token,
    expected: 201,
    body: { orderId: order.data.id, company: producer.company, text: 'Producer smoke message' },
  });
  await request('/messages', {
    method: 'POST',
    token: customerSession.token,
    expected: 201,
    body: { orderId: order.data.id, company: producer.company, text: 'Customer smoke message' },
  });

  const chat = await request(`/messages/${order.data.id}/${encodeURIComponent(producer.company)}`, {
    token: customerSession.token,
  });
  assert.strictEqual(chat.data.length, 2, 'chat history must contain two messages');

  await request(`/messages/${order.data.id}/${encodeURIComponent(producer.company)}`, {
    token: outsiderSession.token,
    expected: 403,
  });

  await request(`/proposals/${proposal.data.id}/accept`, {
    method: 'POST',
    token: customerSession.token,
    body: {},
  });

  const customerDeals = await request('/deals', { token: customerSession.token });
  assert(customerDeals.data.some(deal => deal.proposalId === proposal.data.id), 'customer must see accepted deal');

  const delivery = await request(`/deals/${proposal.data.id}/delivery`, { token: producerSession.token });
  assert.strictEqual(delivery.data.deal.delivery_stage, 'КП принят', 'initial delivery stage must be accepted');

  await request(`/deals/${proposal.data.id}/delivery/stage`, {
    method: 'POST',
    token: producerSession.token,
    body: { stage: 'Отгружен', notes: 'MVP smoke shipped', trackingNumber: `MVP-${stamp}` },
  });

  const updatedDelivery = await request(`/deals/${proposal.data.id}/delivery`, { token: producerSession.token });
  assert.strictEqual(updatedDelivery.data.deal.delivery_stage, 'Отгружен', 'delivery stage must update');
  assert.strictEqual(updatedDelivery.data.deal.tracking_number, `MVP-${stamp}`, 'tracking number must update');

  console.log(`MVP API smoke passed: order=${order.data.id}, proposal=${proposal.data.id}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
