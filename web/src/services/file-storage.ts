import localforage from "localforage";
import { nanoid } from "nanoid";
import { recordLocalMediaBlob, removeLocalMediaRecords } from "@/services/media-index";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();
const MEDIA_FETCH_TIMEOUT_MS = 20_000;
let storageOwnerId = "anonymous";

function ownerStorageKey(storageKey: string) {
    return `${storageOwnerId}:${storageKey}`;
}

export function setMediaStorageOwner(ownerId: string | null) {
    const nextOwnerId = ownerId || "anonymous";
    if (nextOwnerId === storageOwnerId) return;
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    storageOwnerId = nextOwnerId;
}

async function fetchBlob(url: string) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`读取媒体失败（${response.status}）`);
        return await response.blob();
    } finally {
        window.clearTimeout(timer);
    }
}

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await fetchBlob(input) : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(ownerStorageKey(storageKey), blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(ownerStorageKey(storageKey), url);
    void recordLocalMediaBlob(storageKey, blob);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const scopedKey = ownerStorageKey(storageKey);
    const cached = objectUrls.get(scopedKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(scopedKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(scopedKey, url);
    void recordLocalMediaBlob(storageKey, blob);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(ownerStorageKey(storageKey));
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    const scopedKey = ownerStorageKey(storageKey);
    await store.setItem(scopedKey, blob);
    const url = URL.createObjectURL(blob);
    const previous = objectUrls.get(scopedKey);
    if (previous) URL.revokeObjectURL(previous);
    objectUrls.set(scopedKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    const unique = Array.from(new Set(keys));
    await Promise.all(
        unique.map(async (key) => {
            const scopedKey = ownerStorageKey(key);
            const url = objectUrls.get(scopedKey);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(scopedKey);
            await store.removeItem(scopedKey);
        }),
    );
    await removeLocalMediaRecords(unique);
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        const prefix = `${storageOwnerId}:`;
        if (key.startsWith(prefix) && !usedKeys.has(key.slice(prefix.length))) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
    const prefix = `${storageOwnerId}:`;
    await removeLocalMediaRecords(unused.map((key) => key.slice(prefix.length)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        let timer: number;
        const done = () => {
            window.clearTimeout(timer);
            resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        };
        timer = window.setTimeout(done, 10_000);
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        let timer: number;
        const done = () => {
            window.clearTimeout(timer);
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        timer = window.setTimeout(done, 10_000);
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
