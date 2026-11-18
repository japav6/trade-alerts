import { sleep } from './util.mjs';

const LIMIT = 4000; // Telegram allows 4096 characters per message

/** Pack alerts into as few messages as possible without splitting an alert. */
export function pack(alerts) {
  const out = [];
  let cur = '';
  for (const a of alerts) {
    const text = a.length > LIMIT ? a.slice(0, LIMIT - 1) + '…' : a;
    if (cur && cur.length + 2 + text.length > LIMIT) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${text}` : text;
  }
  if (cur) out.push(cur);
  return out;
}

export async function send(alerts, { dryRun, log }) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const messages = pack(alerts);
  if (!messages.length) return;

  if (dryRun || !token || !chatId) {
    if (!dryRun) log('telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, printing instead');
    for (const m of messages) console.log(`\n----- message -----\n${m}`);
    return;
  }

  for (const text of messages) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) break;
      const body = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt < 5) {
        await sleep(((body.parameters?.retry_after ?? 5) + 1) * 1000);
        continue;
      }
      // Never log the token: the URL is not included in this message.
      throw new Error(`Telegram send failed: HTTP ${res.status} ${body.description ?? ''}`);
    }
    await sleep(1100);
  }
  log(`telegram: sent ${messages.length} message(s)`);
}
