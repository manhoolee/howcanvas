// 与本项目后端（server/）通信的轻量客户端。开发环境通过 Vite 代理 /api → 后端端口。
import type { PermissionKey, Pricing } from "@/constant/permissions";

const TOKEN_KEY = "infinite-canvas:auth_token";
let volatileToken = "";
let authEpoch = 0;

export function getToken(): string {
    return volatileToken;
}
export function setToken(token: string) {
    volatileToken = token;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 清理旧版 Token */ }
}

export function bumpAuthEpoch() {
    authEpoch += 1;
}

export function getAuthEpoch() {
    return authEpoch;
}

function notifyAuthExpired(response: Response, requestEpoch: number) {
    if (response.status === 401 && typeof window !== "undefined") {
        const code = response.headers.get("X-Auth-Error") || "AUTH_EXPIRED";
        window.dispatchEvent(new CustomEvent("infinite-canvas:auth-expired", { detail: { epoch: requestEpoch, code } }));
    }
}

export type ServerUser = {
    id: string;
    username: string;
    displayName: string;
    role: "admin" | "user";
    permissions: PermissionKey[];
    credits: number;
    status: "active" | "disabled";
    createdAt: string;
    usage: { image: number; video: number; audio: number; text: number; creditsSpent: number };
};

export type ServerSettings = {
    pricing: Pricing;
    defaultPermissions: PermissionKey[];
    defaultCredits: number;
    /** 按具体模型定价（优先于按类型单价） */
    modelPricing: Record<string, number>;
    /** 各能力默认模型（"渠道id::模型名"） */
    defaultModels: Record<"image" | "video" | "audio" | "text", string>;
    agentLlm: ServerAgentLlmConfig;
};

export type AgentSkillId = "image-creation" | "video-creation" | "canvas-orchestration" | "quality-review";
export type ServerAgentLlmConfig = { enabled: boolean; model: string; skills: AgentSkillId[] };
export type ServerCanvasProject = Record<string, unknown> & { id: string; ownerId?: string; updatedAt?: string };
export type MediaScope = "canvas" | "workbench-image" | "workbench-video";
export type ServerMediaIndexEntry = {
    ownerId: string;
    scope: MediaScope;
    storageKey: string;
    bytes: number;
    mimeType: string;
    sha256: string;
    updatedAt: string;
    version: number;
};

// 服务器上的个人资产记录（文本内容内联，图片/视频为文件）
export type ServerAssetRecord = {
    id: string;
    kind: "text" | "image" | "video";
    title: string;
    tags: string[];
    note: string;
    source: string;
    folder?: string;
    coverUrl: string;
    content?: string;
    filename?: string;
    mimeType?: string;
    bytes?: number;
    width?: number;
    height?: number;
    createdAt: string;
    updatedAt: string;
};

/** 个人资产文件地址；同源媒体请求会自动携带 HttpOnly 会话 Cookie。 */
export function myAssetFileUrl(id: string): string {
    return `/api/assets/${id}/file`;
}

export type PublicAsset = {
    id: string;
    title: string;
    kind: "text" | "image" | "video";
    filename: string;
    mimeType: string;
    bytes: number;
    tags: string[];
    note: string;
    folder?: string;
    uploadedBy: string;
    uploadedByName: string;
    uploadedAt: string;
};

export function publicAssetFileUrl(asset: PublicAsset): string {
    return `/api/public-assets/${asset.id}/file`;
}

// 注意：服务器绝不下发 API Key / Base URL，前端一律通过 /api/ai/<渠道id> 代理调用。
export type ServerChannelModel = { name: string; capability: "image" | "video" | "audio" | "text" };
export type ServerAiConfig = {
    channels: { id: string; name: string; apiFormat: string; models: ServerChannelModel[] }[];
    defaultModels: Record<"image" | "video" | "audio" | "text", string>;
    agentLlm: ServerAgentLlmConfig;
};
export type AdminAiChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini" | "grok-video-v2";
    models: ServerChannelModel[];
    hasKey: boolean;
    apiKeyMasked: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init?.body && typeof init.body === "string") headers["Content-Type"] = "application/json";
    const requestEpoch = authEpoch;
    const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
    notifyAuthExpired(res, requestEpoch);
    const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
    return data;
}

export const backend = {
    authConfig: () => request<{ registrationEnabled: boolean }>("/api/auth/config"),
    register: (input: { username: string; password: string; displayName?: string }) =>
        request<{ token?: string; user: ServerUser }>("/api/auth/register", { method: "POST", body: JSON.stringify(input) }),
    login: (input: { username: string; password: string }) =>
        request<{ token?: string; user: ServerUser }>("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
    me: () => request<{ user: ServerUser }>("/api/auth/me"),
    logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

    aiConfig: () => request<ServerAiConfig>("/api/config/ai"),
    canvasMeta: () => request<{ updatedAt: string; projectCount: number }>("/api/canvas/meta"),
    canvasProjects: () => request<{ updatedAt: string; projects: ServerCanvasProject[] }>("/api/canvas"),
    saveCanvas: (projects: ServerCanvasProject[], baseUpdatedAt?: string) => request<{ ok: boolean; updatedAt: string; projectCount: number }>("/api/canvas", { method: "PUT", body: JSON.stringify({ projects, baseUpdatedAt: baseUpdatedAt || "" }) }),
    mediaIndex: () => request<{ ownerId: string; updatedAt: string; entries: ServerMediaIndexEntry[] }>("/api/media-index"),
    uploadCanvasFile: async (storageKey: string, data: Blob) => {
        const token = getToken();
        const requestEpoch = authEpoch;
        const res = await fetch(`/api/canvas/files/${encodeURIComponent(storageKey)}`, { method: "PUT", headers: { Authorization: token ? `Bearer ${token}` : "" }, credentials: "same-origin", body: data });
        notifyAuthExpired(res, requestEpoch);
        const payload = (await res.json().catch(() => ({}))) as { media?: ServerMediaIndexEntry };
        if (!res.ok || !payload.media) throw new Error(`画布媒体上传失败（${res.status}）`);
        return payload.media;
    },
    downloadCanvasFile: async (storageKey: string, indexedUrl?: string) => {
        const token = getToken();
        const requestEpoch = authEpoch;
        const res = await fetch(indexedUrl || `/api/canvas/files/${encodeURIComponent(storageKey)}`, { headers: { Authorization: token ? `Bearer ${token}` : "" }, credentials: "same-origin" });
        notifyAuthExpired(res, requestEpoch);
        if (!res.ok) return null;
        return res.blob();
    },
    workbenchLogs: (kind: "image" | "video") => request<{ updatedAt: string; logs: Record<string, unknown>[] }>(`/api/workbench/${kind}`),
    saveWorkbenchLogs: (kind: "image" | "video", logs: Record<string, unknown>[]) => request<{ ok: boolean; updatedAt: string; count: number }>(`/api/workbench/${kind}`, { method: "PUT", body: JSON.stringify({ logs }) }),
    workbenchFileMeta: async (kind: "image" | "video", storageKey: string) => {
        const requestEpoch = authEpoch;
        const res = await fetch(`/api/workbench/${kind}/files/${encodeURIComponent(storageKey)}`, { method: "HEAD", headers: { Authorization: getToken() ? `Bearer ${getToken()}` : "" }, credentials: "same-origin" });
        notifyAuthExpired(res, requestEpoch);
        if (!res.ok) return null;
        return { size: Number(res.headers.get("Content-Length") || 0), sha256: res.headers.get("X-File-Sha256") || res.headers.get("ETag")?.replace(/^\"|\"$/g, "") || "" };
    },
    uploadWorkbenchFile: async (kind: "image" | "video", storageKey: string, data: Blob, sha256?: string) => {
        const requestEpoch = authEpoch;
        const res = await fetch(`/api/workbench/${kind}/files/${encodeURIComponent(storageKey)}`, { method: "PUT", headers: { Authorization: getToken() ? `Bearer ${getToken()}` : "", "Content-Type": data.type || "application/octet-stream", ...(sha256 ? { "X-Content-SHA256": sha256 } : {}) }, credentials: "same-origin", body: data });
        notifyAuthExpired(res, requestEpoch);
        const payload = (await res.json().catch(() => ({}))) as { media?: ServerMediaIndexEntry };
        if (!res.ok || !payload.media) throw new Error(`工作台媒体上传失败（${res.status}）`);
        return payload.media;
    },
    downloadWorkbenchFile: async (kind: "image" | "video", storageKey: string) => {
        const requestEpoch = authEpoch;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 20_000);
        try {
            const res = await fetch(`/api/workbench/${kind}/files/${encodeURIComponent(storageKey)}`, { headers: { Authorization: getToken() ? `Bearer ${getToken()}` : "" }, credentials: "same-origin", signal: controller.signal });
            notifyAuthExpired(res, requestEpoch);
            if (!res.ok) return null;
            return res.blob();
        } finally {
            window.clearTimeout(timer);
        }
    },

    adminChannels: () => request<{ channels: AdminAiChannel[] }>("/api/admin/channels"),
    adminCreateChannel: (input: { name: string; baseUrl: string; apiKey: string; apiFormat: string; models: ServerChannelModel[] }) =>
        request<{ channel: AdminAiChannel }>("/api/admin/channels", { method: "POST", body: JSON.stringify(input) }),
    adminPatchChannel: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; apiFormat?: string; models?: ServerChannelModel[] }) =>
        request<{ channel: AdminAiChannel }>(`/api/admin/channels/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    adminDeleteChannel: (id: string) => request<{ ok: boolean }>(`/api/admin/channels/${id}`, { method: "DELETE" }),

    charge: (kind: string, model?: string) => request<{ receiptId: string; user: ServerUser }>("/api/billing/charge", { method: "POST", body: JSON.stringify({ kind, model: model || "" }) }),
    refund: (receiptId: string) => request<{ user: ServerUser }>("/api/billing/refund", { method: "POST", body: JSON.stringify({ receiptId }) }),

    adminUsers: () => request<{ users: ServerUser[] }>("/api/admin/users"),
    adminCreateUser: (input: { username: string; password: string; displayName?: string; role?: "admin" | "user"; permissions?: PermissionKey[]; credits?: number }) =>
        request<{ user: ServerUser }>("/api/admin/users", { method: "POST", body: JSON.stringify(input) }),
    adminPatchUser: (id: string, patch: { permissions?: PermissionKey[]; role?: string; status?: string; addCredits?: number; password?: string }) =>
        request<{ user: ServerUser }>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    adminDeleteUser: (id: string) => request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
    adminSettings: () => request<{ settings: ServerSettings }>("/api/admin/settings"),
    adminSaveSettings: (patch: Partial<ServerSettings>) => request<{ settings: ServerSettings }>("/api/admin/settings", { method: "PUT", body: JSON.stringify(patch) }),

    // 个人资产（跟账号走，服务器按用户隔离存储）
    listMyAssets: () => request<{ assets: ServerAssetRecord[] }>("/api/assets"),
    async createMyAsset(meta: { id: string; kind: "text" | "image" | "video"; title: string; tags: string[]; note?: string; source?: string; folder?: string; coverUrl?: string; ext?: string; width?: number; height?: number }, data: Blob | ArrayBuffer): Promise<ServerAssetRecord> {
        const params = new URLSearchParams({
            id: meta.id,
            kind: meta.kind,
            title: meta.title,
            tags: meta.tags.join(","),
            note: meta.note || "",
            source: meta.source || "",
            folder: meta.folder || "",
            coverUrl: meta.coverUrl || "",
            ext: meta.ext || "bin",
            width: String(meta.width || 0),
            height: String(meta.height || 0),
        });
        const requestEpoch = authEpoch;
        const res = await fetch(`/api/assets?${params}`, {
            method: "POST",
            headers: { Authorization: getToken() ? `Bearer ${getToken()}` : "", "Content-Type": "application/octet-stream" },
            credentials: "same-origin",
            body: data,
        });
        notifyAuthExpired(res, requestEpoch);
        const payload = (await res.json().catch(() => ({}))) as { error?: string; asset?: ServerAssetRecord };
        if (!res.ok || !payload.asset) throw new Error(payload?.error || `保存失败（${res.status}）`);
        return payload.asset;
    },
    patchMyAsset: (id: string, patch: { title?: string; tags?: string[]; note?: string; source?: string; folder?: string; coverUrl?: string; content?: string }) =>
        request<{ asset: ServerAssetRecord }>(`/api/assets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    async putMyAssetFile(id: string, data: Blob, ext: string, width?: number, height?: number): Promise<void> {
        const params = new URLSearchParams({ ext, width: String(width || 0), height: String(height || 0) });
        const requestEpoch = authEpoch;
        const res = await fetch(`/api/assets/${id}/file?${params}`, {
            method: "PUT",
            headers: { Authorization: getToken() ? `Bearer ${getToken()}` : "", "Content-Type": "application/octet-stream" },
            credentials: "same-origin",
            body: data,
        });
        notifyAuthExpired(res, requestEpoch);
        if (!res.ok) throw new Error(`更新文件失败（${res.status}）`);
    },
    deleteMyAsset: (id: string) => request<{ ok: boolean }>(`/api/assets/${id}`, { method: "DELETE" }),

    publicAssets: () => request<{ assets: PublicAsset[] }>("/api/public-assets"),
    adminPatchPublicAsset: (id: string, patch: { folder?: string; title?: string }) => request<{ asset: PublicAsset }>(`/api/public-assets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deletePublicAsset: (id: string) => request<{ ok: boolean }>(`/api/public-assets/${id}`, { method: "DELETE" }),
    async publishPublicAsset(meta: { kind: "text" | "image" | "video"; title: string; tags: string[]; note?: string; folder?: string; ext: string }, data: Blob | ArrayBuffer): Promise<PublicAsset> {
        const params = new URLSearchParams({
            kind: meta.kind,
            title: meta.title,
            tags: meta.tags.join(","),
            note: meta.note || "",
            folder: meta.folder || "",
            ext: meta.ext,
        });
        const requestEpoch = authEpoch;
        const res = await fetch(`/api/public-assets?${params}`, {
            method: "POST",
            headers: { Authorization: getToken() ? `Bearer ${getToken()}` : "", "Content-Type": "application/octet-stream" },
            credentials: "same-origin",
            body: data,
        });
        notifyAuthExpired(res, requestEpoch);
        const payload = (await res.json().catch(() => ({}))) as { error?: string; asset?: PublicAsset };
        if (!res.ok || !payload.asset) throw new Error(payload?.error || `发布失败（${res.status}）`);
        return payload.asset;
    },

    async uploadFile(kind: "image" | "video" | "audio" | "text", data: Blob | ArrayBuffer, ext: string): Promise<void> {
        const requestEpoch = authEpoch;
        const res = await fetch(`/api/files/upload?kind=${kind}&ext=${encodeURIComponent(ext)}`, {
            method: "POST",
            headers: { Authorization: getToken() ? `Bearer ${getToken()}` : "", "Content-Type": "application/octet-stream" },
            credentials: "same-origin",
            body: data,
        });
        notifyAuthExpired(res, requestEpoch);
        if (!res.ok) throw new Error(`文件上传失败（${res.status}）`);
    },
};
