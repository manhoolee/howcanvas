// Shared metric definitions. No prompts, provider URLs or credentials enter this projection.
export const METRIC_VERSION = "2026-09-13.2";
export const terminal = new Set(["succeeded", "partial", "failed"]);
export function iso(value) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function safeError(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[地址]")
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/gi, "[凭据]")
    .slice(0, 300);
}
export function errorCode(value, status = 0) {
  const text = String(value || "");
  if (status === 429 || /限流|rate.limit/i.test(text)) return "rate_limit";
  if ([401, 403].includes(status)) return "provider_auth";
  if (/timeout|超时|deadline/i.test(text)) return "timeout";
  if (/cancel|取消/i.test(text)) return "canceled";
  if (/额度|积分|quota|balance/i.test(text)) return "quota";
  if (/磁盘|存储|ENOSPC|文件大小/i.test(text)) return "storage";
  if (/校验|视频轨|时长|decode|验证/i.test(text)) return "verification";
  if (/下载|取回|download/i.test(text)) return "retrieval";
  if (status >= 500) return "provider_5xx";
  return text ? "other" : "";
}
export function imageFact(task) {
  const media = Array.isArray(task.media) ? task.media : [];
  const expected =
    Number.isInteger(task.expectedOutputs) && task.expectedOutputs > 0
      ? task.expectedOutputs
      : null;
  const delivered = media.length;
  const status = task.status === "succeeded" && delivered === 0
    ? "unknown"
    : task.status === "succeeded" && expected && delivered < expected ? "partial" : task.status;
  return {
    id: task.id,
    userId: task.userId,
    receiptId: task.receiptId || "",
    kind: "image",
    model: task.model || "未知模型",
    channelId: task.channelId || "",
    source: task.context?.source || "image-task",
    createdAt: iso(task.createdAt),
    startedAt: iso(task.startedAt),
    endedAt: iso(task.finishedAt),
    availableAt: iso(task.persistedAt),
    status,
    expected,
    delivered,
    phase: task.phase || status,
    upstreamState: task.upstreamCompletedAt
      ? "succeeded"
      : status === "failed" && !task.retrievalStartedAt
        ? "failed"
        : "unknown",
    error: task.error
      ? `生成异常：${errorCode(task.error, task.upstreamStatus)}`
      : "",
    errorCode: errorCode(task.error, task.upstreamStatus),
    evidence: task.status === "succeeded" && delivered === 0 ? "legacy-unverified" : expected ? "complete" : "legacy-output-count",
    retries: null,
    clientAckAt: iso(task.clientAckAt),
    clientRenderedAt: iso(task.clientRenderedAt),
    stages: {
      queued: iso(task.createdAt),
      generating: iso(task.startedAt),
      upstream: iso(task.upstreamCompletedAt),
      retrieving: iso(task.retrievalStartedAt),
      persisted: iso(task.persistedAt),
      rendered: iso(task.clientRenderedAt),
    },
    artifacts: media.map((m, i) => ({
      id: `${task.id}:${i}`,
      taskId: task.id,
      userId: task.userId,
      kind: "image",
      model: task.model || "未知模型",
      channelId: task.channelId || "",
      createdAt: iso(task.persistedAt || task.finishedAt),
      bytes: Number(m.bytes) || 0,
      durationMs: 0,
      sha256: m.sha256 || "",
      storageKey: m.storageKey || "",
      outputIndex: i,
      evidence: "server-persisted",
    })),
  };
}
export function receiptFact(r) {
  const verified = Boolean(r.media?.sha256 && r.deliveredAt);
  const status =
    r.kind === "video"
      ? verified
        ? "succeeded"
        : r.status === "failed"
          ? "failed"
          : r.upstreamState === "unknown" || r.status === "legacy"
            ? "unknown"
            : "running"
      : r.observedOutcome || (r.status === "failed" ? "failed" : "unknown");
  const id = r.generationTaskId || `receipt:${r.id}`;
  return {
    id,
    userId: r.userId,
    receiptId: r.id,
    kind: r.kind,
    model: r.model || "未知模型",
    channelId: r.channelId || "",
    source: r.source || "proxy",
    createdAt: iso(r.createdAt),
    startedAt: iso(r.createdAt),
    endedAt: iso(
      r.observedEndedAt || (verified ? r.deliveredAt : r.refundedAt),
    ),
    availableAt: verified ? iso(r.deliveredAt) : null,
    status,
    phase: r.delivery?.phase || r.upstreamState || status,
    expected: r.kind === "video" ? 1 : null,
    delivered: verified ? 1 : 0,
    upstreamState:
      ["ready", "succeeded"].includes(r.upstreamState) || verified
        ? "succeeded"
        : r.status === "failed" && !r.delivery?.failedPhase
          ? "failed"
          : "unknown",
    error: r.lastError ? `交付异常：${errorCode(r.lastError)}` : "",
    errorCode: errorCode(r.lastError),
    evidence: verified
      ? "complete"
      : r.kind === "video"
        ? "legacy-unverified"
        : "billing-only",
    retries: null,
    clientAckAt: null,
    clientRenderedAt: null,
    stages: {
      generating: iso(r.createdAt),
      retrieving: iso(r.delivery?.downloadStartedAt),
      persisted: iso(r.deliveredAt),
    },
    artifacts: verified
      ? [
          {
            id: `${id}:0`,
            taskId: id,
            userId: r.userId,
            kind: r.kind,
            model: r.model || "未知模型",
            channelId: r.channelId || "",
            createdAt: iso(r.deliveredAt),
            bytes: r.media.bytes || 0,
            durationMs: r.actualDurationMs || 0,
            sha256: r.media.sha256,
            storageKey: "",
            outputIndex: 0,
            evidence: "server-verified",
          },
        ]
      : [],
  };
}
export function summarize(tasks) {
  const result = {
    total: tasks.length,
    succeeded: 0,
    partial: 0,
    failed: 0,
    canceled: 0,
    queued: 0,
    running: 0,
    unknown: 0,
    outputs: 0,
    expectedOutputs: 0,
    knownOutputCount: 0,
    upstreamSucceeded: 0,
    upstreamFailed: 0,
    firstSucceeded: 0,
    retryKnown: 0,
    retried: 0,
    recovered: 0,
    durationMs: [],
    waitMs: [],
  };
  for (const t of tasks) {
    result[Object.hasOwn(result, t.status) ? t.status : "unknown"]++;
    result.outputs += t.delivered || 0;
    if (terminal.has(t.status) && t.expected) {
      result.expectedOutputs += t.expected;
      result.knownOutputCount += Math.min(t.expected, t.delivered || 0);
    }
    if (t.upstreamState === "succeeded") result.upstreamSucceeded++;
    if (t.upstreamState === "failed") result.upstreamFailed++;
    if (
      terminal.has(t.status) &&
      t.retries !== null &&
      t.retries !== undefined
    ) {
      result.retryKnown++;
      if (t.retries > 0) {
        result.retried++;
        if (t.status === "succeeded") result.recovered++;
      } else if (t.status === "succeeded") result.firstSucceeded++;
    }
    if (t.endedAt && t.createdAt && terminal.has(t.status))
      result.durationMs.push(
        Math.max(0, Date.parse(t.endedAt) - Date.parse(t.createdAt)),
      );
    if (t.startedAt && t.createdAt)
      result.waitMs.push(
        Math.max(0, Date.parse(t.startedAt) - Date.parse(t.createdAt)),
      );
  }
  const denominator = result.succeeded + result.partial + result.failed;
  const rate = (n, d) => (d ? (100 * n) / d : null);
  return {
    ...result,
    denominator,
    successRate: rate(result.succeeded, denominator),
    upstreamSuccessRate: rate(
      result.upstreamSucceeded,
      result.upstreamSucceeded + result.upstreamFailed,
    ),
    firstSuccessRate: rate(result.firstSucceeded, result.retryKnown),
    retryRecoveryRate: rate(result.recovered, result.retried),
    outputSuccessRate: rate(result.knownOutputCount, result.expectedOutputs),
    completionRate: rate(result.succeeded, result.total),
    p50Ms: percentile(result.durationMs, 0.5),
    p95Ms: percentile(result.durationMs, 0.95),
    waitP95Ms: percentile(result.waitMs, 0.95),
    durationMs: undefined,
    waitMs: undefined,
  };
}
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
export function parseRange(query, now = Date.now()) {
  const hours = { "2h": 2, "24h": 24, "7d": 168, "30d": 720 };
  const to = query.to ? Date.parse(query.to) : now;
  const from = query.from
    ? Date.parse(query.from)
    : to - (hours[query.range] || 24) * 3600000;
  if (
    ![from, to].every(Number.isFinite) ||
    from >= to ||
    to > now + 60000 ||
    to - from > 366 * 86400000
  )
    throw Object.assign(new Error("请选择有效时间范围（最多366天）"), {
      statusCode: 400,
    });
  const span = to - from;
  const grain =
    span <= 2 * 3600000
      ? 60000
      : span <= 24 * 3600000
        ? 300000
        : span <= 7 * 86400000
          ? 3600000
          : Math.ceil(span / 720 / 3600000) * 3600000;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    asOf: new Date(now).toISOString(),
    grain,
    timezone: "Asia/Shanghai",
    metricVersion: METRIC_VERSION,
  };
}
export function csv(rows, columns) {
  const cell = (value) => {
    const s = String(value ?? "");
    return `"${(/^[=+@\-\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""')}"`;
  };
  return (
    "\ufeff" +
    [
      columns
        .map((c) => c.label)
        .map(cell)
        .join(","),
      ...rows.map((row) => columns.map((c) => cell(row[c.key])).join(",")),
    ].join("\r\n")
  );
}
