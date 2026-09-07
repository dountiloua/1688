/**
 * Admin web panel — order list, order detail, status advancement,
 * deletions and pricing settings in a browser. Runs on the same
 * process/port as the Telegram bot (Railway-friendly: one service).
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
  deleteOrder,
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
import { translateVariant } from "./variantDict.js";

const STATUS_COLORS: Record<OrderStatus, string> = {
  AWAITING_DEPOSIT: "#b45309",
  DEPOSIT_PAID: "#1d4ed8",
  FORWARDED_TO_SHIPPING_PARTNER: "#6d28d9",
  IN_TRANSIT: "#0e7490",
  DELIVERED: "#15803d",
  CANCELLED: "#b91c1c",
};

const CSS = `
:root{--bg:#f1f5f9;--card:#fff;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--brand:#0f172a;--accent:#2563eb;--danger:#dc2626;--ok:#16a34a;--r:14px}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);margin:0}
.wrap{max-width:1120px;margin:0 auto;padding:20px 16px 48px}
.top{position:sticky;top:0;z-index:10;background:rgba(241,245,249,.9);backdrop-filter:blur(8px);padding:14px 0;margin-bottom:14px;border-bottom:1px solid var(--line)}
.top h1{margin:0;font-size:20px}
.top p{margin:2px 0 0;color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:0 1px 3px rgba(15,23,42,.07)}
.pad{padding:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 14px}
.stat{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px}
.stat b{font-size:20px}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:700;color:#fff;white-space:nowrap}
.notice{background:#ecfdf5;border:1px solid #a7f3d0;padding:10px 14px;border-radius:10px;margin:0 0 14px;font-size:14px}
.grid2{display:grid;grid-template-columns:1fr 1.35fr;gap:14px;margin:0 0 14px}
@media(max-width:820px){.grid2{grid-template-columns:1fr}}
.card h2{margin:0 0 2px;font-size:17px}
.card h3{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.sub{color:var(--mut);font-size:12.5px;margin:0 0 10px}
.kv{display:grid;grid-template-columns:128px 1fr;gap:6px 10px;font-size:14px}
.kv dt{color:var(--mut)}
.kv dd{margin:0;overflow-wrap:anywhere}
.kv a{color:var(--accent);text-decoration:none}
.money{width:100%;border-collapse:collapse;font-size:14px}
.money td{padding:6px 0;border-top:1px dashed var(--line)}
.money tr:first-child td{border-top:0}
.money td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.total td{font-weight:800;font-size:16px}
.mark{display:inline-block;background:#f1f5f9;border:1px dashed #94a3b8;padding:4px 10px;border-radius:8px;font-family:ui-monospace,monospace;font-size:13px}
button,.btn{font:inherit;cursor:pointer;border:0;border-radius:8px;background:var(--brand);color:#fff;padding:7px 14px;font-size:13.5px}
.btn-danger{background:var(--danger)}
.btn-ghost{background:#f1f5f9;color:var(--ink)}
input,select{font:inherit;padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;font-size:13.5px;background:#fff}
a{color:var(--accent)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;font-size:12.5px}
.pill{display:inline-block;padding:5px 12px;border-radius:999px;text-decoration:none;border:1px solid #cbd5e1;background:#fff;color:var(--ink)}
.pill.on{background:var(--brand);color:#fff;border-color:var(--brand)}
table.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th{text-align:left;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:10px 8px;border-bottom:1px solid var(--line)}
.tbl td{padding:10px 8px;border-top:1px solid var(--line);vertical-align:middle}
.tbl tbody tr:hover{background:#f8fafc}
.prodcell{display:flex;gap:10px;align-items:center;min-width:220px}
.thumb{width:52px;height:52px;object-fit:cover;border-radius:9px;border:1px solid var(--line);flex:none}
.ptitle{font-weight:600;color:var(--ink);text-decoration:none}
.ptitle:hover{text-decoration:underline}
.mut{color:var(--mut);font-size:12px}
.rowflex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
form.inline{margin:0;display:inline-flex;gap:6px;align-items:center}
.del{color:var(--danger);text-decoration:none;font-size:16px}
.confirm{border:2px solid var(--danger);background:#fef2f2}
.settings{display:flex;gap:12px;flex-wrap:wrap;align-items:end}
.settings label{font-size:12.5px;color:var(--mut)}
.settings label input{display:block;margin-top:4px;width:130px}
`;

const JS = `
function copyMark(btn,text){
  function done(){var o=btn.textContent;btn.textContent="✓ Copied";setTimeout(function(){btn.textContent=o},1500)}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done).catch(function(){fallback()});}else{fallback()}
  function fallback(){var ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand("copy");done()}catch(e){}document.body.removeChild(ta)}
}`;

function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsStr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
  return `<span class="badge" style="background:${color}">${esc(status)}</span>`;
}

function advanceForm(order: OrderRow, token: string): string {
  const options = ORDER_STATUSES.filter((s) => s !== order.status)
    .map((s) => `<option value="${s}">${s}</option>`)
    .join("");
  return `<form class="inline" method="POST" action="/admin/advance">
    <input type="hidden" name="token" value="${esc(token)}" />
    <input type="hidden" name="id" value="${order.id}" />
    <select name="status">${options}</select>
    <button type="submit">Move</button>
  </form>`;
}

/** Original Chinese variant + English translation for the admin. */
function variantLine(summary: string): string {
  if (!summary) return "";
  const en = summary
    .split(" / ")
    .map((v) => translateVariant(v.trim(), "en"))
    .join(" / ");
  return en !== summary ? `${esc(summary)} <span class="mut">(${esc(en)})</span>` : esc(summary);
}

function thumb(img: string, url: string, title: string): string {
  if (!img) return "";
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer"><img class="thumb" src="${esc(img)}" alt="" loading="lazy" /></a>`;
}

function orderDetailCard(order: OrderRow, token: string): string {
  const mark = `HK Shipping / Mark: ${order.shippingMark}`;
  return `<div class="grid2">
    <div class="card pad">
      <h3>👤 Customer</h3>
      <h2>${esc(order.fullName)}</h2>
      <p class="sub">Order #${order.id} ${statusBadge(order.status)}</p>
      <dl class="kv">
        <dt>Phone</dt><dd><a href="tel:${esc(order.phone)}">${esc(order.phone)}</a></dd>
        <dt>Wilaya</dt><dd>${esc(order.wilaya)}</dd>
        <dt>Postal code</dt><dd>${esc(order.postalCode) || '<span class="mut">—</span>'}</dd>
        <dt>Address</dt><dd>${esc(order.address)}</dd>
        <dt>Telegram ID</dt><dd><code>${order.telegramUserId}</code></dd>
        <dt>Created</dt><dd>${esc(order.createdAt)}</dd>
      </dl>
    </div>
    <div class="card pad">
      <h3>📦 Order</h3>
      <div class="rowflex" style="margin-bottom:10px">
        ${thumb(order.imageUrl, order.productUrl, order.titleRaw)}
        <div><a class="ptitle" style="font-size:15px" href="${esc(order.productUrl)}" target="_blank" rel="noreferrer">${esc(order.titleRaw)} ↗</a>
        <div class="mut">×${order.quantity || 1} • ${esc(String(order.priceRmb))} RMB / unit</div></div>
      </div>
      ${order.variantSummary ? `<p style="margin:0 0 10px">🎨 ${variantLine(order.variantSummary)}</p>` : ""}
      <table class="money">
        <tr><td>Product (${order.quantity || 1} × ${esc(String(order.priceRmb))} RMB)</td><td>${esc(formatDzd((order.totalAmountDzd - order.freightDzd)))}</td></tr>
        <tr><td>Freight ${order.weightKg > 0 ? `(${esc(String(order.weightKg))} kg)` : "(weight unknown)"}</td><td>${order.weightKg > 0 ? esc(formatDzd(order.freightDzd)) : "TBD"}</td></tr>
        <tr class="total"><td>Total</td><td>${esc(formatDzd(order.totalAmountDzd))}</td></tr>
        <tr><td>Deposit</td><td>${esc(formatDzd(order.depositAmountDzd))}</td></tr>
        <tr><td>Remaining</td><td>${esc(formatDzd(order.remainingBalanceDzd))}</td></tr>
      </table>
      <p class="mut" style="margin:8px 0">Rates locked at order time: ${esc(String(order.cnyPerUsd || "—"))} ¥/$ • ${esc(String(order.usdRateDzd || "—"))} DZD/$</p>
      <div class="rowflex">
        <code class="mark">${esc(mark)}</code>
        <button class="btn-ghost btn" onclick="copyMark(this,'${jsStr(mark)}')">⧉ Copy</button>
      </div>
      <div class="rowflex" style="margin-top:12px">${advanceForm(order, token)}
        <a class="del" style="font-size:13px" href="/admin?token=${esc(token)}&delete=${order.id}">🗑️ Delete…</a>
      </div>
    </div>
  </div>`;
}

function deleteConfirmCard(order: OrderRow, token: string): string {
  return `<div class="card pad confirm" style="margin-bottom:14px">
    <h2 style="color:var(--danger)">🗑️ Delete order #${order.id}?</h2>
    <p style="margin:6px 0 12px;font-size:14px">${esc(order.titleRaw.slice(0, 100))} ×${order.quantity || 1} • <b>${esc(formatDzd(order.totalAmountDzd))}</b> • ${statusBadge(order.status)}<br/>This is permanent and cannot be undone.</p>
    <form class="inline" method="POST" action="/admin/delete">
      <input type="hidden" name="token" value="${esc(token)}" />
      <input type="hidden" name="id" value="${order.id}" />
      <input type="hidden" name="confirm" value="yes" />
      <button type="submit" class="btn-danger">Yes, delete permanently</button>
    </form>
    &nbsp;<a href="/admin?token=${esc(token)}&view=${order.id}">Cancel</a>
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
  deleteTarget: OrderRow | null;
  notice: string;
}): string {
  const { token, orders, counts, usdRate, freightPerKg, cny, cnyMode, activeStatus, view, deleteTarget, notice } =
    opts;
  const totalOrders = Object.values(counts).reduce((a, b) => a + b, 0);

  const filterLinks =
    `<a class="pill${activeStatus === "" ? " on" : ""}" href="/admin?token=${esc(token)}">All (${totalOrders})</a>` +
    ORDER_STATUSES.map(
      (s) =>
        `<a class="pill${activeStatus === s ? " on" : ""}" href="/admin?token=${esc(token)}&status=${s}">${s} (${counts[s]})</a>`,
    ).join("");

  const rows = orders
    .map(
      (o) => `<tr>
      <td><b>#${o.id}</b><br/><span class="mut">${esc(o.createdAt.slice(0, 16).replace("T", " "))}</span></td>
      <td><b>${esc(o.fullName)}</b><br/><span class="mut">${esc(o.phone)} • ${esc(o.wilaya)}${o.postalCode ? ` ${esc(o.postalCode)}` : ""}</span></td>
      <td><div class="prodcell">${thumb(o.imageUrl, o.productUrl, o.titleRaw)}<div><a class="ptitle" href="${esc(o.productUrl)}" target="_blank" rel="noreferrer">${esc(o.titleRaw.slice(0, 80))} ↗</a><br/><code class="mut">${esc(o.shippingMark)}</code></div></div></td>
      <td style="white-space:nowrap">${esc(formatDzd(o.totalAmountDzd))}<br/><span class="mut">dep. ${esc(formatDzd(o.depositAmountDzd))}</span></td>
      <td>${statusBadge(o.status)}</td>
      <td style="white-space:nowrap"><a href="/admin?token=${esc(token)}&status=${esc(activeStatus)}&view=${o.id}">View</a> &nbsp; ${advanceForm(o, token)} &nbsp; <a class="del" title="Delete order" href="/admin?token=${esc(token)}&status=${esc(activeStatus)}&delete=${o.id}">🗑️</a></td>
    </tr>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>1688-DZ Admin</title><style>${CSS}</style></head>
  <body><div class="top"><div class="wrap" style="padding-top:0;padding-bottom:0">
    <h1>📦 1688-DZ Admin Panel</h1>
    <p>Orders, statuses & pricing — status changes notify the customer on Telegram automatically.</p>
  </div></div>
  <div class="wrap">
    ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
    <div class="stats">
      ${Object.entries(counts).map(([s, n]) => `<div class="card stat">${statusBadge(s as OrderStatus)} <b>${n}</b></div>`).join("")}
    </div>
    <div class="card pad" style="margin-bottom:14px">
      <form method="POST" action="/admin/settings" style="margin:0">
        <div class="settings">
          <input type="hidden" name="token" value="${esc(token)}" />
          <label>USD rate (DZD per $)<input name="usd_rate" value="${usdRate}" inputmode="decimal" /></label>
          <label>CNY→USD ("auto" or fixed)<input name="cny" value="${cnyMode === "manual" ? esc(String(cny?.rate ?? "")) : "auto"}" inputmode="text" /></label>
          <label>Freight (DZD / kg)<input name="freight_kg" value="${freightPerKg}" inputmode="numeric" /></label>
          <button type="submit">Save (new orders only)</button>
        </div>
      </form>
      <p class="mut" style="margin:8px 0 0">CNY→USD now: <b>${cny ? esc(cny.rate.toFixed(4)) : "unavailable"}</b>${cny ? ` (${esc(cny.source)}${cny.updatedAt ? `, ${esc(cny.updatedAt.slice(0, 16).replace("T", " "))}` : ""})` : ""} • mode: <b>${esc(cnyMode)}</b></p>
    </div>
    <div class="filters">${filterLinks}</div>
    ${deleteTarget ? deleteConfirmCard(deleteTarget, token) : ""}
    ${view && (!deleteTarget || deleteTarget.id !== view.id) ? orderDetailCard(view, token) : ""}
    <div class="card" style="overflow-x:auto">
    <table class="tbl">
      <thead><tr>
        <th>Order</th><th>Customer</th><th>Product</th><th>Total</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="padding:16px;color:var(--mut)">No orders yet.</td></tr>`}</tbody>
    </table></div>
  </div><script>${JS}</script></body></html>`;
}

function loginPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>1688-DZ Admin</title><style>${CSS}</style></head>
  <body style="display:flex;justify-content:center;padding:15vh 16px 0">
  <form class="card pad" method="GET" action="/admin" style="width:340px">
    <h2 style="margin-top:0">🔐 Admin Panel</h2>
    <p class="mut">Enter the <code>ADMIN_PANEL_TOKEN</code> from your <code>.env</code>.</p>
    <input type="password" name="token" autofocus style="width:100%" />
    <button type="submit" style="margin-top:12px;width:100%">Open panel</button>
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

  if (req.method === "POST" && url.pathname === "/admin/delete") {
    const body = await parseBody(req);
    const token = body.get("token") ?? "";
    if (!isAuthorized(token)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const id = Number(body.get("id"));
    if (!Number.isInteger(id) || id <= 0 || body.get("confirm") !== "yes") {
      redirect(res, token, "Delete not confirmed — nothing removed.");
      return;
    }
    const existing = getOrderById(id);
    if (!existing) {
      redirect(res, token, `Order #${body.get("id")} not found.`);
      return;
    }
    const ok = deleteOrder(id);
    redirect(res, token, ok ? `🗑️ Order #${id} permanently deleted.` : `Order #${id} could not be deleted.`);
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
    const deleteId = Number(url.searchParams.get("delete"));
    const deleteTarget =
      Number.isInteger(deleteId) && deleteId > 0 ? getOrderById(deleteId) : null;
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
        deleteTarget,
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
