import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_BENEFIT_DZD,
  DEFAULT_FREIGHT_ESTIMATE_DZD,
  DEFAULT_FREIGHT_PER_KG_DZD,
  DEFAULT_FX_RATE_RMB_DZD,
  DEFAULT_MIN_ORDER_DZD,
  DEFAULT_USD_RATE_DZD,
  MINIMUM_DEPOSIT_DZD,
  roundWeightKg,
} from "./pricing.js";

export type OrderStatus =
  | "PENDING_ACCEPTANCE"
  | "AWAITING_DEPOSIT"
  | "DEPOSIT_PAID"
  | "FORWARDED_TO_SHIPPING_PARTNER"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "CANCELLED";

export const ORDER_STATUSES: OrderStatus[] = [
  "PENDING_ACCEPTANCE",
  "AWAITING_DEPOSIT",
  "DEPOSIT_PAID",
  "FORWARDED_TO_SHIPPING_PARTNER",
  "IN_TRANSIT",
  "DELIVERED",
  "CANCELLED",
];

export interface OrderRow {
  id: number;
  telegramUserId: number;
  fullName: string;
  phone: string;
  wilaya: string;
  postalCode: string;
  address: string;
  productUrl: string;
  titleRaw: string;
  priceRmb: number;
  /** Source currency of priceRmb: CNY (1688) or USD (Alibaba). */
  currency: string;
  imageUrl: string;
  variantSummary: string;
  fxRateRmbDzd: number;
  quantity: number;
  weightKg: number;
  freightDzd: number;
  cnyPerUsd: number;
  usdRateDzd: number;
  /** Approximate total shown pre-acceptance (formula + benefit). */
  approxTotalDzd: number;
  /** Final total locked by the admin at acceptance (invoice). */
  totalAmountDzd: number;
  depositAmountDzd: number;
  remainingBalanceDzd: number;
  shippingMark: string;
  status: OrderStatus;
  createdAt: string;
}

export interface NewOrder {
  telegramUserId: number;
  fullName: string;
  phone: string;
  wilaya: string;
  postalCode: string;
  address: string;
  productUrl: string;
  titleRaw: string;
  priceRmb: number;
  /** Source currency of priceRmb: CNY (1688) or USD (Alibaba). */
  currency: string;
  imageUrl: string;
  variantSummary: string;
  fxRateRmbDzd: number;
  quantity: number;
  weightKg: number;
  freightDzd: number;
  cnyPerUsd: number;
  usdRateDzd: number;
  /** Approximate total shown pre-acceptance (formula + benefit). */
  approxTotalDzd: number;
  /** Final total locked by the admin at acceptance (invoice). */
  totalAmountDzd: number;
  depositAmountDzd: number;
  remainingBalanceDzd: number;
  status: OrderStatus;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath =
    process.env.DATABASE_PATH ?? "./data/orders.db";
  const dir = path.dirname(path.resolve(dbPath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegramUserId INTEGER NOT NULL,
      fullName TEXT NOT NULL,
      phone TEXT NOT NULL,
      wilaya TEXT NOT NULL,
      address TEXT NOT NULL,
      productUrl TEXT NOT NULL,
      titleRaw TEXT NOT NULL DEFAULT '',
      priceRmb REAL NOT NULL,
      fxRateRmbDzd REAL NOT NULL,
      totalAmountDzd INTEGER NOT NULL,
      depositAmountDzd INTEGER NOT NULL,
      remainingBalanceDzd INTEGER NOT NULL,
      shippingMark TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'AWAITING_DEPOSIT',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(telegramUserId);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const getSetting = database.prepare(
    "SELECT value FROM settings WHERE key = ?",
  );
  const setSetting = database.prepare(
    "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
  );
  if (!getSetting.get("fx_rate_rmb_dzd")) {
    setSetting.run("fx_rate_rmb_dzd", String(DEFAULT_FX_RATE_RMB_DZD));
  }
  if (!getSetting.get("freight_estimate_dzd")) {
    setSetting.run(
      "freight_estimate_dzd",
      String(DEFAULT_FREIGHT_ESTIMATE_DZD),
    );
  }
  // USD-based pricing settings
  if (!getSetting.get("usd_rate_dzd")) {
    setSetting.run("usd_rate_dzd", String(DEFAULT_USD_RATE_DZD));
  }
  if (!getSetting.get("freight_per_kg_dzd")) {
    setSetting.run(
      "freight_per_kg_dzd",
      String(DEFAULT_FREIGHT_PER_KG_DZD),
    );
  }
  if (!getSetting.get("cny_per_usd_mode")) {
    setSetting.run("cny_per_usd_mode", "auto");
  }
  if (!getSetting.get("benefit_dzd")) {
    setSetting.run("benefit_dzd", String(DEFAULT_BENEFIT_DZD));
  }
  if (!getSetting.get("min_order_dzd")) {
    setSetting.run("min_order_dzd", String(DEFAULT_MIN_ORDER_DZD));
  }

  // Order columns for quantity / weight-based freight (added after v1)
  const cols = database
    .prepare("PRAGMA table_info(orders)")
    .all() as { name: string }[];
  const hasCol = (n: string): boolean => cols.some((c) => c.name === n);
  if (!hasCol("quantity")) {
    database.exec("ALTER TABLE orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1");
  }
  if (!hasCol("weightKg")) {
    database.exec("ALTER TABLE orders ADD COLUMN weightKg REAL NOT NULL DEFAULT 0");
  }
  if (!hasCol("freightDzd")) {
    database.exec("ALTER TABLE orders ADD COLUMN freightDzd INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasCol("cnyPerUsd")) {
    database.exec("ALTER TABLE orders ADD COLUMN cnyPerUsd REAL NOT NULL DEFAULT 0");
  }
  if (!hasCol("usdRateDzd")) {
    database.exec("ALTER TABLE orders ADD COLUMN usdRateDzd REAL NOT NULL DEFAULT 0");
  }
  if (!hasCol("variantSummary")) {
    database.exec("ALTER TABLE orders ADD COLUMN variantSummary TEXT NOT NULL DEFAULT ''");
  }
  if (!hasCol("postalCode")) {
    database.exec("ALTER TABLE orders ADD COLUMN postalCode TEXT NOT NULL DEFAULT ''");
  }
  if (!hasCol("imageUrl")) {
    database.exec("ALTER TABLE orders ADD COLUMN imageUrl TEXT NOT NULL DEFAULT ''");
  }
  if (!hasCol("approxTotalDzd")) {
    database.exec("ALTER TABLE orders ADD COLUMN approxTotalDzd INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasCol("currency")) {
    database.exec("ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'");
  }
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function getFxRate(): number {
  const raw = getSetting("fx_rate_rmb_dzd");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FX_RATE_RMB_DZD;
}

/** Flat admin benefit added to the formula total (default 2000). New orders only. */
export function getBenefit(): number {
  const raw = getSetting("benefit_dzd");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_BENEFIT_DZD;
}

/** Minimum order product-subtotal in DZD (default 3000). New orders only. */
export function getMinOrder(): number {
  const raw = getSetting("min_order_dzd");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_MIN_ORDER_DZD;
}

/** DZD per 1 USD (default 255). Applies to new orders only. */
export function getUsdRate(): number {
  const raw = getSetting("usd_rate_dzd");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_RATE_DZD;
}

/** Estimated freight in DZD per kg (default 5000). Applies to new orders only. */
export function getFreightPerKg(): number {
  const raw = getSetting("freight_per_kg_dzd");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FREIGHT_PER_KG_DZD;
}

export function getFreightEstimate(): number {
  const raw = getSetting("freight_estimate_dzd");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0
    ? n
    : DEFAULT_FREIGHT_ESTIMATE_DZD;
}

/**
 * Insert an order, then assign the unique shipping mark ALG-<orderId>.
 * The mark uses the internal order-sequence id, never the raw Telegram id.
 */
export function createOrder(input: NewOrder): OrderRow {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO orders (
      telegramUserId, fullName, phone, wilaya, postalCode, address,
      productUrl, titleRaw, priceRmb, currency, imageUrl, variantSummary, fxRateRmbDzd,
      quantity, weightKg, freightDzd, cnyPerUsd, usdRateDzd,
      approxTotalDzd, totalAmountDzd, depositAmountDzd, remainingBalanceDzd,
      shippingMark, status
    ) VALUES (
      @telegramUserId, @fullName, @phone, @wilaya, @postalCode, @address,
      @productUrl, @titleRaw, @priceRmb, @currency, @imageUrl, @variantSummary, @fxRateRmbDzd,
      @quantity, @weightKg, @freightDzd, @cnyPerUsd, @usdRateDzd,
      @approxTotalDzd, @totalAmountDzd, @depositAmountDzd, @remainingBalanceDzd,
      '', @status
    )
  `);
  const info = stmt.run(input);
  const id = Number(info.lastInsertRowid);
  const shippingMark = `ALG-${id}`;
  database
    .prepare("UPDATE orders SET shippingMark = ? WHERE id = ?")
    .run(shippingMark, id);
  const row = getOrderById(id);
  if (!row) throw new Error(`Failed to read back order #${id}`);
  return row;
}

export function getOrderById(id: number): OrderRow | null {
  const row = getDb()
    .prepare("SELECT * FROM orders WHERE id = ?")
    .get(id) as OrderRow | undefined;
  return row ?? null;
}

export function listAwaitingDeposit(limit = 20): OrderRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM orders WHERE status = 'AWAITING_DEPOSIT' ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as OrderRow[];
}

/** Orders waiting for the admin to lock a final price + accept. */
export function listPendingAcceptance(limit = 50): OrderRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM orders WHERE status = 'PENDING_ACCEPTANCE' ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as OrderRow[];
}

/**
 * Accept an order: lock the final product price, apply the admin-entered
 * parcel weight (smart-rounded × per-kg rate) as freight, recompute the
 * (always-10000) deposit against the all-in total, and move to
 * AWAITING_DEPOSIT for the invoice. Weight 0/omitted = shipping TBD.
 */
export function acceptOrder(
  id: number,
  productFinalDzd: number,
  weightKgRaw?: number,
): OrderRow | null {
  const productFinal = Math.max(0, Math.round(productFinalDzd));
  const weightKg = roundWeightKg(weightKgRaw ?? 0);
  const freight = Math.round(weightKg * getFreightPerKg());
  const total = productFinal + freight;
  const deposit = Math.min(total, MINIMUM_DEPOSIT_DZD);
  getDb()
    .prepare(
      `UPDATE orders SET weightKg = ?, freightDzd = ?,
       totalAmountDzd = ?, depositAmountDzd = ?,
       remainingBalanceDzd = ?, status = 'AWAITING_DEPOSIT' WHERE id = ?`,
    )
    .run(weightKg, freight, total, deposit, total - deposit, id);
  return getOrderById(id);
}

/** All orders, newest first, optionally filtered by status (for the dashboard). */
export function listOrders(status?: OrderStatus, limit = 200): OrderRow[] {
  if (status && isValidStatus(status)) {
    return getDb()
      .prepare("SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ?")
      .all(status, limit) as OrderRow[];
  }
  return getDb()
    .prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?")
    .all(limit) as OrderRow[];
}

/** Order counts per status (for the dashboard stats row). */
export function countByStatus(): Record<OrderStatus, number> {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status")
    .all() as { status: string; n: number }[];
  const out = Object.fromEntries(
    ORDER_STATUSES.map((s) => [s, 0]),
  ) as Record<OrderStatus, number>;
  for (const r of rows) {
    if (isValidStatus(r.status)) out[r.status] = r.n;
  }
  return out;
}

export function listOrdersByUser(
  telegramUserId: number,
  limit = 20,
): OrderRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM orders WHERE telegramUserId = ? ORDER BY id DESC LIMIT ?",
    )
    .all(telegramUserId, limit) as OrderRow[];
}

export function updateOrderStatus(
  id: number,
  status: OrderStatus,
): OrderRow | null {
  getDb().prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, id);
  return getOrderById(id);
}

/** Permanently delete an order (admin panel). Returns true if one was removed. */
export function deleteOrder(id: number): boolean {
  const info = getDb().prepare("DELETE FROM orders WHERE id = ?").run(id);
  return info.changes === 1;
}

export function isValidStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as string[]).includes(value);
}
