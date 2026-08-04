import { LayoutDashboard, LogOut, User as UserIcon } from "lucide-react";
import { Drawer, Tag } from "antd";
import { Link, useNavigate } from "react-router-dom";

import { type NavigationToolSlug } from "@/constant/navigation-tools";
import { useIsAdmin, useVisibleNavTools } from "@/hooks/use-nav-permissions";
import { useAuthStore, useCurrentUser } from "@/stores/use-auth-store";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

const itemClass = "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100";

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const visibleNavTools = useVisibleNavTools();
    const isAdmin = useIsAdmin();
    const user = useCurrentUser();
    const logout = useAuthStore((s) => s.logout);
    const navigate = useNavigate();

    return (
        <Drawer title="导航" placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            {user ? (
                <div className="mb-3 flex items-center gap-2 px-3">
                    <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{user.displayName}</span>
                    <Tag color={isAdmin ? "gold" : "blue"} className="!m-0">
                        {isAdmin ? "管理员" : "用户"}
                    </Tag>
                    {!isAdmin ? <span className="text-xs text-amber-600 dark:text-amber-400">额度 {user.credits}</span> : null}
                </div>
            ) : null}
            <div className="space-y-1">
                {visibleNavTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    return (
                        <Link
                            key={tool.slug}
                            to={`/${tool.slug}`}
                            onClick={onClose}
                            className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition",
                                active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                            )}
                        >
                            <Icon className="size-5" />
                            <span>{tool.label}</span>
                        </Link>
                    );
                })}
                <Link to="/account" onClick={onClose} className={itemClass}>
                    <UserIcon className="size-5" />
                    <span>我的账号</span>
                </Link>
                {isAdmin ? (
                    <Link to="/admin" onClick={onClose} className={itemClass}>
                        <LayoutDashboard className="size-5" />
                        <span>管理后台</span>
                    </Link>
                ) : null}
                <button
                    type="button"
                    onClick={async () => {
                        onClose();
                        await logout();
                        navigate("/login", { replace: true });
                    }}
                    className={cn(itemClass, "w-full text-left !text-red-600 hover:!bg-red-50 dark:!text-red-400 dark:hover:!bg-red-950/40")}
                >
                    <LogOut className="size-5" />
                    <span>退出登录</span>
                </button>
            </div>
        </Drawer>
    );
}
