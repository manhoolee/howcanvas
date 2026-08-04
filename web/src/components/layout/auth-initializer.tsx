import { useEffect, useRef } from "react";
import { message } from "antd";

import { useAssetStore } from "@/stores/use-asset-store";
import { useAuthStore } from "@/stores/use-auth-store";
import { getAuthEpoch } from "@/services/api/backend";

/** 应用启动时校验本地令牌并从后端加载当前用户会话；登录状态变化时同步个人资产（资产跟账号走）。 */
export function AuthInitializer() {
    const initialize = useAuthStore((s) => s.initialize);
    const currentUserId = useAuthStore((s) => s.currentUserId);
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void initialize();
    }, [initialize]);

    useEffect(() => {
        const handleExpired = (event: Event) => {
            const detail = (event as CustomEvent<{ epoch?: number; code?: string }>).detail;
            const epoch = detail?.epoch;
            if (typeof epoch === "number" && epoch !== getAuthEpoch()) return;
            if (useAuthStore.getState().currentUserId) {
                message.warning(detail?.code === "SESSION_REPLACED" ? "账号已在其他设备登录，当前设备已退出" : "登录已过期，请重新登录");
                useAuthStore.getState().logout();
            }
        };
        window.addEventListener("infinite-canvas:auth-expired", handleExpired);
        return () => window.removeEventListener("infinite-canvas:auth-expired", handleExpired);
    }, []);

    useEffect(() => {
        if (!currentUserId || typeof EventSource === "undefined") return;
        const source = new EventSource("/api/session/events", { withCredentials: true });
        const handleReplaced = () => window.dispatchEvent(new CustomEvent("infinite-canvas:auth-expired", { detail: { epoch: getAuthEpoch(), code: "SESSION_REPLACED" } }));
        const handleImageTask = (event: MessageEvent<string>) => {
            try {
                const detail = JSON.parse(event.data) as { task?: { id?: string } };
                if (detail.task?.id) window.dispatchEvent(new CustomEvent("infinite-canvas:image-task", { detail }));
            } catch {
                // Ignore malformed SSE frames; polling remains the recovery path.
            }
        };
        source.addEventListener("session-replaced", handleReplaced);
        source.addEventListener("image-task-updated", handleImageTask as EventListener);
        source.addEventListener("image-task-completed", handleImageTask as EventListener);
        return () => {
            source.removeEventListener("session-replaced", handleReplaced);
            source.removeEventListener("image-task-updated", handleImageTask as EventListener);
            source.removeEventListener("image-task-completed", handleImageTask as EventListener);
            source.close();
        };
    }, [currentUserId]);

    useEffect(() => {
        const store = useAssetStore.getState();
        if (currentUserId) void store.loadFromServer();
        else store.clearLocal();
    }, [currentUserId]);

    return null;
}
