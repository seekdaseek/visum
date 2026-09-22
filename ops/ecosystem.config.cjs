// PM2 definitions for the visum live demo on solwatch.
//
// Two processes, both confined to this project:
//   visum-demo    the node server on 127.0.0.1:3029. It starts the Canton
//                 sandbox on demand and stops it after ten idle minutes, so
//                 there is deliberately NO always-on sandbox process here.
//   visum-tunnel  a dedicated cloudflared, same shape as cassum-tunnel.
//
// No dotenv file is involved: every variable is set here. Even so, follow the
// house rule on this box and cycle these with `pm2 delete` then `pm2 start`,
// never `pm2 restart`.
module.exports = {
  apps: [
    {
      name: "visum-demo",
      script: "cli/src/demo/server.ts",
      interpreter: "node",
      cwd: "/opt/visum",
      env: {
        VISUM_ROOT: "/opt/visum",
        VISUM_DPM: "/root/.dpm/bin/dpm",
        VISUM_DAR: "/opt/visum/main/.daml/dist/visum-0.0.1.dar",
        VISUM_DEMO_PORT: "3029",
        VISUM_JSON_PORT: "7575",
        VISUM_LEDGER: "http://127.0.0.1:7575",
        VISUM_PORT_FILE: "/opt/visum/.run/ports.json",
        VISUM_IDLE_MS: "600000",

        // --- condition 1: the kernel cgroup is the memory control ---------
        // -Xmx is only a hint: RSS was measured at 914 MB with the heap
        // capped, because metaspace, code cache and thread stacks sit
        // outside it. MemorySwapMax=0 keeps this off a swapfile that is
        // already 1.1 GB into its 2 GB.
        VISUM_REQUIRE_CGROUP: "1",
        VISUM_MEMORY_MAX: "1G",
        VISUM_SCOPE_UNIT: "visum-sandbox.scope",

        // --- condition 2: visum is the OOM victim, never anything else ----
        VISUM_OOM_SCORE_ADJ: "1000",

        // --- condition 4: refuse to start below this much free memory -----
        // Tunable here without a redeploy: edit, then pm2 delete + start.
        VISUM_MIN_AVAIL_MB: "1200",

        VISUM_JVM_OPTS:
          "-Xmx320m -Xms96m -XX:MaxMetaspaceSize=384m -XX:ReservedCodeCacheSize=128m -Xss768k",
      },
      // The node server itself should sit near 35 MB. If it ever reaches
      // 300 MB something has leaked; recycle it rather than let it grow.
      // The sandbox is a child process and is not covered by this.
      max_memory_restart: "300M",
      autorestart: true,
      max_restarts: 10,
      out_file: "/opt/visum/.run/demo.out.log",
      error_file: "/opt/visum/.run/demo.err.log",
    },
    {
      name: "visum-tunnel",
      script: "/usr/local/bin/cloudflared",
      args: ["tunnel", "--config", "/root/.cloudflared/visum.yml", "--no-autoupdate", "run"],
      cwd: "/root",
      autorestart: true,
      out_file: "/opt/visum/.run/tunnel.out.log",
      error_file: "/opt/visum/.run/tunnel.err.log",
    },
  ],
};
