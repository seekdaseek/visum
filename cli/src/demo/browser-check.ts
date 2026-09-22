// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// A real browser clicks the real button and reads the rendered result.
//
// This exists because curl is not an acceptance test for a page. curl does
// not enforce Content-Security-Policy, so a policy that blocks the page's own
// fetch looks perfectly healthy over curl while the button is dead for every
// human visitor. That shipped once.
//
//   node cli/src/demo/browser-check.ts [url]

import { chromium } from "playwright";

// The callbacks passed to page.evaluate / addInitScript are serialised and
// run inside the browser, not in node. The project's `lib` deliberately
// excludes DOM so server code cannot reach for it, so the handful of browser
// globals used below are declared here rather than widening lib for
// everything.
declare const window: { __cspViolations?: Violation[] } & Record<string, unknown>;
declare const document: {
  getElementById(id: string): { textContent: string | null; hidden: boolean } | null;
  addEventListener(t: string, cb: (e: { effectiveDirective: string; blockedURI: string }) => void): void;
};

const URL_ = process.argv[2] ?? "https://visum.ochinimus.app";
const COLD_START_MS = 120_000;

type Violation = { directive: string; blocked: string };

async function main(): Promise<number> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const violations: Violation[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  // Surface CSP blocks as first-class failures rather than letting them look
  // like a network problem.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations?.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
      });
    });
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("requestfailed", (r) => {
    failedRequests.push(`${r.method()} ${r.url()} -- ${r.failure()?.errorText ?? "?"}`);
  });

  let fail = 0;
  const ok = (m: string) => console.log(`  PASS  ${m}`);
  const bad = (m: string) => {
    console.log(`  FAIL  ${m}`);
    fail = 1;
  };

  try {
    const resp = await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45_000 });
    resp && resp.ok() ? ok(`loaded ${URL_} (${resp.status()})`) : bad(`page load returned ${resp?.status()}`);

    const title = await page.title();
    title.includes("visum") ? ok(`title "${title}"`) : bad(`unexpected title "${title}"`);

    // Click the real button.
    const btn = page.locator("#go");
    await btn.waitFor({ state: "visible", timeout: 15_000 });
    ok("run button is present");
    await btn.click();

    // Wait for the result to actually RENDER -- not for the API to answer.
    // #ratio is only filled by render(), so this asserts the whole path.
    try {
      await page.waitForFunction(
        () => {
          const el = document.getElementById("ratio");
          return !!el && /^[0-9]+\.[0-9]+$/.test((el.textContent ?? "").trim());
        },
        undefined,
        { timeout: COLD_START_MS },
      );
    } catch {
      const status = (await page.locator("#status").textContent())?.trim() ?? "(none)";
      bad(`no ratio rendered within ${COLD_START_MS / 1000}s; page status says: "${status}"`);
    }

    const ratio = (await page.locator("#ratio").textContent())?.trim() ?? "";
    if (/^[0-9]+\.[0-9]{10}$/.test(ratio)) {
      ok(`rendered ratio ${ratio} (Numeric 10)`);
    } else {
      bad(`rendered ratio "${ratio}" is not a Numeric 10 value`);
    }

    const vRatio = (await page.locator("#valueRatio").textContent())?.trim() ?? "";
    if (/^[0-9]+\.[0-9]{10}$/.test(vRatio)) {
      ok(`rendered value ratio ${vRatio} (Numeric 10)`);
    } else {
      bad(`rendered value ratio "${vRatio}" is not a Numeric 10 value`);
    }

    // The three things the demo exists to show must be on screen.
    const outHidden = await page.locator("#out").evaluate((el) => (el as { hidden: boolean }).hidden);
    outHidden ? bad("results section still hidden") : ok("results section visible");

    const controlText = (await page.locator("#controlVerdict").textContent()) ?? "";
    controlText.includes("numerator and no denominator")
      ? ok("control case rendered")
      : bad(`control verdict missing: "${controlText.slice(0, 60)}"`);

    const worldText = (await page.locator("#worldVerdict").textContent()) ?? "";
    worldText.includes("Identical projections")
      ? ok("indistinguishability rendered")
      : bad(`world verdict missing: "${worldText.slice(0, 60)}"`);

    const verifyText = (await page.locator("#verify").textContent()) ?? "";
    verifyText.includes("VERIFIED")
      ? ok("verify says VERIFIED against ground truth")
      : bad(`verify did not report VERIFIED: "${verifyText.slice(0, 80)}"`);

    const vVerdict = (await page.locator("#valueVerdict").textContent()) ?? "";
    vVerdict.length > 20
      ? ok("value-vs-count verdict rendered")
      : bad("value verdict missing");

    const pills = (await page.locator("#ratioPills").textContent()) ?? "";
    pills.includes("denominator:")
      ? ok(`denominator source shown (${pills.replace(/\s+/g, " ").trim()})`)
      : bad("denominator source pill missing");

    // CSP: a block on OUR OWN origin is a bug. A block on a third-party
    // script is the policy working as intended -- Cloudflare injects an
    // analytics beacon into proxied pages and this CSP refuses it, which is
    // the desired outcome, not a regression. Failing on it would make this
    // guard permanently red and therefore ignored.
    const origin = new URL(URL_).origin;
    const v = await page.evaluate(() => window.__cspViolations ?? []);
    const ours = v.filter((x) => x.blocked.startsWith(origin) || x.blocked === "self");
    const theirs = v.filter((x) => !ours.includes(x));

    if (ours.length === 0) {
      ok("no CSP violations on our own origin");
    } else {
      for (const x of ours) bad(`CSP blocked ${x.directive} -> ${x.blocked}`);
    }
    for (const x of theirs) {
      console.log(`  note  CSP refused third-party ${x.directive} -> ${x.blocked.slice(0, 70)} (intended)`);
    }

    const isThirdParty = (t: string) => !t.includes(origin) || t.includes("cloudflareinsights");
    const realErrors = consoleErrors.filter((e) => !isThirdParty(e));
    if (realErrors.length === 0) {
      ok(`no first-party console errors${consoleErrors.length ? ` (${consoleErrors.length} third-party, ignored)` : ""}`);
    } else {
      for (const e of realErrors.slice(0, 5)) bad(`console error: ${e.slice(0, 140)}`);
    }

    const realFailed = failedRequests.filter((r) => !isThirdParty(r));
    if (realFailed.length === 0) {
      ok(`no first-party failed requests${failedRequests.length ? ` (${failedRequests.length} third-party, ignored)` : ""}`);
    } else {
      for (const r of realFailed.slice(0, 5)) bad(`request failed: ${r.slice(0, 140)}`);
    }
  } finally {
    await browser.close();
  }
  return fail;
}

main()
  .then((c) => process.exit(c))
  .catch((e: unknown) => {
    console.log(`  FAIL  browser check threw: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
