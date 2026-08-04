import { navigationTools } from "@/constant/navigation-tools";
import type { PermissionKey } from "@/constant/permissions";
import { useCurrentUser } from "@/stores/use-auth-store";

/** 依据当前用户权限过滤可见的导航工具（管理员可见全部；公共资产对所有登录用户可见）。 */
export function useVisibleNavTools() {
    const user = useCurrentUser();
    if (!user) return [] as typeof navigationTools[number][];
    if (user.role === "admin") return [...navigationTools];
    return navigationTools.filter((tool) => tool.slug === "public-assets" || user.permissions.includes(tool.slug as PermissionKey));
}

export function useHasPermission(perm: PermissionKey): boolean {
    const user = useCurrentUser();
    if (!user) return false;
    return user.role === "admin" || user.permissions.includes(perm);
}

export function useIsAdmin(): boolean {
    const user = useCurrentUser();
    return user?.role === "admin";
}
