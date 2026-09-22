// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The live demo server.
//
// SECURITY SHAPE, deliberate:
//   * Binds to 127.0.0.1 only. The Cloudflare tunnel is the sole way in.
//   * The Ledger API is never proxied and never reachable from this process's
//     public surface. `dpm sandbox` itself binds 127.0.0.1 (verified), and
//     nothing here forwards to it.
//   * The visitor sends no ledger input of any kind. GET / serves a page,
//     POST /api/run triggers a fixed server-side script whose parameters are
//     chosen by the server's own RNG. There is no request body, and any body
//     sent is ignored and never parsed.
//   * One run at a time, plus a per-IP and a global rate limit, so a public
//     endpoint cannot be used to fill the sandbox.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LEDGER_URL } from "../api.ts";
import { runDemo, type RunResult } from "./flow.ts";
import { PAGE } from "./page.ts";
import {
  availableMb,
  bootSeconds,
  ensureSandbox,
  HeadroomError,
  minAvailableMb,
  reconcileOnStartup,
  sandboxState,
  touch,
} from "./sandbox.ts";

const PORT = Number.parseInt(process.env.VISUM_DEMO_PORT ?? "3029", 10);
const HOST = "127.0.0.1";

// --- rate limiting --------------------------------------------------------
const PER_IP_WINDOW_MS = 60_000;
const PER_IP_MAX = 4;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX = 20;

const ipHits = new Map<string, number[]>();
let globalHits: number[] = [];
let running = false;

function prune(times: number[], window: number): number[] {
  const cutoff = Date.now() - window;
  return times.filter((t) => t > cutoff);
}

function rateLimited(ip: string): string | undefined {
  globalHits = prune(globalHits, GLOBAL_WINDOW_MS);
  if (globalHits.length >= GLOBAL_MAX) return "the demo is busy right now; try again in a minute";
  const mine = prune(ipHits.get(ip) ?? [], PER_IP_WINDOW_MS);
  if (mine.length >= PER_IP_MAX) return `at most ${PER_IP_MAX} runs a minute, please`;
  mine.push(Date.now());
  ipHits.set(ip, mine);
  globalHits.push(Date.now());
  return undefined;
}

// --- a small deterministic-ish RNG, seeded per run ------------------------
function rng(): () => number {
  let a = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function send(res: ServerResponse, code: number, body: string, type: string): void {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function clientIp(req: IncomingMessage): string {
  // Behind the tunnel, Cloudflare sets CF-Connecting-IP. Fall back to socket.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  return req.socket.remoteAddress ?? "unknown";
}

async function ledgerUp(): Promise<boolean> {
  try {
    const r = await fetch(`${LEDGER_URL}/v2/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, PAGE, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      // The demo server being up is what health means. The sandbox is started
      // on demand and stopped again when idle, so "stopped" is a normal state
      // and must not read as a failure to a monitor.
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          sandbox: sandboxState(),
          coldStartSeconds: bootSeconds(),
          availableMb: availableMb() ?? null,
          minAvailableMb: minAvailableMb(),
          busy: running,
        }),
        "application/json",
      );
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      // The request body is never read. Nothing the visitor sends reaches
      // the ledger.
      req.resume();

      const limit = rateLimited(clientIp(req));
      if (limit) return send(res, 429, JSON.stringify({ error: limit }), "application/json");

      // Condition 3: exactly one sandbox, ever. A strict mutex, not a rate
      // limit. The flag is set synchronously before any await, so two
      // requests arriving in the same tick cannot both pass it.
      if (running) {
        return send(
          res,
          503,
          JSON.stringify({ error: "a run is already in flight; try again in a few seconds" }),
          "application/json",
        );
      }
      running = true;
      try {
        // Boots the sandbox if this is the first run in a while. Concurrent
        // callers share the one boot.
        await ensureSandbox();
        if (!(await ledgerUp())) {
          return send(
            res,
            503,
            JSON.stringify({ error: "the ledger did not come up; try again in a moment" }),
            "application/json",
          );
        }
        const result: RunResult = await runDemo(rng());
        touch();
        return send(res, 200, JSON.stringify(result), "application/json");
      } catch (err) {
        // Condition 4: a headroom refusal is a deliberate, explained decline,
        // not a crash. The visitor is told plainly.
        if (err instanceof HeadroomError) {
          console.warn(`refused to start: ${err.message}`);
          return send(
            res,
            503,
            JSON.stringify({
              error:
                "This host does not have enough free memory to start a ledger right now, " +
                "so visum is declining to start one rather than risk the other services " +
                "sharing this machine. Please try again shortly.",
              headroom: { availableMb: availableMb(), requiredMb: minAvailableMb() },
            }),
            "application/json",
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`run failed: ${msg}`);
        return send(res, 500, JSON.stringify({ error: "the run failed" }), "application/json");
      } finally {
        running = false;
      }
    }

    send(res, 404, "not found", "text/plain; charset=utf-8");
  })();
});

void reconcileOnStartup().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(
      `visum demo on http://${HOST}:${PORT} (ledger ${LEDGER_URL}, sandbox started on demand)`,
    );
  });
});
