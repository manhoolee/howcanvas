import { create } from "zustand";

import { nanoid } from "nanoid";
import { backend, myAssetFileUrl, type ServerAssetRecord } from "@/services/api/backend";
import { getCurrentUser } from "@/stores/use-auth-store";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    /** 文件夹（用于整理，空为未分类） */
    folder?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
    /** 归属用户 id */
    ownerId?: string;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    loadFromServer: () => Promise<void>;
    clearLocal: () => void;
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

// 旧版（浏览器本地）资产存储 key，仅用于一次性迁移到服务器
const LEGACY_ASSET_STORE_KEY = "infinite-canvas:asset_store";
let assetLoadGeneration = 0;
const ASSET_FETCH_TIMEOUT_MS = 20_000;

async function fetchAssetBlob(url: string) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`读取资产内容失败（${response.status}）`);
        return await response.blob();
    } finally {
        window.clearTimeout(timer);
    }
}

function extFromMime(mime: string, fallback: string): string {
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/webm": "webm",
    };
    return map[(mime || "").toLowerCase()] || fallback;
}

/** 服务器记录 → 前端 Asset（图片/视频内容指向服务器文件地址） */
function mapRecord(record: ServerAssetRecord, ownerId?: string): Asset {
    const base = {
        id: record.id,
        title: record.title,
        tags: record.tags || [],
        source: record.source || undefined,
        note: record.note || undefined,
        folder: record.folder || undefined,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ownerId,
    };
    if (record.kind === "text") {
        return { ...base, kind: "text", coverUrl: record.coverUrl || "", data: { content: record.content || "" } };
    }
    const fileUrl = myAssetFileUrl(record.id);
    const media = { width: record.width || 0, height: record.height || 0, bytes: record.bytes || 0, mimeType: record.mimeType || "" };
    if (record.kind === "video") {
        return { ...base, kind: "video", coverUrl: record.coverUrl || "", data: { url: fileUrl, ...media } };
    }
    return { ...base, kind: "image", coverUrl: record.coverUrl || fileUrl, data: { dataUrl: fileUrl, ...media } };
}

/** 把一个 Asset 内容上传到服务器，返回服务器记录（后台静默执行，失败仅告警） */
async function uploadAssetToServer(asset: Asset): Promise<ServerAssetRecord> {
    const meta = {
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        tags: asset.tags || [],
        note: asset.note,
        source: asset.source,
        folder: asset.folder,
        coverUrl: /^https?:/i.test(asset.coverUrl || "") ? asset.coverUrl : "",
    };
    if (asset.kind === "text") {
        return backend.createMyAsset({ ...meta, ext: "txt" }, new Blob([asset.data.content], { type: "text/plain" }));
    }
    // 画布保存的资产可能只带 storageKey（旧约定：dataUrl 留空，内容存本地媒体库），需先还原
    let url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
    if (!url && asset.data.storageKey) {
        url = asset.kind === "image" ? await resolveImageUrl(asset.data.storageKey, "") : await resolveMediaUrl(asset.data.storageKey, "");
    }
    if (!url) throw new Error("资产内容为空");
    const blob = await fetchAssetBlob(url);
    if (!blob.size) throw new Error("资产内容为空");
    const mime = blob.type || asset.data.mimeType || "";
    const ext = extFromMime(mime, asset.kind === "image" ? "png" : "mp4");
    return backend.createMyAsset({ ...meta, ext, width: asset.data.width, height: asset.data.height }, blob);
}

/** 迁移旧版浏览器资产；只移除服务器已确认存在的本地副本。 */
async function migrateLegacyAssets(existingAssetIds: Set<string>): Promise<Asset[]> {
    try {
        const raw = await localForageStorage.getItem(LEGACY_ASSET_STORE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as { state?: { assets?: Asset[]; [key: string]: unknown }; [key: string]: unknown };
        const storedAssets = Array.isArray(parsed?.state?.assets) ? parsed.state.assets : [];
        const legacy = storedAssets.filter((a) => a?.kind === "text" || a?.kind === "image" || a?.kind === "video");
        if (!legacy.length) return [];
        const migrated: Asset[] = [];
        for (const asset of legacy) {
            try {
                if (existingAssetIds.has(asset.id)) {
                    migrated.push(asset);
                    continue;
                }
                // 旧记录的 blob: 地址已失效，需先经 storageKey 还原
                if (asset.kind === "image" && asset.data.storageKey) asset.data.dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
                if (asset.kind === "video" && asset.data.storageKey) asset.data.url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
                await uploadAssetToServer(asset);
                migrated.push(asset);
            } catch (e) {
                console.warn("[assets] 迁移单个资产失败", asset.id, e);
            }
        }
        const migratedIds = new Set(migrated.map((asset) => asset.id));
        const remainingAssets = storedAssets.filter((asset) => !migratedIds.has(asset?.id));
        if (remainingAssets.length) {
            await localForageStorage.setItem(LEGACY_ASSET_STORE_KEY, JSON.stringify({ ...parsed, state: { ...parsed.state, assets: remainingAssets } }));
        } else {
            await localForageStorage.removeItem(LEGACY_ASSET_STORE_KEY);
        }
        console.info(`[assets] 已迁移 ${migrated.length}/${legacy.length} 个本地资产到服务器`);
        return migrated;
    } catch (e) {
        console.warn("[assets] 本地资产迁移失败", e);
        return [];
    }
}

export const useAssetStore = create<AssetStore>()((set, get) => ({
    hydrated: false,
    assets: [],

    loadFromServer: async () => {
        const generation = ++assetLoadGeneration;
        const ownerId = getCurrentUser()?.id || "";
        try {
            let { assets } = await backend.listMyAssets();
            // 即使服务器已有部分资产，也继续重试上次未成功的迁移项。
            const migrated = await migrateLegacyAssets(new Set(assets.map((asset) => asset.id)));
            if (migrated.length) assets = (await backend.listMyAssets()).assets;
            if (generation !== assetLoadGeneration || getCurrentUser()?.id !== ownerId) return;
            set({ assets: assets.map((record) => mapRecord(record, ownerId)), hydrated: true });
        } catch (e) {
            if (generation !== assetLoadGeneration || getCurrentUser()?.id !== ownerId) return;
            console.error("[assets] 加载服务器资产失败", e);
            set({ hydrated: true });
        }
    },

    clearLocal: () => {
        assetLoadGeneration += 1;
        set({ assets: [], hydrated: false });
    },

    addAsset: (asset) => {
        const now = new Date().toISOString();
        const id = nanoid().replace(/[^a-zA-Z0-9_-]/g, "");
        const ownerId = getCurrentUser()?.id;
        const full = { ...asset, ...(ownerId ? { ownerId } : {}), id, createdAt: now, updatedAt: now } as Asset;
        set((state) => ({ assets: [full, ...state.assets] }));
        // 上传成功后用服务器记录回填本地状态（内容地址指向服务器文件，保证会话内预览/发布可用）
        void uploadAssetToServer(full)
            .then((record) => set((state) => ({ assets: state.assets.map((a) => (a.id === id ? mapRecord(record, ownerId) : a)) })))
            .catch((e) => console.warn("[assets] 同步到服务器失败", e));
        return id;
    },

    updateAsset: (id, patch) => {
        set((state) => ({
            assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
        }));
        const current = get().assets.find((a) => a.id === id);
        if (!current) return;
        const p = patch as Partial<Asset> & { data?: { content?: string; dataUrl?: string; width?: number; height?: number; mimeType?: string } };
        void backend
            .patchMyAsset(id, {
                title: typeof p.title === "string" ? p.title : undefined,
                tags: Array.isArray(p.tags) ? p.tags : undefined,
                note: typeof p.note === "string" ? p.note : undefined,
                source: typeof p.source === "string" ? p.source : undefined,
                folder: typeof p.folder === "string" ? p.folder : undefined,
                coverUrl: typeof p.coverUrl === "string" && /^https?:/i.test(p.coverUrl) ? p.coverUrl : undefined,
                content: current.kind === "text" && typeof p.data?.content === "string" ? p.data.content : undefined,
            })
            .catch((e) => console.warn("[assets] 同步到服务器失败", e));
        // 图片内容被替换（编辑资产重新选图）：重新上传文件
        if (current.kind === "image" && typeof p.data?.dataUrl === "string" && !p.data.dataUrl.startsWith("/api/assets/")) {
            void (async () => {
                const blob = await fetchAssetBlob(p.data!.dataUrl!);
                await backend.putMyAssetFile(id, blob, extFromMime(blob.type || p.data?.mimeType || "", "png"), p.data?.width, p.data?.height);
            })().catch((e) => console.warn("[assets] 更新图片文件失败", e));
        }
    },

    removeAsset: (id) => {
        set((state) => {
            const assets = state.assets.filter((asset) => asset.id !== id);
            get().cleanupImages({ assets });
            return { assets };
        });
        void backend.deleteMyAsset(id).catch((e) => console.warn("[assets] 删除服务器资产失败", e));
    },

    replaceAssets: (assets) => set({ assets }),

    cleanupImages: (extra) => {
        window.setTimeout(async () => {
            const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
            await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
            await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
        }, 0);
    },
}));
