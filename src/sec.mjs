// Watches SEC Form 4 filings: trades by company insiders (CEOs, CFOs, directors)
// in their own company's stock. By default only open-market BUYS, which are the
// classic "insider conviction" signal; sales are mostly routine and very noisy.
// Insiders must file within 2 business days of the trade.
//
// The SEC requires every automated client to send a User-Agent with a contact
// e-mail. Set it in the SEC_USER_AGENT environment variable / GitHub secret.

import { fetchWithRetry, esc, usd, price, tagBlocks, tagText, sleep, isDue } from './util.mjs';

const feedUrl = (start) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&start=${start}&count=100&output=atom`;

const CODE_LABEL = { P: '🟢 BOUGHT', S: '🔴 SOLD', A: '🎁 GRANTED', M: '⚙️ EXERCISED' };

function parseFeed(xml) {
  return tagBlocks(xml, 'entry')
    .map((e) => {
      const href = e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? '';
      const m = href.match(/\/data\/(\d+)\/\d+\/([\d-]+)-index\.html?/);
      return m ? { title: tagText(e, 'title'), cik: m[1], accession: m[2], indexUrl: href } : null;
    })
    .filter(Boolean);
}

const flag = (block, tag) => /^(1|true)$/i.test(tagText(block, tag));

/** Parse the ownershipDocument XML of a Form 4. */
export function parseForm4(xml) {
  const owners = tagBlocks(xml, 'reportingOwner').map((o) => {
    const rel = tagBlocks(o, 'reportingOwnerRelationship')[0] ?? '';
    return {
      name: tagText(o, 'rptOwnerName'),
      director: flag(rel, 'isDirector'),
      officer: flag(rel, 'isOfficer'),
      tenPercentOwner: flag(rel, 'isTenPercentOwner'),
      other: flag(rel, 'isOther'),
      title: tagText(rel, 'officerTitle'),
    };
  });
  const txs = tagBlocks(xml, 'nonDerivativeTransaction').map((t) => ({
    security: tagText(t, 'securityTitle'),
    date: tagText(t, 'transactionDate'),
    code: tagText(tagBlocks(t, 'transactionCoding')[0] ?? '', 'transactionCode'),
    shares: Number(tagText(t, 'transactionShares')) || 0,
    price: Number(tagText(t, 'transactionPricePerShare')) || 0,
    acqDisp: tagText(t, 'transactionAcquiredDisposedCode'),
    after: Number(tagText(t, 'sharesOwnedFollowingTransaction')) || 0,
  }));
  return {
    issuer: tagText(xml, 'issuerName'),
    ticker: tagText(xml, 'issuerTradingSymbol').toUpperCase(),
    plan10b51: flag(xml, 'aff10b5One'),
    owners,
    txs,
  };
}

function roleOf(o) {
  const parts = [];
  if (o.officer) parts.push(o.title || 'Officer');
  if (o.director) parts.push('Director');
  if (o.tenPercentOwner) parts.push('10% owner');
  if (!parts.length && o.other) parts.push('Other');
  return parts.join(', ');
}

function ownerMatches(o, roles) {
  return (
    (roles.includes('officer') && o.officer) ||
    (roles.includes('director') && o.director) ||
    (roles.includes('tenPercentOwner') && o.tenPercentOwner) ||
    (roles.includes('other') && o.other)
  );
}

async function fetchForm4(entry, ua) {
  const acc = entry.accession;
  const url = `https://www.sec.gov/Archives/edgar/data/${entry.cik}/${acc.replace(/-/g, '')}/${acc}.txt`;
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': ua } });
  const txt = await res.text();
  const xml = txt.match(/<ownershipDocument>[\s\S]*?<\/ownershipDocument>/)?.[0];
  return xml ? parseForm4(xml) : null;
}

function formatFiling(doc, owners, txs, entry, cfg) {
  const byCode = new Map();
  for (const t of txs) {
    const g = byCode.get(t.code) ?? { shares: 0, value: 0, after: 0, dates: new Set() };
    g.shares += t.shares;
    g.value += t.shares * t.price;
    g.after = t.after || g.after;
    g.dates.add(t.date);
    byCode.set(t.code, g);
  }
  const who = owners.map((o) => `${esc(o.name)} (${esc(roleOf(o))})`).join(', ');
  const lines = [`🏢 <b>$${esc(doc.ticker || '?')}</b> · ${esc(doc.issuer)}`, `👤 ${who}`];
  for (const [code, g] of byCode) {
    const avg = g.shares ? g.value / g.shares : 0;
    const before = code === 'P' ? g.after - g.shares : g.after + g.shares;
    const share = before > 0 ? (g.shares / before) * 100 : null;
    const pct = share == null ? '' : ` (${code === 'P' ? '+' : '-'}${share < 1 ? '<1' : Math.round(share)}% of holding)`;
    lines.push(
      `${CODE_LABEL[code] ?? code} ${Math.round(g.shares).toLocaleString('en-US')} sh @ $${price(avg)} = <b>${usd(g.value)}</b>${pct} · ${[...g.dates].join(', ')}`,
    );
  }
  if (doc.plan10b51) lines.push('ℹ️ Pre-scheduled (10b5-1 plan), a weaker signal');
  lines.push(`<a href="${esc(entry.indexUrl)}">SEC filing</a>`);
  return lines.join('\n');
}

export async function runSec(cfg, state, log) {
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!ua) {
    log('sec: skipped. Set SEC_USER_AGENT (e.g. "MyTradeAlerts you@example.com"), required by the SEC');
    return [];
  }
  const st = (state.sec ??= {});
  if (!isDue(st.lastRun, cfg.checkEveryMinutes)) return [];

  const firstRun = !st.seen;
  const seen = new Set(st.seen ?? []);

  // Read the newest Form 4s until we reach ones we've already handled.
  const fresh = new Map();
  for (let page = 0; page < cfg.maxPages; page++) {
    const res = await fetchWithRetry(feedUrl(page * 100), { headers: { 'User-Agent': ua } });
    const entries = parseFeed(await res.text());
    let hitSeen = false;
    for (const e of entries) {
      if (seen.has(e.accession)) { hitSeen = true; continue; }
      if (!cfg.includeAmendments && /^4\/A/.test(e.title)) { seen.add(e.accession); continue; }
      if (!fresh.has(e.accession)) fresh.set(e.accession, e);
    }
    if (firstRun || hitSeen || entries.length < 100) break;
    await sleep(250);
  }
  st.lastRun = Date.now();

  const remember = () => { st.seen = [...seen].slice(-cfg.rememberFilings); };

  if (firstRun) {
    for (const a of fresh.keys()) seen.add(a);
    remember();
    log(`sec: baseline recorded (${fresh.size} recent filings)`);
    return [];
  }
  log(`sec: ${fresh.size} new Form 4 filing(s) to check`);

  const codes = new Set(cfg.transactionCodes);
  const tickers = new Set((cfg.tickers ?? []).map((t) => t.toUpperCase()));
  const messages = [];

  for (const entry of [...fresh.values()].reverse()) { // oldest first
    seen.add(entry.accession);
    let doc;
    try {
      doc = await fetchForm4(entry, ua);
    } catch (err) {
      log(`sec: ${entry.accession} failed: ${err.message}`);
      continue;
    } finally {
      await sleep(150); // stay well under the SEC's 10 requests/second limit
    }
    if (!doc) continue;
    if (tickers.size && !tickers.has(doc.ticker)) continue;
    const owners = doc.owners.filter((o) => ownerMatches(o, cfg.roles));
    if (!owners.length) continue;
    const txs = doc.txs.filter((t) => codes.has(t.code));
    const value = txs.reduce((s, t) => s + t.shares * t.price, 0);
    if (!txs.length || value < cfg.minValueUsd) continue;
    if (cfg.skip10b51Plans && doc.plan10b51) continue;
    messages.push(formatFiling(doc, owners, txs, entry, cfg));
  }
  remember();
  log(`sec: ${messages.length} filing(s) match your filters`);
  return messages;
}

export function describeSec(cfg) {
  const what = cfg.transactionCodes.map((c) => ({ P: 'buys', S: 'sales' })[c] ?? c).join(' + ');
  const roleNames = { officer: 'officers', director: 'directors', tenPercentOwner: '10% owners', other: 'other insiders' };
  return `🏢 SEC insiders: open-market ${what} ≥ ${usd(cfg.minValueUsd)} by ${cfg.roles.map((r) => roleNames[r] ?? r).join(' or ')}`;
}
