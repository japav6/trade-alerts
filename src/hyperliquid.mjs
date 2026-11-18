// Follows the best-performing traders on the Hyperliquid public leaderboard and
// reports when they open, add to, reduce, close or flip a perpetual position.
// Uses only Hyperliquid's public, read-only endpoints. No keys, no account.

import { fetchWithRetry, esc, usd, price, sleep } from './util.mjs';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const HOUR = 3_600_000;

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const explorer = (a) => `https://app.hyperliquid.xyz/explorer/address/${a}`;

/** Download the leaderboard and pick the traders worth following. */
export async function selectTopTraders(sel) {
  const res = await fetchWithRetry(LEADERBOARD_URL, {}, { timeoutMs: 240_000 });
  const { leaderboardRows } = await res.json();

  const rows = leaderboardRows.map((r) => {
    const w = Object.fromEntries(
      r.windowPerformances.map(([k, v]) => [k, { pnl: +v.pnl, roi: +v.roi, vlm: +v.vlm }]),
    );
    return { address: r.ethAddress.toLowerCase(), name: r.displayName || null, accountValue: +r.accountValue, ...w };
  });

  const picked = rows
    .filter((r) =>
      r.accountValue >= sel.minAccountValueUsd &&
      r.month.pnl > 0 &&
      r.month.roi >= sel.minMonthRoi &&
      r.allTime.pnl >= sel.minAllTimePnlUsd &&
      (!sel.requirePositiveWeek || r.week.pnl > 0) &&
      // Very high volume relative to account size = market maker / HFT bot, not a "trader to follow".
      r.month.vlm / r.accountValue <= sel.maxMonthlyTurnover,
    )
    .sort((a, b) => b.month.pnl - a.month.pnl)
    .slice(0, sel.topN);

  return {
    total: rows.length,
    traders: picked.map((r, i) => ({
      address: r.address,
      name: r.name,
      rank: i + 1,
      accountValue: r.accountValue,
      monthPnl: r.month.pnl,
      monthRoi: r.month.roi,
      allTimePnl: r.allTime.pnl,
    })),
  };
}

/** Current open perp positions for one wallet, keyed by coin. */
async function getPositions(address) {
  const res = await fetchWithRetry(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
  });
  const s = await res.json();
  const out = {};
  for (const { position: p } of s.assetPositions ?? []) {
    const size = +p.szi;
    if (!size) continue;
    out[p.coin] = {
      size,
      entry: +p.entryPx,
      value: Math.abs(+p.positionValue),
      lev: p.leverage?.value ?? null,
    };
  }
  return out;
}

/**
 * Compare the last *alerted* snapshot with now. The stored record for a coin only
 * changes when an alert fires, so slow scaling in/out still triggers once it adds up.
 */
export function diffPositions(prev, cur, a) {
  const events = [];
  const next = { ...prev };
  for (const coin of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
    const was = prev[coin];
    const now = cur[coin];
    if (!was && now) {
      if (now.value >= a.minPositionUsd) {
        events.push({ kind: 'open', coin, now });
        next[coin] = now;
      }
    } else if (was && !now) {
      if (was.value >= a.minPositionUsd) events.push({ kind: 'close', coin, was });
      delete next[coin];
    } else if (Math.sign(was.size) !== Math.sign(now.size)) {
      if (Math.max(was.value, now.value) >= a.minPositionUsd) events.push({ kind: 'flip', coin, was, now });
      next[coin] = now;
    } else {
      const px = now.value / Math.abs(now.size);
      const delta = Math.abs(now.size) - Math.abs(was.size);
      const deltaUsd = Math.abs(delta) * px;
      const rel = Math.abs(delta) / Math.abs(was.size);
      if (deltaUsd >= a.minChangeUsd && rel >= a.minChangePct) {
        events.push({ kind: delta > 0 ? 'add' : 'reduce', coin, was, now, deltaUsd, rel });
        next[coin] = now;
      }
    }
  }
  return { events, next };
}

const side = (size) => (size > 0 ? 'LONG' : 'SHORT');
const lev = (p) => (p.lev ? ` ${p.lev}x` : '');

function formatEvent(e) {
  switch (e.kind) {
    case 'open':
      return `${e.now.size > 0 ? '🟢' : '🔴'} <b>Opened ${side(e.now.size)} ${esc(e.coin)}</b> ${usd(e.now.value)} @ ${price(e.now.entry)}${lev(e.now)}`;
    case 'close':
      return `✖️ <b>Closed ${side(e.was.size)} ${esc(e.coin)}</b> (was ${usd(e.was.value)}, entry ${price(e.was.entry)})`;
    case 'flip':
      return `🔄 <b>Flipped ${esc(e.coin)} ${side(e.was.size)} → ${side(e.now.size)}</b> ${usd(e.now.value)} @ ${price(e.now.entry)}${lev(e.now)}`;
    case 'add':
      return `➕ <b>Added to ${side(e.now.size)} ${esc(e.coin)}</b> +${usd(e.deltaUsd)} (+${Math.round(e.rel * 100)}%) → ${usd(e.now.value)}, avg entry ${price(e.now.entry)}`;
    case 'reduce':
      return `➖ <b>Cut ${side(e.now.size)} ${esc(e.coin)}</b> -${usd(e.deltaUsd)} (-${Math.round(e.rel * 100)}%) → ${usd(e.now.value)}`;
    default:
      return '';
  }
}

function traderHeader(t) {
  const label = t.name ? `${esc(t.name)} (${short(t.address)})` : short(t.address);
  const stats = t.rank
    ? ` · #${t.rank}, 30d ${usd(t.monthPnl)} (${Math.round(t.monthRoi * 100)}%), acct ${usd(t.accountValue)}`
    : ' · your watchlist';
  return `🐋 <a href="${explorer(t.address)}">${label}</a>${stats}`;
}

export async function runHyperliquid(cfg, state, log) {
  const st = (state.hyperliquid ??= { traders: [], snapshots: {} });
  const messages = [];
  const now = Date.now();

  // 1) Refresh who we follow (daily by default).
  if (!st.refreshedAt || now - st.refreshedAt >= cfg.selection.refreshHours * HOUR || !st.traders.length) {
    log('hyperliquid: refreshing leaderboard…');
    const { total, traders } = await selectTopTraders(cfg.selection);
    log(`hyperliquid: ${traders.length} of ${total} leaderboard traders pass the filters`);
    st.traders = traders;
    st.refreshedAt = now;
  }

  const watch = new Map(st.traders.map((t) => [t.address, t]));
  for (const w of cfg.extraWallets ?? []) {
    const address = w.toLowerCase();
    if (!watch.has(address)) watch.set(address, { address, name: null });
  }

  // Forget wallets we no longer follow.
  for (const a of Object.keys(st.snapshots)) if (!watch.has(a)) delete st.snapshots[a];

  // 2) Check each wallet's positions.
  let seeded = 0;
  for (const t of watch.values()) {
    let cur;
    try {
      cur = await getPositions(t.address);
    } catch (err) {
      log(`hyperliquid: ${short(t.address)} failed: ${err.message}`);
      continue;
    }
    const prev = st.snapshots[t.address];
    if (!prev) {
      // New to the watchlist: record a baseline silently.
      st.snapshots[t.address] = Object.fromEntries(Object.entries(cur).filter(([, p]) => p.value >= cfg.alerts.minPositionUsd));
      seeded++;
    } else {
      const { events, next } = diffPositions(prev, cur, cfg.alerts);
      st.snapshots[t.address] = next;
      if (events.length) messages.push([traderHeader(t), ...events.map(formatEvent)].join('\n'));
    }
    await sleep(150);
  }
  if (seeded) log(`hyperliquid: baseline recorded for ${seeded} wallet(s)`);
  log(`hyperliquid: ${messages.length} trader(s) with alerts`);
  return messages;
}

export function describeHyperliquid(state) {
  const t = state.hyperliquid?.traders ?? [];
  return `🐋 Hyperliquid: following ${t.length} top traders` + (t[0] ? ` (best 30d: ${usd(t[0].monthPnl)})` : '');
}
