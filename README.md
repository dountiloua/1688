# 1688 → DZ Sourcing Telegram Bot (MVP)

Telegram bot that lets Algerian customers paste a 1688.com product link, see the
price converted to DZD, and place an order. Orders are saved to SQLite and
forwarded to a human admin. Purchasing + shipping are handled by a partner
freight company — the bot only does order intake, pricing, and status tracking.

## Stack

- Node.js 20+, TypeScript
- [grammY](https://grammy.dev/) for the Telegram Bot API
- `better-sqlite3` (file-based, zero external DB)
- Playwright (headless Chromium) for 1688 scraping
- Railway-ready: `npm start`, reads `PORT`/`TELEGRAM_BOT_TOKEN` from env,
  SQLite file persisted to a volume

## Setup

### 1. Create the bot — get a token from @BotFather

1. Open Telegram and message **@BotFather**.
2. Send `/newbot`, pick a name + username.
3. Copy the HTTP API token it gives you.
4. Find your Telegram user id by messaging **@userinfobot** (needed for `ADMIN_TELEGRAM_ID`).

### 2. Run locally

```bash
npm install
npx playwright install chromium   # downloads headless Chromium for the scraper
cp .env.example .env              # then fill in TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_ID
npm run build
npm start
```

Dev mode (no build):

```bash
npm run dev
```

### 3. Environment variables

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from @BotFather |
| `ADMIN_TELEGRAM_ID` | ✅ | — | Telegram user id allowed to run admin commands |
| `DATABASE_PATH` | — | `./data/orders.db` | SQLite file location |
| `PORT` | — | `3000` | Health-check HTTP port |
| `SCRAPER_TIMEOUT_MS` | — | `30000` | Playwright navigation timeout |
| `SCRAPER_NAV_DELAY_MS` | — | `1500` | Post-load delay + retry backoff base |

### 4. Deploy on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Add a **Volume** mounted at `/data`.
4. Set variables:
   - `TELEGRAM_BOT_TOKEN` = your token
   - `ADMIN_TELEGRAM_ID` = your user id
   - `DATABASE_PATH` = `/data/orders.db`
   - (`PORT` is injected automatically by Railway.)
5. Start command: `npm start`. Build command: `npm run build`
   (or `npm install && npm run build` — `postinstall` already fetches Chromium).
6. Redeploy — the `.db` file survives restarts because it lives on the volume.

## Bot usage

Customer:

- `/start` — welcome (Arabic default, `/lang` for FR/EN)
- Send a `1688.com` link → preview with DZD price → ✅ confirm → name → phone → wilaya → address
- `/myorders` — order history + status
- `/cancel` — abort the current flow

Admin (`ADMIN_TELEGRAM_ID` only):

- `/orders` — orders with `AWAITING_DEPOSIT`, each with a ✅ button
- `/order <id>` — full detail incl. `HK Shipping / Mark: ALG-<id>` for the freight partner
- `/setfx <rate>` — FX rate for new orders (default 38)
- `/setfreight <amount>` — flat freight estimate for new orders (default 1500)
- `/advance <order_id> <new_status>` — move lifecycle + notify customer

Statuses: `AWAITING_DEPOSIT → DEPOSIT_PAID → FORWARDED_TO_SHIPPING_PARTNER → IN_TRANSIT → DELIVERED` (or `CANCELLED`).

## Pricing

`src/pricing.ts` — do not change the formula:

```text
productCostDzd = priceRmb * fxRateRmbDzd
totalAmountDzd = round(productCostDzd * 1.05 * 1.10 + estFreightDzd)
total <= 10000 → full payment upfront, else 10000 deposit + remainder
```

## Notes / limits

- 1688 aggressively bot-protects pages; the scraper (`src/scraper/oneSixEightEight.ts`)
  is an isolated module behind `scrape1688Product()` so it can be swapped for a
  paid scraping API later without touching bot logic.
- grammY sessions are in-memory; conversation state resets on restart, but
  persisted orders in SQLite are never lost.
