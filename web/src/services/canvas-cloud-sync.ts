import { backend, type ServerCanvasProject } from "@/services/api/backend";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { decideMediaSync, getRemoteMediaEntry, isIndexedMediaCurrent, markMediaDownloaded, markMediaUploaded } from "@/services/media-index";

let unsubscribe: (() => void) | null = null;
let activeOwnerId = "";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let saveInFlight: Promise<void> | null = null;
let applyingServer = false;
let syncGeneration = 0;
let onlineListenerAttached = false;
let uploadedCanvasFilesOwner = "";
const uploadedCanvasFiles = new Set<string>();

/**
 * 服务器是画布主数据，localForage 只保存当前账户的缓存和最近一次服务器版本。
 * 登录时先比较版本号，版本一致不下载完整项目；本地变化则自动保存到服务器。
 */
export async function syncCanvasOwner(ownerId: string | null) {
    const generation = ++syncGeneration;
    if (activeOwnerId && activeOwnerId !== ownerId) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        clearRetry();
    }
    if (!ownerId) {
        activeOwnerId = "";
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        clearRetry();
        uploadedCanvasFilesOwner = "";
        uploadedCanvasFiles.clear();
        useCanvasStore.getState().setOwner(null);
        return;
    }

    activeOwnerId = ownerId;
    if (uploadedCanvasFilesOwner !== ownerId) {
        uploadedCanvasFilesOwner = ownerId;
        uploadedCanvasFiles.clear();
    }
    await waitForHydration();
    if (!isCurrent(ownerId, generation)) return;
    applyingServer = true;
    useCanvasStore.getState().setOwner(ownerId);
    applyingServer = false;

    try {
        const local = useCanvasStore.getState();
        const meta = await backend.canvasMeta();
        if (!isCurrent(ownerId, generation)) return;
        if (local.serverUpdatedAt && local.serverUpdatedAt === meta.updatedAt) {
            startAutoSave();
            return;
        }

        if (meta.updatedAt) {
            const remote = await backend.canvasProjects();
            if (!isCurrent(ownerId, generation)) return;
            applyingServer = true;
            useCanvasStore.getState().replaceServerProjects(remote.projects as CanvasProject[], remote.updatedAt);
            applyingServer = false;
        } else {
            // 首次迁移旧浏览器缓存：服务器没有数据时上传一次，避免历史画布丢失。
            await saveCurrentCanvas(ownerId, generation);
        }
    } catch (error) {
        applyingServer = false;
        console.error("[canvas] 账户画布同步失败", error);
        scheduleRetry(ownerId, generation);
    }
    if (isCurrent(ownerId, generation)) startAutoSave();
}

function startAutoSave() {
    if (unsubscribe) return;
    attachOnlineListener();
    unsubscribe = useCanvasStore.subscribe((state, previous) => {
        if (applyingServer || !activeOwnerId || state.ownerId !== activeOwnerId || state.allProjects === previous.allProjects) return;
        if (saveTimer) clearTimeout(saveTimer);
        const ownerId = state.ownerId;
        const generation = syncGeneration;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void saveCurrentCanvas(ownerId, generation);
        }, 800);
    });
}

async function saveCurrentCanvas(ownerId = activeOwnerId, generation = syncGeneration) {
    if (saveInFlight) return saveInFlight;
    const operation = saveCurrentCanvasImpl(ownerId, generation);
    const tracked = operation.finally(() => {
        if (saveInFlight === tracked) saveInFlight = null;
    });
    saveInFlight = tracked;
    return tracked;
}

async function saveCurrentCanvasImpl(ownerId: string, generation: number) {
    const state = useCanvasStore.getState();
    if (!state.ownerId || state.ownerId !== ownerId || !isCurrent(ownerId, generation)) return;
    try {
        await uploadCanvasFiles(state.projects, ownerId, generation);
        if (!isCurrent(ownerId, generation)) return;
        const result = await backend.saveCanvas(state.projects as ServerCanvasProject[], state.serverUpdatedAt);
        if (!isCurrent(ownerId, generation)) return;
        useCanvasStore.getState().setServerUpdatedAt(result.updatedAt);
        retryAttempt = 0;
        clearRetry();
    } catch (error) {
        // 版本冲突时服务器数据优先，避免多设备互相覆盖。
        try {
            if (!isCurrent(ownerId, generation)) return;
            const remote = await backend.canvasProjects();
            if (!isCurrent(ownerId, generation)) return;
            applyingServer = true;
            useCanvasStore.getState().replaceServerProjects(remote.projects as CanvasProject[], remote.updatedAt);
            applyingServer = false;
        } catch (remoteError) {
            applyingServer = false;
            scheduleRetry(ownerId, generation);
            console.error("[canvas] 保存失败，远端恢复也失败", error, remoteError);
        }
    }
}

function scheduleRetry(ownerId: string, generation: number) {
    if (!isCurrent(ownerId, generation) || retryTimer) return;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(retryAttempt, 5));
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void saveCurrentCanvas(ownerId, generation);
    }, delay);
}

function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
}

function attachOnlineListener() {
    if (onlineListenerAttached || typeof window === "undefined") return;
    window.addEventListener("online", () => {
        if (!activeOwnerId || retryTimer) return;
        void saveCurrentCanvas(activeOwnerId, syncGeneration);
    });
    onlineListenerAttached = true;
}

function isCurrent(ownerId: string, generation: number) {
    return syncGeneration === generation && activeOwnerId === ownerId;
}

async function uploadCanvasFiles(projects: CanvasProject[], ownerId: string, generation: number) {
    const keys = collectStorageKeys(projects);
    await Promise.all(Array.from(keys).map(async (storageKey) => {
        if (uploadedCanvasFilesOwner === ownerId && uploadedCanvasFiles.has(storageKey)) return;
        if (isIndexedMediaCurrent("canvas", storageKey)) {
            if (uploadedCanvasFilesOwner === ownerId) uploadedCanvasFiles.add(storageKey);
            return;
        }
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        const decision = await decideMediaSync("canvas", storageKey, blob);
        if (decision === "upload" && blob) {
            const media = await backend.uploadCanvasFile(storageKey, blob);
            await markMediaUploaded(media, blob);
        } else if (decision === "download") {
            const remote = await backend.downloadCanvasFile(storageKey);
            if (remote && isCurrent(ownerId, generation)) {
                if (storageKey.startsWith("image:")) await setImageBlob(storageKey, remote);
                else await setMediaBlob(storageKey, remote);
                const indexed = getRemoteMediaEntry("canvas", storageKey);
                if (indexed) await markMediaDownloaded(indexed, remote);
            }
        }
        if (decision !== "missing" && uploadedCanvasFilesOwner === ownerId) uploadedCanvasFiles.add(storageKey);
    }));
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && /^(image|video|audio|file|video-reference|audio-reference):/.test(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return keys;
}

async function waitForHydration() {
    if (useCanvasStore.getState().hydrated) return;
    await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            if (!useCanvasStore.getState().hydrated) return;
            clearInterval(timer);
            resolve();
        }, 20);
        setTimeout(() => {
            clearInterval(timer);
            resolve();
        }, 5000);
    });
}
