import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { sendTelemetry } from "@/services/api/observability";

export function PresenceTracker() {
    const { pathname } = useLocation();
    const tab = useRef(crypto.randomUUID());
    useEffect(() => {
        const tabId = tab.current;
        let dirty = true,
            lastError = 0;
        const activity = () => {
            dirty = true;
        };
        const beat = () => {
            void sendTelemetry("heartbeat", { tabId, page: pathname, visible: document.visibilityState === "visible", active: dirty && document.visibilityState === "visible" });
            dirty = false;
        };
        const error = () => {
            if (Date.now() - lastError < 60000) return;
            lastError = Date.now();
            void sendTelemetry("activity", { action: "frontend-error", code: "runtime-error" });
        };
        window.addEventListener("pointerdown", activity, { passive: true });
        window.addEventListener("keydown", activity, { passive: true });
        document.addEventListener("visibilitychange", beat);
        window.addEventListener("error", error);
        window.addEventListener("unhandledrejection", error);
        beat();
        const timer = setInterval(beat, 30000);
        return () => {
            clearInterval(timer);
            window.removeEventListener("pointerdown", activity);
            window.removeEventListener("keydown", activity);
            document.removeEventListener("visibilitychange", beat);
            window.removeEventListener("error", error);
            window.removeEventListener("unhandledrejection", error);
        };
    }, [pathname]);
    return null;
}
