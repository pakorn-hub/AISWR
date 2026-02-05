import { WRMonitorDO } from "./monitor_do.js";
export { WRMonitorDO };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Optional protection with ?k=
    if (
      env.DASH_KEY &&
      (url.pathname === "/dashboard" ||
        url.pathname === "/sse" ||
        url.pathname === "/api/stats" ||
        url.pathname === "/api/history")
    ) {
      if (url.searchParams.get("k") !== env.DASH_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      return Response.redirect(url.origin + "/dashboard" + url.search, 302);
    }

    if (url.pathname === "/dashboard") {
      return new Response(renderDashboard(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (
      url.pathname === "/sse" ||
      url.pathname === "/api/stats" ||
      url.pathname === "/api/history"
    ) {
      const id = env.WR_MONITOR.idFromName("global");
      const stub = env.WR_MONITOR.get(id);
      return stub.fetch("https://do" + url.pathname + url.search, { method: "GET" });
    }

    return new Response("OK", { status: 200 });
  },
};

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Waiting Room Live Monitor</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin:0; padding:20px; background:#f4f6f8; }
    .grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:16px; margin-bottom:16px; }
    .card { background:#fff; padding:18px; border-radius:14px; box-shadow:0 1px 3px rgba(0,0,0,.10); }
    .label { font-size:12px; font-weight:800; color:#64748b; text-transform:uppercase; margin-bottom:8px; letter-spacing:.04em; }
    .metric { font-size:44px; font-weight:900; line-height:1.0; }
    .sub { color:#64748b; font-size:12px; margin-top:8px; }
    .dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:#ccc; margin-left:6px; vertical-align:middle; }
    .dot.connected { background:#22c55e; box-shadow:0 0 6px #22c55e; }
    .chart { background:#fff; border-radius:14px; padding:14px; height:420px; box-shadow:0 1px 3px rgba(0,0,0,.10); }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>

  <div class="grid">
    <div class="card">
      <div class="label">Status <span id="dot" class="dot"></span></div>
      <div class="metric" id="status">—</div>
      <div class="sub" id="updated">Last sample: —</div>
    </div>

    <div class="card">
      <div class="label">Estimated Active</div>
      <div class="metric" id="active-count">0</div>
      <div class="sub">Raw value (glitch-filtered)</div>
    </div>

    <div class="card">
      <div class="label">Estimated Queued</div>
      <div class="metric" id="queue-count">0</div>
      <div class="sub">Raw value (glitch-filtered)</div>
    </div>

    <div class="card">
      <div class="label">Max Est. Wait (min)</div>
      <div class="metric" id="wait-count">0</div>
      <div class="sub">From status API</div>
    </div>
  </div>

  <div class="chart">
    <canvas id="c"></canvas>
  </div>

  <script>
    const dot = document.getElementById("dot");
    const $ = (id) => document.getElementById(id);

    // ===== chart tuning =====
    const EMA_ALPHA = 0.25;
    const ZERO_GLITCH_MS = 20000;

    let smoothActive = null;
    let smoothQueued = null;
    let lastGoodActive = { v: 0, ts: 0 };
    let lastGoodQueued = { v: 0, ts: 0 };

    function ewma(x, prev, a) {
      return prev === null ? x : (a * x + (1 - a) * prev);
    }

    function fixZeroGlitch(raw, status, lastGood) {
      const now = Date.now();
      const isQueueing = (status === "queueing");
      const isGlitchZero =
        raw === 0 &&
        lastGood.v > 0 &&
        isQueueing &&
        (now - lastGood.ts) < ZERO_GLITCH_MS;

      if (isGlitchZero) return { value: lastGood.v, lastGood };
      if (raw > 0 || !isQueueing) lastGood = { v: raw, ts: now };
      return { value: raw, lastGood };
    }

    function fmtTick(ts) {
      return new Date(ts).toLocaleTimeString([], { hour12:false, hour:"2-digit", minute:"2-digit" });
    }
    function fmtFull(ts) {
      return new Date(ts).toLocaleTimeString([], { hour12:false });
    }

    const activePoints = [];
    const queuedPoints = [];

    const chart = new Chart(document.getElementById("c").getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          { label:"Active (smoothed)", data: activePoints, parsing:false, tension:0.25, fill:true, pointRadius:0,
            borderColor:"#2563eb", backgroundColor:"#2563eb10" },
          { label:"Queued (smoothed)", data: queuedPoints, parsing:false, tension:0.25, fill:true, pointRadius:0,
            borderColor:"#ea580c", backgroundColor:"#ea580c10" }
        ]
      },
      options: {
        responsive:true,
        maintainAspectRatio:false,
        animation:{ duration:0 },
        scales: {
          x: {
            type:"linear",
            ticks: { maxTicksLimit: 10, callback: (v) => fmtTick(v), maxRotation:0 },
            grid: { display:false }
          },
          y: { beginAtZero:true }
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => items?.length ? fmtFull(items[0].parsed.x) : ""
            }
          }
        }
      }
    });

    function pushPoint(arr, pt, maxPoints) {
      arr.push(pt);
      while (arr.length > maxPoints) arr.shift();
    }

    // These will be set from /api/history on load
    let POLL_MS = 5000;
    let MAX_POINTS = 120;
    let HISTORY_MINUTES = 30;

    function applyLatest(latest) {
      const status = latest.status || "unknown";
      const ts = Number(latest.ts ?? Date.now());

      const activeRaw = Number(latest.estimated_total_active_users ?? 0);
      const queuedRaw = Number(latest.estimated_queued_users ?? 0);
      const waitRaw = Number(latest.max_estimated_time_minutes ?? 0);

      const a = fixZeroGlitch(activeRaw, status, lastGoodActive);
      lastGoodActive = a.lastGood;
      const q = fixZeroGlitch(queuedRaw, status, lastGoodQueued);
      lastGoodQueued = q.lastGood;

      const activeFixed = a.value;
      const queuedFixed = q.value;

      smoothActive = ewma(activeFixed, smoothActive, EMA_ALPHA);
      smoothQueued = ewma(queuedFixed, smoothQueued, EMA_ALPHA);

      $("status").innerText = status;
      $("active-count").innerText = Math.round(activeFixed);
      $("queue-count").innerText = Math.round(queuedFixed);
      $("wait-count").innerText = Math.round(waitRaw);

      const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
      $("updated").innerText = "Last sample: " + fmtFull(ts) + " (age " + ageSec + "s)";

      // update chart range
      const oldest = activePoints.length ? activePoints[0].x : (ts - HISTORY_MINUTES*60*1000);
      chart.options.scales.x.min = oldest;
      chart.options.scales.x.max = ts;
    }

    async function bootstrap() {
      // Load server-side history so reload keeps the graph
      const r = await fetch("/api/history" + location.search, { cache:"no-store" });
      const data = await r.json();

      POLL_MS = Number(data.poll_ms ?? 5000);
      HISTORY_MINUTES = Number(data.history_minutes ?? 30);
      MAX_POINTS = Math.ceil((HISTORY_MINUTES * 60 * 1000) / POLL_MS);

      // Fill points from history
      activePoints.length = 0;
      queuedPoints.length = 0;

      const hist = Array.isArray(data.history) ? data.history : [];
      // Ensure at least a full window: backfill zeros if needed
      const now = Date.now();
      const want = MAX_POINTS;
      const missing = Math.max(0, want - hist.length);

      for (let i = missing; i > 0; i--) {
        const x = now - i * POLL_MS;
        activePoints.push({ x, y: 0 });
        queuedPoints.push({ x, y: 0 });
      }

      for (const s of hist) {
        const x = Number(s.ts);
        activePoints.push({ x, y: Number(s.active ?? 0) });
        queuedPoints.push({ x, y: Number(s.queued ?? 0) });
      }

      // Trim if too long
      while (activePoints.length > MAX_POINTS) activePoints.shift();
      while (queuedPoints.length > MAX_POINTS) queuedPoints.shift();

      // Set smoothing baselines from last real point
      if (activePoints.length) smoothActive = activePoints[activePoints.length - 1].y;
      if (queuedPoints.length) smoothQueued = queuedPoints[queuedPoints.length - 1].y;

      // Apply latest cards
      if (data.latest) applyLatest(data.latest);

      chart.update("none");
    }

    // Live updates (SSE)
    function startSSE() {
      const es = new EventSource("/sse" + location.search);
      es.onopen = () => dot.classList.add("connected");
      es.onerror = () => dot.classList.remove("connected");

      es.onmessage = (e) => {
        try {
          const latest = JSON.parse(e.data);

          // push one new point using smoothed values
          const status = latest.status || "unknown";
          const ts = Number(latest.ts ?? Date.now());
          const activeRaw = Number(latest.estimated_total_active_users ?? 0);
          const queuedRaw = Number(latest.estimated_queued_users ?? 0);

          const a = fixZeroGlitch(activeRaw, status, lastGoodActive);
          lastGoodActive = a.lastGood;
          const q = fixZeroGlitch(queuedRaw, status, lastGoodQueued);
          lastGoodQueued = q.lastGood;

          smoothActive = ewma(a.value, smoothActive, EMA_ALPHA);
          smoothQueued = ewma(q.value, smoothQueued, EMA_ALPHA);

          pushPoint(activePoints, { x: ts, y: Math.round(smoothActive) }, MAX_POINTS);
          pushPoint(queuedPoints, { x: ts, y: Math.round(smoothQueued) }, MAX_POINTS);

          applyLatest(latest);
          chart.update("none");
        } catch {}
      };

      // Fallback polling if SSE drops
      setInterval(async () => {
        if (dot.classList.contains("connected")) return;
        try {
          const r = await fetch("/api/stats" + location.search, { cache: "no-store" });
          const latest = await r.json();
          // treat it as a live update
          const ts = Number(latest.ts ?? Date.now());
          pushPoint(activePoints, { x: ts, y: Number(latest.estimated_total_active_users ?? 0) }, MAX_POINTS);
          pushPoint(queuedPoints, { x: ts, y: Number(latest.estimated_queued_users ?? 0) }, MAX_POINTS);
          applyLatest(latest);
          chart.update("none");
        } catch {}
      }, 3000);
    }

    (async () => {
      try { await bootstrap(); } catch (e) { console.error(e); }
      startSSE();
    })();
  </script>

</body>
</html>`;
}




