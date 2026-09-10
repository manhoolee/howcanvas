import { getAuthEpoch } from "./backend";

export class ImageTransferError extends Error {
    constructor(message: string, readonly status = 0) {
        super(message);
        this.name = "ImageTransferError";
    }
}

/** Retry reads only. Generation submissions must never be replayed here. */
export async function readImageResource<T>(
    url: string,
    read: (response: Response, progress: () => void) => Promise<T>,
    signal?: AbortSignal,
) {
    const epoch = getAuthEpoch();
    for (let attempt = 0; ; attempt += 1) {
        signal?.throwIfAborted();
        if (getAuthEpoch() !== epoch) throw new ImageTransferError("账号已切换，请重新取回图片", 401);
        const controller = new AbortController();
        let idleTimer: ReturnType<typeof setTimeout>;
        const progress = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => controller.abort(), 45_000);
        };
        const totalTimer = setTimeout(() => controller.abort(), 300_000);
        progress();
        let failure: unknown;
        try {
            const response = await fetch(url, {
                credentials: "same-origin",
                signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
            });
            if (!response.ok) {
                const detail = await response.json().catch(() => ({})) as { error?: string };
                throw new ImageTransferError(detail.error || (response.status === 401 ? "登录已失效，请登录后取回原图片" : `读取图片任务失败（${response.status}）`), response.status);
            }
            progress();
            const result = await read(response, progress);
            if (getAuthEpoch() !== epoch) throw new ImageTransferError("账号已切换，请重新取回图片", 401);
            return result;
        } catch (error) {
            signal?.throwIfAborted();
            failure = error;
            const retryable = error instanceof ImageTransferError
                ? [408, 425, 429].includes(error.status) || error.status >= 500
                : error instanceof TypeError || controller.signal.aborted;
            if (!retryable || attempt >= 2) {
                if (controller.signal.aborted) throw new ImageTransferError("图片任务读取暂时中断，请稍后继续取回");
                throw error;
            }
        } finally {
            clearTimeout(idleTimer!);
            clearTimeout(totalTimer);
        }
        if (failure) await waitForImageRetry(1000 * 2 ** attempt, signal);
    }
}

export function waitForImageRetry(delay: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const finish = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal?.reason || new DOMException("请求已取消", "AbortError")); };
        const visible = () => { if (document.visibilityState === "visible") finish(); };
        const timer = setTimeout(finish, delay);
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            window.removeEventListener("online", finish);
            document.removeEventListener("visibilitychange", visible);
        };
        window.addEventListener("online", finish);
        document.addEventListener("visibilitychange", visible);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });
}

export function downloadImageBlob(url: string, signal?: AbortSignal) {
    return readImageResource(url, async (response, progress) => {
        if (!response.body) return response.blob();
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value as Uint8Array<ArrayBuffer>);
                progress();
            }
        } finally {
            reader.releaseLock();
        }
        return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
    }, signal);
}
