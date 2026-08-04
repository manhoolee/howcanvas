import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { refreshDueSources } from "@/services/api/prompts";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";

const CHECK_INTERVAL_MS = 60_000;
const INITIAL_REFRESH_DELAY_MS = 1_000;

/** Periodically update only the sources whose last successful refresh is due. */
export function usePromptSourceScheduler(enabled = true) {
    const queryClient = useQueryClient();
    const intervalMinutes = usePromptSourceStore((state) => state.schedule.intervalMinutes);

    useEffect(() => {
        if (!enabled || !intervalMinutes) return;
        let running = false;
        const tick = async () => {
            if (running) return;
            const { updateSchedule } = usePromptSourceStore.getState();
            running = true;
            try {
                const result = await refreshDueSources(intervalMinutes * 60_000);
                if (!result.results.length) return;
                updateSchedule("lastFetchedAt", new Date().toISOString());
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["prompt-source-statuses"] }),
                ]);
            } catch {
                // 单个来源的错误已写入来源状态，下一个检查周期会继续尝试。
            } finally {
                running = false;
            }
        };
        let intervalTimer: number | undefined;
        const initialTimer = window.setTimeout(() => {
            // 认证状态会先于路由跳转更新；登录页绝不启动提示词源网络任务。
            if (window.location.pathname === "/login") return;
            void tick();
            intervalTimer = window.setInterval(() => void tick(), CHECK_INTERVAL_MS);
        }, INITIAL_REFRESH_DELAY_MS);
        return () => {
            window.clearTimeout(initialTimer);
            if (intervalTimer) window.clearInterval(intervalTimer);
        };
    }, [enabled, intervalMinutes, queryClient]);
}
