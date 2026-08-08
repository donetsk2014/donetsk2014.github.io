import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY_BYTES = 16_000;
const ORDER_LIMIT = 5;
const ORDER_WINDOW_MS = 15 * 60 * 1000;
const DELIVERY_MODES = new Set(['branch', 'parcel_locker', 'abroad']);
const CONTACT_CHANNELS = new Set(['Viber', 'Telegram', 'WhatsApp', 'Phone']);
const KYIV_TIME_ZONE = 'Europe/Kyiv';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function envNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createConfig(overrides = {}) {
  const dataDirectory = overrides.dataDirectory || process.env.DATA_DIR || '/var/lib/donetsk2014-orders';
  const origins = overrides.allowedOrigins || String(process.env.ALLOWED_ORIGINS || 'https://donetsk2014.github.io')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    port: envNumber(overrides.port ?? process.env.PORT, 5081),
    dataFile: overrides.dataFile || join(dataDirectory, 'orders.json'),
    allowedOrigins: new Set(origins),
    bookPrice: envNumber(overrides.bookPrice ?? process.env.BOOK_PRICE, 250),
    novaPoshtaApiKey: overrides.novaPoshtaApiKey ?? process.env.NOVAPOSHTA_API_KEY ?? '',
    telegramBotToken: overrides.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: String(overrides.telegramChatId ?? process.env.TELEGRAM_CHAT_ID ?? ''),
    telegramWebhookSecret: overrides.telegramWebhookSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    fetch: overrides.fetch || globalThis.fetch,
    sendTelegram: overrides.sendTelegram || null,
    novaRequest: overrides.novaRequest || null
  };
}

function normalizeText(value, maxLength) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (normalized.length > maxLength) throw new ApiError(422, 'Занадто довге значення у формі.');
  return normalized;
}

function boundedInteger(value, minimum, maximum, fieldName) {
  const normalized = String(value ?? '').trim();
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(422, `Перевірте поле «${fieldName}».`);
  }
  return parsed;
}

function isSafePhone(value) {
  return /^[+()\d\s-]{7,30}$/.test(value);
}

function safeEqual(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function getClientIp(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

function createRateLimiter() {
  const attempts = new Map();

  return {
    take(key) {
      const now = Date.now();
      const active = (attempts.get(key) || []).filter((time) => now - time < ORDER_WINDOW_MS);
      if (active.length >= ORDER_LIMIT) return false;
      active.push(now);
      attempts.set(key, active);
      return true;
    }
  };
}

function createStore(file) {
  let queue = Promise.resolve();

  async function readState() {
    await mkdir(dirname(file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return {
        version: 1,
        orders: Array.isArray(parsed.orders) ? parsed.orders : []
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, orders: [] };
      throw error;
    }
  }

  async function writeState(state) {
    const temporaryFile = `${file}.tmp`;
    await writeFile(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporaryFile, file);
  }

  return {
    async add(order) {
      const operation = queue.then(async () => {
        const state = await readState();
        state.orders.push(order);
        await writeState(state);
        return order;
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    async list() {
      await queue;
      return (await readState()).orders;
    }
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) fail(new ApiError(413, 'Форма завелика.'));
    });
    request.on('end', () => {
      if (settled) return;
      try {
        const payload = JSON.parse(body || '{}');
        settled = true;
        resolve(payload);
      } catch {
        fail(new ApiError(400, 'Не вдалося прочитати форму.'));
      }
    });
    request.on('error', () => fail(new ApiError(400, 'Не вдалося прочитати форму.')));
  });
}

function resolveCors(request, config) {
  const origin = String(request.headers.origin || '');
  return { origin, allowed: !origin || config.allowedOrigins.has(origin) };
}

function sendJson(response, status, payload, corsOrigin = '') {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff'
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers.Vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function sendOptions(response, corsOrigin) {
  response.writeHead(204, {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  });
  response.end();
}

function kyivDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function orderSummary(orders) {
  const summary = {
    orders: orders.length,
    books: 0,
    revenue: 0,
    donations: 0,
    newOrders: 0,
    branch: 0,
    parcelLocker: 0,
    abroad: 0
  };

  for (const order of orders) {
    summary.books += Number(order.quantity || 0);
    summary.revenue += Number(order.total || 0);
    summary.donations += Number(order.donation || 0);
    if (order.status === 'new') summary.newOrders += 1;
    if (order.deliveryMode === 'branch') summary.branch += 1;
    if (order.deliveryMode === 'parcel_locker') summary.parcelLocker += 1;
    if (order.deliveryMode === 'abroad') summary.abroad += 1;
  }

  return summary;
}

function formatNumber(value) {
  return new Intl.NumberFormat('uk-UA').format(value);
}

function formatStats(orders) {
  const todayKey = kyivDateKey();
  const monthKey = todayKey.slice(0, 7);
  const today = orderSummary(orders.filter((order) => kyivDateKey(new Date(order.createdAt)) === todayKey));
  const month = orderSummary(orders.filter((order) => kyivDateKey(new Date(order.createdAt)).slice(0, 7) === monthKey));
  const all = orderSummary(orders);
  const last = orders.at(-1);

  return [
    '📚 Статистика замовлень',
    '',
    `Сьогодні: ${today.orders} замовлень, ${today.books} книг, ${formatNumber(today.revenue)} ₴`,
    `Цього місяця: ${month.orders} замовлень, ${month.books} книг, ${formatNumber(month.revenue)} ₴`,
    `Усього: ${all.orders} замовлень, ${all.books} книг, ${formatNumber(all.revenue)} ₴`,
    `Донати: ${formatNumber(all.donations)} ₴`,
    '',
    `Доставка: відділення ${all.branch} · поштомати ${all.parcelLocker} · за кордон ${all.abroad}`,
    `Нові: ${all.newOrders}`,
    last ? `Останнє: ${last.id} · ${kyivDateKey(new Date(last.createdAt))}` : 'Замовлень ще немає.'
  ].join('\n');
}

function createOrderId() {
  const date = kyivDateKey().replaceAll('-', '');
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `K14-${date}-${suffix}`;
}

function validateOrder(payload, bookPrice) {
  if (normalizeText(payload.website, 120)) return { honeypot: true };

  const customerName = normalizeText(payload.customerName, 120);
  const phone = normalizeText(payload.phone, 30);
  const contactChannel = normalizeText(payload.contactChannel, 24);
  const quantity = boundedInteger(payload.quantity, 1, 12, 'Кількість');
  const donation = boundedInteger(payload.donation ?? 0, 0, 100_000, 'Донат');
  const deliveryMode = normalizeText(payload.deliveryMode, 30);

  if (customerName.length < 2) throw new ApiError(422, 'Вкажіть ім’я та прізвище.');
  if (!isSafePhone(phone)) throw new ApiError(422, 'Перевірте номер телефону.');
  if (!CONTACT_CHANNELS.has(contactChannel)) throw new ApiError(422, 'Оберіть спосіб зв’язку.');
  if (!DELIVERY_MODES.has(deliveryMode)) throw new ApiError(422, 'Оберіть спосіб доставки.');

  const order = {
    id: createOrderId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'new',
    product: 'Я знаю, що ви робили влітку чотирнадцятого',
    customerName,
    phone,
    contactChannel,
    quantity,
    donation,
    total: quantity * bookPrice + donation,
    deliveryMode,
    city: '',
    cityRef: '',
    settlementRef: '',
    deliveryPoint: '',
    deliveryPointRef: '',
    abroadAddress: ''
  };

  if (deliveryMode === 'abroad') {
    order.abroadAddress = normalizeText(payload.abroadAddress, 500);
    if (order.abroadAddress.length < 8) throw new ApiError(422, 'Вкажіть повну адресу для доставки за кордон.');
  } else {
    order.city = normalizeText(payload.city, 160);
    order.cityRef = normalizeText(payload.cityRef, 100);
    order.settlementRef = normalizeText(payload.settlementRef, 100);
    order.deliveryPoint = normalizeText(payload.deliveryPoint, 320);
    order.deliveryPointRef = normalizeText(payload.deliveryPointRef, 100);
    if (!order.city || (!order.cityRef && !order.settlementRef) || !order.deliveryPoint || !order.deliveryPointRef) {
      throw new ApiError(422, 'Оберіть населений пункт і точку доставки зі списку.');
    }
  }

  return order;
}

function deliveryLabel(order) {
  if (order.deliveryMode === 'abroad') return `За кордон: ${order.abroadAddress}`;
  const mode = order.deliveryMode === 'parcel_locker' ? 'Поштомат НП' : 'Відділення НП';
  return `${mode}: ${order.city}\n${order.deliveryPoint}`;
}

function orderNotification(order) {
  return [
    `📕 Нове замовлення ${order.id}`,
    order.product,
    '',
    `Кількість: ${order.quantity} шт.`,
    `Разом: ${formatNumber(order.total)} ₴${order.donation ? ` (донат ${formatNumber(order.donation)} ₴)` : ''}`,
    '',
    `Покупець: ${order.customerName}`,
    `Телефон: ${order.phone}`,
    `Рахунок у: ${order.contactChannel}`,
    '',
    deliveryLabel(order),
    '',
    'Статус: нове'
  ].join('\n');
}

function createNovaClient(config) {
  const cache = new Map();

  async function request(modelName, calledMethod, methodProperties) {
    if (!config.novaPoshtaApiKey) throw new ApiError(503, 'Доставка тимчасово недоступна. Спробуйте трохи пізніше.');
    const response = await config.fetch('https://api.novaposhta.ua/v2.0/json/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: config.novaPoshtaApiKey, modelName, calledMethod, methodProperties })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) throw new ApiError(503, 'Нова пошта тимчасово недоступна. Спробуйте пізніше.');
    return payload.data || [];
  }

  async function cached(key, loader) {
    const current = cache.get(key);
    if (current && current.expiresAt > Date.now()) return current.value;
    const value = await loader();
    cache.set(key, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
    return value;
  }

  return {
    async cities(query) {
      const normalized = normalizeText(query, 80);
      if (normalized.length < 2) return [];
      return cached(`cities:${normalized.toLowerCase()}`, async () => {
        const data = await request('Address', 'searchSettlements', { CityName: normalized, Limit: '10' });
        return (data[0]?.Addresses || []).slice(0, 10).map((item) => ({
          label: item.Present,
          cityRef: item.DeliveryCity || '',
          settlementRef: item.Ref || ''
        })).filter((item) => item.label && (item.cityRef || item.settlementRef));
      });
    },
    async points({ cityRef, settlementRef, type }) {
      const normalizedType = type === 'parcel_locker' ? 'parcel_locker' : 'branch';
      const normalizedCityRef = normalizeText(cityRef, 100);
      const normalizedSettlementRef = normalizeText(settlementRef, 100);
      if (!normalizedCityRef && !normalizedSettlementRef) throw new ApiError(422, 'Оберіть населений пункт зі списку.');
      const cacheKey = `warehouses:${normalizedCityRef}:${normalizedSettlementRef}`;
      const warehouses = await cached(cacheKey, async () => {
        const props = normalizedCityRef ? { CityRef: normalizedCityRef } : { SettlementRef: normalizedSettlementRef };
        return request('Address', 'getWarehouses', { ...props, Limit: '500', Page: '1' });
      });
      const category = normalizedType === 'parcel_locker' ? 'Postomat' : 'Branch';
      return warehouses
        .filter((item) => item.CategoryOfWarehouse === category)
        .sort((left, right) => (Number.parseInt(left.Number, 10) || 0) - (Number.parseInt(right.Number, 10) || 0))
        .map((item) => ({
          ref: item.Ref,
          label: item.Description,
          shortAddress: item.ShortAddress || '',
          number: item.Number || ''
        }));
    }
  };
}

function createTelegramClient(config) {
  async function sendMessage(chatId, text) {
    if (config.sendTelegram) return config.sendTelegram({ chatId, text });
    if (!config.telegramBotToken || !chatId) throw new Error('Telegram is not configured');
    const response = await config.fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error('Telegram delivery failed');
    return payload.result;
  }

  return { sendMessage };
}

function commandReply(text, orders) {
  const [command] = String(text || '').trim().split(/\s+/, 1);
  const name = command.toLowerCase().split('@')[0];
  if (name === '/orders' || name === '/stats') return formatStats(orders);
  if (name === '/start' || name === '/help') {
    return 'Команди:\n/orders - статистика замовлень\n/stats - статистика замовлень';
  }
  return '';
}

export function createOrderService(overrides = {}) {
  const config = createConfig(overrides);
  const store = createStore(config.dataFile);
  const limiter = createRateLimiter();
  const nova = config.novaRequest || createNovaClient(config);
  const telegram = createTelegramClient(config);

  async function handleOrder(request, response, corsOrigin) {
    const payload = await readBody(request);
    const order = validateOrder(payload, config.bookPrice);
    if (order.honeypot) return sendJson(response, 201, { ok: true }, corsOrigin);
    if (!limiter.take(getClientIp(request))) throw new ApiError(429, 'Забагато спроб. Спробуйте за кілька хвилин.');
    await store.add(order);
    try {
      await telegram.sendMessage(config.telegramChatId, orderNotification(order));
    } catch (error) {
      console.error(`Telegram notification failed for ${order.id}:`, error.message);
    }
    return sendJson(response, 201, { ok: true, id: order.id }, corsOrigin);
  }

  async function handleTelegramWebhook(request, response, corsOrigin) {
    const receivedSecret = String(request.headers['x-telegram-bot-api-secret-token'] || '');
    if (!safeEqual(config.telegramWebhookSecret, receivedSecret)) throw new ApiError(403, 'Forbidden');
    const update = await readBody(request);
    const message = update?.message;
    if (!message?.chat || String(message.chat.id) !== config.telegramChatId) return sendJson(response, 200, { ok: true }, corsOrigin);
    const reply = commandReply(message.text, await store.list());
    if (reply) await telegram.sendMessage(message.chat.id, reply);
    return sendJson(response, 200, { ok: true }, corsOrigin);
  }

  const server = createServer(async (request, response) => {
    const cors = resolveCors(request, config);
    const corsOrigin = cors.origin && cors.allowed ? cors.origin : '';
    const url = new URL(request.url, 'http://localhost');

    try {
      if (!cors.allowed) throw new ApiError(403, 'Доступ заборонено.');
      if (request.method === 'OPTIONS') return sendOptions(response, corsOrigin);
      if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { ok: true }, corsOrigin);
      if (request.method === 'GET' && url.pathname === '/api/novaposhta/cities') {
        return sendJson(response, 200, { items: await nova.cities(url.searchParams.get('q') || '') }, corsOrigin);
      }
      if (request.method === 'GET' && url.pathname === '/api/novaposhta/points') {
        return sendJson(response, 200, {
          items: await nova.points({
            cityRef: url.searchParams.get('cityRef') || '',
            settlementRef: url.searchParams.get('settlementRef') || '',
            type: url.searchParams.get('type') || 'branch'
          })
        }, corsOrigin);
      }
      if (request.method === 'POST' && url.pathname === '/api/orders') return await handleOrder(request, response, corsOrigin);
      if (request.method === 'POST' && url.pathname === '/api/telegram/webhook') return await handleTelegramWebhook(request, response, corsOrigin);
      throw new ApiError(404, 'Не знайдено.');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      return sendJson(response, error instanceof ApiError ? error.status : 500, {
        ok: false,
        error: error instanceof ApiError ? error.message : 'Сталася технічна помилка. Спробуйте пізніше.'
      }, corsOrigin);
    }
  });

  return { server, config, store };
}

const executedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (executedDirectly) {
  const service = createOrderService();
  service.server.listen(service.config.port, '127.0.0.1', () => {
    console.log(`Donetsk 2014 order service listening on ${service.config.port}`);
  });
}
