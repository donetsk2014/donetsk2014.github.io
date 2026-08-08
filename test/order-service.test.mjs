import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOrderService } from '../server/order-service.mjs';

async function boot() {
  const directory = await mkdtemp(join(tmpdir(), 'donetsk2014-orders-'));
  const messages = [];
  const service = createOrderService({
    dataDirectory: directory,
    allowedOrigins: ['https://donetsk2014.github.io'],
    telegramChatId: '871897952',
    telegramWebhookSecret: 'test-webhook-secret',
    sendTelegram: async (message) => messages.push(message)
  });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const address = service.server.address();

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    messages,
    service,
    async close() {
      await new Promise((resolve) => service.server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('stores a parcel-locker order and returns Telegram statistics', async () => {
  const app = await boot();
  try {
    const submission = await fetch(`${app.endpoint}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://donetsk2014.github.io'
      },
      body: JSON.stringify({
        customerName: 'Ірина Тестова',
        phone: '+380 99 123 45 67',
        contactChannel: 'Telegram',
        quantity: 2,
        donation: 50,
        requestId: 'checkout-test-001',
        deliveryMode: 'parcel_locker',
        city: 'Київ',
        deliveryPoint: '№1001, вул. Хрещатик, 1'
      })
    });
    const created = await submission.json();

    assert.equal(submission.status, 201);
    assert.equal(created.ok, true);
    assert.match(created.id, /^K14-\d{8}-[A-F0-9]{6}$/);
    const [storedOrder] = await app.service.store.list();
    assert.equal(storedOrder.city, 'Київ');
    assert.equal(storedOrder.deliveryPoint, '№1001, вул. Хрещатик, 1');
    assert.match(app.messages[0].text, /Поштомат НП/);

    const retry = await fetch(`${app.endpoint}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://donetsk2014.github.io'
      },
      body: JSON.stringify({
        customerName: 'Ірина Тестова',
        phone: '+380 99 123 45 67',
        contactChannel: 'Telegram',
        quantity: 2,
        donation: 50,
        requestId: 'checkout-test-001',
        deliveryMode: 'parcel_locker',
        city: 'Київ',
        deliveryPoint: '№1001, вул. Хрещатик, 1'
      })
    });
    const retried = await retry.json();
    assert.equal(retry.status, 201);
    assert.equal(retried.id, created.id);
    assert.equal((await app.service.store.list()).length, 1);
    assert.equal(app.messages.length, 1);

    const stats = await fetch(`${app.endpoint}/api/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret'
      },
      body: JSON.stringify({
        message: { chat: { id: 871897952 }, text: '/orders' }
      })
    });

    assert.equal(stats.status, 200);
    assert.match(app.messages[1].text, /Статистика замовлень/);
    assert.match(app.messages[1].text, /поштомати 1/);
  } finally {
    await app.close();
  }
});

test('rejects orders submitted from another website origin', async () => {
  const app = await boot();
  try {
    const response = await fetch(`${app.endpoint}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 403);
  } finally {
    await app.close();
  }
});

test('requires a usable city and a manually entered delivery point', async () => {
  const app = await boot();
  try {
    const response = await fetch(`${app.endpoint}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://donetsk2014.github.io'
      },
      body: JSON.stringify({
        customerName: 'Ірина Тестова',
        phone: '+380 99 123 45 67',
        contactChannel: 'Viber',
        quantity: 1,
        donation: 0,
        deliveryMode: 'branch',
        city: 'К',
        deliveryPoint: ''
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.match(payload.error, /місто доставки/);
  } finally {
    await app.close();
  }
});
