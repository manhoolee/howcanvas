import { Worker } from "node:worker_threads";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { safeError, errorCode } from "./observability-domain.mjs";

export function createObservability({
  database,
  dataDir,
  users,
  channels,
  queue,
  video,
  version = "unknown",
}) {
  const enabled = process.env.OBSERVABILITY_ENABLED !== "false";
  const presence = new Map(),
    activeAttempts = new Map(),
    pending = new Map(),
    alerts = new Map();
  for (const a of database.observationSetting("alerts") || [])
    alerts.set(a.id, a);
  const delay = monitorEventLoopDelay({ resolution: 20 });
  if (enabled) delay.enable();
  let worker,
    workerAt = 0,
    workerError = "",
    seq = 0,
    httpConcurrent = 0,
    sseConnections = 0,
    dropped = 0,
    requestCount = 0,
    errorCount = 0,
    previousCpu = process.cpuUsage(),
    previousAt = performance.now(),
    snapshotCache = null;
  const histogram = [
    0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1200,
  ].map((le) => ({ le, count: 0 }));
  let requestSeconds = 0;
  function startWorker() {
    worker = new Worker(
      new URL("./observability-worker.mjs", import.meta.url),
      {
        workerData: {
          sourceFile: database.file,
          analysisFile: path.join(
            process.env.OBSERVABILITY_DATA_DIR ||
              path.join(dataDir, "observability"),
            "analytics.sqlite",
          ),
          usersFile: path.join(dataDir, "users.json"),
        },
      },
    );
    worker.on("message", (m) => {
      if (m.type === "healthy") {
        workerAt = Date.now();
        workerError = "";
        return;
      }
      if (m.type === "fault") {
        workerError = m.error;
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      m.error
        ? p.reject(
            Object.assign(new Error(m.error), { statusCode: m.statusCode }),
          )
        : p.resolve(m.result);
    });
    worker.on("error", (e) => {
      workerError = safeError(e.message);
    });
    worker.on("exit", () => {
      workerError = workerError || "统计进程重启中";
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          Object.assign(new Error("统计进程暂不可用"), { statusCode: 503 }),
        );
      }
      pending.clear();
      setTimeout(startWorker, 5000).unref();
    });
    worker.unref();
  }
  if (enabled) startWorker();
  function query(method, input = {}) {
    if (!enabled || !worker)
      return Promise.reject(
        Object.assign(new Error("统计功能未启用"), { statusCode: 503 }),
      );
    if (pending.size >= 20)
      return Promise.reject(
        Object.assign(new Error("统计查询繁忙，请稍后重试"), {
          statusCode: 429,
        }),
      );
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Object.assign(new Error("统计查询超时，请缩小范围"), {
            statusCode: 504,
          }),
        );
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, input });
    });
  }
  function event(entity, id, payload) {
    if (!enabled) return;
    try {
      database.observe(entity, id, payload);
    } catch {
      dropped++;
    }
  }
  function snapshot() {
    const now = Date.now();
    if (snapshotCache && now - Date.parse(snapshotCache.at) < 1000)
      return snapshotCache;
    for (const [key, p] of presence) {
      const u = users().find((u) => u.id === p.userId);
      if (
        now - p.seenAt > 90000 ||
        !u ||
        u.status === "disabled" ||
        database.getSession(p.userId)?.active_session_id !== p.sessionId
      )
        presence.delete(key);
    }
    const byUser = new Map();
    for (const p of presence.values()) {
      const old = byUser.get(p.userId);
      if (!old || old.activeAt < p.activeAt) byUser.set(p.userId, p);
    }
    const cpu = process.cpuUsage(),
      at = performance.now(),
      cpuPercent = Math.min(
        100 * os.availableParallelism(),
        (100 *
          (cpu.user + cpu.system - previousCpu.user - previousCpu.system)) /
          1000 /
          (at - previousAt),
      );
    previousCpu = cpu;
    previousAt = at;
    let host = null;
    try {
      host = JSON.parse(
        fs.readFileSync(
          process.env.OBSERVABILITY_HOST_FILE ||
            "/app/host-monitor/snapshot.json",
          "utf8",
        ),
      );
    } catch {}
    const hostFresh = host && now - Date.parse(host.at) < 90000;
    const q = queue(),
      v = video();
    const rows = [...byUser.values()].map((p) => ({
      userId: p.userId,
      name: users().find((u) => u.id === p.userId)?.displayName || "用户",
      page: p.page,
      seenAt: new Date(p.seenAt).toISOString(),
      active: now - p.activeAt <= 300000,
      visible: p.visible,
    }));
    snapshotCache = {
      at: new Date().toISOString(),
      version,
      enabled,
      online: rows.length,
      active: rows.filter((p) => p.active).length,
      people: rows,
      httpConcurrent,
      sseConnections,
      upstreamConcurrent: activeAttempts.size,
      queued: q.queued,
      running: q.running,
      imageLimit: q.limit,
      oldestWaitMs: q.oldestWaitMs,
      videoWorkers: v.running,
      videoWorkerLimit: v.limit,
      cpuPercent: Math.max(0, cpuPercent),
      cpuCores: os.availableParallelism(),
      memoryBytes: process.memoryUsage().rss,
      heapBytes: process.memoryUsage().heapUsed,
      eventLoopP95Ms: Number.isFinite(delay.percentile(95))
        ? delay.percentile(95) / 1e6
        : 0,
      uptimeSeconds: process.uptime(),
      requestCount,
      errorCount,
      dropped,
      worker: {
        at: workerAt ? new Date(workerAt).toISOString() : null,
        error: workerError,
        lagSeconds: workerAt ? (now - workerAt) / 1000 : null,
      },
      host: hostFresh ? host : null,
      hostFresh: Boolean(hostFresh),
      hostCpuPercent: hostFresh ? host.cpuPercent : null,
      hostMemoryPercent: hostFresh ? host.memoryPercent : null,
      diskUsedPercent: hostFresh ? host.diskUsedPercent : null,
      channels: channels().map((c) => ({
        id: c.id,
        name: c.name,
        models:
          c.models?.map((m) => ({ name: m.name, capability: m.capability })) ||
          [],
        paused: database.currentChannelRevision(c.id)?.archived || false,
      })),
    };
    return snapshotCache;
  }
  function beginAttempt(data) {
    const id = crypto.randomUUID(),
      startedAt = new Date().toISOString(),
      start = performance.now();
    const record = {
      ...data,
      id,
      startedAt,
      status: "running",
      usageSource: "unknown",
    };
    activeAttempts.set(id, record);
    event("attempt", id, record);
    let ended = false;
    return {
      id,
      finish(status, extra = {}) {
        if (ended) return;
        ended = true;
        activeAttempts.delete(id);
        Object.assign(
          record,
          {
            status,
            endedAt: new Date().toISOString(),
            durationMs: Math.max(0, performance.now() - start),
          },
          extra,
        );
        record.errorCode = errorCode(record.error, record.httpStatus);
        record.error = record.error ? `调用异常：${record.errorCode}` : "";
        event("attempt", id, record);
      },
      firstByte() {
        if (!record.firstByteAt) record.firstByteAt = new Date().toISOString();
      },
    };
  }
  function middleware(req, res, next) {
    if (
      !enabled ||
      !req.path.startsWith("/api") ||
      req.path.includes("/observability") ||
      req.path.startsWith("/api/telemetry") ||
      req.path === "/api/health"
    )
      return next();
    const isSse = req.path === "/api/session/events";
    if (isSse) sseConnections++;
    else httpConcurrent++;
    const start = performance.now();
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      if (isSse) {
        sseConnections--;
        return;
      }
      httpConcurrent--;
      requestCount++;
      const elapsed = (performance.now() - start) / 1000;
      requestSeconds += elapsed;
      for (const b of histogram) if (elapsed <= b.le) b.count++;
      if (res.statusCode >= 500) errorCount++;
      const route = String(req.route?.path || req.path)
        .replace(/[a-f0-9-]{24,}/gi, ":id")
        .slice(0, 140);
      if (res.statusCode >= 400)
        event("request-error", crypto.randomUUID(), {
          userId: req.user?.id || "",
          method: req.method,
          route,
          status: res.statusCode,
          durationMs: elapsed * 1000,
          code:
            res.statusCode === 429
              ? "rate_limit"
              : res.statusCode === 402
                ? "credits"
                : res.statusCode === 401
                  ? "auth"
                  : res.statusCode === 403
                    ? "permission"
                    : "request",
        });
      if (req.user && req.method !== "GET" && !req.path.endsWith("/ack"))
        event("activity", crypto.randomUUID(), {
          userId: req.user.id,
          kind: "server",
          action: route,
          status: res.statusCode,
        });
      if (
        req.user?.role === "admin" &&
        req.path.startsWith("/api/admin") &&
        req.method !== "GET"
      )
        event("audit", crypto.randomUUID(), {
          actorId: req.user.id,
          method: req.method,
          route,
          objectId: req.params?.id || "",
          status: res.statusCode,
          fields: Object.keys(req.body || {}).filter(
            (k) => !/password|key|secret|token/i.test(k),
          ),
          reason: safeError(req.body?.reason),
        });
    };
    res.once("finish", finish);
    res.once("close", finish);
    next();
  }
  function alert(key, title, active, severity = "warning", detail = "") {
    const prev = alerts.get(key);
    if (active) {
      const value = {
        ...prev,
        id: key,
        title,
        severity,
        detail,
        status: "open",
        firstAt: prev?.firstAt || new Date().toISOString(),
        lastAt: new Date().toISOString(),
      };
      alerts.set(key, value);
      if (!prev) event("alert", key, value);
    } else if (prev) {
      alerts.delete(key);
      event("alert", key, {
        ...prev,
        status: "resolved",
        lastAt: new Date().toISOString(),
      });
    }
  }
  const timer = setInterval(() => {
    if (!enabled) return;
    const s = snapshot();
    worker?.postMessage({
      type: "runtime",
      data: { ...s, people: undefined, channels: undefined },
    });
    delay.reset();
    alert(
      "collector",
      "统计采集延迟",
      Boolean(workerError) || (workerAt > 0 && Date.now() - workerAt > 120000),
      "error",
      workerError,
    );
    alert(
      "queue",
      "图片队列等待较长",
      s.oldestWaitMs > 120000,
      "warning",
      `最长等待 ${Math.round(s.oldestWaitMs / 1000)} 秒`,
    );
    alert(
      "disk",
      "磁盘空间不足",
      s.hostFresh && s.diskUsedPercent > 85,
      "error",
    );
    alert(
      "host",
      "宿主机采集未更新",
      !s.hostFresh && process.uptime() > 120,
      "warning",
    );
    alert(
      "health",
      "服务健康检查失败",
      Boolean(s.host?.checks?.some((c) => !c.ok)),
      "error",
    );
    alert(
      "memory",
      "宿主机内存使用偏高",
      s.hostFresh && s.hostMemoryPercent > 90,
      "warning",
    );
    alert(
      "backup",
      "备份或恢复验证异常",
      Boolean(
        s.hostFresh &&
        (!s.host?.backup?.ok ||
          Date.now() - Date.parse(s.host.backup.at) > 36 * 3600000),
      ),
      "error",
    );
  }, 15000);
  timer.unref();
  const maintenance = setInterval(async () => {
    if (!enabled) return;
    try {
      const state = await query("maintenance");
      database.pruneObservations(
        state.cursor,
        new Date(Date.now() - 7 * 86400000).toISOString(),
      );
      const report = await query("report", {
        from: new Date(Date.now() - 1800000).toISOString(),
        to: new Date().toISOString(),
      });
      const billing = await query("credits", { range: "24h" });
      alert(
        "success",
        "近30分钟交付成功率偏低",
        report.summary.denominator >= 20 && report.summary.successRate < 80,
        "error",
        `成功 ${report.summary.succeeded} / 分母 ${report.summary.denominator}`,
      );
      alert(
        "credits",
        "积分账本不一致",
        billing.rows.some(
          (u) => u.availableDifference !== 0 || u.reservedDifference !== 0,
        ),
        "error",
      );
      alert(
        "pending-bill",
        "存在超时未结算任务",
        billing.pending.some(
          (r) => Date.now() - Date.parse(r.createdAt) > 3600000,
        ),
        "warning",
      );
      database.setObservationSetting("alerts", [...alerts.values()]);
    } catch {}
  }, 60000);
  maintenance.unref();
  function register(app, { auth, adminOnly, rateLimit, actions }) {
    const guard = [
      auth,
      adminOnly,
      rateLimit({ max: 3000, name: "observability" }),
    ];
    const accountRates = new Map();
    const telemetryLimit = (req, res, next) => {
      const now = Date.now(),
        key = req.user.id;
      let item = accountRates.get(key);
      if (!item || now - item.at > 60000) {
        item = { at: now, n: 0 };
        accountRates.set(key, item);
      }
      if (++item.n > 120)
        return res.status(429).json({ error: "活动请求过于频繁" });
      if (accountRates.size > 10000)
        for (const [id, r] of accountRates)
          if (now - r.at > 60000) accountRates.delete(id);
      next();
    };
    app.get("/internal/metrics", (_req, res) => {
      const s = snapshot();
      const lines = [
        "# TYPE canvas_http_requests_total counter",
        `canvas_http_requests_total ${requestCount}`,
        "# TYPE canvas_http_errors_total counter",
        `canvas_http_errors_total ${errorCount}`,
        "# TYPE canvas_http_request_duration_seconds histogram",
        `canvas_http_request_duration_seconds_sum ${requestSeconds}`,
        `canvas_http_request_duration_seconds_count ${requestCount}`,
        ...histogram.map(
          (b) =>
            `canvas_http_request_duration_seconds_bucket{le="${b.le}"} ${b.count}`,
        ),
        `canvas_http_request_duration_seconds_bucket{le="+Inf"} ${requestCount}`,
        ...[
          "online",
          "active",
          "httpConcurrent",
          "upstreamConcurrent",
          "queued",
          "running",
          "cpuPercent",
          "memoryBytes",
          "eventLoopP95Ms",
          "dropped",
        ].map(
          (k) =>
            `canvas_${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} ${s[k]}`,
        ),
      ];
      res.type("text/plain").send(lines.join("\n") + "\n");
    });
    app.post("/api/telemetry/heartbeat", auth, telemetryLimit, (req, res) => {
      const now = Date.now(),
        tab = String(req.body?.tabId || "").slice(0, 64);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(tab))
        return res.status(400).json({ error: "无效页面标识" });
      const key = `${req.user.id}:${tab}`;
      if (presence.size > 10000 && !presence.has(key))
        return res.status(429).json({ error: "在线会话数量超限" });
      const old = presence.get(key);
      const page =
        String(req.body.page || "")
          .split("/")[1]
          ?.replace(/[^a-z-]/gi, "")
          .slice(0, 30) || "home";
      const activeAt = req.body.active === true ? now : old?.activeAt || 0;
      presence.set(key, {
        userId: req.user.id,
        sessionId: req.sessionId,
        page,
        seenAt: now,
        activeAt,
        visible: req.body.visible === true,
      });
      if (!old || req.body.active)
        event("activity", crypto.randomUUID(), {
          userId: req.user.id,
          kind: "client",
          action: req.body.active ? "active" : "visit",
          page,
          visible: req.body.visible === true,
        });
      res.json({ ok: true, at: new Date(now).toISOString() });
    });
    app.post("/api/telemetry/activity", auth, telemetryLimit, (req, res) => {
      const action = String(req.body.action || "");
      if (
        ![
          "frontend-error",
          "sync-error",
          "export",
          "saved",
          "rendered",
          "feedback",
        ].includes(action)
      )
        return res.status(400).json({ error: "无效活动类型" });
      event("activity", crypto.randomUUID(), {
        userId: req.user.id,
        kind: "client",
        action,
        taskId: String(req.body.taskId || "").slice(0, 100),
        code: String(req.body.code || "")
          .replace(/[^a-z0-9_-]/gi, "")
          .slice(0, 80),
        rating: [-1, 1].includes(req.body.rating) ? req.body.rating : null,
      });
      res.json({ ok: true });
    });
    app.get("/api/admin/observability/snapshot", ...guard, (_req, res) =>
      res.json({ ...snapshot(), alerts: [...alerts.values()] }),
    );
    app.get("/api/admin/observability/stream", ...guard, (req, res) => {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const send = () => {
        if (
          !database.validateSession(
            req.user.id,
            req.sessionId,
            req.sessionVersion,
          ) ||
          req.user.status === "disabled" ||
          req.user.role !== "admin"
        ) {
          res.end();
          return;
        }
        res.write(
          `data: ${JSON.stringify({ ...snapshot(), alerts: [...alerts.values()] })}\n\n`,
        );
      };
      send();
      const t = setInterval(send, 5000);
      req.on("close", () => clearInterval(t));
    });
    for (const [route, method] of [
      ["dashboard", "dashboard"],
      ["overview", "report"],
      ["usage", "usage"],
      ["success-rates", "report"],
      ["options", "options"],
      ["tasks", "tasks"],
      ["artifacts", "artifacts"],
      ["credits", "credits"],
      ["runtime", "runtime"],
      ["events", "events"],
    ])
      app.get(
        `/api/admin/observability/${route}`,
        ...guard,
        async (req, res) => {
          try {
            res.json(await query(method, req.query));
          } catch (e) {
            res.status(e.statusCode || 500).json({ error: e.message });
          }
        },
      );
    app.get(
      "/api/admin/observability/tasks/:id",
      ...guard,
      async (req, res) => {
        try {
          res.json(await query("task", { id: req.params.id }));
        } catch (e) {
          res.status(e.statusCode || 500).json({ error: e.message });
        }
      },
    );
    app.get("/api/admin/observability/export", ...guard, async (req, res) => {
      try {
        const r = await query("export", req.query);
        event("audit", crypto.randomUUID(), {
          actorId: req.user.id,
          action: "export",
          from: r.range.from,
          to: r.range.to,
        });
        res
          .set({
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="canvas-tasks.csv"',
            "X-Metric-Version": r.range.metricVersion,
            "X-Data-From": r.range.from,
            "X-Data-To": r.range.to,
            "X-Data-As-Of": r.range.asOf,
          })
          .send(r.text);
      } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
      }
    });
    app.post("/api/admin/observability/actions", ...guard, async (req, res) => {
      try {
        const { action, id, reason } = req.body || {};
        if (!reason || String(reason).trim().length < 2)
          return res.status(400).json({ error: "请填写操作原因" });
        let result;
        if (action === "resync") result = await query("maintenance");
        else if (action === "ack-alert") {
          const a = alerts.get(id);
          if (a) {
            a.acknowledgedBy = req.user.id;
            database.setObservationSetting("alerts", [...alerts.values()]);
          }
          result = { ok: true };
        } else result = await actions(action, id, req.body, req.user);
        event("audit", crypto.randomUUID(), {
          actorId: req.user.id,
          action,
          objectId: id || "",
          reason: safeError(reason),
          status: 200,
        });
        res.json(result);
      } catch (e) {
        event("audit", crypto.randomUUID(), {
          actorId: req.user.id,
          action: String(req.body?.action || ""),
          objectId: String(req.body?.id || ""),
          reason: safeError(req.body?.reason),
          status: e.statusCode || 400,
        });
        res.status(e.statusCode || 400).json({ error: safeError(e.message) });
      }
    });
  }
  return { event, query, snapshot, beginAttempt, middleware, register };
}
