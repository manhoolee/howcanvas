import { useMemo } from "react";
import { Button, Card, Progress, Tag } from "antd";
import { ArrowLeft, Coins, ImageIcon, LayoutDashboard, LogOut, Music, RefreshCw, Type, User as UserIcon, Video } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { useAuthStore, useCurrentUser } from "@/stores/use-auth-store";
import { PERMISSIONS, permissionLabel, type PermissionKey } from "@/constant/permissions";

export default function AccountPage() {
    const user = useCurrentUser();
    const logout = useAuthStore((s) => s.logout);
    const navigate = useNavigate();

    const derived = useMemo(() => {
        if (!user) return null;
        const spent = user.usage.creditsSpent;
        const remaining = user.credits;
        const total = remaining + spent;
        const totalGen = user.usage.image + user.usage.video + user.usage.audio + user.usage.text;
        const usedRatio = total > 0 ? Math.round((spent / total) * 100) : 0;
        return { spent, remaining, total, totalGen, usedRatio };
    }, [user]);

    if (!user || !derived) return null;

    const isAdmin = user.role === "admin";

    async function signOut() {
        await logout();
        navigate("/login", { replace: true });
    }

    const genCards = [
        { key: "image", label: "生图数量", value: user.usage.image, icon: ImageIcon, accent: "text-sky-500" },
        { key: "video", label: "视频生成", value: user.usage.video, icon: Video, accent: "text-violet-500" },
        { key: "audio", label: "音频生成", value: user.usage.audio, icon: Music, accent: "text-emerald-500" },
        { key: "text", label: "文本生成", value: user.usage.text, icon: Type, accent: "text-amber-500" },
    ];

    const infoRows: Array<{ label: string; value: string }> = [
        { label: "用户名", value: `@${user.username}` },
        { label: "昵称", value: user.displayName },
        { label: "角色", value: isAdmin ? "管理员" : "普通用户" },
        { label: "账号状态", value: user.status === "active" ? "正常" : "已禁用" },
        { label: "注册时间", value: new Date(user.createdAt).toLocaleString("zh-CN") },
    ];

    return (
        <main className="h-full overflow-y-auto bg-background px-6 py-6 text-stone-950 dark:text-stone-100">
            <div className="mx-auto max-w-4xl">
                <div className="mb-6 flex items-center justify-between">
                    <h1 className="text-xl font-semibold">我的账号</h1>
                    <Link to="/" className="inline-flex items-center gap-1 text-sm text-stone-500 transition hover:text-stone-900 dark:hover:text-stone-100">
                        <ArrowLeft className="size-4" />
                        返回应用
                    </Link>
                </div>

                {/* 用户信息 */}
                <Card className="!rounded-2xl">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-4">
                            <span className="inline-flex size-14 items-center justify-center rounded-full bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-200">
                                <UserIcon className="size-7" />
                            </span>
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="text-lg font-semibold">{user.displayName}</span>
                                    <Tag color={isAdmin ? "gold" : "blue"} className="!m-0">
                                        {isAdmin ? "管理员" : "用户"}
                                    </Tag>
                                </div>
                                <div className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">@{user.username}</div>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            {isAdmin ? (
                                <Button icon={<LayoutDashboard className="size-4" />} onClick={() => navigate("/admin")}>
                                    管理后台
                                </Button>
                            ) : null}
                            <Button icon={<RefreshCw className="size-4" />} onClick={signOut}>
                                更换账号
                            </Button>
                            <Button danger icon={<LogOut className="size-4" />} onClick={signOut}>
                                退出登录
                            </Button>
                        </div>
                    </div>
                </Card>

                {/* 额度 */}
                <div className="mt-4 grid gap-4 lg:grid-cols-3">
                    <Card className="!rounded-2xl lg:col-span-2">
                        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-stone-500 dark:text-stone-400">
                            <Coins className="size-4" />
                            额度概览
                        </div>
                        {isAdmin ? (
                            <div className="py-4 text-center text-stone-400">管理员账号不受额度限制（无限额度）</div>
                        ) : (
                            <>
                                <div className="grid grid-cols-3 gap-4">
                                    <div>
                                        <div className="text-xs text-stone-500">剩余额度</div>
                                        <div className="mt-1 text-3xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{derived.remaining}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-stone-500">累计额度</div>
                                        <div className="mt-1 text-3xl font-semibold tabular-nums">{derived.total}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-stone-500">已用额度</div>
                                        <div className="mt-1 text-3xl font-semibold tabular-nums text-stone-400">{derived.spent}</div>
                                    </div>
                                </div>
                                <Progress className="mt-3" percent={derived.usedRatio} showInfo={false} strokeColor="#f59e0b" />
                                <div className="mt-1 text-xs text-stone-400">已消耗 {derived.usedRatio}% · 额度不足时请联系管理员充值</div>
                            </>
                        )}
                    </Card>

                    <Card className="!rounded-2xl">
                        <div className="mb-3 text-sm font-medium text-stone-500 dark:text-stone-400">总生成量</div>
                        <div className="text-4xl font-semibold tabular-nums">{derived.totalGen}</div>
                        <div className="mt-1 text-xs text-stone-400">图片 + 视频 + 音频 + 文本</div>
                    </Card>
                </div>

                {/* 生成统计 */}
                <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {genCards.map((c) => {
                        const Icon = c.icon;
                        return (
                            <Card key={c.key} className="!rounded-2xl">
                                <div className={`mb-2 inline-flex items-center gap-1.5 text-sm text-stone-500 dark:text-stone-400`}>
                                    <Icon className={`size-4 ${c.accent}`} />
                                    {c.label}
                                </div>
                                <div className="text-2xl font-semibold tabular-nums">{c.value}</div>
                            </Card>
                        );
                    })}
                </div>

                {/* 账号信息 + 权限 */}
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <Card title="账号信息" className="!rounded-2xl">
                        <dl className="divide-y divide-stone-100 dark:divide-stone-800">
                            {infoRows.map((row) => (
                                <div key={row.label} className="flex items-center justify-between py-2.5 text-sm">
                                    <dt className="text-stone-500 dark:text-stone-400">{row.label}</dt>
                                    <dd className="font-medium">{row.value}</dd>
                                </div>
                            ))}
                        </dl>
                    </Card>

                    <Card title="我的权限" className="!rounded-2xl">
                        {isAdmin ? (
                            <Tag color="gold">全部功能</Tag>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {PERMISSIONS.filter((p) => user.permissions.includes(p.key as PermissionKey)).map((p) => (
                                    <Tag key={p.key} color="blue" className="!m-0">
                                        {permissionLabel(p.key)}
                                    </Tag>
                                ))}
                                {user.permissions.length === 0 ? <span className="text-sm text-stone-400">暂未开通任何功能权限，请联系管理员</span> : null}
                            </div>
                        )}
                    </Card>
                </div>
            </div>
        </main>
    );
}
