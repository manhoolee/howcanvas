import { create } from "zustand";

import { backend, bumpAuthEpoch, getAuthEpoch, setToken, type ServerUser } from "@/services/api/backend";
import { applyServerAiConfig } from "@/lib/server-ai-config";
import { DEFAULT_PRICING, DEFAULT_USER_PERMISSIONS, type PermissionKey, type Pricing } from "@/constant/permissions";
import { setImageStorageOwner } from "@/services/image-storage";
import { setMediaStorageOwner } from "@/services/file-storage";
import { setWorkbenchOwner } from "@/services/workbench-cloud-sync";
import { refreshAccountMediaIndex, setMediaIndexOwner } from "@/services/media-index";

export type Role = "admin" | "user";
export type AccountStatus = "active" | "disabled";
export type Usage = ServerUser["usage"];
export type Account = ServerUser;

export type ActionResult = { ok: boolean; error?: string };

type AuthState = {
    accounts: Account[];
    currentUserId: string | null;
    pricing: Pricing;
    modelPricing: Record<string, number>;
    defaultPermissions: PermissionKey[];
    defaultCredits: number;
    initialized: boolean;
    _hasHydrated: boolean;

    initialize: () => Promise<void>;
    applyUser: (user: Account) => void;

    register: (input: { username: string; password: string; displayName?: string }) => Promise<ActionResult>;
    login: (input: { username: string; password: string }) => Promise<ActionResult>;
    logout: () => Promise<void>;

    // 管理员操作（调用后端并同步本地状态）
    refreshAdminData: () => Promise<void>;
    setPermissions: (id: string, permissions: PermissionKey[]) => Promise<ActionResult>;
    setRole: (id: string, role: Role) => Promise<ActionResult>;
    setStatus: (id: string, status: AccountStatus) => Promise<ActionResult>;
    addCredits: (id: string, amount: number) => Promise<ActionResult>;
    resetPassword: (id: string, newPassword: string) => Promise<ActionResult>;
    deleteAccount: (id: string) => Promise<ActionResult>;
    setPricing: (pricing: Pricing) => void;
    setModelPricing: (modelPricing: Record<string, number>) => void;
    setDefaultPermissions: (permissions: PermissionKey[]) => void;
};

async function loadServerAiConfig(userId: string) {
    const requestEpoch = getAuthEpoch();
    try {
        const data = await backend.aiConfig();
        // 登录/退出或切换账号期间，旧请求可能晚于新会话返回；禁止它把
        // 上一个账号的渠道元数据和 Agent 配置重新注入当前页面。
        if (requestEpoch !== getAuthEpoch() || useAuthStore.getState().currentUserId !== userId) return;
        applyServerAiConfig(data);
    } catch {
        // 后端未配置 AI 信息时忽略
    }
}

const OWNER_SYNC_SLOW_MS = 10_000;
let ownerBindingGeneration = 0;

function runOwnerSync(label: string, generation: number, operation: () => Promise<void>) {
    const timer = globalThis.setTimeout(() => {
        if (generation === ownerBindingGeneration) console.warn(`[${label}] 账户后台同步超过 ${OWNER_SYNC_SLOW_MS / 1000} 秒，界面已继续加载`);
    }, OWNER_SYNC_SLOW_MS);
    void operation()
        .catch((error) => console.warn(`[${label}] 账户后台同步失败`, error))
        .finally(() => globalThis.clearTimeout(timer));
}

function runAfterRoutePaint(operation: () => void) {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        globalThis.setTimeout(operation, 0);
        return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(operation));
}

function bindCanvasOwner(user: Account | null) {
    const generation = ++ownerBindingGeneration;
    const ownerId = user?.id ?? null;
    // 账号边界必须在路由跳转前生效，但登录成功时不启动任何工作台网络同步。
    setImageStorageOwner(ownerId);
    setMediaStorageOwner(ownerId);
    setMediaIndexOwner(ownerId);
    setWorkbenchOwner(ownerId);

    const syncCanvas = () =>
        runOwnerSync("canvas", generation, async () => {
            const { syncCanvasOwner } = await import("@/services/canvas-cloud-sync");
            if (generation !== ownerBindingGeneration) return;
            if (ownerId) await refreshAccountMediaIndex(ownerId).catch((error) => console.warn("[media-index] 账户媒体索引同步失败", error));
            if (generation !== ownerBindingGeneration) return;
            await syncCanvasOwner(ownerId);
        });

    // 退出时立即清空当前画布视图；登录时先让认证路由完成并绘制画布外壳。
    if (!ownerId) syncCanvas();
    else runAfterRoutePaint(() => {
        if (generation === ownerBindingGeneration) syncCanvas();
    });
}

export const useAuthStore = create<AuthState>()((set, get) => ({
    accounts: [],
    currentUserId: null,
    pricing: { ...DEFAULT_PRICING },
    modelPricing: {},
    defaultPermissions: [...DEFAULT_USER_PERMISSIONS],
    defaultCredits: 100,
    initialized: false,
    _hasHydrated: false,

    applyUser: (user) =>
        set((state) => ({
            accounts: state.accounts.some((a) => a.id === user.id) ? state.accounts.map((a) => (a.id === user.id ? user : a)) : [...state.accounts, user],
        })),

    initialize: async () => {
        if (get().initialized) return;
        try {
            const { user } = await backend.me();
            set({ accounts: [user], currentUserId: user.id });
            bindCanvasOwner(user);
            void loadServerAiConfig(user.id);
            if (user.role === "admin") void get().refreshAdminData();
        } catch {
            setToken("");
            bindCanvasOwner(null);
        } finally {
            set({ initialized: true, _hasHydrated: true });
        }
    },

    register: async (input) => {
        bumpAuthEpoch();
        try {
            const { token, user } = await backend.register(input);
            setToken(token || "");
            set({ accounts: [user], currentUserId: user.id });
            bindCanvasOwner(user);
            void loadServerAiConfig(user.id);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "注册失败" };
        }
    },

    login: async (input) => {
        bumpAuthEpoch();
        try {
            const { token, user } = await backend.login(input);
            setToken(token || "");
            set({ accounts: [user], currentUserId: user.id });
            bindCanvasOwner(user);
            void loadServerAiConfig(user.id);
            if (user.role === "admin") void get().refreshAdminData();
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "登录失败" };
        }
    },

    logout: async () => {
        bumpAuthEpoch();
        setToken("");
        applyServerAiConfig({ channels: [], defaultModels: { image: "", video: "", audio: "", text: "" }, agentLlm: { enabled: false, model: "", skills: [] } });
        set({ currentUserId: null, accounts: [] });
        bindCanvasOwner(null);
        await backend.logout().catch(() => undefined);
    },

    refreshAdminData: async () => {
        try {
            const [{ users }, { settings }] = await Promise.all([backend.adminUsers(), backend.adminSettings()]);
            set({
                accounts: users,
                pricing: settings.pricing,
                modelPricing: settings.modelPricing || {},
                defaultPermissions: settings.defaultPermissions,
                defaultCredits: settings.defaultCredits,
            });
        } catch (error) {
            console.error("[admin] 获取管理数据失败", error);
        }
    },

    setPermissions: async (id, permissions) => {
        try {
            const { user } = await backend.adminPatchUser(id, { permissions });
            get().applyUser(user);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "权限更新失败" };
        }
    },

    setRole: async (id, role) => {
        try {
            const { user } = await backend.adminPatchUser(id, { role });
            get().applyUser(user);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "角色更新失败" };
        }
    },

    setStatus: async (id, status) => {
        try {
            const { user } = await backend.adminPatchUser(id, { status });
            get().applyUser(user);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "状态更新失败" };
        }
    },

    addCredits: async (id, amount) => {
        try {
            const { user } = await backend.adminPatchUser(id, { addCredits: amount });
            get().applyUser(user);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "额度更新失败" };
        }
    },

    resetPassword: async (id, newPassword) => {
        try {
            await backend.adminPatchUser(id, { password: newPassword });
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "重置失败" };
        }
    },

    deleteAccount: async (id) => {
        try {
            await backend.adminDeleteUser(id);
            set((state) => ({ accounts: state.accounts.filter((a) => a.id !== id) }));
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "删除失败" };
        }
    },

    setPricing: (pricing) => {
        set({ pricing: { ...pricing } });
        void backend.adminSaveSettings({ pricing }).catch((e) => console.error(e));
    },

    setModelPricing: (modelPricing) => {
        set({ modelPricing: { ...modelPricing } });
        void backend.adminSaveSettings({ modelPricing }).catch((e) => console.error(e));
    },

    setDefaultPermissions: (permissions) => {
        set({ defaultPermissions: [...permissions] });
        void backend.adminSaveSettings({ defaultPermissions: permissions }).catch((e) => console.error(e));
    },
}));

// 便捷选择器
export function useCurrentUser(): Account | null {
    return useAuthStore((state) => state.accounts.find((a) => a.id === state.currentUserId) ?? null);
}

export function getCurrentUser(): Account | null {
    const state = useAuthStore.getState();
    return state.accounts.find((a) => a.id === state.currentUserId) ?? null;
}
