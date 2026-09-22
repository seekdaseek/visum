// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// Lazy, bounded, single-instance sandbox supervisor.
//
// WHY ALL THIS. Measured on this project: a Canton sandbox peaks around
// 770 MB resident under load even with -Xmx320m, because RSS also covers
// metaspace, code cache, thread stacks and direct buffers. `-Xmx` is
// therefore NOT the control. The host runs 28 other PM2 services including
// live-revenue and live-judging workloads, has 1.1 GB of its 2 GB swap
// already in use, and was OOM-killed in September. So:
//
//   1. A kernel cgroup caps the whole process tree (MemoryMax, MemorySwapMax=0).
//      The cgroup is the control; the heap flag is only a hint.
//   2. oom_score_adj=1000 on the tree, so if the box ever does hit global OOM
//      the kernel takes this demo and nothing else.
//   3. Exactly one sandbox, ever. Runs serialise behind a mutex and the
//      spawn path refuses if a listener already exists.
//   4. A pre-flight headroom check. Below the floor it refuses to start at
//      all rather than gamble with the box.
//
// Refusing to run beats taking the host down.

import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";

const DPM = process.env.VISUM_DPM ?? "dpm";
const DAR = process.env.VISUM_DAR ?? "main/.daml/dist/visum-0.0.1.dar";
const PORT_FILE = process.env.VISUM_PORT_FILE ?? "/tmp/visum-sandbox-ports.json";
const JSON_PORT = process.env.VISUM_JSON_PORT ?? "7575";
const IDLE_MS = Number.parseInt(process.env.VISUM_IDLE_MS ?? "600000", 10);
const BOOT_TIMEOUT_MS = Number.parseInt(process.env.VISUM_BOOT_TIMEOUT_MS ?? "90000", 10);

// --- condition 1: the cgroup -------------------------------------------
const SCOPE_UNIT = process.env.VISUM_SCOPE_UNIT ?? "visum-sandbox.scope";
const MEMORY_MAX = process.env.VISUM_MEMORY_MAX ?? "1G";
// When true, an unavailable cgroup is a hard failure rather than a warning.
// Production sets this; a macOS dev box leaves it off.
const REQUIRE_CGROUP = (process.env.VISUM_REQUIRE_CGROUP ?? "0") === "1";

// --- condition 2: the OOM victim ---------------------------------------
const OOM_SCORE_ADJ = process.env.VISUM_OOM_SCORE_ADJ ?? "1000";

// --- condition 4: the headroom floor -----------------------------------
const MIN_AVAILABLE_MB = Number.parseInt(process.env.VISUM_MIN_AVAIL_MB ?? "1200", 10);

// `java` does NOT read JAVA_OPTS -- that is a wrapper-script convention and
// the flag silently does nothing. _JAVA_OPTIONS is read by the JVM itself,
// which echoes it on startup. Metaspace below ~384m kills Canton on boot.
const JVM_OPTS =
  process.env.VISUM_JVM_OPTS ??
  "-Xmx320m -Xms96m -XX:MaxMetaspaceSize=384m -XX:ReservedCodeCacheSize=128m -Xss768k";

export type State = "stopped" | "booting" | "ready";
export class HeadroomError extends Error {}

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
export function minAvailableMb(): number {
  return MIN_AVAILABLE_MB;
}

// ------------------------------------------------------------------------
// Condition 4: pre-flight headroom
// ------------------------------------------------------------------------

/** MemAvailable in MB, or undefined where /proc/meminfo does not exist. */
export function availableMb(): number | undefined {
  try {
    const m = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return m?.[1] ? Math.floor(Number.parseInt(m[1], 10) / 1024) : undefined;
  } catch {
    return undefined;
  }
}

function assertHeadroom(): void {
  const avail = availableMb();
  if (avail === undefined) return; // not Linux; dev box
  if (avail < MIN_AVAILABLE_MB) {
    throw new HeadroomError(
      `not enough memory headroom on this host right now: ${avail} MB available, ` +
        `${MIN_AVAILABLE_MB} MB required`,
    );
  }
}

// ------------------------------------------------------------------------
// Condition 3: exactly one, ever
// ------------------------------------------------------------------------

/** True if something is already listening on the ledger port. */
function portBusy(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port: Number.parseInt(JSON_PORT, 10) })
      .on("connect", () => {
        s.destroy();
        resolve(true);
      })
      .on("error", () => resolve(false));
    s.setTimeout(1500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

// ------------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------------

function clearIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

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

function haveSystemdRun(): boolean {
  try {
    execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Clear any leftover scope from a previous life, so a respawn is clean. */
function resetScope(): void {
  if (!haveSystemdRun()) return;
  for (const args of [["stop", SCOPE_UNIT], ["reset-failed", SCOPE_UNIT]]) {
    try {
      execFileSync("systemctl", args, { stdio: "ignore" });
    } catch {
      /* not present, which is the normal case */
    }
  }
}

/**
 * Build the spawn command.
 *
 * The inner `sh -c` writes oom_score_adj for itself and then execs, because
 * oom_score_adj is inherited across fork and preserved across exec -- so the
 * JVM the launcher spawns carries it too. systemd's OOMScoreAdjust is an exec
 * property and does not apply to scopes, which is why this is done by hand.
 */
function buildCommand(): { cmd: string; args: string[]; cgrouped: boolean } {
  const inner =
    `echo ${OOM_SCORE_ADJ} > /proc/self/oom_score_adj; ` +
    `exec "$0" sandbox --dar "$1" --json-api-port "$2" --canton-port-file "$3"`;
  const shArgs = ["-c", inner, DPM, DAR, JSON_PORT, PORT_FILE];

  if (haveSystemdRun()) {
    return {
      cmd: "systemd-run",
      args: [
        "--scope",
        "--collect",
        `--unit=${SCOPE_UNIT}`,
        "-p",
        `MemoryMax=${MEMORY_MAX}`,
        "-p",
        "MemorySwapMax=0",
        "--quiet",
        "--",
        "/bin/sh",
        ...shArgs,
      ],
      cgrouped: true,
    };
  }

  if (REQUIRE_CGROUP) {
    throw new Error(
      "VISUM_REQUIRE_CGROUP=1 but systemd-run is unavailable; refusing to run the sandbox uncapped",
    );
  }
  console.warn("systemd-run unavailable: running WITHOUT a memory cgroup (dev only)");
  return { cmd: "/bin/sh", args: shArgs, cgrouped: false };
}

export async function stopSandbox(): Promise<void> {
  clearIdle();
  const c = child;
  child = undefined;
  state = "stopped";
  if (c?.pid) {
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
  }
  resetScope();
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

/**
 * Start the sandbox if it is not already up.
 *
 * Concurrent callers share the one boot promise, and the spawn path refuses
 * outright if a listener already exists, so a second JVM cannot appear.
 */
export function ensureSandbox(): Promise<void> {
  if (state === "ready") {
    touch();
    return Promise.resolve();
  }
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    // Condition 3, belt: never spawn over an existing listener.
    if (await portBusy()) {
      if (await ledgerUp()) {
        console.log("a sandbox is already listening; adopting it rather than spawning a second");
        state = "ready";
        touch();
        return;
      }
      throw new Error(`port ${JSON_PORT} is held by something that is not our ledger`);
    }

    // Condition 4: refuse rather than gamble.
    assertHeadroom();

    state = "booting";
    rmSync(PORT_FILE, { force: true });
    mkdirSync(dirname(PORT_FILE), { recursive: true });
    resetScope();

    const { cmd, args, cgrouped } = buildCommand();
    console.log(
      `booting sandbox${cgrouped ? ` in cgroup ${SCOPE_UNIT} (MemoryMax=${MEMORY_MAX}, swap 0)` : ""}` +
        `, oom_score_adj=${OOM_SCORE_ADJ}, available=${availableMb() ?? "n/a"} MB`,
    );

    child = spawn(cmd, args, {
      cwd: process.env.VISUM_ROOT ?? process.cwd(),
      env: { ...process.env, _JAVA_OPTIONS: JVM_OPTS },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so the whole tree can be signalled
    });
    child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[sandbox] ${d}`));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[sandbox] ${d}`));
    child.on("exit", (code, signal) => {
      console.log(`sandbox exited (code=${code} signal=${signal})`);
      if (state !== "stopped") {
        state = "stopped";
        child = undefined;
      }
    });

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(PORT_FILE) && (await ledgerUp())) {
        state = "ready";
        touch();
        console.log(`sandbox ready${cgrouped ? " (capped)" : ""}`);
        return;
      }
      if (!child || child.exitCode !== null || child.signalCode !== null) {
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

/**
 * Clear anything left over from a previous life, before serving traffic.
 *
 * A supervisor that is SIGKILLed cannot run its own cleanup, and the JVM it
 * started is reparented to init and keeps its memory -- observed on the dev
 * box: an orphan at ppid=1 still holding 435 MB. Under systemd the scope unit
 * is the handle that survives that, so stopping the scope kills the whole
 * tree no matter who its parent has become.
 */
export async function reconcileOnStartup(): Promise<void> {
  resetScope();
  if (await portBusy()) {
    console.warn(
      `port ${JSON_PORT} was already held at startup; stopping ${SCOPE_UNIT} and waiting for it to clear`,
    );
    resetScope();
    for (let i = 0; i < 10; i++) {
      if (!(await portBusy())) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (await portBusy()) {
      console.error(
        `port ${JSON_PORT} is STILL held by something outside our scope; the first run will refuse rather than spawn a second JVM`,
      );
    } else {
      console.log("leftover cleared");
    }
  }
  rmSync(PORT_FILE, { force: true });
}

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
  resetScope();
});
