// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The single page. Inlined so the server ships one file and serves no assets.

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>visum — live</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3;
    --dim:#8b949e; --acc:#58a6ff; --bad:#f85149; --good:#3fb950; --warn:#d29922;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width:940px; margin:0 auto; padding:32px 16px 72px }
  h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.4px }
  h1 span { color:var(--dim); font-weight:400 }
  .sub { color:var(--dim); margin:0 0 24px }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
          padding:18px 20px; margin:14px 0 }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.9px;
             color:var(--dim); margin:0 0 12px; font-weight:600 }
  button { background:var(--acc); color:#06121f; border:0; border-radius:7px;
           padding:11px 20px; font-size:15px; font-weight:650; cursor:pointer }
  button:disabled { opacity:.5; cursor:default }
  table { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:13.5px }
  td { padding:5px 0; vertical-align:top }
  td.k { color:var(--dim); width:210px; padding-right:14px }
  .big { font-family:var(--mono); font-size:30px; font-weight:650 }
  .pill { display:inline-block; font-family:var(--mono); font-size:11.5px;
          padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim) }
  .pill.good { color:var(--good); border-color:#20502f } 
  .pill.bad  { color:var(--bad);  border-color:#5c2020 }
  .pill.warn { color:var(--warn); border-color:#5a4415 }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:14px }
  .twoup { display:grid; grid-template-columns:1fr 1fr; gap:20px; align-items:start }
  @media (max-width:700px){ .twoup{grid-template-columns:1fr; gap:10px} }
  .lbl { font-family:var(--mono); font-size:11px; text-transform:uppercase;
         letter-spacing:.8px; color:var(--dim); margin-bottom:2px }
  @media (max-width:700px){ .cols{grid-template-columns:1fr} td.k{width:150px} }
  .world { border:1px solid var(--line); border-radius:8px; padding:12px 14px }
  .world h3 { font-size:12px; margin:0 0 8px; color:var(--dim); text-transform:uppercase;
              letter-spacing:.7px }
  .verdict { margin-top:12px; padding:12px 14px; border-radius:8px;
             border:1px solid #5a4415; background:#2a1f08; font-size:14px }
  pre { font-family:var(--mono); font-size:12px; color:var(--dim); background:#0b0f14;
        border:1px solid var(--line); border-radius:7px; padding:12px;
        overflow-x:auto; margin:0; max-height:280px }
  details summary { cursor:pointer; color:var(--dim); font-size:13px }
  a { color:var(--acc) }
  .note { color:var(--dim); font-size:13px }
  .spin { display:inline-block; animation:b 1s steps(4) infinite }
  @keyframes b { to { opacity:.25 } }
  footer { margin-top:32px; color:var(--dim); font-size:13px; border-top:1px solid var(--line);
           padding-top:16px }
</style>
</head>
<body>
<div class="wrap">

  <h1>visum <span>— live</span></h1>
  <p class="sub">
    On Canton a party sees only contracts where it is a stakeholder. Withheld
    contracts are <em>absent</em> from its projection, not present-and-empty, so
    an auditor cannot tell <strong>&ldquo;no event existed&rdquo;</strong> from
    <strong>&ldquo;an event existed and I was not shown it&rdquo;</strong>.
    visum measures that gap and publishes it on the ledger as a signed
    coverage ratio.
  </p>

  <div class="card">
    <button id="go">Run it on a real ledger</button>
    <span id="status" class="note" style="margin-left:12px"></span>
    <p class="note" style="margin:12px 0 0">
      Every step runs server side against a Canton sandbox on this host: seed
      &rarr; declare &rarr; attest &rarr; prove &rarr; audit &rarr; verify.
      The settlement count and how many are withheld are chosen by the server.
      The Ledger API is not exposed and this page sends it nothing.
      The sandbox is started on demand and stopped again when idle, so the
      first run after a quiet spell waits about half a minute for it to boot.
    </p>
  </div>

  <div id="out" hidden>

    <div class="card">
      <h2>1 &nbsp;The control — what the auditor can determine alone</h2>
      <table><tbody id="control"></tbody></table>
      <div class="verdict" id="controlVerdict"></div>
    </div>

    <div class="card">
      <h2>2 &nbsp;Two ledgers the auditor cannot tell apart</h2>
      <div class="cols">
        <div class="world">
          <h3>World A — concealment</h3>
          <table><tbody id="worldA"></tbody></table>
        </div>
        <div class="world">
          <h3>World B — honest, smaller</h3>
          <table><tbody id="worldB"></tbody></table>
        </div>
      </div>
      <div class="verdict" id="worldVerdict"></div>
    </div>

    <div class="card">
      <h2>3 &nbsp;The published CoverageProof</h2>
      <div class="twoup">
        <div>
          <div class="lbl">coverage by count</div>
          <div class="big" id="ratio"></div>
        </div>
        <div>
          <div class="lbl">coverage by value</div>
          <div class="big" id="valueRatio"></div>
        </div>
      </div>
      <div class="verdict" id="valueVerdict" style="margin:12px 0"></div>
      <div id="ratioPills" style="margin:6px 0 14px"></div>
      <table><tbody id="proof"></tbody></table>
    </div>

    <div class="card">
      <h2>4 &nbsp;Verified against ground truth</h2>
      <table><tbody id="verify"></tbody></table>
      <p class="note" style="margin:10px 0 0">
        The prover never reads the answer key. It derives the numerator by
        reading signatories and observers off each created event.
        <code>scripts/check-isolation.sh</code> fails the build if the prover
        ever imports the ground-truth module.
      </p>
    </div>

    <details class="card">
      <summary>Server-side command output</summary>
      <pre id="log" style="margin-top:12px"></pre>
    </details>

  </div>

  <footer>
    <a href="https://github.com/seekdaseek/visum">github.com/seekdaseek/visum</a>
    &nbsp;·&nbsp; MIT &nbsp;·&nbsp; HackCanton League Season 3, RWA &amp; Business Workflows
    <br>
    Sandbox only. No MainNet deployment, no Decentralized Party, no audit-firm
    integration. Coverage is measured against a declared scope, so a dishonestly
    declared scope can read 100% over an incomplete universe — which is what the
    attestation floor and the denominator source exist to expose.
  </footer>
</div>

<script>
// If a CSP directive ever blocks the page's own fetch again, say so out loud
// rather than letting it masquerade as an unreachable server.
document.addEventListener('securitypolicyviolation', (e) => {
  console.error('visum: CSP blocked', e.effectiveDirective, e.blockedURI);
  const st = document.getElementById('status');
  if (st) st.textContent =
    'blocked by this page\u2019s own Content-Security-Policy (' + e.effectiveDirective + ')';
});

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const rows = (el, pairs) => {
  el.innerHTML = pairs.map(([k,v]) =>
    '<tr><td class="k">' + esc(k) + '</td><td>' + v + '</td></tr>').join('');
};
const pill = (text, kind) => '<span class="pill ' + (kind||'') + '">' + esc(text) + '</span>';

$('go').addEventListener('click', async () => {
  const btn = $('go'), st = $('status');
  btn.disabled = true;
  st.innerHTML = 'booting a scope and committing contracts <span class="spin">…</span>';
  try {
    const res = await fetch('/api/run', { method:'POST' });
    // Read as text first. A Cloudflare 502/524 returns an HTML body, and
    // res.json() on that throws -- which previously fell into the catch
    // below and reported "could not reach the demo server", which was false
    // and hid the real status code.
    const body = await res.text();
    let d = null;
    try { d = body ? JSON.parse(body) : null; } catch (parseErr) {
      console.error('visum: non-JSON response', res.status, body.slice(0, 300));
      st.textContent = 'unexpected response from the server (HTTP ' + res.status + ')';
      btn.disabled = false;
      return;
    }
    if (!res.ok) {
      st.textContent = (d && d.error) || ('the run failed (HTTP ' + res.status + ')');
      btn.disabled = false;
      return;
    }
    render(d);
    st.textContent = 'done in ' + (d.elapsedMs/1000).toFixed(1) + 's';
  } catch (e) {
    // Never swallow this. A silent catch is what hid the CSP block.
    console.error('visum: /api/run failed', e);
    st.textContent = 'could not reach the demo server: ' + ((e && e.message) || e);
  }
  btn.disabled = false;
});

function render(d) {
  $('out').hidden = false;

  rows($('control'), [
    ['settlements it can see', '<strong>' + d.control.visible + '</strong>'],
    ['scope declared by operator', d.control.hasDeclaration ? 'yes' : pill('none','bad')],
    ['counterparty attestations', d.control.hasAttestation ? 'yes' : pill('none','bad')],
    ['can it compute coverage?', d.control.canComputeCoverage
        ? pill('yes','good') : pill('NO','bad')],
  ]);
  $('controlVerdict').innerHTML =
    '<strong>The auditor holds a numerator and no denominator.</strong> ' +
    'It sees ' + d.control.visible + ' settlements and has no way to learn how many exist. ' +
    'Offsets are participant-local and non-contiguous by design, so even the gaps carry no signal.';

  rows($('worldA'), [
    ['settlements that exist', d.worldA.n],
    ['withheld from auditor', d.worldA.hidden],
    ['auditor sees', '<strong>' + d.worldA.auditorSees + '</strong>'],
  ]);
  rows($('worldB'), [
    ['settlements that exist', d.worldB.n],
    ['withheld from auditor', d.worldB.hidden],
    ['auditor sees', '<strong>' + d.worldB.auditorSees + '</strong>'],
  ]);
  $('worldVerdict').innerHTML = d.indistinguishable
    ? '<strong>Identical projections.</strong> World A hides ' + d.worldA.hidden +
      ' of ' + d.worldA.n + '. World B has only ' + d.worldB.n +
      ' and hides nothing. The auditor sees ' + d.worldA.auditorSees +
      ' in both and cannot tell which ledger it is looking at. That is the gap visum measures.'
    : 'projections differed — see the log';

  $('ratio').textContent = d.ratio;
  $('valueRatio').textContent = d.valueRatio;

  // The point of publishing both: they can disagree sharply, and the value
  // number is the one an auditor actually cares about.
  const c = parseFloat(d.ratio), vv = parseFloat(d.valueRatio);
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const gap = Math.abs(c - vv);
  $('valueVerdict').innerHTML = gap < 0.02
    ? '<strong>The two measures agree here</strong> (' + esc(pct(c)) + ' by count, ' +
      esc(pct(vv)) + ' by value). They often do not &mdash; run it again.'
    : (vv < c
        ? '<strong>Count coverage flatters this ledger.</strong> ' + esc(pct(c)) +
          ' of the contracts are visible but only ' + esc(pct(vv)) + ' of the value. ' +
          'The withheld settlements are the expensive ones.'
        : '<strong>Value coverage is the stronger number here.</strong> Only ' + esc(pct(c)) +
          ' of the contracts are visible, but they carry ' + esc(pct(vv)) + ' of the value. ' +
          'What was withheld is small change.') +
      ' Nine percent of contracts means nothing until you know whose nine percent.';
  const src = d.denominatorSource;
  $('ratioPills').innerHTML =
    pill('attested by ' + d.attestors + ' of ' + d.expectedAttestors,
         d.attestors === d.expectedAttestors ? 'good' : 'warn') + ' ' +
    pill('denominator: ' + src, src === 'AttestedFloor' ? 'good' : 'warn') + ' ' +
    pill('value denominator: ' + d.valueDenominatorSource,
         d.valueDenominatorSource === 'AttestedFloor' ? 'good' : 'warn') +
    (d.concealment ? ' ' + pill('concealment signal','bad') : '');

  rows($('proof'), [
    ['auditorVisible', d.visible],
    ['declaredTotal (operator claim)', d.declaredTotal],
    ['attestedFloor (counterparty-signed)', d.attestedFloor],
    ['denominator source', esc(src) + (src === 'AttestedFloor'
        ? ' &mdash; counterparty-signed, the strongest floor'
        : src === 'AuditorVisible'
          ? ' &mdash; <strong>nothing corroborated the population; this ratio is 1.0 by construction</strong>'
          : ' &mdash; the operator&rsquo;s own claim, corroborated by nobody')],
    ['attestors', d.attestors + ' of ' + d.expectedAttestors +
        (d.missing.length ? ' &nbsp;(silent: ' + esc(d.missing.join(', ')) + ')' : '')],
    ['ratio (count)', '<strong>' + esc(d.ratio) + '</strong> = ' + d.visible + ' / ' +
        Math.max(d.declaredTotal, d.attestedFloor, d.visible)],
    ['auditorVisibleValue', d.visibleValue.toLocaleString() + ' minor units'],
    ['attestedValueFloor', d.attestedValue.toLocaleString() + ' minor units'],
    ['value denominator source', esc(d.valueDenominatorSource)],
    ['ratio (value)', '<strong>' + esc(d.valueRatio) + '</strong> = ' +
        d.visibleValue.toLocaleString() + ' / ' +
        Math.max(d.attestedValue, d.visibleValue).toLocaleString()],
  ]);

  rows($('verify'), [
    ['ground truth: exist', d.groundTruth.total],
    ['ground truth: withheld', d.groundTruth.hidden],
    ['ground truth: visible', d.groundTruth.visible],
    ['published auditorVisible', d.visible],
    ['exact match', d.verified
        ? pill('VERIFIED — to the event','good')
        : pill('MISMATCH','bad') + ' ' + esc(d.verifyFailures.join('; '))],
  ]);

  $('log').textContent = d.log.join('\n');
}
</script>
</body>
</html>`;
