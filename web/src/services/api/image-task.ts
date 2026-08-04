import type { AiConfig } from "@/stores/use-config-store";

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

/**
 * 单次查询已有图片任务。不创建任务、不重新扣费；成功时同时取回原始结果。
 */
export async function refreshServerImageTask(taskId: string, signal?: AbortSignal): Promise<ServerImageTaskSnapshot> {
    const response = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}`, { credentials: "same-origin", signal });
    const payload = await response.json().catch(() => ({})) as { task?: ServerImageTask; error?: string };
    if (!response.ok || !payload.task) throw new Error(payload.error || `查询后台图片任务失败（${response.status}）`);
    if (payload.task.status === "queued" || payload.task.status === "running") return { status: "pending", task: payload.task };
    if (payload.task.status !== "succeeded") return { status: "failed", task: payload.task, error: taskError(payload.task) };

    const resultResponse = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}/result`, { credentials: "same-origin", signal });
    const text = await resultResponse.text();
    if (!resultResponse.ok) {
        let message = text;
        try { message = String(JSON.parse(text)?.error || text); } catch {}
        throw new Error(message || `读取后台图片结果失败（${resultResponse.status}）`);
    }
    let result: unknown = text;
    try { result = JSON.parse(text); } catch {}
    return { status: "succeeded", task: payload.task, result };
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
        const response = await fetch(`/api/${submitRoute}/${encodeURIComponent(channelId)}/${action}`, {
            method: "POST",
            headers: {
                ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
                "X-Infinite-Canvas-Model": config.model.trim(),
                ...(options?.clientContext ? { "X-Infinite-Canvas-Context": encodeContext(options.clientContext) } : {}),
                ...(contentType ? { "Content-Type": contentType } : {}),
            },
            credentials: "same-origin",
            body,
            signal: options?.signal,
        });
        const payload = await response.json().catch(() => ({})) as { task?: ServerImageTask; error?: string };
        if (!response.ok || !payload.task?.id) throw new Error(payload.error || `创建后台图片任务失败（${response.status}）`);
        taskId = payload.task.id;
        options?.onTaskSubmitted?.(taskId);
        options?.onTaskUpdated?.(payload.task);
    }

    const onAbort = () => {
        void fetch(`/api/image-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        while (true) {
            if (options?.signal?.aborted) throw new Error("请求已取消");
            const response = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}`, { credentials: "same-origin", signal: options?.signal });
            const payload = await response.json().catch(() => ({})) as { task?: ServerImageTask; error?: string };
            if (!response.ok || !payload.task) throw new Error(payload.error || `查询后台图片任务失败（${response.status}）`);
            options?.onTaskUpdated?.(payload.task);
            if (payload.task.status === "succeeded") break;
            if (payload.task.status === "failed" || payload.task.status === "canceled" || payload.task.status === "unknown") throw new Error(taskError(payload.task));
            await waitForTaskUpdate(taskId, options?.signal, options?.onTaskUpdated);
        }
        const result = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}/result`, { credentials: "same-origin", signal: options?.signal });
        const text = await result.text();
        if (!result.ok) {
            let message = text;
            try { message = String(JSON.parse(text)?.error || text); } catch {}
            throw new Error(message || `读取后台图片结果失败（${result.status}）`);
        }
        try { return JSON.parse(text) as unknown; }
        catch { return text; }
    } finally {
        options?.signal?.removeEventListener("abort", onAbort);
    }
}

export async function acknowledgeImageTaskDelivery(taskId: string, metrics?: Record<string, number>) {
    if (!taskId) return;
    const response = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ metrics }),
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `图片交付回执失败（${response.status}）`);
    }
}

export function acknowledgeImageTaskAfterRender(taskId?: string, metrics?: Record<string, number>) {
    if (!taskId) return;
    void afterBrowserPaint()
        .then(() => acknowledgeImageTaskDelivery(taskId, metrics))
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
            if (abort) signal?.removeEventListener("abort", abort);
            resolve();
        };
        const timer = window.setTimeout(() => {
            finish();
        }, POLL_INTERVAL_MS);
        window.addEventListener(TASK_EVENT, handleTask);
        if (!signal) return;
        abort = () => {
            window.clearTimeout(timer);
            window.removeEventListener(TASK_EVENT, handleTask);
            reject(new Error("请求已取消"));
        };
        signal.addEventListener("abort", abort, { once: true });
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
