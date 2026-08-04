import localforage from "localforage";

import { backend, getAuthEpoch } from "@/services/api/backend";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { decideMediaSync, ensureAccountMediaIndex, getRemoteMediaEntry, markMediaDownloaded, markMediaUploaded, workbenchMediaScope } from "@/services/media-index";

export type WorkbenchKind = "image" | "video";
export type WorkbenchLogStore = ReturnType<typeof localforage.createInstance>;
const logStores = new Map<string, WorkbenchLogStore>();
const mediaQueueStores = new Map<string, WorkbenchLogStore>();
const activeSyncs = new Map<string, Promise<Record<string, unknown>[]>>();
const activeMediaSyncs = new Map<string, Promise<void>>();
const MEDIA_SYNC_CONCURRENCY = 3;
let activeOwnerId: string | null = null;

export function setWorkbenchOwner(ownerId: string | null) {
    activeOwnerId = ownerId;
}

export function getWorkbenchLogStore(kind: WorkbenchKind, ownerId: string): WorkbenchLogStore {
    const key = scopedKey(ownerId, kind);
    const existing = logStores.get(key);
    if (existing) return existing;
    const store = localforage.createInstance({ name: scopedDatabaseName(ownerId), storeName: `${kind}_generation_logs` });
    logStores.set(key, store);
    return store;
}

export async function syncAllWorkbenchLogs(ownerId: string, kinds: WorkbenchKind[] = ["image", "video"]) {
    await Promise.all(kinds.map((kind) => syncWorkbenchLogs(kind, ownerId)));
}

export async function syncWorkbenchLogs(kind: WorkbenchKind, ownerId: string, store = getWorkbenchLogStore(kind, ownerId), commitLocal = false): Promise<Record<string, unknown>[]> {
    const key = `${scopedKey(ownerId, kind)}:${commitLocal ? "commit" : "pull"}`;
    const active = activeSyncs.get(key);
    if (active) return active;
    const sync = syncWorkbenchLogsImpl(kind, ownerId, store, commitLocal).finally(() => activeSyncs.delete(key));
    activeSyncs.set(key, sync);
    return sync;
}

async function syncWorkbenchLogsImpl(kind: WorkbenchKind, ownerId: string, store: WorkbenchLogStore, commitLocal: boolean): Promise<Record<string, unknown>[]> {
    const authEpoch = getAuthEpoch();
    assertCurrentAccount(ownerId, authEpoch);
    const local = await readLogs(store);
    assertCurrentAccount(ownerId, authEpoch);
    const remote = await backend.workbenchLogs(kind);
    assertCurrentAccount(ownerId, authEpoch);
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of remote.logs) if (typeof item.id === "string") byId.set(item.id, item);
    if (commitLocal) for (const item of local) if (typeof item.id === "string") {
        const previous = byId.get(item.id);
        const localTime = recordTimestamp(item);
        const remoteTime = previous ? recordTimestamp(previous) : 0;
        if (!previous || localTime > remoteTime) byId.set(item.id, { ...item, updatedAt: localTime || Date.now() });
    }
    const merged = [...byId.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 500);
    // 记录列表不等待图片文件下载；先让服务器确认合并结果，再用确认后的列表
    // 校正当前账号本地缓存。图片资源的下载、补传和缺失清理在后台继续执行。
    let confirmed = remote;
    if (commitLocal && JSON.stringify(remote.logs) !== JSON.stringify(merged)) {
        assertCurrentAccount(ownerId, authEpoch);
        await backend.saveWorkbenchLogs(kind, merged);
        assertCurrentAccount(ownerId, authEpoch);
        confirmed = await backend.workbenchLogs(kind);
    }
    assertCurrentAccount(ownerId, authEpoch);
    const reconciled = await replaceConfirmedLogs(store, confirmed.logs, local);
    void syncWorkbenchMedia(kind, ownerId, store, confirmed.logs).catch((error) => {
        console.warn(`[workbench:${kind}] 媒体资源后台同步失败`, error);
    });
    return reconciled;
}

export async function syncWorkbenchMedia(kind: WorkbenchKind, ownerId: string, store = getWorkbenchLogStore(kind, ownerId), records?: Record<string, unknown>[]) {
    const key = scopedKey(ownerId, kind);
    const active = activeMediaSyncs.get(key);
    if (active) return active;
    const sync = hydrateWorkbenchMedia(kind, ownerId, store, records).finally(() => activeMediaSyncs.delete(key));
    activeMediaSyncs.set(key, sync);
    return sync;
}

async function hydrateWorkbenchMedia(kind: WorkbenchKind, ownerId: string, store: WorkbenchLogStore, records?: Record<string, unknown>[]) {
    const authEpoch = getAuthEpoch();
    await ensureAccountMediaIndex(ownerId);
    assertCurrentAccount(ownerId, authEpoch);
    const merged = records || await readLogs(store);
    const missingStorageKeys = new Set<string>();
    const allowedStorageKeys = new Set<string>();
    const tasks: MediaSyncTask[] = [];
    const ordered = [...merged].sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
    for (const log of ordered) for (const storageKey of collectStorageKeys(log)) {
        allowedStorageKeys.add(storageKey);
        const localBlob = kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        const decision = await decideMediaSync(workbenchMediaScope(kind), storageKey, localBlob);
        if (decision === "missing") missingStorageKeys.add(storageKey);
        else if (decision !== "reuse") tasks.push({ kind, storageKey, direction: decision });
    }
    const queueStore = getMediaQueueStore(ownerId);
    const queuedTasks = await readQueuedTasks(kind, queueStore, allowedStorageKeys);
    const uniqueTasks = [...new Map([...queuedTasks, ...tasks].map((task) => [`${task.kind}:${task.storageKey}`, task])).values()];
    await enqueueMediaTasks(uniqueTasks, queueStore);
    await runMediaTasks(uniqueTasks, missingStorageKeys, ownerId, authEpoch, queueStore);
    const cleaned = merged.map((log) => removeMissingStorageKeys(log, missingStorageKeys));
    if (missingStorageKeys.size > 0) {
        await Promise.all(cleaned.map((log) => store.setItem(String(log.id), log)));
        // 只有确认媒体确实不存在时才同步清理记录，网络超时不会误删 storageKey。
        if (JSON.stringify(merged) !== JSON.stringify(cleaned)) {
            assertCurrentAccount(ownerId, authEpoch);
            await backend.saveWorkbenchLogs(kind, cleaned);
        }
    }
}

type MediaSyncTask = { kind: WorkbenchKind; storageKey: string; direction: "upload" | "download" };

async function enqueueMediaTasks(tasks: MediaSyncTask[], queueStore: WorkbenchLogStore) {
    await Promise.all(tasks.map((task) => queueStore.setItem(`${task.kind}:${task.storageKey}`, { ...task, queuedAt: Date.now() })));
}

async function readQueuedTasks(kind: WorkbenchKind, queueStore: WorkbenchLogStore, allowedStorageKeys: Set<string>) {
    const tasks: MediaSyncTask[] = [];
    const staleTaskKeys: string[] = [];
    await queueStore.iterate<MediaSyncTask, void>((value, key) => {
        if (value?.kind !== kind || typeof value.storageKey !== "string") return;
        if (!allowedStorageKeys.has(value.storageKey)) {
            staleTaskKeys.push(key);
            return;
        }
        if (value.direction === "upload" || value.direction === "download") tasks.push(value);
    });
    await Promise.all(staleTaskKeys.map((key) => queueStore.removeItem(key)));
    return tasks;
}

async function runMediaTasks(tasks: MediaSyncTask[], missingStorageKeys: Set<string>, ownerId: string, authEpoch: number, queueStore: WorkbenchLogStore) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(MEDIA_SYNC_CONCURRENCY, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const task = tasks[cursor++];
            try {
                assertCurrentAccount(ownerId, authEpoch);
                const blob = task.kind === "image" ? await getImageBlob(task.storageKey) : await getMediaBlob(task.storageKey);
                const scope = workbenchMediaScope(task.kind);
                const decision = await decideMediaSync(scope, task.storageKey, blob);
                if (decision === "missing") {
                    missingStorageKeys.add(task.storageKey);
                    continue;
                }
                if (decision === "reuse") {
                    await queueStore.removeItem(`${task.kind}:${task.storageKey}`);
                    continue;
                }
                if (decision === "download") {
                    const indexed = getRemoteMediaEntry(scope, task.storageKey);
                    if (!indexed) {
                        missingStorageKeys.add(task.storageKey);
                        continue;
                    }
                    const remoteBlob = await backend.downloadWorkbenchFile(task.kind, task.storageKey);
                    if (!remoteBlob) {
                        missingStorageKeys.add(task.storageKey);
                        continue;
                    }
                    assertCurrentAccount(ownerId, authEpoch);
                    if (task.kind === "image") await setImageBlob(task.storageKey, remoteBlob);
                    else await setMediaBlob(task.storageKey, remoteBlob);
                    await markMediaDownloaded(indexed, remoteBlob);
                } else {
                    if (!blob) continue;
                    const indexed = await backend.uploadWorkbenchFile(task.kind, task.storageKey, blob);
                    await markMediaUploaded(indexed, blob);
                }
                await queueStore.removeItem(`${task.kind}:${task.storageKey}`);
            } catch {
                // 保留队列项，下一次打开工作台或生成任务完成后继续重试。
            }
        }
    }));
}

function getMediaQueueStore(ownerId: string): WorkbenchLogStore {
    const existing = mediaQueueStores.get(ownerId);
    if (existing) return existing;
    const store = localforage.createInstance({ name: scopedDatabaseName(ownerId), storeName: "workbench_media_sync_queue" });
    mediaQueueStores.set(ownerId, store);
    return store;
}

function scopedDatabaseName(ownerId: string) {
    return `infinite-canvas-user-${ownerId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function scopedKey(ownerId: string, kind: WorkbenchKind) {
    return `${ownerId}:${kind}`;
}

function assertCurrentAccount(ownerId: string, authEpoch: number) {
    if (activeOwnerId !== ownerId || getAuthEpoch() !== authEpoch) throw new Error(`账号已切换，已取消 ${ownerId} 的工作台同步`);
}

function recordTimestamp(record: Record<string, unknown>) {
    const value = record.updatedAt ?? record.createdAt;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

async function readLogs(store: WorkbenchLogStore) {
    const logs: Record<string, unknown>[] = [];
    await store.iterate<Record<string, unknown>, void>((value: Record<string, unknown>) => { if (value && typeof value === "object") logs.push(value); });
    return logs;
}

async function replaceConfirmedLogs(store: WorkbenchLogStore, logs: Record<string, unknown>[], initialLocal: Record<string, unknown>[]) {
    const initialById = new Map(initialLocal.flatMap((log) => typeof log.id === "string" && log.id ? [[log.id, JSON.stringify(log)] as const] : []));
    const reconciled = new Map(logs.flatMap((log) => typeof log.id === "string" && log.id ? [[log.id, log] as const] : []));
    // 同步请求进行期间可能刚好完成一项生成任务。只保留相对初始快照新增或
    // 已更新的本地记录，避免服务器校正缓存时误删这类并发写入。
    for (const log of await readLogs(store)) {
        if (typeof log.id !== "string" || !log.id || initialById.get(log.id) === JSON.stringify(log)) continue;
        const confirmed = reconciled.get(log.id);
        if (!confirmed || recordTimestamp(log) > recordTimestamp(confirmed)) reconciled.set(log.id, log);
    }
    await store.clear();
    await Promise.all([...reconciled].map(([id, log]) => store.setItem(id, log)));
    return [...reconciled.values()];
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && /^(image|video|audio|file|video-reference|audio-reference):/.test(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return keys;
}

function removeMissingStorageKeys(value: Record<string, unknown>, missing: Set<string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === "storageKey" && typeof item === "string" && missing.has(item)) continue;
        if ((key === "dataUrl" || key === "url") && typeof value.storageKey === "string" && missing.has(value.storageKey)) continue;
        if (Array.isArray(item)) {
            result[key] = item
                .filter((child) => !(child && typeof child === "object" && "storageKey" in child && typeof child.storageKey === "string" && missing.has(child.storageKey)))
                .map((child) => child && typeof child === "object" ? removeMissingStorageKeys(child as Record<string, unknown>, missing) : child);
        } else if (item && typeof item === "object") {
            result[key] = removeMissingStorageKeys(item as Record<string, unknown>, missing);
        } else {
            result[key] = item;
        }
    }
    return result;
}
