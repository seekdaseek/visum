// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// Lazy sandbox supervisor.
//
// WHY LAZY. Measured on this project: a Canton sandbox peaks around 770 MB
// resident under load even with -Xmx320m, because RSS also covers metaspace,
// code cache, thread stacks and direct buffers. The host it runs on has 3.8 GB
// total, 28 other PM2 services, and 1.1 GB of its 2 GB swap already in use --
// and it was OOM-killed once in September. A permanently resident 770 MB is
// not a fair tenant there.
//
// So the sandbox is started on the first run and stopped again after a few
// idle minutes. Steady-state cost is just this node process, about 50 MB. A
// visitor who arrives cold waits for the boot, which the page tells them about.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const DPM = process.env.VISUM_DPM ?? "dpm";
const DAR = process.env.VISUM_DAR ?? "main/.daml/dist/visum-0.0.1.dar";
const PORT_FILE = process.env.VISUM_PORT_FILE ?? "/tmp/visum-sandbox-ports.json";
const JSON_PORT = process.env.VISUM_JSON_PORT ?? "7575";
const IDLE_MS = Number.parseInt(process.env.VISUM_IDLE_MS ?? "600000", 10); // 10 min
const BOOT_TIMEOUT_MS = 90_000;

// Bounds the JVM. `java` does NOT read JAVA_OPTS -- that is a wrapper-script
// convention -- so the options go through _JAVA_OPTIONS, which the JVM itself
// reads and echoes on startup. Metaspace below ~384m makes Canton die on boot
// with a Metaspace OutOfMemoryError, verified.
const JVM_OPTS =
  process.env.VISUM_JVM_OPTS ??
  "-Xmx320m -Xms96m -XX:MaxMetaspaceSize=384m -XX:ReservedCodeCacheSize=128m -Xss768k";

type State = "stopped" | "booting" | "ready";

let child: ChildProcess | undefined;
let state: State = "stopped";
let bootPromise: Promise<void> | undefined;
let idleTimer: NodeJS.Timeout | undefined;

export function sandboxState(): State {
  return state;
}

export function bootSeconds(): number {
  return Math.round(BOOT_TIMEOUT_MS / 1000);
}

function clearIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

/** Restart the idle countdown. Called after every run. */
export function touch(): void {
  clearIdle();
  if (IDLE_MS > 0) {
    idleTimer = setTimeout(() => {
      console.log("sandbox idle, stopping it");
      void stopSandbox();
    }, IDLE_MS);
    idleTimer.unref();
  }
}

export async function stopSandbox(): Promise<void> {
  clearIdle();
  const c = child;
  child = undefined;
  state = "stopped";
  if (!c?.pid) return;

  // Kill the whole group: the dpm launcher spawns the JVM as a child, and a
  // backgrounded JVM can outlive a kill aimed only at its parent.
  try {
    process.kill(-c.pid, "SIGTERM");
  } catch {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 4000));
  try {
    process.kill(-c.pid, "SIGKILL");
  } catch {
    /* expected once it has exited */
  }
  rmSync(PORT_FILE, { force: true });
}

async function ledgerUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${JSON_PORT}/v2/version`, {
      signal: AbortSignal.timeout(2500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start the sandbox if it is not already up. Concurrent callers share one boot. */
export function ensureSandbox(): Promise<void> {
  if (state === "ready") {
    touch();
    return Promise.resolve();
  }
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    state = "booting";
    rmSync(PORT_FILE, { force: true });
    mkdirSync(dirname(PORT_FILE), { recursive: true });

    console.log(`booting sandbox: ${DPM} sandbox --dar ${DAR} --json-api-port ${JSON_PORT}`);
    child = spawn(
      DPM,
      [
        "sandbox",
        "--dar",
        DAR,
        "--json-api-port",
        JSON_PORT,
        "--canton-port-file",
        PORT_FILE,
      ],
      {
        cwd: process.env.VISUM_ROOT ?? process.cwd(),
        env: { ...process.env, _JAVA_OPTIONS: JVM_OPTS },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so the whole tree can be signalled at once.
        detached: true,
      },
    );
    child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[sandbox] ${d}`));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[sandbox] ${d}`));
    child.on("exit", (code) => {
      console.log(`sandbox exited (${code})`);
      if (state !== "stopped") {
        state = "stopped";
        child = undefined;
      }
    });

    // --canton-port-file appears exactly when the sandbox is ready. Never sleep
    // a fixed interval and hope.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(PORT_FILE) && (await ledgerUp())) {
        state = "ready";
        touch();
        console.log("sandbox ready");
        return;
      }
      if (!child || child.exitCode !== null) {
        throw new Error("the sandbox exited during startup");
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    await stopSandbox();
    throw new Error(`the sandbox did not become ready within ${BOOT_TIMEOUT_MS / 1000}s`);
  })().finally(() => {
    bootPromise = undefined;
  });

  return bootPromise;
}

// Never leave an orphan holding the port.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    void stopSandbox().then(() => process.exit(0));
  });
}
process.on("exit", () => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* nothing to clean */
    }
  }
});
