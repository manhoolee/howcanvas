import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  imageFact,
  receiptFact,
  summarize,
  parseRange,
  safeError,
  METRIC_VERSION,
  csv,
} from "./observability-domain.mjs";

export function createAnalytics({ sourceFile, analysisFile, usersFile }) {
  fs.mkdirSync(path.dirname(analysisFile), { recursive: true });
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  source.exec("PRAGMA busy_timeout=1500");
  const db = new DatabaseSync(analysisFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT,model TEXT,channel_id TEXT,created_at TEXT,status TEXT,payload_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tasks_time ON tasks(created_at); CREATE INDEX IF NOT EXISTS tasks_user_time ON tasks(user_id,created_at); CREATE INDEX IF NOT EXISTS tasks_model_time ON tasks(model,channel_id,created_at);
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,task_id TEXT,user_id TEXT,kind TEXT,model TEXT,channel_id TEXT,created_at TEXT,payload_json TEXT);
        CREATE INDEX IF NOT EXISTS artifacts_time ON artifacts(created_at);
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,task_id TEXT,user_id TEXT,kind TEXT,model TEXT,channel_id TEXT,created_at TEXT,payload_json TEXT);
        CREATE INDEX IF NOT EXISTS attempts_time ON attempts(created_at); CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,entity TEXT,entity_id TEXT,created_at TEXT,payload_json TEXT);
        CREATE INDEX IF NOT EXISTS events_type_time ON events(entity,created_at);
        CREATE TABLE IF NOT EXISTS runtime(created_at TEXT PRIMARY KEY,payload_json TEXT);
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,payload_json TEXT);
        CREATE TABLE IF NOT EXISTS postings(id TEXT PRIMARY KEY,user_id TEXT,receipt_id TEXT,created_at TEXT,available_delta INTEGER,reserved_delta INTEGER,payload_json TEXT);
        CREATE INDEX IF NOT EXISTS postings_time ON postings(created_at);
        CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,user_id TEXT,created_at TEXT,payload_json TEXT);
        CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY,status TEXT,first_at TEXT,last_at TEXT,payload_json TEXT);
    `);
  const meta = (key) =>
    db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value;
  const setMeta = (k, v) =>
    db
      .prepare(
        "INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(k, String(v));
  const parse = (row) => (row ? JSON.parse(row.payload_json) : null);
  const all = (sql, ...args) =>
    db
      .prepare(sql)
      .all(...args)
      .map(parse);
  let lastSync = 0;
  function writeFact(t) {
    if (!t.createdAt) return;
    const previous = parse(
      db.prepare("SELECT payload_json FROM tasks WHERE id=?").get(t.id),
    );
    if (previous?.observedOutcome && !t.observedOutcome)
      t = {
        ...t,
        ...Object.fromEntries(["status", "endedAt", "phase", "evidence", "upstreamState", "errorCode"].filter(key => previous[key] !== undefined).map(key => [key, previous[key]])),
        observedOutcome: true,
      };
    const attempts = all(
      "SELECT payload_json FROM attempts WHERE task_id=?",
      t.id,
    ).filter((a) => ["generation", "retrieval"].includes(a.purpose));
    if (attempts.some((a) => a.purpose === "generation")) {
      const groups = new Map();
      for (const a of attempts) {
        const key = `${a.purpose}:${a.outputIndex || 0}`;
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      t.retries = [...groups.values()].reduce(
        (sum, count) => sum + Math.max(0, count - 1),
        0,
      );
    }
    db.prepare(
      "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,kind=excluded.kind,model=excluded.model,channel_id=excluded.channel_id,created_at=excluded.created_at,status=excluded.status,payload_json=excluded.payload_json",
    ).run(
      t.id,
      t.userId,
      t.kind,
      t.model,
      t.channelId,
      t.createdAt,
      t.status,
      JSON.stringify(t),
    );
    for (const a of t.artifacts || [])
      db.prepare(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,payload_json=excluded.payload_json",
      ).run(
        a.id,
        a.taskId,
        a.userId,
        a.kind,
        a.model,
        a.channelId,
        a.createdAt,
        JSON.stringify(a),
      );
  }
  function writeReceipt(r) {
    // Materialize only safe billing metadata. Source JSON may contain signed submission URLs.
    const safe = Object.fromEntries(
      [
        "id",
        "userId",
        "generationTaskId",
        "taskId",
        "kind",
        "model",
        "channelId",
        "channelRevisionId",
        "pricingVersionId",
        "createdAt",
        "confirmedAt",
        "refundedAt",
        "status",
        "cost",
        "standardCost",
        "reservedCost",
        "confirmedCost",
        "returnedCost",
        "exempt",
        "quantity",
        "actualDurationMs",
        "pricingUnit",
        "unitPrice",
        "needsReview",
        "refunded",
        "upstreamState",
      ]
        .filter((k) => r[k] !== undefined)
        .map((k) => [k, r[k]]),
    );
    safe.lastError = r.lastError ? "交付异常（详见错误分类）" : "";
    safe.verified = Boolean(r.media?.sha256 && r.deliveredAt);
    db.prepare(
      "INSERT INTO receipts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json",
    ).run(r.id, r.userId, r.createdAt, JSON.stringify(safe));
    const image =
      r.kind === "image" &&
      source
        .prepare("SELECT task_id FROM image_tasks WHERE task_id=?")
        .get(r.taskId || "");
    if (!image) writeFact(receiptFact(r));
    else
      db.prepare("DELETE FROM tasks WHERE id=? AND id!=?").run(
        r.generationTaskId || `receipt:${r.id}`,
        image.task_id,
      );
  }
  function projection(entity, id) {
    if (entity === "image_tasks") {
      const task = parse(
        source
          .prepare("SELECT payload_json FROM image_tasks WHERE task_id=?")
          .get(id),
      );
      if (task) writeFact(imageFact(task));
    } else if (entity === "billing_ledger") {
      const r = parse(
        source
          .prepare("SELECT payload_json FROM billing_ledger WHERE receipt_id=?")
          .get(id),
      );
      if (r) writeReceipt(r);
    } else if (entity === "credit_postings") {
      const r = source
        .prepare("SELECT * FROM credit_postings WHERE operation_key=?")
        .get(id);
      if (r) {
        r.reason = safeError(r.reason);
        db.prepare("INSERT OR IGNORE INTO postings VALUES(?,?,?,?,?,?,?)").run(
          r.operation_key,
          r.user_id,
          r.receipt_id,
          r.created_at,
          r.available_delta,
          r.reserved_delta,
          JSON.stringify(r),
        );
      }
    }
  }
  function consume(event) {
    projection(event.entity, event.entity_id);
    const data = parse(event);
    if (event.entity === "task-deleted") writeFact(imageFact(data));
    if (event.entity === "attempt") {
      db.prepare(
        "INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json",
      ).run(
        event.entity_id,
        data.taskId || "",
        data.userId || "",
        data.kind || "",
        data.model || "",
        data.channelId || "",
        data.startedAt || event.created_at,
        JSON.stringify(data),
      );
      const t = parse(
        db
          .prepare("SELECT payload_json FROM tasks WHERE id=?")
          .get(data.taskId),
      );
      if (t) writeFact(t);
    }
    if (event.entity === "outcome") {
      const t = parse(
        db
          .prepare("SELECT payload_json FROM tasks WHERE id=?")
          .get(event.entity_id),
      );
      if (t) writeFact({ ...t, ...data, observedOutcome: true });
    }
    if (
      ![
        "image_tasks",
        "billing_ledger",
        "media_assets",
        "credit_postings",
        "attempt",
      ].includes(event.entity)
    )
      db.prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?)").run(
        event.sequence,
        event.entity,
        event.entity_id,
        event.created_at,
        event.payload_json,
      );
  }
  function refreshUsers() {
    let users;
    try {
      users = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    } catch {
      return;
    }
    const current = new Set();
    for (const u of users) {
      current.add(u.id);
      const account = source
        .prepare(
          "SELECT available,reserved FROM credit_accounts WHERE user_id=?",
        )
        .get(u.id);
      const session = source
        .prepare(
          "SELECT last_login_at,last_seen_at FROM account_sessions WHERE user_id=?",
        )
        .get(u.id);
      const storage = source
        .prepare(
          "SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM media_assets WHERE user_id=?",
        )
        .get(u.id);
      const safe = {
        id: u.id,
        name: u.displayName || u.username,
        username: u.username,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt,
        credits: (account?.available || 0) / 1e6,
        reservedCredits: (account?.reserved || 0) / 1e6,
        lastLoginAt: session?.last_login_at,
        lastSeenAt: session?.last_seen_at,
        storageBytes: storage.bytes,
        storedAssets: storage.count,
        deleted: false,
      };
      db.prepare(
        "INSERT INTO users VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json",
      ).run(u.id, JSON.stringify(safe));
    }
    for (const u of all("SELECT payload_json FROM users"))
      if (!current.has(u.id))
        db.prepare("UPDATE users SET payload_json=? WHERE id=?").run(
          JSON.stringify({
            ...u,
            name: "已删除用户",
            username: "",
            deleted: true,
          }),
          u.id,
        );
  }
  function sync(force = false) {
    if (!force && Date.now() - lastSync < 1000) return;
    source.exec("BEGIN");
    try {
      if (!meta("initialized")) {
        db.exec("BEGIN");
        try {
          for (const row of source
            .prepare("SELECT task_id FROM image_tasks")
            .all())
            projection("image_tasks", row.task_id);
          for (const row of source
            .prepare("SELECT receipt_id FROM billing_ledger")
            .all())
            projection("billing_ledger", row.receipt_id);
          for (const row of source
            .prepare("SELECT operation_key FROM credit_postings")
            .all())
            projection("credit_postings", row.operation_key);
          setMeta("initialized", new Date().toISOString());
          setMeta("cursor", 0);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
      const events = source
        .prepare(
          "SELECT * FROM telemetry_outbox WHERE sequence>? ORDER BY sequence LIMIT 1000",
        )
        .all(Number(meta("cursor") || 0));
      db.exec("BEGIN");
      try {
        for (const e of events) consume(e);
        if (events.length) setMeta("cursor", events.at(-1).sequence);
        refreshUsers();
        setMeta("syncedAt", new Date().toISOString());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      lastSync = Date.now();
    } finally {
      source.exec("ROLLBACK");
    }
  }
  function filter(query, alias = "") {
    const range = parseRange(query);
    const p = alias ? `${alias}.` : "";
    const where = [`${p}created_at>=?`, `${p}created_at<?`];
    const args = [range.from, range.to];
    for (const [key, column] of [
      ["userId", "user_id"],
      ["model", "model"],
      ["channelId", "channel_id"],
      ["kind", "kind"],
    ])
      if (query[key]) {
        const values = String(query[key]).split(",");
        if (values.length > 20 || values.some((v) => v.length > 200))
          throw new Error("筛选项过多");
        where.push(`${p}${column} IN (${values.map(() => "?").join(",")})`);
        args.push(...values);
      }
    if (query.role)
      (where.push(
        `${p}user_id IN (SELECT id FROM users WHERE json_extract(payload_json,'$.role')=?)`,
      ),
        args.push(query.role));
    return { range, where: where.join(" AND "), args };
  }
  function loadTasks(query) {
    const f = filter(query);
    const count = db
      .prepare(`SELECT COUNT(*) n FROM tasks WHERE ${f.where}`)
      .get(...f.args).n;
    if (count > 100000)
      throw Object.assign(
        new Error("当前区间超过10万任务，请缩短时间或选择用户/模型"),
        { statusCode: 413 },
      );
    return {
      ...f,
      tasks: all(
        `SELECT payload_json FROM tasks WHERE ${f.where} ORDER BY created_at`,
        ...f.args,
      ),
    };
  }
  function groups(tasks, key) {
    const map = new Map();
    for (const t of tasks) {
      const id = key(t);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(t);
    }
    return [...map]
      .map(([id, ts]) => ({ id, ...summarize(ts) }))
      .sort((a, b) => b.total - a.total);
  }
  function report(query) {
    const { range, tasks, where, args } = loadTasks(query);
    const previousTo = range.from,
      previousFrom = new Date(
        Date.parse(range.from) -
          (Date.parse(range.to) - Date.parse(range.from)),
      ).toISOString();
    const previous = loadTasks({
      ...query,
      from: previousFrom,
      to: previousTo,
    }).tasks;
    const bins = new Map();
    for (
      let at = Date.parse(range.from);
      at < Date.parse(range.to);
      at += range.grain
    )
      bins.set(at, []);
    for (const t of tasks)
      bins
        .get(
          Date.parse(range.from) +
            Math.floor(
              (Date.parse(t.createdAt) - Date.parse(range.from)) / range.grain,
            ) *
              range.grain,
        )
        ?.push(t);
    const users = all("SELECT payload_json FROM users");
    const userMap = new Map(users.map((u) => [u.id, u]));
    const attempts = all(
      `SELECT payload_json FROM attempts WHERE ${where}`,
      ...args,
    );
    const generation = attempts.filter((a) => a.purpose === "generation");
    const start = meta("initialized");
    return {
      ...range,
      summary: summarize(tasks),
      previous: summarize(previous),
      users: groups(tasks, (t) => t.userId).map((g) => ({
        ...g,
        ...(userMap.get(g.id) || { name: "历史用户", id: g.id }),
      })),
      models: groups(tasks, (t) => t.model),
      channels: groups(tasks, (t) => t.channelId || "未知渠道"),
      kinds: groups(tasks, (t) => t.kind),
      matrix: groups(tasks, (t) => `${t.userId}\u0000${t.model}`).map((g) => ({
        ...g,
        userId: g.id.split("\u0000")[0],
        model: g.id.split("\u0000")[1],
      })),
      errors: groups(
        tasks.filter((t) => ["failed", "partial"].includes(t.status)),
        (t) => t.errorCode || "unknown",
      ),
      series: [...bins].map(([at, ts]) => ({
        at: new Date(at).toISOString(),
        ...summarize(ts),
      })),
      attempts: {
        total: generation.length,
        succeeded: generation.filter((a) => a.status === "succeeded").length,
        failed: generation.filter((a) => a.status === "failed").length,
        query: attempts.filter((a) => a.purpose === "query").length,
        retrieval: attempts.filter((a) => a.purpose === "retrieval").length,
        inputTokens: generation.reduce((s, a) => s + (a.inputTokens || 0), 0),
        outputTokens: generation.reduce((s, a) => s + (a.outputTokens || 0), 0),
        measured: generation.filter((a) => a.usageSource === "actual").length,
      },
      coverage: {
        historicalFrom: db.prepare("SELECT MIN(created_at) at FROM tasks").get()
          .at,
        telemetryFrom: start,
        retryMeasured: tasks.filter((t) => t.retries !== null).length,
        strictOutputMeasured: tasks.filter((t) => t.expected !== null).length,
        external: "仅包含服务器托管渠道，外部直连未纳管",
        legacy: "历史未知结果不推定成功；旧批量任务预期数量未保留",
        dataLagSeconds: Math.max(
          0,
          (Date.now() - Date.parse(meta("syncedAt"))) / 1000,
        ),
        cursor: Number(meta("cursor")),
        pendingEvents: source
          .prepare("SELECT COUNT(*) n FROM telemetry_outbox WHERE sequence>?")
          .get(Number(meta("cursor"))).n,
      },
    };
  }
  function credits(query) {
    const range = parseRange(query),
      selected = String(query.userId || "")
        .split(",")
        .filter(Boolean);
    const users = all("SELECT payload_json FROM users").filter(
      (u) =>
        (!selected.length || selected.includes(u.id)) &&
        (!query.role || u.role === query.role),
    );
    const rows = users.map((u) => {
      const postings = db
        .prepare(
          "SELECT * FROM postings WHERE user_id=? AND created_at<? ORDER BY created_at,id",
        )
        .all(u.id, range.to);
      let openingAvailable = 0,
        openingReserved = 0,
        available = 0,
        reserved = 0,
        granted = 0,
        spent = 0,
        refund = 0,
        released = 0,
        held = 0;
      for (const p of postings) {
        available += p.available_delta;
        reserved += p.reserved_delta;
        if (p.created_at < range.from) {
          openingAvailable = available;
          openingReserved = reserved;
          continue;
        }
        if (p.id.startsWith("opening:")) {
          granted += p.available_delta + p.reserved_delta;
        } else if (p.id.startsWith("adjust:"))
          granted += p.available_delta + p.reserved_delta;
        else if (p.id.startsWith("reserve:")) held += p.reserved_delta;
        else if (p.id.startsWith("settle:")) {
          spent -= p.available_delta + p.reserved_delta;
          released += p.available_delta;
        } else if (p.id.startsWith("release:")) {
          if (p.reserved_delta < 0) released += p.available_delta;
          else refund += p.available_delta;
        }
      }
      const total = db
        .prepare(
          "SELECT COALESCE(SUM(available_delta),0) a,COALESCE(SUM(reserved_delta),0) r FROM postings WHERE user_id=?",
        )
        .get(u.id);
      return {
        ...u,
        openingAvailable: openingAvailable / 1e6,
        openingReserved: openingReserved / 1e6,
        closingAvailable: available / 1e6,
        closingReserved: reserved / 1e6,
        granted: granted / 1e6,
        spent: spent / 1e6,
        refund: refund / 1e6,
        released: released / 1e6,
        held: held / 1e6,
        net: (spent - refund) / 1e6,
        difference:
          (total.a -
            Math.round(u.credits * 1e6) +
            (total.r - Math.round(u.reservedCredits * 1e6))) /
          1e6,
        availableDifference: (total.a - Math.round(u.credits * 1e6)) / 1e6,
        reservedDifference:
          (total.r - Math.round(u.reservedCredits * 1e6)) / 1e6,
      };
    });
    const totals = {};
    for (const k of [
      "openingAvailable",
      "openingReserved",
      "closingAvailable",
      "closingReserved",
      "granted",
      "spent",
      "refund",
      "released",
      "held",
      "net",
      "credits",
      "reservedCredits",
    ])
      totals[k] = rows.reduce((s, r) => s + r[k], 0);
    const receipts = all("SELECT payload_json FROM receipts").filter(
      (r) =>
        (!selected.length || selected.includes(r.userId)) &&
        (!query.role || users.some((u) => u.id === r.userId)),
    );
    return {
      ...range,
      rows,
      totals,
      pending: receipts.filter((r) => r.status === "pending"),
      issues: receipts.filter(
        (r) =>
          r.needsReview ||
          (r.status === "completed" && r.kind === "video" && !r.verified),
      ),
      postingFrom: db.prepare("SELECT MIN(created_at) at FROM postings").get()
        .at,
      costSource: "供应商成本未接入",
      billingHistorical:
        "期初余额导入单列；迁移前消费仅在历史账单中可查，未重新记为当期消费",
    };
  }
  function usage(input) {
    const { range, tasks } = loadTasks(input),
      selected = String(input.userId || "")
        .split(",")
        .filter(Boolean);
    const users = all("SELECT payload_json FROM users").filter(
      (u) =>
        (!selected.length || selected.includes(u.id)) &&
        (!input.role || u.role === input.role),
    );
    const allowed = new Set(users.map((u) => u.id));
    const events = db
      .prepare(
        "SELECT entity,created_at,payload_json FROM events WHERE created_at>=? AND created_at<? AND entity IN ('activity','request-error') ORDER BY id LIMIT 100000",
      )
      .all(range.from, range.to)
      .map((r) => ({
        ...JSON.parse(r.payload_json),
        at: r.created_at,
        entity: r.entity,
      }))
      .filter((e) => !e.userId || allowed.has(e.userId));
    const active = events.filter(
      (e) =>
        e.entity === "activity" &&
        (e.action === "active" || (e.kind === "server" && e.status < 400)),
    );
    const days = new Map(),
      hours = new Map(),
      pages = new Map();
    for (const e of active) {
      const local = new Date(Date.parse(e.at) + 8 * 3600000),
        day = local.toISOString().slice(0, 10),
        hour = local.getUTCHours(),
        week = (local.getUTCDay() + 6) % 7;
      if (!days.has(day)) days.set(day, new Set());
      days.get(day).add(e.userId);
      const h = `${week}:${hour}`;
      if (!hours.has(h)) hours.set(h, new Set());
      hours.get(h).add(e.userId);
      const p = e.page || String(e.action || "").split("/")[2] || "other";
      pages.set(p, (pages.get(p) || 0) + 1);
    }
    const first = db
      .prepare(
        "SELECT user_id,MIN(created_at) first_at FROM tasks WHERE status='succeeded' GROUP BY user_id",
      )
      .all()
      .filter((r) => allowed.has(r.user_id));
    const successUsers = new Set(
      tasks.filter((t) => t.status === "succeeded").map((t) => t.userId),
    );
    const generationUsers = new Set(tasks.map((t) => t.userId));
    const cohort = first.filter(
      (r) => r.first_at >= range.from && r.first_at < range.to,
    );
    const dayKey = (value) =>
      new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
    const retention = [1, 7].map((offset) => {
      const mature = cohort.filter(
        (r) =>
          Date.parse(dayKey(r.first_at) + "T00:00:00+08:00") +
            (offset + 1) * 86400000 <=
          Date.now(),
      );
      let retained = 0;
      for (const r of mature) {
        const start =
          Date.parse(dayKey(r.first_at) + "T00:00:00+08:00") +
          offset * 86400000;
        const yes = db
          .prepare(
            "SELECT 1 FROM tasks WHERE user_id=? AND created_at>=? AND created_at<? LIMIT 1",
          )
          .get(
            r.user_id,
            new Date(start).toISOString(),
            new Date(start + 86400000).toISOString(),
          );
        if (yes) retained++;
      }
      return {
        day: offset,
        eligible: mature.length,
        retained,
        rate: mature.length ? (retained * 100) / mature.length : null,
      };
    });
    return {
      ...range,
      activeUsers: new Set(active.map((e) => e.userId)).size,
      newUsers: users.filter(
        (u) => u.createdAt >= range.from && u.createdAt < range.to,
      ).length,
      generationUsers: generationUsers.size,
      successUsers: successUsers.size,
      days: [...days].map(([day, ids]) => ({ day, users: ids.size })),
      hours: [...hours].map(([h, ids]) => ({
        day: Number(h.split(":")[0]),
        hour: Number(h.split(":")[1]),
        users: ids.size,
      })),
      pages: [...pages].map(([page, count]) => ({ page, count })),
      retention,
      errors: events
        .filter(
          (e) =>
            e.entity === "request-error" ||
            ["frontend-error", "sync-error"].includes(e.action),
        )
        .map((e) => ({
          at: e.at,
          userId: e.userId,
          action: e.action || e.route,
          code: e.code,
          status: e.status,
        })),
      coverageFrom: meta("initialized"),
      truncated: events.length === 100000,
      retentionDefinition:
        "首次成功任务后的第1/7个自然日再次提交生成；仅统计观察日已结束的用户",
      scope:
        "行为分析支持用户、账户类型与时间，模型/渠道/生成类型不筛选页面行为",
    };
  }
  function query(method, input = {}, skipSync = false) {
    if (!skipSync) sync();
    if (method === "dashboard")
      return {
        report: query("report", input, true),
        options: query("options", input, true),
        runtime: query("runtime", input, true),
        credits: query("credits", input, true),
        artifacts: query("artifacts", input, true),
        tasks: query("tasks", input, true),
        events: query("events", input, true),
        usage: query("usage", input, true),
      };
    if (method === "report") return report(input);
    if (method === "credits") return credits(input);
    if (method === "usage") return usage(input);
    if (method === "options")
      return {
        users: all("SELECT payload_json FROM users"),
        models: db
          .prepare("SELECT DISTINCT model id FROM tasks ORDER BY model")
          .all(),
        channels: db
          .prepare(
            "SELECT DISTINCT channel_id id FROM tasks WHERE channel_id!=''",
          )
          .all(),
        metricVersion: METRIC_VERSION,
      };
    if (method === "tasks") {
      const f = filter(input);
      const status = input.status ? " AND status=?" : "";
      const args = input.status ? [...f.args, input.status] : f.args;
      return {
        ...f.range,
        total: db
          .prepare(`SELECT COUNT(*) n FROM tasks WHERE ${f.where}${status}`)
          .get(...args).n,
        items: all(
          `SELECT payload_json FROM tasks WHERE ${f.where}${status} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          ...args,
          Math.min(200, Math.max(1, Number(input.limit) || 50)),
          Math.max(0, Number(input.offset) || 0),
        ),
      };
    }
    if (method === "task") {
      const task = parse(
        db.prepare("SELECT payload_json FROM tasks WHERE id=?").get(input.id),
      );
      if (!task)
        throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
      return {
        task,
        attempts: all(
          "SELECT payload_json FROM attempts WHERE task_id=? ORDER BY created_at",
          task.id,
        ),
        receipt: parse(
          db
            .prepare("SELECT payload_json FROM receipts WHERE id=?")
            .get(task.receiptId),
        ),
        events: db
          .prepare(
            "SELECT entity,created_at,payload_json FROM events WHERE entity_id=? ORDER BY id LIMIT 200",
          )
          .all(task.id)
          .map((r) => ({
            ...r,
            data: JSON.parse(r.payload_json),
            payload_json: undefined,
          })),
      };
    }
    if (method === "artifacts") {
      const f = filter(input);
      const items = all(
        `SELECT payload_json FROM artifacts WHERE ${f.where} ORDER BY created_at DESC`,
        ...f.args,
      );
      return {
        ...f.range,
        total: items.length,
        bytes: items.reduce((s, r) => s + r.bytes, 0),
        durationMs: items.reduce((s, r) => s + r.durationMs, 0),
        kinds: [...new Set(items.map((a) => a.kind))].map((kind) => ({
          kind,
          count: items.filter((a) => a.kind === kind).length,
          bytes: items
            .filter((a) => a.kind === kind)
            .reduce((s, a) => s + a.bytes, 0),
        })),
        items: items.slice(
          Math.max(0, Number(input.offset) || 0),
          Math.max(0, Number(input.offset) || 0) +
            Math.min(200, Number(input.limit) || 50),
        ),
      };
    }
    if (method === "runtime") {
      const range = parseRange(input),
        bins = new Map();
      for (
        let at = Date.parse(range.from);
        at < Date.parse(range.to);
        at += range.grain
      )
        bins.set(at, []);
      for (const r of db
        .prepare(
          "SELECT * FROM runtime WHERE created_at>=? AND created_at<? ORDER BY created_at",
        )
        .all(range.from, range.to)) {
        const at =
          Date.parse(range.from) +
          Math.floor(
            (Date.parse(r.created_at) - Date.parse(range.from)) / range.grain,
          ) *
            range.grain;
        if (!bins.has(at)) bins.set(at, []);
        bins.get(at).push(JSON.parse(r.payload_json));
      }
      return {
        ...range,
        fromAvailable: db
          .prepare("SELECT MIN(created_at) at FROM runtime")
          .get().at,
        series: [...bins].map(([at, rows]) => {
          const out = { at: new Date(at).toISOString(), samples: rows.length };
          for (const key of [
            "online",
            "active",
            "httpConcurrent",
            "upstreamConcurrent",
            "queued",
            "running",
            "cpuPercent",
            "memoryBytes",
            "eventLoopP95Ms",
            "hostCpuPercent",
            "hostMemoryPercent",
            "diskUsedPercent",
          ]) {
            const values = rows.map((r) => r[key]).filter(Number.isFinite);
            out[key] = values.length
              ? values.reduce((a, b) => a + b, 0) / values.length
              : null;
            out[`${key}Max`] = values.length ? Math.max(...values) : null;
          }
          return out;
        }),
      };
    }
    if (method === "events") {
      const range = parseRange(input);
      const type = input.entity || "audit";
      const rows = db
        .prepare(
          "SELECT * FROM events WHERE entity=? AND created_at>=? AND created_at<? ORDER BY id DESC LIMIT 500",
        )
        .all(type, range.from, range.to);
      return {
        ...range,
        items: rows.map((r) => ({
          id: r.id,
          entity: r.entity,
          entityId: r.entity_id,
          at: r.created_at,
          ...JSON.parse(r.payload_json),
        })),
      };
    }
    if (method === "export") {
      const range = parseRange(input);
      let rows, columns;
      if (input.type === "credits") {
        rows = credits(input).rows;
        columns = [
          { key: "id", label: "用户ID" },
          { key: "name", label: "用户" },
          ...[
            "openingAvailable",
            "openingReserved",
            "granted",
            "held",
            "spent",
            "refund",
            "released",
            "closingAvailable",
            "closingReserved",
            "availableDifference",
            "reservedDifference",
          ].map((key, i) => ({
            key,
            label: [
              "期初可用",
              "期初冻结",
              "发放调整",
              "预扣",
              "实耗",
              "退款",
              "释放冻结",
              "期末可用",
              "期末冻结",
              "可用差异",
              "冻结差异",
            ][i],
          })),
        ];
      } else if (["users", "models"].includes(input.type)) {
        rows = report(input)[input.type];
        columns = [
          { key: "id", label: "标识" },
          { key: "name", label: "用户" },
          ...[
            "total",
            "succeeded",
            "partial",
            "failed",
            "canceled",
            "running",
            "queued",
            "unknown",
            "denominator",
            "successRate",
            "outputs",
          ].map((key, i) => ({
            key,
            label: [
              "任务",
              "成功",
              "部分成功",
              "失败",
              "取消",
              "进行中",
              "排队",
              "未知",
              "有效分母",
              "成功率百分比",
              "成品",
            ][i],
          })),
        ];
      } else if (input.type === "artifacts") {
        const f = filter(input);
        rows = all(
          `SELECT payload_json FROM artifacts WHERE ${f.where} ORDER BY created_at`,
          ...f.args,
        );
        if (rows.length > 100000)
          throw Object.assign(new Error("成品超过10万条，请缩小范围"), {
            statusCode: 413,
          });
        columns = [
          "id",
          "taskId",
          "userId",
          "kind",
          "model",
          "channelId",
          "createdAt",
          "bytes",
          "durationMs",
          "evidence",
        ].map((key, i) => ({
          key,
          label: [
            "成品ID",
            "任务ID",
            "用户ID",
            "类型",
            "模型",
            "渠道",
            "交付时间UTC",
            "字节数",
            "时长毫秒",
            "证据",
          ][i],
        }));
      } else {
        rows = loadTasks(input).tasks;
        columns = [
          "id",
          "userId",
          "kind",
          "model",
          "channelId",
          "createdAt",
          "endedAt",
          "status",
          "expected",
          "delivered",
          "evidence",
          "errorCode",
        ].map((key, i) => ({
          key,
          label: [
            "任务ID",
            "用户ID",
            "类型",
            "模型",
            "渠道",
            "受理时间UTC",
            "结束时间UTC",
            "状态",
            "预期输出",
            "已交付输出",
            "证据覆盖",
            "错误分类",
          ][i],
        }));
      }
      const metadata = {
        rangeFrom: range.from,
        rangeTo: range.to,
        asOf: range.asOf,
        timezone: range.timezone,
        metricVersion: range.metricVersion,
      };
      return {
        range,
        text: csv(
          rows.map((r) => ({ ...r, ...metadata })),
          [
            ...columns,
            ...Object.keys(metadata).map((key) => ({ key, label: key })),
          ],
        ),
      };
    }
    if (method === "maintenance") {
      sync(true);
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      return {
        ok: true,
        cursor: Number(meta("cursor")),
        syncedAt: meta("syncedAt"),
      };
    }
    throw Object.assign(new Error("未知统计查询"), { statusCode: 404 });
  }
  function runtime(snapshot) {
    db.prepare("INSERT OR REPLACE INTO runtime VALUES(?,?)").run(
      snapshot.at,
      JSON.stringify(snapshot),
    );
    if (
      !meta("lastPrune") ||
      Date.now() - Number(meta("lastPrune")) > 3600000
    ) {
      db.prepare("DELETE FROM runtime WHERE created_at<?").run(
        new Date(Date.now() - 90 * 86400000).toISOString(),
      );
      setMeta("lastPrune", Date.now());
    }
  }
  return {
    sync,
    query,
    runtime,
    close() {
      source.close();
      db.close();
    },
  };
}

if (parentPort) {
  const analytics = createAnalytics(workerData);
  const timer = setInterval(() => {
    try {
      analytics.sync();
      parentPort.postMessage({ type: "healthy", at: new Date().toISOString() });
    } catch (e) {
      parentPort.postMessage({ type: "fault", error: safeError(e.message) });
    }
  }, 5000);
  timer.unref();
  parentPort.on("message", (message) => {
    try {
      if (message.type === "runtime") {
        analytics.runtime(message.data);
        return;
      }
      const result = analytics.query(message.method, message.input);
      parentPort.postMessage({ id: message.id, result });
    } catch (e) {
      parentPort.postMessage({
        id: message.id,
        error: safeError(e.message),
        statusCode: e.statusCode || 500,
      });
    }
  });
}
