import { inflateRawSync } from 'node:zlib';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when a throttled source should run again. 2-minute grace absorbs scheduler jitter. */
export const isDue = (lastRun, everyMinutes) => !lastRun || Date.now() - lastRun >= (everyMinutes - 2) * 60_000;

/** fetch() with a timeout and retries on network errors, 429 and 5xx. */
export async function fetchWithRetry(url, opts = {}, { retries = 3, timeoutMs = 60_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} for ${url}`);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.fatal = true;
        throw err;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Escape text for Telegram HTML messages. */
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Compact dollar formatting: $1.23M, $450K, $9,800. */
export function usd(n) {
  const v = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${sign}$${Math.round(v / 1e3)}K`;
  return `${sign}$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** Price formatting that keeps precision for small-priced coins. */
export function price(n) {
  if (!Number.isFinite(n)) return '?';
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// ---------- tiny XML helpers (the feeds we read are simple and regular) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });

/** Inner contents of every <tag ...>...</tag> occurrence. */
export function tagBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

/** Text of the first <tag>, with nested tags stripped. '' if absent. */
export function tagText(xml, tag) {
  const block = tagBlocks(xml, tag)[0];
  return block == null ? '' : decodeEntities(block.replace(/<[^>]+>/g, '').trim());
}

// ---------- minimal ZIP reader (enough for the House Clerk index zip) ----------

export function unzipEntry(buf, matchName) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (matchName(name)) {
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
