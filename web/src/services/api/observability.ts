export type Usage = {
    activeUsers: number;
    newUsers: number;
    generationUsers: number;
    successUsers: number;
    days: { day: string; users: number }[];
    hours: { day: number; hour: number; users: number }[];
    pages: { page: string; count: number }[];
    retention: { day: number; eligible: number; retained: number; rate: number | null }[];
    coverageFrom: string;
    scope: string;
    retentionDefinition: string;
    truncated: boolean;
};
export type Filters = Record<string, string>;
export type Summary = {
    total: number;
    succeeded: number;
    failed: number;
    partial: number;
    canceled: number;
    running: number;
    queued: number;
    unknown: number;
    outputs: number;
    denominator: number;
    successRate: number | null;
    upstreamSuccessRate: number | null;
    firstSuccessRate: number | null;
    outputSuccessRate: number | null;
    retryRecoveryRate: number | null;
    completionRate: number | null;
    p95Ms: number | null;
    waitP95Ms: number | null;
    retryKnown: number;
};
export type UserRow = { id: string; name: string; username?: string; role: string; credits: number; reservedCredits: number; storageBytes: number; storedAssets: number; lastLoginAt?: string; createdAt: string; status: string; deleted: boolean };
export type Group = Summary & { id: string; name?: string; userId?: string; model?: string };
export type Report = {
    from: string;
    to: string;
    asOf: string;
    grain: number;
    summary: Summary;
    previous: Summary;
    users: (Group & UserRow)[];
    models: Group[];
    channels: Group[];
    kinds: Group[];
    matrix: Group[];
    errors: Group[];
    series: (Summary & { at: string })[];
    attempts: { total: number; succeeded: number; failed: number; query: number; retrieval: number; inputTokens: number; outputTokens: number; measured: number };
    coverage: { billingOnly:number; historicalFrom: string | null; telemetryFrom: string; retryMeasured: number; strictOutputMeasured: number; dataLagSeconds: number; pendingEvents: number; legacy: string; external: string };
};
export type Task = {
    id: string;
    userId: string;
    receiptId: string;
    kind: string;
    model: string;
    channelId: string;
    createdAt: string;
    endedAt: string | null;
    status: string;
    phase: string;
    expected: number | null;
    delivered: number;
    error: string;
    errorCode: string;
    evidence: string;
    stages: Record<string, string | null>;
};
export type Attempt = { id: string; purpose: string; model: string; channelId: string; status: string; startedAt: string; endedAt?: string; durationMs?: number; httpStatus?: number; errorCode?: string };
export type TaskDetail = { task: Task; attempts: Attempt[]; receipt: Record<string, unknown> | null; events: { entity: string; created_at: string; data: Record<string, unknown> }[] };
export type Snapshot = {
    at: string;
    version: string;
    online: number;
    active: number;
    httpConcurrent: number;
    sseConnections: number;
    upstreamConcurrent: number;
    queued: number;
    running: number;
    imageLimit: number;
    oldestWaitMs: number;
    videoWorkers: number;
    videoWorkerLimit: number;
    cpuPercent: number;
    cpuCores: number;
    memoryBytes: number;
    heapBytes: number;
    eventLoopP95Ms: number;
    uptimeSeconds: number;
    dropped: number;
    worker: { error: string; lagSeconds: number | null };
    people: { userId: string; name: string; page: string; seenAt: string; active: boolean; visible: boolean }[];
    alerts: { id: string; title: string; severity: string; detail: string; firstAt: string; acknowledgedBy?: string }[];
    channels: { id: string; name: string; paused: boolean; models: { name: string; capability: string }[] }[];
    hostFresh: boolean;
    hostCpuPercent: number | null;
    hostMemoryPercent: number | null;
    diskUsedPercent: number | null;
    host: { at: string; memoryTotal?: number; diskTotal?: number; containers?: { name: string; cpu: string; memory: string; status: string }[]; checks?: { name: string; ok: boolean; latencyMs: number }[]; backup?: { at: string; ok: boolean } } | null;
};
export type Credits = {
    rows: (UserRow & { spent: number; net: number; granted: number; refund: number; released: number; held: number; closingAvailable: number; closingReserved: number; availableDifference: number; reservedDifference: number })[];
    totals: Record<string, number>;
    pending: Record<string, unknown>[];
    issues: Record<string, unknown>[];
    postingFrom: string | null;
    costSource: string;
    billingHistorical: string;
};
export type Runtime = { fromAvailable: string | null; series: ({ at: string; samples: number } & Record<string, number | string | null>)[] };
export type Options = { users: UserRow[]; models: { id: string }[]; channels: { id: string }[] };
export type ActivityEvent = { id: number; at: string; entity: string; actorId?: string; userId?: string; action?: string; route?: string; status?: string | number; reason?: string; title?: string; code?: string; page?: string };
export type Artifacts = {
    total: number;
    bytes: number;
    durationMs: number;
    kinds: { kind: string; count: number; bytes: number }[];
    items: { id: string; taskId: string; userId: string; kind: string; model: string; createdAt: string; bytes: number; durationMs: number }[];
};

async function request<T>(route: string, filters: Filters = {}, body?: unknown): Promise<T> {
    const response = await fetch(`/api/admin/observability/${route}?${new URLSearchParams(filters)}`, { credentials: "include", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `查询失败（${response.status}）`);
    return result;
}
export const observabilityApi = {
    dashboard: (f: Filters) => request<{ report: Report; options: Options; runtime: Runtime; credits: Credits; artifacts: Artifacts; tasks: { total: number; items: Task[] }; events: { items: ActivityEvent[] }; usage: Usage }>("dashboard", f),
    usage: (f: Filters) => request<Usage>("usage", f),
    report: (f: Filters) => request<Report>("overview", f),
    options: () => request<Options>("options"),
    snapshot: () => request<Snapshot>("snapshot"),
    tasks: (f: Filters) => request<{ total: number; items: Task[] }>("tasks", f),
    task: (id: string) => request<TaskDetail>(`tasks/${encodeURIComponent(id)}`),
    credits: (f: Filters) => request<Credits>("credits", f),
    runtime: (f: Filters) => request<Runtime>("runtime", f),
    artifacts: (f: Filters) => request<Artifacts>("artifacts", f),
    events: (f: Filters) => request<{ items: ActivityEvent[] }>("events", f),
    action: (body: Record<string, unknown>) => request<{ ok: boolean }>("actions", {}, body),
    async export(f: Filters) {
        const r = await fetch(`/api/admin/observability/export?${new URLSearchParams(f)}`, { credentials: "include" });
        if (!r.ok) throw new Error((await r.json()).error || "导出失败");
        const url = URL.createObjectURL(await r.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = `画布任务统计-${f.from?.slice(0, 10) || "导出"}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
};
export async function sendTelemetry(action: "heartbeat" | "activity", data: Record<string, unknown>) {
    try {
        await fetch(`/api/telemetry/${action}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(5000) });
    } catch {
        /* Optional telemetry never blocks editing or login. */
    }
}
