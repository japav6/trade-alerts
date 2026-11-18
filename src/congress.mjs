// Watches U.S. House members' Periodic Transaction Reports (STOCK Act stock-trade
// disclosures) from the official House Clerk site. Members may file up to 45 days
// after a trade, so these alerts are about what was *disclosed*, not live trades.
// The Senate is not covered: its disclosure site forbids automated access.

import { fetchWithRetry, esc, tagBlocks, tagText, unzipEntry, sleep, isDue } from './util.mjs';

const BASE = 'https://disclosures-clerk.house.gov/public_disc';
let pdfLib; // loaded lazily so the other sources work even if unpdf is missing

const TYPE_LABEL = { P: '🟢 BUY', S: '🔴 SELL', 'S (partial)': '🔴 SELL (partial)', E: '🔁 EXCHANGE' };

async function loadFilings(year) {
  const res = await fetchWithRetry(`${BASE}/financial-pdfs/${year}FD.zip`);
  const zip = Buffer.from(await res.arrayBuffer());
  const xml = unzipEntry(zip, (n) => n.toLowerCase().endsWith('.xml'))?.toString('utf8');
  if (!xml) throw new Error(`No XML in ${year}FD.zip`);
  return tagBlocks(xml, 'Member')
    .map((m) => ({
      docId: tagText(m, 'DocID'),
      type: tagText(m, 'FilingType'),
      name: [tagText(m, 'Prefix'), tagText(m, 'First'), tagText(m, 'Last'), tagText(m, 'Suffix')].filter(Boolean).join(' '),
      last: tagText(m, 'Last'),
      district: tagText(m, 'StateDst'),
      filed: tagText(m, 'FilingDate'),
      year,
    }))
    .filter((f) => f.type === 'P' && f.docId);
}

const pdfUrl = (f) => `${BASE}/ptr-pdfs/${f.year}/${f.docId}.pdf`;

/** Pull transaction rows out of an electronically filed PTR. Scanned paper filings return []. */
export function parsePtrText(text) {
  const flat = text.replace(/\s+/g, ' ');
  const re = /\(([A-Z][A-Z0-9.\-]{0,9})\)\s*\[([A-Z]{2})\]\s*(S \(partial\)|P|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+(\$[\d,]+\s*-\s*\$[\d,]+|\$[\d,]+\s*\+|Over \$[\d,]+|\$[\d,]+)/g;
  return [...flat.matchAll(re)].map((m) => ({
    ticker: m[1],
    assetType: m[2],
    type: m[3],
    date: m[4],
    amount: m[5].replace(/\s+/g, ' '),
    minUsd: Number(m[5].match(/[\d,]+/)[0].replace(/,/g, '')),
  }));
}

async function fetchTrades(f) {
  pdfLib ??= await import('unpdf');
  const res = await fetchWithRetry(pdfUrl(f));
  const pdf = await pdfLib.getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  const { text } = await pdfLib.extractText(pdf, { mergePages: true });
  return parsePtrText(text);
}

const shortAmount = (a) =>
  a.replace(/\$([\d,]+)/g, (_, n) => {
    const v = Number(n.replace(/,/g, ''));
    return v >= 1e6 ? `$${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${v}`;
  }).replace(' - ', '–');

function formatFiling(f, trades, parsed) {
  const head = `🏛️ <b>${esc(f.name)}</b> (${esc(f.district)}) disclosed trades · filed ${esc(f.filed)}`;
  const link = `<a href="${pdfUrl(f)}">Filing PDF</a>`;
  if (!parsed) return `${head}\n(scanned/paper filing, see PDF)\n${link}`;

  // Merge identical rows (e.g. same trade in self + spouse accounts).
  const groups = new Map();
  for (const t of trades) {
    const k = `${t.type}|${t.ticker}|${t.assetType}|${t.date}|${t.amount}`;
    groups.set(k, { ...t, n: (groups.get(k)?.n ?? 0) + 1 });
  }
  const rows = [...groups.values()];
  const lines = rows.slice(0, 15).map((t) =>
    `${TYPE_LABEL[t.type] ?? t.type} <b>${esc(t.ticker)}</b>${t.assetType !== 'ST' ? ` [${esc(t.assetType)}]` : ''} ${shortAmount(t.amount)}${t.n > 1 ? ` ×${t.n}` : ''} · traded ${esc(t.date)}`,
  );
  if (rows.length > 15) lines.push(`…and ${rows.length - 15} more`);
  return [head, ...lines, link].join('\n');
}

export async function runCongress(cfg, state, log) {
  const st = (state.congress ??= {});
  const now = new Date();
  if (!isDue(st.lastRun, cfg.checkEveryMinutes)) return [];

  const years = [now.getUTCFullYear()];
  if (now.getUTCMonth() === 0) years.unshift(years[0] - 1); // January: also catch late filings for last year
  const filings = (await Promise.all(years.map(loadFilings))).flat();
  st.lastRun = Date.now();

  const firstRun = !st.seen;
  const seen = new Set(st.seen ?? []);
  const fresh = filings.filter((f) => !seen.has(f.docId));
  st.seen = filings.map((f) => f.docId); // index only holds this/last year, so this stays bounded

  if (firstRun) {
    log(`congress: baseline recorded (${filings.length} existing filings)`);
    return [];
  }
  log(`congress: ${fresh.length} new filing(s)`);

  const members = (cfg.members ?? []).map((m) => m.toLowerCase());
  const tickers = new Set((cfg.tickers ?? []).map((t) => t.toUpperCase()));
  const messages = [];

  for (const f of fresh.slice(0, cfg.maxFilingsPerRun)) {
    if (members.length && !members.some((m) => f.name.toLowerCase().includes(m))) continue;
    let trades = [];
    try {
      trades = await fetchTrades(f);
    } catch (err) {
      log(`congress: could not read ${f.docId}: ${err.message}`);
    }
    const parsed = trades.length > 0;
    const kept = trades.filter((t) =>
      (!tickers.size || tickers.has(t.ticker)) &&
      t.minUsd >= cfg.minAmountUsd &&
      (cfg.includeExchanges || t.type !== 'E'),
    );
    if (parsed && !kept.length) continue; // nothing matching the filters
    if (!parsed && tickers.size) continue; // can't tell, and the user only wants certain tickers
    messages.push(formatFiling(f, kept, parsed));
    await sleep(300);
  }
  if (fresh.length > cfg.maxFilingsPerRun) log(`congress: skipped ${fresh.length - cfg.maxFilingsPerRun} filing(s) over the per-run cap`);
  return messages;
}

export function describeCongress(state) {
  return `🏛️ Congress: watching House stock-trade disclosures (${state.congress?.seen?.length ?? 0} filings already on record)`;
}
