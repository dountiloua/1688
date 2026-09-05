# Prompt for OpenCode (Muse Spark 1.3) — 1688-DZ Sourcing Telegram Bot MVP

Copy everything below into OpenCode as your build instruction.

---

Act as a senior Node.js/TypeScript backend engineer. Build a complete,
working Telegram bot MVP for a 1688-to-Algeria B2B sourcing service. The bot
lets Algerian customers paste a 1688.com product link, see the price
converted to DZD, and place an order that gets forwarded to a human admin
for processing (purchasing + shipping is handled by a partner freight
company — this bot does NOT manage warehousing or logistics itself, only
order intake, pricing, and status tracking).

## Tech stack
- Node.js 20+, TypeScript
- Telegram Bot API via `grammY` (preferred over node-telegram-bot-api for
  its modern TS support and middleware/session handling)
- SQLite via `better-sqlite3` for storage (simple, file-based, zero external
  DB dependency for the MVP — easy to swap for Postgres later)
- Playwright for scraping (headless Chromium)
- Deployment target: Railway (must run via `npm start`, read `PORT`/`TOKEN`
  from environment variables, and be resilient to container restarts —
  persist the SQLite file to a Railway volume, not ephemeral disk)

## 1688 product scraping
Implement a `scrape1688Product(url: string)` function that:
- Accepts a 1688.com product URL
- Uses Playwright (headless Chromium) to load the page and extract:
  `title` (Chinese), `priceRmb` (numeric, handle price ranges/tiers by
  taking the lowest tier price), `imageUrl` (main product image),
  `moq` (minimum order quantity, if present)
- Handles pages that fail to load or don't match expected selectors by
  throwing a clear, catchable error (`Product1688ScrapeError`) rather than
  crashing
- Includes realistic browser headers/viewport to reduce blocking, and a
  configurable delay/backoff if 1688 rate-limits
- NOTE: build this scraping logic as an isolated, swappable module
  (`src/scraper/oneSixEightEight.ts`) behind a clean interface, since it may
  later be replaced by a paid scraping API if reliability becomes an issue

## Pricing engine
Port this exact pricing logic into `src/pricing.ts` (already validated
elsewhere in this project — do not change the formula):

```
DEFAULT_FX_RATE_RMB_DZD = 38       // DZD per 1 CNY, admin-editable via /setfx command
FX_VOLATILITY_BUFFER = 1.05
PLATFORM_MARGIN = 1.10
MINIMUM_DEPOSIT_DZD = 10000

productCostDzd = priceRmb * fxRateRmbDzd
totalAmountDzd = round(productCostDzd * 1.05 * 1.10 + estFreightDzd)

if totalAmountDzd <= 10000:
    requiresFullPaymentUpfront = true
    depositAmountDzd = totalAmountDzd
    remainingBalanceDzd = 0
else:
    requiresFullPaymentUpfront = false
    depositAmountDzd = 10000
    remainingBalanceDzd = totalAmountDzd - 10000
```

`estFreightDzd` should default to a configurable flat estimate (e.g. 1500
DZD) until real freight-cost data from the partner shipping company is
available — expose this as an admin-configurable value too.

## Bot conversation flow (customer side)
1. `/start` — welcome message in Arabic (default), with a note that
   French/English are available via `/lang`
2. Customer sends a 1688.com URL as a plain message
3. Bot replies "🔎 جاري البحث عن المنتج..." then scrapes and shows:
   - Product image + title
   - Price in RMB and converted DZD (using the pricing engine)
   - Deposit required now vs. remaining balance
   - Buttons: "✅ تأكيد الطلب" (Confirm order) / "❌ إلغاء" (Cancel)
4. On confirm, bot asks for (one at a time, via a simple session-based
   conversation): full name → phone number → wilaya → full delivery address
5. Bot generates a unique shipping mark: `ALG-[USER_ID]` (USER_ID = the
   Telegram user's internal order-sequence ID, not their raw Telegram ID)
6. Bot shows an order summary and confirms it's been received, with a
   status of `AWAITING_DEPOSIT`. Include a note that payment instructions
   (bank transfer / BaridiMob / cash-on-delivery — real SATIM integration
   is not yet live) will be sent by an admin shortly.
7. Order is saved to SQLite with: id, telegramUserId, fullName, phone,
   wilaya, address, productUrl, titleRaw, priceRmb, fxRateRmbDzd,
   totalAmountDzd, depositAmountDzd, remainingBalanceDzd, shippingMark,
   status, createdAt

## Order status enum (simplified — no warehouse stages, since a partner
company handles physical logistics)
```
AWAITING_DEPOSIT -> DEPOSIT_PAID -> FORWARDED_TO_SHIPPING_PARTNER ->
IN_TRANSIT -> DELIVERED
(or CANCELLED at any point before FORWARDED_TO_SHIPPING_PARTNER)
```

## Admin commands (restricted to a hardcoded admin Telegram user ID from env
var `ADMIN_TELEGRAM_ID`)
- `/orders` — list all orders with status `AWAITING_DEPOSIT`, most recent
  first, each with an inline button to mark as `DEPOSIT_PAID`
- `/order <id>` — show full order detail, including the shipping mark
  formatted exactly as `HK Shipping / Mark: ALG-[USER_ID]` for the admin to
  copy into their communication with the shipping partner
- `/setfx <rate>` — update the admin-editable FX rate used for all new
  orders going forward (does not retroactively change existing orders)
- `/setfreight <amount>` — update the flat estimated freight default
- `/advance <order_id> <new_status>` — manually move an order to the next
  lifecycle stage, notifying the customer via a Telegram message when this
  happens

## Customer status check
- `/myorders` — customer can see their own order history and current
  status at any time

## Code quality requirements
- Full TypeScript typing, no `any` unless truly unavoidable
- Split into clear modules: `bot.ts` (entrypoint + grammY setup),
  `scraper/oneSixEightEight.ts`, `pricing.ts`, `db.ts` (SQLite setup +
  queries), `handlers/customer.ts`, `handlers/admin.ts`
- Include a `.env.example` listing all required environment variables
  (`TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_ID`, `DATABASE_PATH`)
- Include a `README.md` with setup steps: how to get a bot token from
  @BotFather, how to run locally, and how to deploy on Railway
- Include basic error handling everywhere a scrape or DB call could fail,
  so the bot never crashes silently on a bad link or malformed input

Generate the full project now: all files, fully working, ready to
`npm install && npm run build && npm start`.