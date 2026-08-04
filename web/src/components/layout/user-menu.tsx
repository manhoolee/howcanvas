import { Coins, LayoutDashboard, LogOut, RefreshCw, User as UserIcon } from "lucide-react";
import { Dropdown, Tag, type MenuProps } from "antd";
import { useNavigate } from "react-router-dom";

import { useAuthStore, useCurrentUser } from "@/stores/use-auth-store";

export function UserMenu() {
    const user = useCurrentUser();
    const logout = useAuthStore((s) => s.logout);
    const navigate = useNavigate();

    if (!user) return null;

    const isAdmin = user.role === "admin";

    const items: MenuProps["items"] = [
        {
            key: "header",
            type: "group",
            label: (
                <div className="py-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{user.displayName}</span>
                        <Tag color={isAdmin ? "gold" : "blue"} className="!m-0">
                            {isAdmin ? "管理员" : "用户"}
                        </Tag>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
                        <Coins className="size-3.5" />
                        {isAdmin ? "无限额度" : `剩余额度 ${user.credits} 点 · 生图 ${user.usage.image} 次`}
                    </div>
                </div>
            ),
        },
        { type: "divider" },
        { key: "account", icon: <UserIcon className="size-4" />, label: "我的账号" },
        ...(isAdmin ? [{ key: "admin", icon: <LayoutDashboard className="size-4" />, label: "管理后台" }] : []),
        { type: "divider" },
        { key: "switch", icon: <RefreshCw className="size-4" />, label: "更换账号" },
        { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", danger: true },
    ];

    const onClick: MenuProps["onClick"] = async ({ key }) => {
        if (key === "account") navigate("/account");
        else if (key === "admin") navigate("/admin");
        else if (key === "switch" || key === "logout") {
            await logout();
            navigate("/login", { replace: true });
        }
    };

    return (
        <Dropdown menu={{ items, onClick }} trigger={["click"]} placement="bottomLeft">
            <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 pl-1.5 pr-2.5 text-sm text-stone-700 transition hover:border-stone-300 hover:text-stone-950 dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-600 dark:hover:text-white"
                aria-label="我的账号"
                title="我的账号"
            >
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-200">
                    <UserIcon className="size-3.5" />
                </span>
                <span className="hidden sm:inline">我的账号</span>
                {!isAdmin ? (
                    <span className="hidden items-center gap-0.5 text-xs text-amber-600 sm:inline-flex dark:text-amber-400">· {user.credits}</span>
                ) : null}
            </button>
        </Dropdown>
    );
}
