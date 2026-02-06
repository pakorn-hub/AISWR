const POLL_MS = 5000;
const HISTORY_MINUTES = 30; // <-- change to 60 for 1 hour, etc.
const MAX_POINTS = Math.ceil((HISTORY_MINUTES * 60 * 1000) / POLL_MS);

export class WRMonitorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.clients = new Set(); // ReadableStream controllers
    this.fetching = null;

    this.last = {
      ts: 0,
      status: "unknown",
      estimated_total_active_users: 0,
      estimated_queued_users: 0,
      max_estimated_time_minutes: 0,
    };

    this.history = []; // array of samples

    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get("history");
      if (Array.isArray(saved)) this.history = saved;

      const lastSaved = await this.state.storage.get("last");
      if (lastSaved && typeof lastSaved === "object") this.last = lastSaved;
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/stats") {
      const stats = await this.getFreshStats();
      return json(stats);
    }

    if (url.pathname === "/api/history") {
      // Ensure we have a fresh-ish point before returning history
      await this.getFreshStats();
      return json({
        poll_ms: POLL_MS,
        history_minutes: HISTORY_MINUTES,
        history: this.history,
        latest: this.last,
      });
    }

    if (url.pathname === "/sse") {
      await this.ensureAlarm();

      const encoder = new TextEncoder();
      const self = this;

      const stream = new ReadableStream({
        async start(controller) {
          self.clients.add(controller);

          // send latest immediately
          const stats = await self.getFreshStats();
          controller.enqueue(encoder.encode("data: " + JSON.stringify(stats) + "\n\n"));

          // heartbeat
          const hb = setInterval(() => {
            try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
          }, 15000);

          req.signal.addEventListener("abort", () => {
            clearInterval(hb);
            self.clients.delete(controller);
            try { controller.close(); } catch {}
          }, { once: true });
        },
        cancel(controller) {
          self.clients.delete(controller);
        }
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
          "connection": "keep-alive",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    const stats = await this.getFreshStats(true);
    this.broadcast(stats);

    if (this.clients.size > 0) {
      await this.state.storage.setAlarm(Date.now() + POLL_MS);
    }
  }

  async ensureAlarm() {
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) await this.state.storage.setAlarm(Date.now() + 1);
  }

  broadcast(stats) {
    const encoder = new TextEncoder();
    const msg = encoder.encode("data: " + JSON.stringify(stats) + "\n\n");

    for (const c of this.clients) {
      try { c.enqueue(msg); }
      catch { this.clients.delete(c); }
    }
  }

  async getFreshStats(force = false) {
    const now = Date.now();

    if (!force && now - (this.last.ts || 0) < POLL_MS) return this.last;
    if (this.fetching) return this.fetching;

    this.fetching = (async () => {
      const next = await fetchWaitingRoomStatus(this.env);

      const updated = next ? { ...next, ts: Date.now() } : { ...this.last, ts: Date.now() };
      this.last = updated;

      // Append to history if this is a new timestamp
      this.pushHistory(updated);

      // Persist occasionally (every point is OK here; small data)
      await this.state.storage.put("last", this.last);
      await this.state.storage.put("history", this.history);

      this.fetching = null;
      return this.last;
    })();

    return this.fetching;
  }

  pushHistory(sample) {
    // store only the fields we need for charting
    const s = {
      ts: sample.ts,
      status: sample.status || "unknown",
      active: Number(sample.estimated_total_active_users ?? 0),
      queued: Number(sample.estimated_queued_users ?? 0),
      wait: Number(sample.max_estimated_time_minutes ?? 0),
    };

    // avoid duplicates if called twice quickly
    const last = this.history.length ? this.history[this.history.length - 1] : null;
    if (last && last.ts === s.ts) return;

    this.history.push(s);

    // trim to rolling window
    while (this.history.length > MAX_POINTS) this.history.shift();
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function fetchWaitingRoomStatus(env) {
  if (!env.CF_API_TOKEN || !env.ZONE_ID || !env.WR_ID) {
    return {
      status: "missing_env",
      estimated_queued_users: 0,
      estimated_total_active_users: 0,
      max_estimated_time_minutes: 0,
    };
  }

  const api =
    "https://api.cloudflare.com/client/v4/zones/" +
    env.ZONE_ID +
    "/waiting_rooms/" +
    env.WR_ID +
    "/status";

  try {
    const res = await fetch(api, {
      headers: { Authorization: "Bearer " + env.CF_API_TOKEN },
    });
    const json = await res.json();
    return json && json.result ? json.result : null;
  } catch {
    return null;
  }
}




