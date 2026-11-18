// Trade alerts: one run checks every enabled source once, sends any new alerts to
// Telegram, and saves what it has seen to state/state.json.
//
//   node src/index.mjs              normal run
//   node src/index.mjs --dry-run    print alerts instead of sending them
//   node src/index.mjs --only=sec   run only some sources (hyperliquid,congress,sec)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runHyperliquid, describeHyperliquid } from './hyperliquid.mjs';
import { runCongress, describeCongress } from './congress.mjs';
import { runSec, describeSec } from './sec.mjs';
import { send } from './telegram.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.CONFIG_PATH || join(ROOT, 'config.json');
const STATE_PATH = process.env.STATE_PATH || join(ROOT, 'state', 'state.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
state.failures ??= {};

const sources = [
  { key: 'hyperliquid', run: runHyperliquid },
  { key: 'congress', run: runCongress },
  { key: 'sec', run: runSec },
].filter((s) => config[s.key]?.enabled && (!only || only.includes(s.key)));

const alerts = [];
for (const s of sources) {
  try {
    alerts.push(...(await s.run(config[s.key], state, log)));
    state.failures[s.key] = 0;
  } catch (err) {
    const n = (state.failures[s.key] ?? 0) + 1;
    state.failures[s.key] = n;
    log(`${s.key}: FAILED (${n} in a row): ${err.stack || err.message}`);
    // Tell the user once if a source keeps failing, instead of failing silently.
    if (n === config.alertAfterFailures) {
      alerts.push(`⚠️ <b>${s.key}</b> has failed ${n} runs in a row: ${String(err.message).slice(0, 300)}`);
    }
  }
}

if (!state.announced && !only) {
  const lines = ['✅ <b>Trade alerts are running.</b> Existing trades were recorded as a baseline; you will only hear about new ones.'];
  if (config.hyperliquid?.enabled) lines.push(describeHyperliquid(state));
  if (config.congress?.enabled) lines.push(describeCongress(state));
  if (config.sec?.enabled) lines.push(process.env.SEC_USER_AGENT ? describeSec(config.sec) : '🏢 SEC insiders: <b>off</b>, SEC_USER_AGENT is not set');
  lines.push('<i>Information only, not investment advice.</i>');
  alerts.unshift(lines.join('\n'));
  state.announced = new Date().toISOString();
}

// Send first: if Telegram fails we exit before saving, so the same alerts are retried next run.
await send(alerts, { dryRun, log });

if (dryRun && !process.env.STATE_PATH) {
  log(`dry run: ${alerts.length} alert(s); state NOT saved (set STATE_PATH to keep a test state file)`);
} else {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 1) + '\n');
  log(`done: ${alerts.length} alert(s)`);
}
