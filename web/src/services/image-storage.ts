import localforage from "localforage";

import { nanoid } from "nanoid";
import { dataUrlToBlob, readImageMeta } from "@/lib/image-utils";
import { hashMediaBlob, markMediaDownloaded, recordLocalMediaBlob, removeLocalMediaRecords } from "@/services/media-index";
import { getAuthEpoch, type ServerMediaIndexEntry } from "@/services/api/backend";
import { downloadImageBlob } from "@/services/api/image-transfer";
import { acknowledgeImageTaskDelivery } from "@/services/api/image-task";

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
    serverTaskId?: string;
    mediaIndex?: ServerMediaIndexEntry;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();
const generatedImageDownloads = new Map<string, Promise<UploadedImage>>();
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
    return downloadImageBlob(url);
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

/** Share in-flight downloads and register server media before canvas autosave. */
export async function storeGeneratedImage(input: ServerImageInput): Promise<UploadedImage> {
    if (!input.storageKey) return uploadImage(input.dataUrl);
    const key = `${getAuthEpoch()}:${ownerStorageKey(input.storageKey)}`;
    const active = generatedImageDownloads.get(key);
    if (active) return active;
    const operation = storeServerImage(input).catch((error) => {
        throw Object.assign(new Error(`原图已保存在服务器，本地取回未完成：${error instanceof Error ? error.message : String(error)}`), { taskStatus: "persisted" });
    }).finally(() => generatedImageDownloads.delete(key));
    generatedImageDownloads.set(key, operation);
    return operation;
}

async function storeServerImage(input: ServerImageInput & { storageKey?: string }): Promise<UploadedImage> {
    const storageKey = input.storageKey!;
    const owner = storageOwnerId;
    const epoch = getAuthEpoch();
    const assertOwner = () => {
        if (storageOwnerId !== owner || getAuthEpoch() !== epoch || (input.mediaIndex && input.mediaIndex.ownerId !== owner)) throw new Error("账号已切换，已取消图片缓存");
    };
    assertOwner();
    const startedAt = performance.now();
    const scopedKey = ownerStorageKey(storageKey);
    let blob = await store.getItem<Blob>(scopedKey);
    let downloaded = false;
    if (!blob) {
        blob = await fetchBlob(input.dataUrl);
        downloaded = true;
    }
    assertOwner();
    const downloadedAt = performance.now();
    if (!blob.type.startsWith("image/")) throw new Error("服务器返回的文件不是图片");
    if (typeof input.bytes === "number" && input.bytes !== blob.size) throw new Error("服务器图片大小校验失败");
    if (input.mimeType && blob.type && input.mimeType.toLowerCase() !== blob.type.toLowerCase()) throw new Error("服务器图片类型校验失败");
    if (input.mediaIndex) {
        await markMediaDownloaded(input.mediaIndex, blob);
    } else if (input.sha256) {
        const actual = await hashMediaBlob(blob);
        if (actual !== input.sha256.toLowerCase()) throw new Error("服务器图片哈希校验失败");
    }
    assertOwner();
    const verifiedAt = performance.now();
    if (downloaded) await store.setItem(scopedKey, blob);
    assertOwner();
    if (input.serverTaskId) void acknowledgeImageTaskDelivery(input.serverTaskId, {
        downloadMs: downloadedAt - startedAt,
        verifyMs: verifiedAt - downloadedAt,
        cacheMs: performance.now() - verifiedAt,
        cacheHit: downloaded ? 0 : 1,
    }, "cached").catch((error) => console.warn("[image-task] cache ACK failed", error));
    const previous = objectUrls.get(scopedKey);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    objectUrls.set(scopedKey, url);
    if (!input.mediaIndex) void recordLocalMediaBlob(storageKey, blob);
    const meta = await readImageMeta(url);
    assertOwner();
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || input.mimeType || meta.mimeType };
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
