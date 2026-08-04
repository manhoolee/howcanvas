import type { ReactNode } from "react";
import { Spin } from "antd";
import { Navigate, useLocation } from "react-router-dom";

import { useAuthStore, useCurrentUser } from "@/stores/use-auth-store";
import type { PermissionKey } from "@/constant/permissions";
import { permissionLabel } from "@/constant/permissions";

function FullscreenLoader() {
    return (
        <div className="flex h-dvh w-full items-center justify-center bg-background">
            <Spin size="large" />
        </div>
    );
}

/** 需要登录：未登录跳转到登录页。 */
export function RequireAuth({ children }: { children: ReactNode }) {
    const hydrated = useAuthStore((s) => s._hasHydrated);
    const initialized = useAuthStore((s) => s.initialized);
    const user = useCurrentUser();
    const location = useLocation();

    if (!hydrated || !initialized) return <FullscreenLoader />;
    if (!user || user.status === "disabled") {
        return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return <>{children}</>;
}

/** 需要管理员：非管理员跳转回首页。 */
export function RequireAdmin({ children }: { children: ReactNode }) {
    const user = useCurrentUser();
    if (!user) return <Navigate to="/login" replace />;
    if (user.role !== "admin") return <Navigate to="/" replace />;
    return <>{children}</>;
}

/** 需要指定功能权限：无权限时展示提示。 */
export function RequirePermission({ perm, children }: { perm: PermissionKey; children: ReactNode }) {
    const user = useCurrentUser();
    if (!user) return <Navigate to="/login" replace />;
    if (user.role === "admin" || user.permissions.includes(perm)) return <>{children}</>;
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-lg font-medium text-stone-900 dark:text-stone-100">暂无访问权限</div>
            <p className="max-w-sm text-sm text-stone-500 dark:text-stone-400">
                你当前没有「{permissionLabel(perm)}」的使用权限，请联系管理员在后台为你开通。
            </p>
        </div>
    );
}
