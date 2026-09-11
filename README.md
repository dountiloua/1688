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
5. **Notifications bot (recommended):** message **@BotFather** → `/newbot` again for a *second, private* bot → put its token in `NOTIFY_BOT_TOKEN` and your user id in `NOTIFY_CHAT_ID`. All admin alerts (new orders, updates) go there instead of the public bot. **Important:** open the new bot once and press START, otherwise it cannot message you. While unset, alerts fall back to the main bot.

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
| `ADMIN_PANEL_TOKEN` | ✅ | — | Password for the `/admin` web panel |
| `SCRAPER_PROVIDER` | — | auto | `oxylabs` / `playwright` / auto |
| `OXYLABS_USERNAME` / `OXYLABS_PASSWORD` | — | — | Oxylabs Realtime API creds |
| `USD_RATE_DZD` | — | `255` | Default DZD per 1 USD (DB settings win) |
| `FREIGHT_PER_KG_DZD` | — | `5000` | Default freight DZD per kg (DB settings win) |
| `BENEFIT_DZD` | — | `2000` | Flat benefit per order (DB settings win) |
| `MIN_ORDER_DZD` | — | `3000` | Minimum order subtotal, enforced via min quantity |

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
- Send a `1688.com` or `alibaba.com` product link → preview (source price in RMB or USD → DZD price, no exchange-rate internals, no shipping talk) → ✅ confirm → total quantity → **split it across options** (stepper +/− buttons per color/size, or type e.g. `white 2, red 1` — must add up to the total) → name → phone → wilaya → **postal code** → address → unit price only. The admin then locks the **final price** (+ parcel weight → smart-rounded freight) and the customer receives the **invoice** by DM. Deposit is always 10,000 DZD.
- `/myorders` — order history + status
- `/cancel` — abort the current flow

Admin (`ADMIN_TELEGRAM_ID` only):

- `/orders` — orders with `AWAITING_DEPOSIT`, each with a ✅ button
- `/order <id>` — full detail incl. `HK Shipping / Mark: ALG-<id>` for the freight partner
- `/setusd <rate>` — DZD per 1 USD for new orders (default 255)
- `/setcny auto|<rate>` — CNY→USD: live auto rate (free API, cached 12h) or fixed manual rate
- `/setfreightkg <amount>` — freight DZD per kg for new orders (default 5000)
- `/setbenefit <amount>` — flat benefit per order for new orders (default 2000)
- `/setmin <amount>` — minimum order subtotal for new orders (default 3000; bot auto-requires enough pieces)
- `/pending` — orders waiting for acceptance
- `/accept <id> <final_price>` — lock final price, move to AWAITING_DEPOSIT, DM the invoice
- `/rates` — show current pricing inputs
- `/advance <order_id> <new_status>` — move lifecycle + notify customer

Statuses: `AWAITING_DEPOSIT → DEPOSIT_PAID → FORWARDED_TO_SHIPPING_PARTNER → IN_TRANSIT → DELIVERED` (or `CANCELLED`).

## Pricing (`src/pricing.ts` + `src/fx.ts`)

```text
unitUsd      = priceRmb / cnyPerUsd          # live CNY→USD (free API, 12h cache) or manual
unitDzd      = round(unitUsd * usdRateDzd)    # default 255 DZD per USD
productTotal = unitDzd * quantity
freight      = round(weightKg * 5000)         # per-kg rate, admin-editable
total        = productTotal + freight + benefit   # benefit default 2000
total <= 10000 → full payment upfront, else 10000 deposit + remainder
```

Two-stage pricing: the bot shows the customer an **approximate** total
(formula + benefit, no freight). New orders start as `PENDING_ACCEPTANCE`.
The admin locks the **final price** in the panel (prefilled with the
approximate) or via `/accept <id> <final> [weight_kg]` — optional parcel
weight is smart-rounded (2.7→3, 2.2 stays) and charged at the per-kg rate,
then the customer instantly receives the **invoice** DM and the order moves
to `AWAITING_DEPOSIT`. Deposit is always 10,000 DZD.

Two smarts on top of that:

- **Quantity ladder** — 1688 wholesale prices drop with quantity
  (`currentPrices` on the page). The unit charged is the ladder tier for the
  customer's quantity, not the page's lowest teaser price.
- **Variants** — color/size/model optionsdeclared on the page become
  tap-buttons (🎨 → 📏 → …); picks are stored on the order and the variant
  price applies when SKUs say so.

The customer only ever sees: RMB price → DZD price → shipping → total.
Exchange-rate internals stay hidden; admins control all three inputs from the
panel (`USD rate`, `CNY→USD auto/fixed`, `Freight/kg`) or via
`/setusd`, `/setcny`, `/setfreightkg`.

## Admin web panel

Same process, no extra service: open `http://localhost:3000/admin`
(on Railway: `https://<your-app>.up.railway.app/admin`) and enter your
`ADMIN_PANEL_TOKEN`. You get:

- **Stats row** — order counts per status at a glance
- **Pricing settings** — USD rate, CNY→USD (auto/live or fixed), freight/kg, benefit (new orders only)
- **⏳ Pending acceptance** — orders awaiting review, each with a prefilled final-price field; accepting DMs the invoice to the customer
- **Order list** — newest first, filterable by status, with shipping marks
- **Order detail** (`View`) — full customer/address/money info plus the
  `HK Shipping / Mark:` line to copy to the freight partner
- **Move dropdown** — change any order's status; the customer is notified
  on Telegram automatically
- **🗑️ delete** — per-row trash icon (or in the detail card), with a
  two-step confirmation; deletions are permanent

Health check for Railway lives at `/health` on the same port.

## Scraper providers (local-first)

- **Local (primary):** headless Chromium in `src/scraper/oneSixEightEight.ts`
  (title, price ladder → lowest tier, image, MOQ — same fields as the
  `cn-1688-scraper` approach). Images/fonts/media requests are blocked for
  speed. Needs `npx playwright install chromium` locally; Railway gets it
  via `postinstall`.
- **Oxylabs API (fallback):** paid Realtime API for when 1688 blocks the
  local browser. One 1688 product page = one API query.
- Order via `SCRAPER_ORDER`: `local,api` (default) | `api,local` | `local`
  (never spend API credits) | `api` (never launch a browser).
- The local attempt races `LOCAL_TIMEOUT_MS` (default 45s) so Telegram users
  get fast answers — a stuck page fails over to the API instead of hanging.
- Both providers parse through the shared `src/scraper/parse1688.ts`, so the
  `scrape1688Product()` interface in `src/scraper/index.ts` stays swappable.

## Notes / limits

- 1688 aggressively bot-protects pages; the scraper (`src/scraper/oneSixEightEight.ts`)
  is an isolated module behind `scrape1688Product()` so it can be swapped for a
  paid scraping API later without touching bot logic.
- grammY sessions are in-memory; conversation state resets on restart, but
  persisted orders in SQLite are never lost.
