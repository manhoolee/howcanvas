import localforage from "localforage";

import { nanoid } from "nanoid";
import { dataUrlToBlob, readImageMeta } from "@/lib/image-utils";
import { hashMediaBlob, recordLocalMediaBlob, removeLocalMediaRecords } from "@/services/media-index";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type ServerImageInput = {
    dataUrl: string;
    storageKey?: string;
    bytes?: number;
    mimeType?: string;
    sha256?: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();
const MEDIA_FETCH_TIMEOUT_MS = 20_000;
let storageOwnerId = "anonymous";

function ownerStorageKey(storageKey: string) {
    return `${storageOwnerId}:${storageKey}`;
}

export function setImageStorageOwner(ownerId: string | null) {
    const nextOwnerId = ownerId || "anonymous";
    if (nextOwnerId === storageOwnerId) return;
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    storageOwnerId = nextOwnerId;
}

async function fetchBlob(url: string) {
    if (url.startsWith("data:")) return dataUrlToBlob(url, "image/png");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`读取图片失败（${response.status}）`);
        return await response.blob();
    } finally {
        window.clearTimeout(timer);
    }
}

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await fetchBlob(input) : input;
    const storageKey = `image:${nanoid()}`;
    await store.setItem(ownerStorageKey(storageKey), blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(ownerStorageKey(storageKey), url);
    void recordLocalMediaBlob(storageKey, blob);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

/** Preserve the server-assigned key so cloud sync can HEAD and skip re-upload. */
export async function storeGeneratedImage(input: ServerImageInput): Promise<UploadedImage> {
    if (!input.storageKey) return uploadImage(input.dataUrl);
    const scopedKey = ownerStorageKey(input.storageKey);
    let blob = await store.getItem<Blob>(scopedKey);
    let downloaded = false;
    if (!blob) {
        blob = await fetchBlob(input.dataUrl);
        downloaded = true;
    }
    if (!blob.type.startsWith("image/")) throw new Error("服务器返回的文件不是图片");
    if (typeof input.bytes === "number" && input.bytes !== blob.size) throw new Error("服务器图片大小校验失败");
    if (input.mimeType && blob.type && input.mimeType.toLowerCase() !== blob.type.toLowerCase()) throw new Error("服务器图片类型校验失败");
    if (input.sha256) {
        const actual = await hashMediaBlob(blob);
        if (actual !== input.sha256.toLowerCase()) throw new Error("服务器图片哈希校验失败");
    }
    if (downloaded) await store.setItem(scopedKey, blob);
    const previous = objectUrls.get(scopedKey);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    objectUrls.set(scopedKey, url);
    void recordLocalMediaBlob(input.storageKey, blob);
    const meta = await readImageMeta(url);
    return { url, storageKey: input.storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || input.mimeType || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
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

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(ownerStorageKey(storageKey));
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    const scopedKey = ownerStorageKey(storageKey);
    await store.setItem(scopedKey, blob);
    const url = URL.createObjectURL(blob);
    const previous = objectUrls.get(scopedKey);
    if (previous) URL.revokeObjectURL(previous);
    objectUrls.set(scopedKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchBlob(url));
}

export async function deleteStoredImages(keys: Iterable<string>) {
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

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        const prefix = `${storageOwnerId}:`;
        if (key.startsWith(prefix) && !usedKeys.has(key.slice(prefix.length))) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
    const prefix = `${storageOwnerId}:`;
    await removeLocalMediaRecords(unused.map((key) => key.slice(prefix.length)));
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
