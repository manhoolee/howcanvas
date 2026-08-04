import { useEffect, useState } from "react";
import { App, Button, Form, Input, Tabs } from "antd";
import { useNavigate } from "react-router-dom";

import { useAuthStore, type Account } from "@/stores/use-auth-store";
import { backend } from "@/services/api/backend";

function landingPathFor(user: Account): string {
    if (user.role === "admin") return "/admin";
    const order = ["canvas", "image", "video", "prompts", "assets"] as const;
    const first = order.find((slug) => user.permissions.includes(slug));
    return first ? `/${first}` : "/";
}

export default function AuthPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const login = useAuthStore((s) => s.login);
    const register = useAuthStore((s) => s.register);
    const [tab, setTab] = useState<"login" | "register">("login");
    const [loading, setLoading] = useState(false);
    const [registrationEnabled, setRegistrationEnabled] = useState(false);

    useEffect(() => {
        let active = true;
        void backend.authConfig().then(({ registrationEnabled: enabled }) => {
            if (active) setRegistrationEnabled(enabled);
        }).catch(() => {
            if (active) setRegistrationEnabled(false);
        });
        return () => {
            active = false;
        };
    }, []);

    function afterAuth() {
        const state = useAuthStore.getState();
        const user = state.accounts.find((a) => a.id === state.currentUserId);
        if (!user) return;
        message.success(`欢迎，${user.displayName}`);
        navigate(landingPathFor(user), { replace: true });
    }

    async function onLogin(values: { username: string; password: string }) {
        setLoading(true);
        try {
            const res = await login(values);
            if (!res.ok) message.error(res.error ?? "登录失败");
            else afterAuth();
        } finally {
            setLoading(false);
        }
    }

    async function onRegister(values: { username: string; displayName?: string; password: string; confirm: string }) {
        if (values.password !== values.confirm) {
            message.error("两次输入的密码不一致");
            return;
        }
        setLoading(true);
        try {
            const res = await register({ username: values.username, password: values.password, displayName: values.displayName });
            if (!res.ok) message.error(res.error ?? "注册失败");
            else afterAuth();
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-6 text-stone-950 dark:text-stone-100">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]" />
            <div className="relative w-full max-w-sm">
                <div className="mb-8 text-center">
                    <div className="mb-3 inline-flex items-center gap-2">
                        <img src="/logo.svg" alt="HowCanvas" className="size-10 shrink-0" />
                        <span className="text-xl font-semibold tracking-tight">HowCanvas</span>
                    </div>
                    <p className="text-sm text-stone-500 dark:text-stone-400">{registrationEnabled ? "登录或注册以进入你的创作空间" : "登录以进入你的创作空间"}</p>
                </div>

                <div className="rounded-2xl border border-stone-200 bg-background/80 p-6 shadow-sm backdrop-blur dark:border-stone-800">
                    <Tabs
                        activeKey={tab}
                        onChange={(k) => setTab(k as "login" | "register")}
                        centered
                        items={[
                            {
                                key: "login",
                                label: "登录",
                                children: (
                                    <Form layout="vertical" onFinish={onLogin} requiredMark={false} className="mt-2">
                                        <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                                            <Input size="large" placeholder="用户名" autoComplete="username" />
                                        </Form.Item>
                                        <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                                            <Input.Password size="large" placeholder="密码" autoComplete="current-password" />
                                        </Form.Item>
                                        <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                                            登录
                                        </Button>
                                    </Form>
                                ),
                            },
                            ...(registrationEnabled ? [{
                                key: "register",
                                label: "注册",
                                children: (
                                    <Form layout="vertical" onFinish={onRegister} requiredMark={false} className="mt-2">
                                        <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }, { pattern: /^[a-zA-Z0-9_\-\u4e00-\u9fff]{3,40}$/, message: "3-40 位中文、字母、数字、下划线或连字符" }]}>
                                            <Input size="large" placeholder="用于登录（3-40 位）" autoComplete="username" />
                                        </Form.Item>
                                        <Form.Item name="displayName" label="昵称（可选）">
                                            <Input size="large" placeholder="展示名称" />
                                        </Form.Item>
                                        <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }, { min: 10, message: "密码至少 10 个字符" }]}>
                                            <Input.Password size="large" placeholder="至少 10 位" autoComplete="new-password" />
                                        </Form.Item>
                                        <Form.Item name="confirm" label="确认密码" rules={[{ required: true, message: "请再次输入密码" }]}>
                                            <Input.Password size="large" placeholder="再次输入密码" autoComplete="new-password" />
                                        </Form.Item>
                                        <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                                            注册并登录
                                        </Button>
                                    </Form>
                                ),
                            }] : []),
                        ]}
                    />
                </div>

                <div className="mt-5 space-y-3 text-center">
                    <a
                        href="http://chat.hoosland.com"
                        className="block rounded-xl border border-stone-300 bg-background/80 px-4 py-3 text-sm font-medium text-stone-800 shadow-sm backdrop-blur transition-colors hover:border-stone-400 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2 dark:border-stone-700 dark:text-stone-100 dark:hover:border-stone-600 dark:hover:bg-stone-900 dark:focus-visible:ring-stone-600 dark:focus-visible:ring-offset-stone-950"
                    >
                        无账号用户请移步 HoosChat 提交申请
                    </a>
                    <a
                        href="http://hoosland.com"
                        className="inline-flex text-xs text-stone-500 underline decoration-stone-400 underline-offset-4 transition-colors hover:text-stone-800 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:text-stone-400 dark:hover:text-stone-100"
                    >
                        返回 Hoosland 主页
                    </a>
                </div>

            </div>
        </main>
    );
}
