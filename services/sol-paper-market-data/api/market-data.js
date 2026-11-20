/**
 * On-demand read-only SOL/BTC evidence for Vercel.
 * Import project with Root Directory: services/sol-paper-market-data
 * GET /api/market-data?view=health or ?view=snapshot
 *
 * No keys, wallet integration, trades, cached market marks, or sheet writes.
 */
import { buildSnapshot, PAIRS } from "../src/worker.mjs";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Access-Control-Allow-Origin": "*",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export async function GET(request) {
  const view = new URL(request.url).searchParams.get("view") || "health";
  if (!["health", "snapshot"].includes(view)) {
    return json({ error: "INVALID_VIEW", allowed: ["health", "snapshot"] }, 400);
  }
  try {
    // Evaluate ON DEMAND at the invocation time, not at a GitHub cron tick.
    const snapshot = await buildSnapshot({ nowMs: Date.now() });
    const status = snapshot.status === "DATA_READY" ? 200 : 503;
    if (view === "snapshot") return json(snapshot, status);
    return json({
      schema: snapshot.schema,
      checkedAtUtc: snapshot.checkedAtUtc,
      status: snapshot.status,
      checks: snapshot.checks,
      quoteStatus: Object.fromEntries(PAIRS.map(pair => [
        pair,
        { ok: snapshot.quotes[pair]?.ok === true, reason: snapshot.quotes[pair]?.reason || null },
      ])),
      candleStatus: Object.fromEntries(Object.entries(snapshot.series).map(([name, item]) => [
        name,
        { ok: item.ok, provider: item.provider || null,
          latestCompleted: item.latestCompleted || null,
          latestAgeSeconds: item.latestAgeSeconds ?? null,
          failures: item.failures || [] },
      ])),
      disclaimer: snapshot.disclaimer,
    }, status);
  } catch (error) {
    return json({
      schema: "sol-paper-market-data/v1",
      status: "DATA_UNAVAILABLE",
      checkedAtUtc: new Date().toISOString(),
      reason: "PROVIDER_OR_RUNTIME_ERROR",
      detail: String(error?.message || error).slice(0, 200),
      disclaimer: "Fail-closed paper research only. Never infer executable prices or simulated fills.",
    }, 503);
  }
}
