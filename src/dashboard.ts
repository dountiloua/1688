/**
 * Admin web panel — order list, order detail, status advancement and
 * pricing settings in a browser. Runs on the same process/port as the
 * Telegram bot (Railway-friendly: one service, no extra infra).
 *
 * Auth: shared secret in `ADMIN_PANEL_TOKEN`, passed as `?token=` or a
 * form field. Always served over HTTPS in production (Railway terminates
 * TLS), never commit the token.
 */
import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { Bot } from "grammy";
import {
  countByStatus,
  getFreightPerKg,
  getOrderById,
  getUsdRate,
  isValidStatus,
  listOrders,
  ORDER_STATUSES,
  setSetting,
  updateOrderStatus,
  type OrderRow,
  type OrderStatus,
} from "./db.js";
import { getCnyMode, getCnyPerUsd, type CnyRate } from "./fx.js";
import { formatDzd } from "./i18n.js";
import type { MyContext } from "./session.js";

const STATUS_COLORS: Record<OrderStatus, string> = {
  AWAITING_DEPOSIT: "#b45309",
  DEPOSIT_PAID: "#1d4ed8",
  FORWARDED_TO_SHIPPING_PARTNER: "#6d28d9",
  IN_TRANSIT: "#0e7490",
  DELIVERED: "#15803d",
  CANCELLED: "#b91c1c",
};

function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isAuthorized(token: string): boolean {
  const expected = process.env.ADMIN_PANEL_TOKEN ?? "";
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, x) => n + x.length, 0) > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))),
    );
    req.on("error", reject);
  });
}

function statusBadge(status: OrderStatus): string {
  const color = STATUS_COLORS[status] ?? "#374151";
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;color:#fff;background:${color}">${esc(status)}</span>`;
}

function advanceForm(order: OrderRow, token: string): string {
  const options = ORDER_STATUSES.filter((s) => s !== order.status)
    .map((s) => `<option value="${s}">${s}</option>`)
    .join("");
  return `<form method="POST" action="/admin/advance" style="display:inline-flex;gap:6px;align-items:center;margin:0">
    <input type="hidden" name="token" value="${esc(token)}" />
    <input type="hidden" name="id" value="${order.id}" />
    <select name="status" style="padding:4px 6px;border:1px solid #d1d5db;border-radius:6px">${options}</select>
    <button type="submit" style="padding:4px 10px;background:#111827;color:#fff;border:0;border-radius:6px;cursor:pointer">Move</button>
  </form>`;
}

function orderDetailCard(order: OrderRow, token: string): string {
  return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:16px 0;background:#fff">
    <h2 style="margin:0 0 4px">Order #${order.id} ${statusBadge(order.status)}</h2>
    <p style="color:#6b7280;font-size:13px">Created ${esc(order.createdAt)} • Telegram user <code>${order.telegramUserId}</code></p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <tr><td style="padding:4px 8px;color:#6b7280">Customer</td><td style="padding:4px 8px"><b>${esc(order.fullName)}</b> • ${esc(order.phone)}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280">Delivery</td><td style="padding:4px 8px">${esc(order.wilaya)} — ${esc(order.address)}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280">Product</td><td style="padding:4px 8px">${esc(order.titleRaw)} ×${order.quantity || 1}<br/><a href="${esc(order.productUrl)}" target="_blank" rel="noreferrer">1688 link</a></td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280">Price</td><td style="padding:4px 8px">${esc(String(order.priceRmb))} RMB / unit${order.cnyPerUsd ? ` • ${esc(String(order.cnyPerUsd))} ¥/$ • ${esc(String(order.usdRateDzd))} DZD/$` : ""}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280">Freight</td><td style="padding:4px 8px">${order.weightKg > 0 ? `${esc(String(order.weightKg))} kg → ${esc(formatDzd(order.freightDzd))}` : "unknown → TBD by admin"}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280">Money</td><td style="padding:4px 8px">Total <b>${esc(formatDzd(order.totalAmountDzd))}</b> • Deposit ${esc(formatDzd(order.depositAmountDzd))} • Rest ${esc(formatDzd(order.remainingBalanceDzd))}</td></tr>
      <tr><td style="padding:4px 8px;color:#6b7280">Shipping mark</td><td style="padding:4px 8px"><code style="background:#f3f4f6;padding:2px 8px;border-radius:6px">HK Shipping / Mark: ${esc(order.shippingMark)}</code></td></tr>
    </table>
    <div style="margin-top:10px">${advanceForm(order, token)}</div>
  </div>`;
}

function dashboardPage(opts: {
  token: string;
  orders: OrderRow[];
  counts: Record<OrderStatus, number>;
  usdRate: number;
  freightPerKg: number;
  cny: CnyRate | null;
  cnyMode: string;
  activeStatus: string;
  view: OrderRow | null;
  notice: string;
}): string {
  const { token, orders, counts, usdRate, freightPerKg, cny, cnyMode, activeStatus, view, notice } =
    opts;
  const totalOrders = Object.values(counts).reduce((a, b) => a + b, 0);

  const filterLinks = [
    `<a href="/admin?token=${esc(token)}" style="${filterStyle(activeStatus === "")}">All (${totalOrders})</a>`,
    ...ORDER_STATUSES.map(
      (s) =>
        `<a href="/admin?token=${esc(token)}&status=${s}" style="${filterStyle(activeStatus === s)}">${s} (${counts[s]})</a>`,
    ),
  ].join(" ");

  const rows = orders
    .map(
      (o) => `<tr style="border-top:1px solid #e5e7eb">
      <td style="padding:8px"><b>#${o.id}</b><br/><span style="font-size:12px;color:#6b7280">${esc(o.createdAt.slice(0, 16).replace("T", " "))}</span></td>
      <td style="padding:8px">${esc(o.fullName)}<br/><span style="font-size:12px;color:#6b7280">${esc(o.phone)} • ${esc(o.wilaya)}</span></td>
      <td style="padding:8px;max-width:280px">${esc(o.titleRaw.slice(0, 80))} ×${o.quantity || 1}<br/><code style="font-size:11px;background:#f3f4f6;padding:1px 6px;border-radius:4px">${esc(o.shippingMark)}</code></td>
      <td style="padding:8px;white-space:nowrap">${esc(formatDzd(o.totalAmountDzd))}<br/><span style="font-size:12px;color:#6b7280">dep. ${esc(formatDzd(o.depositAmountDzd))}</span></td>
      <td style="padding:8px">${statusBadge(o.status)}</td>
      <td style="padding:8px;white-space:nowrap"><a href="/admin?token=${esc(token)}&status=${esc(activeStatus)}&view=${o.id}">View</a> &nbsp; ${advanceForm(o, token)}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>1688-DZ Admin</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#f9fafb;color:#111827;margin:0">
  <div style="max-width:1100px;margin:0 auto;padding:20px">
    <h1 style="margin:0 0 4px">📦 1688-DZ Admin Panel</h1>
    <p style="color:#6b7280;margin:0 0 16px">Orders, statuses & pricing — changes notify the customer on Telegram automatically.</p>
    ${notice ? `<p style="background:#ecfdf5;border:1px solid #a7f3d0;padding:8px 12px;border-radius:8px">${esc(notice)}</p>` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${Object.entries(counts).map(([s, n]) => `<span style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:6px 12px;font-size:13px">${statusBadge(s as OrderStatus)} <b>${n}</b></span>`).join("")}
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:16px">
      <form method="POST" action="/admin/settings" style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:0">
        <input type="hidden" name="token" value="${esc(token)}" />
        <label style="font-size:13px">USD rate (DZD per $)<br/><input name="usd_rate" value="${usdRate}" inputmode="decimal" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:110px" /></label>
        <label style="font-size:13px">CNY→USD ("auto" or fixed)<br/><input name="cny" value="${cnyMode === "manual" ? esc(String(cny?.rate ?? "")) : "auto"}" inputmode="text" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:110px" /></label>
        <label style="font-size:13px">Freight (DZD / kg)<br/><input name="freight_kg" value="${freightPerKg}" inputmode="numeric" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:120px" /></label>
        <button type="submit" style="padding:7px 14px;background:#111827;color:#fff;border:0;border-radius:6px;cursor:pointer">Save (new orders only)</button>
      </form>
      <p style="font-size:12px;color:#6b7280;margin:8px 0 0">CNY→USD now: <b>${cny ? esc(cny.rate.toFixed(4)) : "unavailable"}</b>${cny ? ` (${esc(cny.source)}${cny.updatedAt ? `, ${esc(cny.updatedAt.slice(0, 16).replace("T", " "))}` : ""})` : ""} • mode: <b>${esc(cnyMode)}</b></p>
    </div>
    <div style="margin-bottom:12px;font-size:13px;display:flex;gap:8px;flex-wrap:wrap">${filterLinks}</div>
    ${view ? orderDetailCard(view, token) : ""}
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow-x:auto">
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#6b7280;font-size:12px;text-transform:uppercase">
        <th style="padding:8px">Order</th><th style="padding:8px">Customer</th><th style="padding:8px">Product</th><th style="padding:8px">Total</th><th style="padding:8px">Status</th><th style="padding:8px">Actions</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="padding:16px;color:#6b7280">No orders yet.</td></tr>`}</tbody>
    </table></div>
  </div></body></html>`;
}

function filterStyle(active: boolean): string {
  return `display:inline-block;padding:4px 10px;border-radius:999px;text-decoration:none;font-size:12px;border:1px solid #d1d5db;${active ? "background:#111827;color:#fff;" : "background:#fff;color:#111827;"}`;
}

function loginPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>1688-DZ Admin</title></head>
  <body style="font-family:system-ui,sans-serif;background:#f9fafb;display:flex;justify-content:center;padding-top:15vh">
  <form method="GET" action="/admin" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;width:320px">
    <h2 style="margin-top:0">🔐 Admin Panel</h2>
    <p style="color:#6b7280;font-size:13px">Enter the <code>ADMIN_PANEL_TOKEN</code> from your <code>.env</code>.</p>
    <input type="password" name="token" autofocus style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:6px" />
    <button type="submit" style="margin-top:12px;width:100%;padding:8px;background:#111827;color:#fff;border:0;border-radius:6px;cursor:pointer">Open panel</button>
  </form></body></html>`;
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export function startDashboard(bot: Bot<MyContext>, port: number): http.Server {
  const server = http.createServer((req, res) => {
    void handle(req, res, bot).catch((err) => {
      console.error("dashboard error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      }
    });
  });
  server.listen(port, () => console.log(`Admin panel + health on :${port}`));
  return server;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bot: Bot<MyContext>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("1688-dz bot ok");
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(302, { location: "/admin" });
    res.end();
    return;
  }

  if (!process.env.ADMIN_PANEL_TOKEN) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("Admin panel disabled: set ADMIN_PANEL_TOKEN in env.");
    return;
  }

  // --- Mutations ---
  if (req.method === "POST" && url.pathname === "/admin/advance") {
    const body = await parseBody(req);
    const token = body.get("token") ?? "";
    if (!isAuthorized(token)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const id = Number(body.get("id"));
    const status = body.get("status") ?? "";
    if (!Number.isInteger(id) || !isValidStatus(status)) {
      redirect(res, token, "Invalid order id or status.");
      return;
    }
    const existing = getOrderById(id);
    if (!existing) {
      redirect(res, token, `Order #${body.get("id")} not found.`);
      return;
    }
    const updated = updateOrderStatus(id, status);
    if (updated) {
      try {
        await bot.api.sendMessage(
          updated.telegramUserId,
          `📌 تحديث طلبك #${id}: الحالة الجديدة ${status}\n🏷️ ${updated.shippingMark}`,
        );
      } catch (notifyErr) {
        console.error("dashboard customer notify failed:", notifyErr);
      }
    }
    redirect(res, token, `Order #${id} → ${status}. Customer notified.`, `view=${id}`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/settings") {
    const body = await parseBody(req);
    const token = body.get("token") ?? "";
    if (!isAuthorized(token)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const usdRate = Number(body.get("usd_rate"));
    const cnyRaw = (body.get("cny") ?? "").trim().toLowerCase();
    const freightKg = Number(body.get("freight_kg"));
    const msgs: string[] = [];
    if (Number.isFinite(usdRate) && usdRate > 0 && usdRate <= 10000) {
      setSetting("usd_rate_dzd", String(usdRate));
      msgs.push(`USD → ${usdRate} DZD`);
    }
    if (cnyRaw === "auto" || cnyRaw === "") {
      setSetting("cny_per_usd_mode", "auto");
      msgs.push("CNY → auto (live)");
    } else {
      const cnyRate = Number(cnyRaw);
      if (Number.isFinite(cnyRate) && cnyRate >= 5 && cnyRate <= 12) {
        setSetting("cny_per_usd_mode", "manual");
        setSetting("cny_per_usd_manual", String(cnyRate));
        msgs.push(`CNY → manual ${cnyRate}`);
      }
    }
    if (Number.isFinite(freightKg) && freightKg >= 0 && freightKg <= 10000000) {
      setSetting("freight_per_kg_dzd", String(Math.round(freightKg)));
      msgs.push(`freight → ${formatDzd(freightKg)}/kg`);
    }
    redirect(res, token, msgs.length > 0 ? msgs.join(" • ") + " (new orders only)." : "No valid values — nothing changed.");
    return;
  }

  // --- Dashboard page ---
  if (url.pathname === "/admin") {
    const token = url.searchParams.get("token") ?? "";
    if (!token) {
      sendHtml(res, 200, loginPage());
      return;
    }
    if (!isAuthorized(token)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden: bad token");
      return;
    }
    const statusParam = url.searchParams.get("status") ?? "";
    const activeStatus = isValidStatus(statusParam) ? statusParam : "";
    const orders = listOrders(
      activeStatus ? (activeStatus as OrderStatus) : undefined,
      200,
    );
    const viewId = Number(url.searchParams.get("view"));
    const view =
      Number.isInteger(viewId) && viewId > 0 ? getOrderById(viewId) : null;
    let cny: CnyRate | null = null;
    try {
      cny = await getCnyPerUsd();
    } catch (err) {
      console.warn("dashboard live CNY rate unavailable:", err);
    }
    sendHtml(
      res,
      200,
      dashboardPage({
        token,
        orders,
        counts: countByStatus(),
        usdRate: getUsdRate(),
        freightPerKg: getFreightPerKg(),
        cny,
        cnyMode: getCnyMode(),
        activeStatus,
        view,
        notice: url.searchParams.get("notice") ?? "",
      }),
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

function redirect(
  res: http.ServerResponse,
  token: string,
  notice: string,
  extra = "",
): void {
  const params = new URLSearchParams({ token, notice });
  const suffix = extra ? `&${extra}` : "";
  res.writeHead(303, { location: `/admin?${params.toString()}${suffix}` });
  res.end();
}
