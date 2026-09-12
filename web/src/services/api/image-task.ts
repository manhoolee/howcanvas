import type { AiConfig } from "@/stores/use-config-store";
import { getAuthEpoch } from "./backend";
import { readImageResource } from "./image-transfer";
import { postGeneration } from "./generation-request";

export type ServerImageTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "unknown";
export type ServerImageTaskPhase = "queued" | "generating" | "upstream-complete" | "retrieving" | "persisted" | "failed" | "canceled" | "unknown";

export type ServerImageMedia = {
    storageKey: string;
    url: string;
    bytes: number;
    mimeType: string;
    sha256: string;
    persistedAt: string;
};

export type ServerImageTask = {
    id: string;
    status: ServerImageTaskStatus;
    phase: ServerImageTaskPhase;
    action: "generations" | "edits";
    model: string;
    createdAt: string;
    startedAt: string;
    finishedAt: string;
    updatedAt: string;
    upstreamStatus: number;
    error: string;
    upstreamCompletedAt: string;
    retrievalStartedAt: string;
    persistedAt: string;
    deliveryStatus: "pending" | "delivered";
    clientAckAt: string;
    media: ServerImageMedia[];
    context?: Record<string, string | number | boolean>;
};

export type ServerImageTaskOptions = {
    requestId?: string;
    signal?: AbortSignal;
    existingTaskId?: string;
    onTaskSubmitted?: (taskId: string) => void;
    onTaskUpdated?: (task: ServerImageTask) => void;
    clientContext?: Record<string, string | number | boolean>;
};

export type ServerImageTaskSnapshot =
    | { status: "pending"; task: ServerImageTask }
    | { status: "succeeded"; task: ServerImageTask; result: unknown }
    | { status: "failed"; task: ServerImageTask; error: string };

const POLL_INTERVAL_MS = 1_500;
const TASK_EVENT = "infinite-canvas:image-task";
export const IMAGE_TASK_RESUME_EVENT = "infinite-canvas:resume-image-tasks";

/**
 * 单次查询已有图片任务。不创建任务、不重新扣费；成功时同时取回原始结果。
 */
export async function refreshServerImageTask(taskId: string, signal?: AbortSignal): Promise<ServerImageTaskSnapshot> {
    const payload = await readImageResource(`/api/image-tasks/${encodeURIComponent(taskId)}`, (response) => response.json(), signal) as { task?: ServerImageTask; error?: string };
    if (!payload.task) throw new Error(payload.error || "查询后台图片任务失败");
    if (payload.task.status === "queued" || payload.task.status === "running") return { status: "pending", task: payload.task };
    if (payload.task.status !== "succeeded") return { status: "failed", task: payload.task, error: taskError(payload.task) };

    const result = await readImageResource(`/api/image-tasks/${encodeURIComponent(taskId)}/result`, (response) => response.json(), signal);
    return { status: "succeeded", task: payload.task, result };
}

export async function waitForServerImageTask(taskId: string, options?: ServerImageTaskOptions) {
    const epoch = getAuthEpoch();
    while (true) {
        options?.signal?.throwIfAborted();
        if (getAuthEpoch() !== epoch) throw new Error("账号已切换，已停止取回原任务");
        const snapshot = await refreshServerImageTask(taskId, options?.signal);
        options?.onTaskUpdated?.(snapshot.task);
        if (snapshot.status === "succeeded") return snapshot.result;
        if (snapshot.status === "failed") throw Object.assign(new Error(snapshot.error), { taskStatus: snapshot.task.status });
        await waitForTaskUpdate(taskId, options?.signal, options?.onTaskUpdated);
    }
}

export function supportsServerImageTasks(config: Pick<AiConfig, "baseUrl">) {
    return /^\/api\/ai\/[A-Za-z0-9_-]+\/?$/.test(config.baseUrl.trim());
}

export async function requestServerImageTask(
    config: Pick<AiConfig, "baseUrl" | "apiKey" | "model">,
    action: "generations" | "edits",
    body: BodyInit,
    contentType: string | undefined,
    options?: ServerImageTaskOptions,
) {
    const channelId = config.baseUrl.trim().match(/^\/api\/ai\/([A-Za-z0-9_-]+)/)?.[1];
    if (!channelId) throw new Error("服务器图片任务渠道无效");
    let taskId = options?.existingTaskId || "";
    if (!taskId) {
        const submitRoute = /(?:^|[-_.])seedream(?:[-_.]|$)/i.test(config.model.trim()) ? "seedream-tasks" : "image-tasks";
        const response = await postGeneration<{ task?: ServerImageTask; error?: string }>(`/api/${submitRoute}/${encodeURIComponent(channelId)}/${action}`, body, {
            headers: {
                ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
                "X-Infinite-Canvas-Model": config.model.trim(),
                ...(options?.clientContext ? { "X-Infinite-Canvas-Context": encodeContext(options.clientContext) } : {}),
                ...(contentType ? { "Content-Type": contentType } : {}),
            },
            signal: options?.signal,
        }, options?.requestId);
        const payload = response.data;
        if (!payload.task?.id) throw new Error(payload.error || `创建后台图片任务失败（${response.status}）`);
        taskId = payload.task.id;
        options?.onTaskSubmitted?.(taskId);
        options?.onTaskUpdated?.(payload.task);
    }

    const onAbort = () => {
        void fetch(`/api/image-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        return await waitForServerImageTask(taskId, options);
    } finally {
        options?.signal?.removeEventListener("abort", onAbort);
    }
}

export async function acknowledgeImageTaskDelivery(taskId: string, metrics?: Record<string, number>, stage: "cached" | "rendered" = "rendered") {
    if (!taskId) return;
    const response = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ metrics, stage }),
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `图片交付回执失败（${response.status}）`);
    }
}

export function acknowledgeImageTaskAfterRender(taskId?: string, metrics?: Record<string, number>) {
    if (!taskId) return;
    const epoch = getAuthEpoch();
    void afterBrowserPaint()
        .then(() => { if (getAuthEpoch() === epoch) return acknowledgeImageTaskDelivery(taskId, metrics); })
        .catch((error) => console.warn(`[image-task] delivery ACK ${taskId} failed`, error));
}

function encodeContext(context: Record<string, string | number | boolean>) {
    const bytes = new TextEncoder().encode(JSON.stringify(context));
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function waitForTaskUpdate(taskId: string, signal?: AbortSignal, onTaskUpdated?: (task: ServerImageTask) => void) {
    return new Promise<void>((resolve, reject) => {
        let abort: (() => void) | undefined;
        const handleTask = (event: Event) => {
            const task = (event as CustomEvent<{ task?: ServerImageTask }>).detail?.task;
            if (task?.id === taskId) {
                onTaskUpdated?.(task);
                finish();
            }
        };
        const finish = () => {
            window.clearTimeout(timer);
            window.removeEventListener(TASK_EVENT, handleTask);
            window.removeEventListener("online", finish);
            window.removeEventListener(IMAGE_TASK_RESUME_EVENT, finish);
            document.removeEventListener("visibilitychange", visible);
            if (abort) signal?.removeEventListener("abort", abort);
            resolve();
        };
        const visible = () => { if (document.visibilityState === "visible") finish(); };
        const timer = window.setTimeout(() => {
            finish();
        }, POLL_INTERVAL_MS);
        window.addEventListener(TASK_EVENT, handleTask);
        window.addEventListener("online", finish);
        window.addEventListener(IMAGE_TASK_RESUME_EVENT, finish);
        document.addEventListener("visibilitychange", visible);
        if (!signal) return;
        abort = () => {
            window.clearTimeout(timer);
            window.removeEventListener(TASK_EVENT, handleTask);
            window.removeEventListener("online", finish);
            window.removeEventListener(IMAGE_TASK_RESUME_EVENT, finish);
            document.removeEventListener("visibilitychange", visible);
            reject(new Error("请求已取消"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}

function afterBrowserPaint() {
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function taskError(task: ServerImageTask) {
    if (!task.error) return task.status === "canceled" ? "任务已取消" : "后台图片任务失败";
    try {
        const payload = JSON.parse(task.error) as { error?: { message?: string }; message?: string };
        return payload.error?.message || payload.message || task.error;
    } catch {
        return task.error;
    }
}
