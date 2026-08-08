const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token || !webhookUrl || !secretToken) {
  throw new Error('TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET are required.');
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(`Telegram ${method} failed.`);
  return result.result;
}

await telegram('setWebhook', {
  url: webhookUrl,
  secret_token: secretToken,
  allowed_updates: ['message'],
  drop_pending_updates: false
});

await telegram('setMyCommands', {
  commands: [
    { command: 'orders', description: 'Статистика замовлень' },
    { command: 'stats', description: 'Статистика замовлень' },
    { command: 'help', description: 'Підказка по командах' }
  ]
});

console.log('Telegram webhook and commands are configured.');
