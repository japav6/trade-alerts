# Trade alerts

Sends you a Telegram message when:

| Source | What triggers an alert | How fresh |
|---|---|---|
| 🐋 **Hyperliquid top traders** | One of the ~20 most profitable traders (30-day PnL, filtered) opens, adds to, cuts, closes or flips a perp position ≥ $100K | ~10 min after the trade |
| 🏛️ **U.S. House members** | A new STOCK Act trade disclosure (Periodic Transaction Report) is published | Members file up to 45 days after trading |
| 🏢 **SEC company insiders** | A CEO/CFO/director files a Form 4 showing an open-market **buy** ≥ $100K | Filed within ~2 days of the trade |

It only **reads public data**. It has no access to any trading account and cannot place trades.
Nothing here is investment advice: past profits of a "top trader" don't predict future ones,
and by the time a disclosure is public the price may already have moved.

On the first run it records everything that already exists as a baseline and sends one
"✅ Trade alerts are running" message. After that you only hear about new trades.

---

## Setup (about 15 minutes)

### 1. Create a Telegram bot

1. In Telegram, open **@BotFather** → send `/newbot` → pick a name and a username.
   BotFather replies with a **token** like `123456789:AAH...`. Keep it secret.
2. Open your new bot and send it any message (e.g. "hi"). Bots can't message you until you do.
3. Find your **chat ID**: open this in a browser, with your token pasted in:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   Look for `"chat":{"id":123456789` and copy that number.
   (Want alerts in a group instead? Add the bot to the group, post a message there, and use the
   group's id, which starts with `-`.)

### 2. Put the code on GitHub

1. Create a GitHub account if you don't have one, then **New repository** → name it e.g. `trade-alerts`.
   - **Public** (recommended): Actions minutes are free and unlimited. The repo only contains
     public market data; your Telegram token stays hidden in Secrets.
   - **Private**: free accounts get 2,000 Actions minutes/month, which is not enough for every
     10 minutes. Change the schedule in `.github/workflows/tracker.yml` to `'*/30 * * * *'`.
2. Upload the files (everything in this folder **except `node_modules`**). Either:
   - **GitHub Desktop / git**: clone the empty repo, copy the files in, commit, push. *Or*
   - **In the browser**: "uploading an existing file" → drag in `src`, `test`, `config.json`,
     `package.json`, `package-lock.json`, `README.md`, `.gitignore`. Then create the workflow
     separately: **Add file → Create new file**, name it `.github/workflows/tracker.yml`
     and paste in the contents of that file. Browsers often skip dot-folders when dragging.

### 3. Add the secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**, three times:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `TELEGRAM_CHAT_ID` | the chat id number |
| `SEC_USER_AGENT` | a name + contact e-mail, e.g. `MyTradeAlerts you@example.com`. The SEC requires this for automated access and blocks requests without it. |

### 4. Start it

Repo → **Actions** tab → enable workflows if asked → **Trade alerts** → **Run workflow**.
Within a minute or two you should get the "✅ Trade alerts are running" message in Telegram.
From then on it runs by itself every 10 minutes.

---

## Tuning: `config.json`

Edit it on GitHub (pencil icon); changes apply on the next run.

**hyperliquid**
- `selection.topN`: how many traders to follow (default 20). The list is rebuilt every `refreshHours`.
- `selection.minAccountValueUsd`, `minMonthRoi`, `minAllTimePnlUsd`, `requirePositiveWeek`:
  who counts as a "top trader" (profitable this month *and* overall, with real money at stake).
- `selection.maxMonthlyTurnover`: drops market-maker/HFT bots (monthly volume ÷ account size).
- `extraWallets`: addresses you always want followed, e.g. `["0xabc..."]`.
- `alerts.minPositionUsd` / `minChangeUsd` / `minChangePct`: raise these if you get too many alerts.

**congress**
- `members`: only these people, by (part of) the name, e.g. `["Pelosi", "Khanna"]`. Empty = everyone.
- `tickers`: only filings that mention these, e.g. `["NVDA", "TSLA"]`. Empty = all.
- `minAmountUsd`: ignore trades whose disclosed range starts below this (e.g. `15001`
  skips the smallest $1K–$15K bracket).

**sec**
- `transactionCodes`: `["P"]` = open-market buys. Add `"S"` for sales (warning: many alerts).
- `minValueUsd`: minimum trade size (default $100K).
- `roles`: any of `officer`, `director`, `tenPercentOwner`, `other`.
- `tickers`: only these companies. Empty = all.
- `skip10b51Plans`: `true` to hide pre-scheduled trades (a weaker signal).

To turn a source off, set its `"enabled": false`.

## Good to know

- **Not instant.** GitHub runs scheduled jobs every ~10 min and can be late at busy times. A trader who
  opens and closes inside that window won't be seen.
- **Senate trades aren't covered.** The Senate's disclosure site forbids automated access.
- **Scanned paper filings** (some House members) can't be read; you get a link to the PDF instead.
- If a source keeps failing (e.g. a website changes), you get a ⚠️ message after 6 failed runs in a row.
- `state/state.json` is the tracker's memory and is updated automatically. Deleting it resets the baseline.
- GitHub pauses scheduled workflows in repos with no activity for 60 days; the automatic state
  commits normally count as activity. If it ever stops, re-enable it in the Actions tab.

## Run it on your own computer (optional)

Needs Node.js 24+.

```
npm install
npm test                 # parser tests
npm run dry              # one run, prints alerts instead of sending
```
