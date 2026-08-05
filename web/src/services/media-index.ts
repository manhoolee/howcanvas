import localforage from "localforage";
import { sha256 } from "@noble/hashes/sha256";

import { backend, getAuthEpoch, type MediaScope, type ServerMediaIndexEntry } from "@/services/api/backend";

type LocalMediaFingerprint = {
    ownerId: string;
    storageKey: string;
    bytes: number;
    mimeType: string;
    sha256: string;
    updatedAt: string;
};

type MediaSyncMarker = {
    ownerId: string;
    scope: MediaScope;
    storageKey: string;
    serverSha256: string;
    serverVersion: number;
    serverUpdatedAt: string;
};
type MediaIndexStore = ReturnType<typeof localforage.createInstance>;

export type MediaSyncDecision = "reuse" | "download" | "upload" | "missing";

const serverIndexStores = new Map<string, MediaIndexStore>();
const fingerprintStores = new Map<string, MediaIndexStore>();
const syncMarkerStores = new Map<string, MediaIndexStore>();
let activeOwnerId: string | null = null;
let activeGeneration = 0;
let activeAuthEpoch = 0;
let refreshedOwnerId = "";
let refreshPromise: Promise<ServerMediaIndexEntry[]> | null = null;
const remoteEntries = new Map<string, ServerMediaIndexEntry>();
const localFingerprints = new Map<string, LocalMediaFingerprint>();
const syncMarkers = new Map<string, MediaSyncMarker>();
const fingerprintOperations = new Map<string, Promise<LocalMediaFingerprint>>();

export function setMediaIndexOwner(ownerId: string | null) {
    activeOwnerId = ownerId;
    activeGeneration += 1;
    activeAuthEpoch = getAuthEpoch();
    refreshedOwnerId = "";
    refreshPromise = null;
    remoteEntries.clear();
    localFingerprints.clear();
    syncMarkers.clear();
}

export function getMediaIndexOwner() {
    return activeOwnerId;
}

export async function refreshAccountMediaIndex(ownerId: string) {
    if (ownerId !== activeOwnerId) return [];
    if (refreshPromise) return refreshPromise;
    const generation = activeGeneration;
    const authEpoch = activeAuthEpoch;
    const operation = refreshAccountMediaIndexImpl(ownerId, generation, authEpoch).finally(() => {
        if (refreshPromise === operation) refreshPromise = null;
    });
    refreshPromise = operation;
    return operation;
}

async function refreshAccountMediaIndexImpl(ownerId: string, generation: number, authEpoch: number) {
    const [cachedEntries, fingerprints, markers] = await Promise.all([
        readStore<ServerMediaIndexEntry>(getServerIndexStore(ownerId)),
        readStore<LocalMediaFingerprint>(getFingerprintStore(ownerId)),
        readStore<MediaSyncMarker>(getSyncMarkerStore(ownerId)),
    ]);
    assertCurrent(ownerId, generation, authEpoch);
    replaceMap(remoteEntries, cachedEntries, (entry) => remoteKey(entry.scope, entry.storageKey));
    replaceMap(localFingerprints, fingerprints, (entry) => entry.storageKey);
    replaceMap(syncMarkers, markers, (entry) => remoteKey(entry.scope, entry.storageKey));
    const response = await backend.mediaIndex();
    assertCurrent(ownerId, generation, authEpoch);
    if (response.ownerId !== ownerId) throw new Error("服务器媒体索引账号不匹配");
    replaceMap(remoteEntries, response.entries, (entry) => remoteKey(entry.scope, entry.storageKey));
    const store = getServerIndexStore(ownerId);
    await store.clear();
    await Promise.all(response.entries.map((entry) => store.setItem(remoteKey(entry.scope, entry.storageKey), entry)));
    refreshedOwnerId = ownerId;
    return response.entries;
}

export async function ensureAccountMediaIndex(ownerId: string) {
    if (ownerId !== activeOwnerId) return [];
    if (refreshedOwnerId === ownerId) return [...remoteEntries.values()];
    return refreshAccountMediaIndex(ownerId);
}

export function getRemoteMediaEntry(scope: MediaScope, storageKey: string) {
    return remoteEntries.get(remoteKey(scope, storageKey)) || null;
}

export function workbenchMediaScope(kind: "image" | "video"): MediaScope {
    return `workbench-${kind}`;
}

export function isIndexedMediaCurrent(scope: MediaScope, storageKey: string) {
    const remote = getRemoteMediaEntry(scope, storageKey);
    if (!remote) return false;
    const local = localFingerprints.get(storageKey);
    // 旧缓存没有本地指纹时，以不可变 storageKey 的服务端索引为准，不重新读取大文件。
    return !local || mediaMatches(remote, local);
}

export function canvasMediaUrl(storageKey: string) {
    const entry = getRemoteMediaEntry("canvas", storageKey);
    const query = new URLSearchParams({ owner: activeOwnerId || "", version: String(entry?.version || 1) });
    return `/api/canvas/files/${encodeURIComponent(storageKey)}?${query.toString()}`;
}

export async function recordLocalMediaBlob(storageKey: string, blob: Blob) {
    const ownerId = activeOwnerId;
    if (!ownerId) return null;
    return computeAndStoreFingerprint(ownerId, storageKey, blob);
}

export async function removeLocalMediaRecords(keys: Iterable<string>) {
    const ownerId = activeOwnerId;
    if (!ownerId) return;
    const unique = [...new Set(keys)];
    await Promise.all(unique.map(async (storageKey) => {
        localFingerprints.delete(storageKey);
        await getFingerprintStore(ownerId).removeItem(storageKey);
        for (const scope of ["canvas", "workbench-image", "workbench-video"] as const) {
            const key = remoteKey(scope, storageKey);
            syncMarkers.delete(key);
            await getSyncMarkerStore(ownerId).removeItem(key);
        }
    }));
}

export async function decideMediaSync(scope: MediaScope, storageKey: string, blob: Blob | null): Promise<MediaSyncDecision> {
    const ownerId = activeOwnerId;
    if (!ownerId) return "missing";
    const remote = getRemoteMediaEntry(scope, storageKey);
    if (!remote) return blob ? "upload" : "missing";
    if (!blob) return "download";
    const cachedFingerprint = localFingerprints.get(storageKey);
    if (!cachedFingerprint && blob.size === remote.bytes) {
        // v0.12 首次接管旧缓存时先按不可变 key + 大小复用，SHA-256 在后台补齐，避免打开画布时读取全部大文件。
        void ensureFingerprint(ownerId, storageKey, blob).then((fingerprint) => {
            if (mediaMatches(remote, fingerprint)) return markMediaSynced(remote, fingerprint);
        }).catch(() => undefined);
        return "reuse";
    }
    const fingerprint = await ensureFingerprint(ownerId, storageKey, blob);
    if (mediaMatches(remote, fingerprint)) {
        await markMediaSynced(remote, fingerprint);
        return "reuse";
    }
    const marker = syncMarkers.get(remoteKey(scope, storageKey));
    return marker?.serverSha256 === remote.sha256 && marker.serverVersion === remote.version ? "upload" : "download";
}

export async function markMediaDownloaded(entry: ServerMediaIndexEntry, blob: Blob) {
    const ownerId = activeOwnerId;
    if (!ownerId || entry.ownerId !== ownerId) return;
    const fingerprint = await ensureFingerprint(ownerId, entry.storageKey, blob, true);
    await markMediaSynced(entry, fingerprint);
}

export async function markMediaUploaded(entry: ServerMediaIndexEntry, blob: Blob) {
    const ownerId = activeOwnerId;
    if (!ownerId || entry.ownerId !== ownerId) return;
    remoteEntries.set(remoteKey(entry.scope, entry.storageKey), entry);
    await getServerIndexStore(ownerId).setItem(remoteKey(entry.scope, entry.storageKey), entry);
    const fingerprint = await ensureFingerprint(ownerId, entry.storageKey, blob, true);
    await markMediaSynced(entry, fingerprint);
}

async function markMediaSynced(entry: ServerMediaIndexEntry, fingerprint: LocalMediaFingerprint) {
    const ownerId = activeOwnerId;
    if (!ownerId || entry.ownerId !== ownerId || !mediaMatches(entry, fingerprint)) return;
    const marker: MediaSyncMarker = {
        ownerId,
        scope: entry.scope,
        storageKey: entry.storageKey,
        serverSha256: entry.sha256,
        serverVersion: entry.version,
        serverUpdatedAt: entry.updatedAt,
    };
    const key = remoteKey(entry.scope, entry.storageKey);
    syncMarkers.set(key, marker);
    await getSyncMarkerStore(ownerId).setItem(key, marker);
}

async function ensureFingerprint(ownerId: string, storageKey: string, blob: Blob, force = false) {
    const cached = localFingerprints.get(storageKey);
    if (!force && cached && cached.bytes === blob.size && cached.mimeType === (blob.type || "application/octet-stream") && cached.sha256) return cached;
    return computeAndStoreFingerprint(ownerId, storageKey, blob);
}

async function computeAndStoreFingerprint(ownerId: string, storageKey: string, blob: Blob) {
    const operationKey = `${ownerId}:${storageKey}:${blob.size}:${blob.type}`;
    const active = fingerprintOperations.get(operationKey);
    if (active) return active;
    const operation = (async () => {
        const hash = await hashMediaBlob(blob);
        const fingerprint = { ownerId, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", sha256: hash, updatedAt: new Date().toISOString() };
        if (activeOwnerId === ownerId) localFingerprints.set(storageKey, fingerprint);
        await getFingerprintStore(ownerId).setItem(storageKey, fingerprint);
        return fingerprint;
    })().finally(() => fingerprintOperations.delete(operationKey));
    fingerprintOperations.set(operationKey, operation);
    return operation;
}

export async function hashMediaBlob(blob: Blob) {
    if (globalThis.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return bytesToHex(new Uint8Array(digest));
    }
    const hasher = sha256.create();
    const chunkSize = 2 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
        hasher.update(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()));
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
    return bytesToHex(hasher.digest());
}

function bytesToHex(value: Uint8Array) {
    return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mediaMatches(remote: ServerMediaIndexEntry, local: LocalMediaFingerprint) {
    return remote.bytes === local.bytes && remote.sha256 === local.sha256;
}

function assertCurrent(ownerId: string, generation: number, authEpoch: number) {
    if (ownerId !== activeOwnerId || generation !== activeGeneration || authEpoch !== getAuthEpoch()) throw new Error("账号已切换，已取消媒体索引同步");
}

function getServerIndexStore(ownerId: string) {
    return getStore(serverIndexStores, ownerId, "media_server_index");
}

function getFingerprintStore(ownerId: string) {
    return getStore(fingerprintStores, ownerId, "media_local_fingerprints");
}

function getSyncMarkerStore(ownerId: string) {
    return getStore(syncMarkerStores, ownerId, "media_sync_markers");
}

function getStore(cache: Map<string, MediaIndexStore>, ownerId: string, storeName: string) {
    const key = `${ownerId}:${storeName}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const store = localforage.createInstance({ name: `infinite-canvas-user-${ownerId.replace(/[^a-zA-Z0-9_-]/g, "_")}`, storeName });
    cache.set(key, store);
    return store;
}

async function readStore<T>(store: MediaIndexStore) {
    const values: T[] = [];
    await store.iterate<T, void>((value) => { if (value) values.push(value); });
    return values;
}

function replaceMap<T>(target: Map<string, T>, values: T[], keyOf: (value: T) => string) {
    target.clear();
    values.forEach((value) => target.set(keyOf(value), value));
}

function remoteKey(scope: MediaScope, storageKey: string) {
    return `${scope}:${storageKey}`;
}
