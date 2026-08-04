import { useCallback, useEffect, useMemo, useState } from "react";
import { App, AutoComplete, Button, Card, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Select, Table, Tag, Tabs } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ArrowLeft, Bot, Cable, Coins, KeyRound, Plus, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useAuthStore, type Account } from "@/stores/use-auth-store";
import { guessCapability, modelOptionName, useConfigStore } from "@/stores/use-config-store";
import { backend, type AdminAiChannel, type AgentSkillId, type ServerAgentLlmConfig, type ServerChannelModel } from "@/services/api/backend";
import { applyServerAiConfig, isServerChannelId } from "@/lib/server-ai-config";
import { PERMISSIONS, USAGE_KINDS, permissionLabel, usageKindLabel, type PermissionKey, type Pricing, type UsageKind } from "@/constant/permissions";

type CreateUserFormValues = {
    username: string;
    displayName?: string;
    password: string;
    role: "admin" | "user";
    permissions: PermissionKey[];
    credits: number;
};

function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<CreateUserFormValues>();
    const applyUser = useAuthStore((s) => s.applyUser);
    const defaultPermissions = useAuthStore((s) => s.defaultPermissions);
    const defaultCredits = useAuthStore((s) => s.defaultCredits);
    const [saving, setSaving] = useState(false);
    const role = Form.useWatch("role", form) || "user";

    async function submit() {
        const values = await form.validateFields();
        setSaving(true);
        try {
            const { user } = await backend.adminCreateUser({
                username: values.username,
                password: values.password,
                displayName: values.displayName,
                role: values.role,
                permissions: values.permissions,
                credits: values.credits,
            });
            applyUser(user);
            message.success(`用户「${user.displayName}」已创建`);
            form.resetFields();
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建失败");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal open={open} title="新建用户" onCancel={onClose} onOk={() => void submit()} okText="创建" cancelText="取消" confirmLoading={saving} destroyOnHidden>
            <Form form={form} layout="vertical" requiredMark={false} initialValues={{ role: "user", permissions: [...defaultPermissions], credits: defaultCredits }} className="mt-2">
                <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }, { pattern: /^[a-zA-Z0-9_\-\u4e00-\u9fff]{3,40}$/, message: "3-40 位中文、字母、数字、下划线或连字符" }]}>
                    <Input placeholder="用于登录（3-40 位）" />
                </Form.Item>
                <Form.Item name="displayName" label="昵称（可选）">
                    <Input placeholder="展示名称" />
                </Form.Item>
                <Form.Item name="password" label="初始密码" rules={[{ required: true, message: "请输入密码" }, { min: 10, message: "密码至少 10 个字符" }]}>
                    <Input.Password placeholder="至少 10 位" />
                </Form.Item>
                <Form.Item name="role" label="角色">
                    <Select
                        options={[
                            { value: "user", label: "用户" },
                            { value: "admin", label: "管理员" },
                        ]}
                    />
                </Form.Item>
                {role === "user" ? (
                    <>
                        <Form.Item name="permissions" label="功能权限">
                            <Checkbox.Group className="flex flex-col gap-2">
                                {PERMISSIONS.map((p) => (
                                    <Checkbox key={p.key} value={p.key}>
                                        {p.label}
                                    </Checkbox>
                                ))}
                            </Checkbox.Group>
                        </Form.Item>
                        <Form.Item name="credits" label="初始额度">
                            <InputNumber min={0} style={{ width: 160 }} addonAfter="点" />
                        </Form.Item>
                    </>
                ) : null}
            </Form>
        </Modal>
    );
}

function UsersTab() {
    const { message } = App.useApp();
    const accounts = useAuthStore((s) => s.accounts);
    const currentUserId = useAuthStore((s) => s.currentUserId);
    const setPermissions = useAuthStore((s) => s.setPermissions);
    const setRole = useAuthStore((s) => s.setRole);
    const setStatus = useAuthStore((s) => s.setStatus);
    const addCredits = useAuthStore((s) => s.addCredits);
    const resetPassword = useAuthStore((s) => s.resetPassword);
    const deleteAccount = useAuthStore((s) => s.deleteAccount);

    const [permTarget, setPermTarget] = useState<Account | null>(null);
    const [permDraft, setPermDraft] = useState<PermissionKey[]>([]);
    const [creditTarget, setCreditTarget] = useState<Account | null>(null);
    const [creditAmount, setCreditAmount] = useState<number>(100);
    const [pwdTarget, setPwdTarget] = useState<Account | null>(null);
    const [pwdValue, setPwdValue] = useState("");
    const [createOpen, setCreateOpen] = useState(false);

    function openPerms(account: Account) {
        setPermTarget(account);
        setPermDraft([...account.permissions]);
    }
    async function savePerms() {
        if (permTarget) {
            const result = await setPermissions(permTarget.id, permDraft);
            if (!result.ok) return void message.error(result.error ?? "权限更新失败");
            message.success("权限已更新");
        }
        setPermTarget(null);
    }
    async function saveCredits() {
        if (creditTarget) {
            const result = await addCredits(creditTarget.id, creditAmount);
            if (!result.ok) return void message.error(result.error ?? "额度更新失败");
            message.success(`已为 ${creditTarget.displayName} ${creditAmount >= 0 ? "充值" : "扣减"} ${Math.abs(creditAmount)} 点`);
        }
        setCreditTarget(null);
    }
    async function savePwd() {
        if (!pwdTarget) return;
        if (pwdValue.length < 10) return void message.error("密码至少 10 个字符");
        const res = await resetPassword(pwdTarget.id, pwdValue);
        if (!res.ok) message.error(res.error ?? "重置失败");
        else {
            message.success("密码已重置");
            setPwdTarget(null);
            setPwdValue("");
        }
    }

    const columns: ColumnsType<Account> = [
        {
            title: "用户",
            dataIndex: "displayName",
            render: (_, r) => (
                <div className="flex flex-col">
                    <span className="font-medium">{r.displayName}</span>
                    <span className="text-xs text-stone-400">@{r.username}</span>
                </div>
            ),
        },
        {
            title: "角色",
            dataIndex: "role",
            width: 120,
            render: (_, r) => (
                <Select
                    size="small"
                    value={r.role}
                    style={{ width: 92 }}
                    disabled={r.id === currentUserId}
                    onChange={(v) => void setRole(r.id, v).then((result) => { if (result.ok) message.success("角色已更新"); else message.error(result.error ?? "角色更新失败"); })}
                    options={[
                        { value: "user", label: "用户" },
                        { value: "admin", label: "管理员" },
                    ]}
                />
            ),
        },
        {
            title: "权限",
            dataIndex: "permissions",
            render: (_, r) =>
                r.role === "admin" ? (
                    <Tag color="gold">全部</Tag>
                ) : (
                    <div className="flex max-w-72 flex-wrap gap-1">
                        {r.permissions.length === 0 ? <span className="text-xs text-stone-400">无</span> : null}
                        {r.permissions.map((p) => (
                            <Tag key={p} className="!m-0">
                                {permissionLabel(p)}
                            </Tag>
                        ))}
                    </div>
                ),
        },
        {
            title: "额度",
            dataIndex: "credits",
            width: 110,
            render: (_, r) => (r.role === "admin" ? <span className="text-stone-400">∞</span> : <span className="tabular-nums">{r.credits}</span>),
            sorter: (a, b) => a.credits - b.credits,
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (_, r) => (r.status === "active" ? <Tag color="green">正常</Tag> : <Tag color="red">已禁用</Tag>),
        },
        {
            title: "操作",
            key: "actions",
            width: 260,
            render: (_, r) => (
                <div className="flex flex-wrap gap-1">
                    <Button size="small" onClick={() => openPerms(r)} disabled={r.role === "admin"}>
                        权限
                    </Button>
                    <Button size="small" onClick={() => { setCreditTarget(r); setCreditAmount(100); }} disabled={r.role === "admin"}>
                        充值
                    </Button>
                    <Button size="small" onClick={() => { setPwdTarget(r); setPwdValue(""); }}>
                        改密
                    </Button>
                    <Button size="small" onClick={() => void setStatus(r.id, r.status === "active" ? "disabled" : "active").then((result) => { if (result.ok) message.success("状态已更新"); else message.error(result.error ?? "状态更新失败"); })} disabled={r.id === currentUserId}>
                        {r.status === "active" ? "禁用" : "启用"}
                    </Button>
                    <Popconfirm title={`删除用户 ${r.displayName}？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={async () => { const result = await deleteAccount(r.id); if (result.ok) message.success("用户已删除"); else message.error(result.error ?? "删除失败"); }} disabled={r.id === currentUserId}>
                        <Button size="small" danger disabled={r.id === currentUserId}>
                            删除
                        </Button>
                    </Popconfirm>
                </div>
            ),
        },
    ];

    return (
        <>
            <div className="mb-3 flex justify-end">
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                    新建用户
                </Button>
            </div>
            <Table<Account> rowKey="id" columns={columns} dataSource={accounts} pagination={false} size="middle" scroll={{ x: 900 }} />

            <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />

            <Modal open={!!permTarget} title={`设置权限 · ${permTarget?.displayName ?? ""}`} onCancel={() => setPermTarget(null)} onOk={savePerms} okText="保存" cancelText="取消">
                <Checkbox.Group value={permDraft} onChange={(v) => setPermDraft(v as PermissionKey[])} className="flex flex-col gap-2">
                    {PERMISSIONS.map((p) => (
                        <Checkbox key={p.key} value={p.key}>
                            {p.label}
                        </Checkbox>
                    ))}
                </Checkbox.Group>
            </Modal>

            <Modal open={!!creditTarget} title={`调整额度 · ${creditTarget?.displayName ?? ""}`} onCancel={() => setCreditTarget(null)} onOk={saveCredits} okText="确认" cancelText="取消">
                <p className="mb-2 text-sm text-stone-500">当前余额：{creditTarget?.credits ?? 0} 点。输入正数充值，负数扣减。</p>
                <InputNumber value={creditAmount} onChange={(v) => setCreditAmount(v ?? 0)} style={{ width: "100%" }} step={50} />
            </Modal>

            <Modal open={!!pwdTarget} title={`重置密码 · ${pwdTarget?.displayName ?? ""}`} onCancel={() => { setPwdTarget(null); setPwdValue(""); }} onOk={savePwd} okText="重置" cancelText="取消">
                <Input.Password value={pwdValue} onChange={(e) => setPwdValue(e.target.value)} placeholder="新密码（至少 10 位）" />
            </Modal>
        </>
    );
}

function StatsTab() {
    const accounts = useAuthStore((s) => s.accounts);

    const totals = useMemo(() => {
        return accounts.reduce(
            (acc, a) => {
                acc.image += a.usage.image;
                acc.video += a.usage.video;
                acc.audio += a.usage.audio;
                acc.text += a.usage.text;
                acc.creditsSpent += a.usage.creditsSpent;
                return acc;
            },
            { image: 0, video: 0, audio: 0, text: 0, creditsSpent: 0 },
        );
    }, [accounts]);

    const columns: ColumnsType<Account> = [
        { title: "用户", dataIndex: "displayName", render: (_, r) => <span className="font-medium">{r.displayName}</span> },
        { title: "图片", dataIndex: ["usage", "image"], width: 90, sorter: (a, b) => a.usage.image - b.usage.image, render: (_, r) => <span className="tabular-nums">{r.usage.image}</span> },
        { title: "视频", dataIndex: ["usage", "video"], width: 90, sorter: (a, b) => a.usage.video - b.usage.video, render: (_, r) => <span className="tabular-nums">{r.usage.video}</span> },
        { title: "音频", dataIndex: ["usage", "audio"], width: 90, sorter: (a, b) => a.usage.audio - b.usage.audio, render: (_, r) => <span className="tabular-nums">{r.usage.audio}</span> },
        { title: "文本", dataIndex: ["usage", "text"], width: 90, sorter: (a, b) => a.usage.text - b.usage.text, render: (_, r) => <span className="tabular-nums">{r.usage.text}</span> },
        {
            title: "总生成",
            key: "total",
            width: 100,
            render: (_, r) => <span className="tabular-nums font-medium">{r.usage.image + r.usage.video + r.usage.audio + r.usage.text}</span>,
            sorter: (a, b) => a.usage.image + a.usage.video + a.usage.audio + a.usage.text - (b.usage.image + b.usage.video + b.usage.audio + b.usage.text),
        },
        { title: "已用额度", dataIndex: ["usage", "creditsSpent"], width: 110, sorter: (a, b) => a.usage.creditsSpent - b.usage.creditsSpent, render: (_, r) => <span className="tabular-nums">{r.usage.creditsSpent}</span> },
    ];

    const cards = [
        { label: "图片生成", value: totals.image },
        { label: "视频生成", value: totals.video },
        { label: "音频生成", value: totals.audio },
        { label: "文本生成", value: totals.text },
        { label: "累计消耗额度", value: totals.creditsSpent },
    ];

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {cards.map((c) => (
                    <Card key={c.label} size="small" className="!rounded-xl">
                        <div className="text-xs text-stone-500">{c.label}</div>
                        <div className="mt-1 text-2xl font-semibold tabular-nums">{c.value}</div>
                    </Card>
                ))}
            </div>
            <Table<Account> rowKey="id" columns={columns} dataSource={accounts} pagination={false} size="middle" scroll={{ x: 720 }} />
        </div>
    );
}

function BillingTab() {
    const { message } = App.useApp();
    const pricing = useAuthStore((s) => s.pricing);
    const setPricing = useAuthStore((s) => s.setPricing);
    const modelPricing = useAuthStore((s) => s.modelPricing);
    const setModelPricing = useAuthStore((s) => s.setModelPricing);
    const defaultPermissions = useAuthStore((s) => s.defaultPermissions);
    const setDefaultPermissions = useAuthStore((s) => s.setDefaultPermissions);
    const channels = useConfigStore((s) => s.config.channels);

    const [draft, setDraft] = useState<Pricing>({ ...pricing });
    const [modelPrices, setModelPrices] = useState<Record<string, number | null>>({});
    const [customByKind, setCustomByKind] = useState<Record<UsageKind, string[]>>({ image: [], video: [], audio: [], text: [] });
    const [newModel, setNewModel] = useState<Record<UsageKind, string>>({ image: "", video: "", audio: "", text: "" });
    const [perms, setPerms] = useState<PermissionKey[]>([...defaultPermissions]);

    // 服务器设置异步到达后同步一次（登录/刷新时）
    useEffect(() => setDraft({ ...pricing }), [pricing]);
    useEffect(() => setPerms([...defaultPermissions]), [defaultPermissions]);
    useEffect(() => {
        setModelPrices({ ...modelPricing });
        // 已定价但不在渠道列表中的模型，按名称猜测能力归入对应类型
        const known = new Set<string>();
        channels.forEach((channel) => channel.models.forEach((model) => known.add(model.name)));
        const extras: Record<UsageKind, string[]> = { image: [], video: [], audio: [], text: [] };
        Object.keys(modelPricing).forEach((name) => {
            if (!known.has(name)) extras[guessCapability(name) as UsageKind]?.push(name);
        });
        setCustomByKind(extras);
    }, [modelPricing, channels]);

    // 各类型下的具体模型（来自全部渠道，去重）
    const modelsByKind = useMemo(() => {
        const map: Record<UsageKind, string[]> = { image: [], video: [], audio: [], text: [] };
        const seen = new Set<string>();
        channels.forEach((channel) =>
            channel.models.forEach((model) => {
                const kind = model.capability as UsageKind;
                if (!map[kind] || seen.has(model.name)) return;
                seen.add(model.name);
                map[kind].push(model.name);
            }),
        );
        return map;
    }, [channels]);

    // 全部已知模型名（供下拉选择，不限能力归类）
    const allModelNames = useMemo(() => {
        const names = new Set<string>();
        channels.forEach((channel) => channel.models.forEach((model) => names.add(model.name)));
        return Array.from(names).sort();
    }, [channels]);

    function addCustom(kind: UsageKind, picked?: string) {
        const name = (picked ?? newModel[kind]).trim();
        if (!name) return;
        setCustomByKind((prev) => (prev[kind].includes(name) ? prev : { ...prev, [kind]: [...prev[kind], name] }));
        setNewModel((prev) => ({ ...prev, [kind]: "" }));
    }

    function saveAll() {
        const next: Record<string, number> = {};
        Object.entries(modelPrices).forEach(([model, price]) => {
            if (price !== null && price !== undefined && model.trim()) next[model.trim()] = Math.max(0, price);
        });
        setPricing(draft);
        setModelPricing(next);
        message.success("计费设置已保存");
    }

    return (
        <div className="grid gap-4">
            <Card title="计费设置（点 / 次）" className="!rounded-xl">
                <div className="grid gap-4 sm:grid-cols-2">
                    {USAGE_KINDS.map((k) => {
                        const models = [...modelsByKind[k.key], ...customByKind[k.key].filter((name) => !modelsByKind[k.key].includes(name))];
                        return (
                            <div key={k.key} className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                                <div className="mb-3 flex items-center justify-between gap-2">
                                    <span className="font-medium">{usageKindLabel(k.key)}</span>
                                    <span className="inline-flex items-center gap-2 text-xs text-stone-500">
                                        默认单价
                                        <InputNumber size="small" min={0} value={draft[k.key]} onChange={(v) => setDraft((d) => ({ ...d, [k.key]: v ?? 0 }))} style={{ width: 88 }} />
                                    </span>
                                </div>
                                <div className="space-y-2">
                                    {!models.length ? <div className="text-xs text-stone-400">暂无该类型的模型，可在下方添加</div> : null}
                                    {models.map((name) => (
                                        <div key={name} className="flex items-center justify-between gap-2">
                                            <span className="min-w-0 truncate font-mono text-xs text-stone-600 dark:text-stone-300" title={name}>
                                                {name}
                                            </span>
                                            <InputNumber
                                                size="small"
                                                min={0}
                                                placeholder="默认"
                                                value={modelPrices[name] ?? null}
                                                onChange={(v) => setModelPrices((prev) => ({ ...prev, [name]: v === null || v === undefined ? null : v }))}
                                                style={{ width: 88 }}
                                            />
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-3 flex gap-2">
                                    <AutoComplete
                                        size="small"
                                        className="flex-1"
                                        placeholder="选择或输入模型名"
                                        value={newModel[k.key]}
                                        options={allModelNames.filter((name) => !models.includes(name)).map((value) => ({ value }))}
                                        onChange={(v) => setNewModel((prev) => ({ ...prev, [k.key]: String(v ?? "") }))}
                                        onSelect={(v) => addCustom(k.key, String(v))}
                                        filterOption={(input, option) => String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") addCustom(k.key);
                                        }}
                                    />
                                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => addCustom(k.key)} aria-label="添加模型" />
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className="mt-4 flex items-center gap-3">
                    <Button type="primary" onClick={saveAll}>
                        保存计费设置
                    </Button>
                    <span className="text-xs text-stone-400">模型未单独定价（留空）时，按该类型的默认单价计费。</span>
                </div>
            </Card>

            <Card title="新用户默认权限" className="!rounded-xl">
                <p className="mb-3 text-sm text-stone-500">新注册用户将自动获得以下权限（现有用户不受影响）。</p>
                <Checkbox.Group value={perms} onChange={(v) => setPerms(v as PermissionKey[])} className="mb-4 flex flex-wrap gap-4">
                    {PERMISSIONS.map((p) => (
                        <Checkbox key={p.key} value={p.key}>
                            {p.label}
                        </Checkbox>
                    ))}
                </Checkbox.Group>
                <Button
                    type="primary"
                    onClick={() => {
                        setDefaultPermissions(perms);
                        message.success("默认权限已保存");
                    }}
                >
                    保存默认权限
                </Button>
            </Card>
        </div>
    );
}

// ---------------------------------------------------------------------------
// 渠道管理（多渠道，密钥只存服务器 channels.json）
// ---------------------------------------------------------------------------

const CAPABILITY_FIELDS = [
    { capability: "image" as const, label: "生图模型" },
    { capability: "video" as const, label: "视频模型" },
    { capability: "audio" as const, label: "音频模型" },
    { capability: "text" as const, label: "文本模型" },
];

type ChannelFormValues = {
    name: string;
    baseUrl: string;
    apiKey?: string;
    apiFormat: "openai" | "gemini" | "grok-video-v2";
    imageModels: string[];
    videoModels: string[];
    audioModels: string[];
    textModels: string[];
};

function channelToForm(channel: AdminAiChannel): ChannelFormValues {
    const byCap = (cap: string) => channel.models.filter((m) => m.capability === cap).map((m) => m.name);
    return { name: channel.name, baseUrl: channel.baseUrl, apiKey: "", apiFormat: channel.apiFormat, imageModels: byCap("image"), videoModels: byCap("video"), audioModels: byCap("audio"), textModels: byCap("text") };
}

function formToModels(values: ChannelFormValues): ServerChannelModel[] {
    return [
        ...(values.imageModels || []).map((name) => ({ name, capability: "image" as const })),
        ...(values.videoModels || []).map((name) => ({ name, capability: "video" as const })),
        ...(values.audioModels || []).map((name) => ({ name, capability: "audio" as const })),
        ...(values.textModels || []).map((name) => ({ name, capability: "text" as const })),
    ];
}

async function refreshServerChannels() {
    applyServerAiConfig(await backend.aiConfig());
}

function ChannelsManagerCard({ channels, onChanged }: { channels: AdminAiChannel[]; onChanged: () => void }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<ChannelFormValues>();
    const [editing, setEditing] = useState<AdminAiChannel | null>(null);
    const [creating, setCreating] = useState(false);
    const [pendingFormValues, setPendingFormValues] = useState<Partial<ChannelFormValues>>({});
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (creating) form.setFieldsValue(pendingFormValues);
    }, [creating, form, pendingFormValues]);

    function openCreate() {
        setPendingFormValues({ name: "", baseUrl: "", apiKey: "", apiFormat: "openai", imageModels: [], videoModels: [], audioModels: [], textModels: [] });
        setEditing(null);
        setCreating(true);
    }
    function openEdit(channel: AdminAiChannel) {
        setPendingFormValues(channelToForm(channel));
        setEditing(channel);
        setCreating(true);
    }

    async function save() {
        const values = await form.validateFields();
        setSaving(true);
        try {
            const models = formToModels(values);
            if (editing) {
                await backend.adminPatchChannel(editing.id, { name: values.name, baseUrl: values.baseUrl, apiKey: values.apiKey || "", apiFormat: values.apiFormat, models });
                message.success("渠道已更新并即时生效");
            } else {
                await backend.adminCreateChannel({ name: values.name, baseUrl: values.baseUrl, apiKey: values.apiKey || "", apiFormat: values.apiFormat, models });
                message.success("渠道已添加并即时生效");
            }
            setCreating(false);
            onChanged();
            void refreshServerChannels();
        } catch (e) {
            message.error(e instanceof Error ? e.message : "保存失败");
        } finally {
            setSaving(false);
        }
    }

    async function remove(channel: AdminAiChannel) {
        try {
            await backend.adminDeleteChannel(channel.id);
            message.success(`渠道「${channel.name}」已删除`);
            onChanged();
            void refreshServerChannels();
        } catch (e) {
            message.error(e instanceof Error ? e.message : "删除失败");
        }
    }

    const columns: ColumnsType<AdminAiChannel> = [
        { title: "名称", dataIndex: "name", width: 140, render: (v: string) => <span className="font-medium">{v}</span> },
        { title: "Base URL", dataIndex: "baseUrl", render: (v: string) => <code className="text-xs">{v}</code> },
        { title: "格式", dataIndex: "apiFormat", width: 120, render: (v: string) => <Tag className="!m-0">{v === "gemini" ? "Gemini" : v === "grok-video-v2" ? "Grok V2" : "OpenAI"}</Tag> },
        { title: "API Key", dataIndex: "apiKeyMasked", width: 140, render: (v: string) => <code className="text-xs">{v || "未设置"}</code> },
        { title: "模型数", key: "models", width: 80, render: (_, r) => <span className="tabular-nums">{r.models.length}</span> },
        {
            title: "操作",
            key: "actions",
            width: 140,
            render: (_, r) => (
                <div className="flex gap-1">
                    <Button size="small" onClick={() => openEdit(r)}>
                        编辑
                    </Button>
                    <Popconfirm title={`删除渠道「${r.name}」？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void remove(r)}>
                        <Button size="small" danger>
                            删除
                        </Button>
                    </Popconfirm>
                </div>
            ),
        },
    ];

    return (
        <Card
            title="AI 渠道管理（密钥只存服务器，保存即时生效）"
            className="!rounded-xl"
            extra={
                <Button type="primary" size="small" icon={<Plus className="size-3.5" />} onClick={openCreate}>
                    新增渠道
                </Button>
            }
        >
            <Table<AdminAiChannel> rowKey="id" columns={columns} dataSource={channels} pagination={false} size="small" scroll={{ x: 760 }} locale={{ emptyText: "暂无渠道，点击右上角「新增渠道」添加" }} />

            <Modal open={creating} title={editing ? `编辑渠道 · ${editing.name}` : "新增渠道"} onCancel={() => setCreating(false)} onOk={() => void save()} okText={editing ? "保存并生效" : "添加并生效"} cancelText="取消" confirmLoading={saving} width={640} destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false} className="mt-2">
                    <div className="grid gap-x-4 sm:grid-cols-2">
                        <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请输入名称" }]}>
                            <Input placeholder="如 OpenAI 官方 / 中转A" />
                        </Form.Item>
                        <Form.Item name="apiFormat" label="调用格式">
                            <Select
                                options={[
                                    { value: "openai", label: "OpenAI 兼容" },
                                    { value: "gemini", label: "Gemini" },
                                    { value: "grok-video-v2", label: "Grok Video V2（独立渠道）" },
                                ]}
                            />
                        </Form.Item>
                    </div>
                    <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: "请输入接口地址" }]}>
                        <Input placeholder="https://api.openai.com" />
                    </Form.Item>
                    <Form.Item name="apiKey" label={editing?.hasKey ? `API Key（当前：${editing.apiKeyMasked}，留空保持不变）` : "API Key"} rules={editing?.hasKey ? [] : [{ required: true, message: "请输入 API Key" }]}>
                        <Input.Password placeholder={editing?.hasKey ? "留空则不修改" : "sk-..."} autoComplete="new-password" />
                    </Form.Item>
                    <div className="grid gap-x-4 sm:grid-cols-2">
                        {CAPABILITY_FIELDS.map((f) => (
                            <Form.Item key={f.capability} name={`${f.capability}Models`} label={f.label}>
                                <Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入模型名后回车，可多个" open={false} suffixIcon={null} />
                            </Form.Item>
                        ))}
                    </div>
                </Form>
            </Modal>
        </Card>
    );
}

function DefaultModelsCard({ channels, defaultModels, onChanged }: { channels: AdminAiChannel[]; defaultModels: Record<"image" | "video" | "audio" | "text", string>; onChanged: () => void }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState({ ...defaultModels });
    const [saving, setSaving] = useState(false);

    useEffect(() => setDraft({ ...defaultModels }), [defaultModels]);

    const optionsFor = (capability: "image" | "video" | "audio" | "text") =>
        channels.flatMap((channel) =>
            channel.models.filter((m) => m.capability === capability).map((m) => ({ value: `${channel.id}::${m.name}`, label: `${m.name}（${channel.name}）` })),
        );

    async function save() {
        setSaving(true);
        try {
            await backend.adminSaveSettings({ defaultModels: draft });
            message.success("默认模型已保存并即时生效");
            onChanged();
            void refreshServerChannels();
        } catch (e) {
            message.error(e instanceof Error ? e.message : "保存失败");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card title="各能力默认模型（登录用户自动使用）" className="!rounded-xl">
            <div className="grid gap-x-4 sm:grid-cols-2">
                {CAPABILITY_FIELDS.map((f) => (
                    <div key={f.capability} className="mb-3">
                        <div className="mb-1 text-xs text-stone-500">{f.label}</div>
                        <Select allowClear value={draft[f.capability] || undefined} onChange={(v) => setDraft((d) => ({ ...d, [f.capability]: v || "" }))} options={optionsFor(f.capability)} placeholder="未设置" style={{ width: "100%" }} />
                    </div>
                ))}
            </div>
            <Button type="primary" loading={saving} onClick={() => void save()}>
                保存默认模型
            </Button>
        </Card>
    );
}

function ServerChannelsSection() {
    const { message } = App.useApp();
    const [channels, setChannels] = useState<AdminAiChannel[]>([]);
    const [defaultModels, setDefaultModels] = useState<Record<"image" | "video" | "audio" | "text", string>>({ image: "", video: "", audio: "", text: "" });
    const [agentLlm, setAgentLlm] = useState<ServerAgentLlmConfig>({ enabled: false, model: "", skills: [] });
    const [loading, setLoading] = useState(true);

    const reload = useCallback(() => {
        void Promise.all([backend.adminChannels(), backend.adminSettings()])
            .then(([channelsRes, settingsRes]) => {
                setChannels(channelsRes.channels);
                setDefaultModels(settingsRes.settings.defaultModels || { image: "", video: "", audio: "", text: "" });
                setAgentLlm(settingsRes.settings.agentLlm || { enabled: false, model: "", skills: [] });
            })
            .catch((e) => message.error(e instanceof Error ? e.message : "加载渠道失败"))
            .finally(() => setLoading(false));
    }, [message]);

    useEffect(() => {
        reload();
    }, [reload]);

    if (loading) return <Card className="!rounded-xl" loading />;
    return (
        <div className="space-y-4">
            <ChannelsManagerCard channels={channels} onChanged={reload} />
            <DefaultModelsCard channels={channels} defaultModels={defaultModels} onChanged={reload} />
            <AgentLlmSettingsCard channels={channels} config={agentLlm} onChanged={reload} />
        </div>
    );
}

const AGENT_SKILL_OPTIONS: { value: AgentSkillId; label: string; description: string }[] = [
    { value: "image-creation", label: "图片创作", description: "拆解需求、构图、风格与生图参数" },
    { value: "video-creation", label: "视频创作", description: "设计动作、镜头、时长与视频参数" },
    { value: "canvas-orchestration", label: "画布编排", description: "创建提示词、配置、结果节点并连线" },
    { value: "quality-review", label: "质量检查", description: "检查结果并给出下一轮优化建议" },
];

function AgentLlmSettingsCard({ channels, config, onChanged }: { channels: AdminAiChannel[]; config: ServerAgentLlmConfig; onChanged: () => void }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState(config);
    const [saving, setSaving] = useState(false);

    useEffect(() => setDraft(config), [config]);

    const modelOptions = channels.flatMap((channel) => channel.models.filter((model) => model.capability === "text").map((model) => ({ value: `${channel.id}::${model.name}`, label: `${model.name}（${channel.name}）` })));
    async function save() {
        if (draft.enabled && !draft.model) {
            message.warning("启用 Agent LLM 前请先选择文本模型");
            return;
        }
        if (draft.enabled && !draft.skills.length) {
            message.warning("请至少启用一个 Skill");
            return;
        }
        setSaving(true);
        try {
            await backend.adminSaveSettings({ agentLlm: draft });
            message.success("Agent LLM 配置已保存");
            onChanged();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card id="agent-llm-skills" title={<span className="inline-flex items-center gap-2"><Bot className="size-4 text-violet-500" />方案三：Skill + LLM Agent</span>} className="!rounded-xl">
            <div className="mb-4 rounded-lg border border-violet-500/20 bg-violet-500/[.04] px-3 py-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                使用服务器已配置的文本模型进行创作规划和质量检查。Agent LLM 不接触 API Key，生成图片或视频仍通过现有渠道和计费系统执行。
            </div>
            <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
                <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
                    启用方案三
                </label>
                <div className="space-y-4">
                    <div>
                        <div className="mb-1 text-xs text-stone-500">Agent LLM 文本模型</div>
                        <Select className="w-full" value={draft.model || undefined} onChange={(model) => setDraft((current) => ({ ...current, model }))} options={modelOptions} placeholder={modelOptions.length ? "选择文本模型" : "暂无文本模型渠道"} allowClear />
                    </div>
                    <div>
                        <div className="mb-2 text-xs text-stone-500">启用 Skill</div>
                        <Checkbox.Group value={draft.skills} onChange={(skills) => setDraft((current) => ({ ...current, skills: skills as AgentSkillId[] }))} className="grid gap-2 sm:grid-cols-2">
                            {AGENT_SKILL_OPTIONS.map((skill) => (
                                <Checkbox key={skill.value} value={skill.value}>
                                    <span className="text-sm">{skill.label}</span>
                                    <span className="ml-2 text-xs text-stone-400">{skill.description}</span>
                                </Checkbox>
                            ))}
                        </Checkbox.Group>
                    </div>
                    <Button type="primary" loading={saving} onClick={() => void save()}>保存 Agent LLM 配置</Button>
                </div>
            </div>
        </Card>
    );
}

type ApiMapRow = {
    key: string;
    feature: string;
    where: string;
    api: string;
    kind?: UsageKind;
    modelValue?: string;
    note?: string;
};

function ApiMapTab() {
    const config = useConfigStore((s) => s.config);
    const pricing = useAuthStore((s) => s.pricing);
    const modelPricing = useAuthStore((s) => s.modelPricing);

    // 解析当前配置的模型：名称 + 所属渠道 + 是否走服务器代理
    const resolveModel = (optionValue?: string) => {
        if (!optionValue) return null;
        const name = modelOptionName(optionValue);
        const channelId = optionValue.includes("::") ? optionValue.split("::")[0] : "";
        const channel = config.channels.find((c) => c.id === channelId);
        return { name, channelName: channel?.name || "未知渠道", viaProxy: isServerChannelId(channelId) };
    };
    const priceText = (kind?: UsageKind, model?: string) => {
        if (!kind) return "不计费";
        const specific = model !== undefined ? modelPricing[model] : undefined;
        return `${specific !== undefined ? specific : pricing[kind]} 点/次${specific !== undefined ? "（模型价）" : "（类型价）"}`;
    };

    const rows: ApiMapRow[] = [
        { key: "t2i", feature: "文生图", where: "生图工作台 · 画布图片节点 · Agent 生图工具", api: "POST /v1/images/generations", kind: "image", modelValue: config.imageModel },
        { key: "edit", feature: "参考图编辑 / 图生图", where: "生图工作台（带参考图/蒙版）· 画布", api: "POST /v1/images/edits", kind: "image", modelValue: config.imageModel },
        { key: "text", feature: "文案 / 对话生成", where: "图片问答 · 画布文本节点 · Agent 文本工具", api: "POST /v1/responses（流式 SSE）", kind: "text", modelValue: config.textModel },
        { key: "video", feature: "视频生成", where: "视频创作台 · 画布视频节点", api: "POST /v1/videos → 轮询 GET /v1/videos/{id}；Seedance 渠道为 /contents/generations/tasks", kind: "video", modelValue: config.videoModel },
        { key: "audio", feature: "音频生成", where: "画布音频节点", api: "POST /v1/audio/speech", kind: "audio", modelValue: config.audioModel },
        { key: "models", feature: "模型列表拉取", where: "配置页 · 工作台模型选择", api: "GET /v1/models", note: "仅查询可用模型，不产生生成费用" },
        { key: "agent", feature: "Agent 助手（Codex）", where: "顶栏 / 画布 Agent 面板", api: "本地 canvas-agent 服务（127.0.0.1，SSE + /api/tools）", note: "Codex 模型由本机 CLI 决定；其触发的生成走上面各行接口并正常计费" },
    ];

    const columns: ColumnsType<ApiMapRow> = [
        { title: "功能", dataIndex: "feature", width: 170, render: (v: string) => <span className="font-medium">{v}</span> },
        { title: "触发位置", dataIndex: "where", width: 230, render: (v: string) => <span className="text-xs text-stone-500 dark:text-stone-400">{v}</span> },
        { title: "调用的 API", dataIndex: "api", render: (v: string) => <code className="text-xs">{v}</code> },
        {
            title: "使用的大模型（当前配置）",
            key: "model",
            width: 240,
            render: (_, row) => {
                if (!row.modelValue) return <span className="text-xs text-stone-400">{row.note ?? "—"}</span>;
                const model = resolveModel(row.modelValue);
                if (!model?.name) return <Tag color="red">未配置</Tag>;
                return (
                    <div className="flex flex-wrap items-center gap-1">
                        <Tag className="!m-0 font-mono">{model.name}</Tag>
                        <Tag className="!m-0" color={model.viaProxy ? "green" : "default"}>
                            {model.viaProxy ? "服务器代理" : model.channelName}
                        </Tag>
                    </div>
                );
            },
        },
        {
            title: "计费",
            key: "price",
            width: 140,
            render: (_, row) => <span className="text-xs tabular-nums">{priceText(row.kind, row.modelValue ? modelOptionName(row.modelValue) : undefined)}</span>,
        },
    ];

    return (
        <div className="space-y-4">
            <ServerChannelsSection />
            <p className="text-sm text-stone-500 dark:text-stone-400">
                各功能与外部 AI 接口、当前模型的对照关系。服务器已配置密钥时，所有请求经 <code>/api/ai</code> 代理转发（密钥不出服务器）；Gemini 格式渠道的实际路径不同。修改单价请前往「计费设置」。
            </p>
            <Table<ApiMapRow> rowKey="key" columns={columns} dataSource={rows} pagination={false} size="middle" scroll={{ x: 1000 }} />
        </div>
    );
}

export default function AdminPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const initialTab = searchParams.get("tab") || "users";

    useEffect(() => {
        if (initialTab !== "api-map" || searchParams.get("focus") !== "agent-llm") return;
        requestAnimationFrame(() => document.getElementById("agent-llm-skills")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }, [initialTab, searchParams]);

    return (
        <main className="h-full overflow-y-auto bg-background px-6 py-6 text-stone-950 dark:text-stone-100">
            <div className="mx-auto max-w-6xl">
                <div className="mb-6 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <ShieldCheck className="size-6 text-amber-500" />
                        <h1 className="text-xl font-semibold">管理后台</h1>
                    </div>
                    <div className="flex items-center gap-3">
                        <Link to="/admin?tab=api-map&focus=agent-llm" className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/30 px-3 py-1.5 text-sm text-violet-600 transition hover:bg-violet-500/10 dark:text-violet-300">
                            <Bot className="size-4" />
                            Agent LLM / Skill
                        </Link>
                        <Link to="/" className="inline-flex items-center gap-1 text-sm text-stone-500 transition hover:text-stone-900 dark:hover:text-stone-100">
                            <ArrowLeft className="size-4" />
                            返回应用
                        </Link>
                    </div>
                </div>

                <Tabs
                    activeKey={initialTab}
                    onChange={(key) => navigate(`/admin?tab=${key}`)}
                    items={[
                        { key: "users", label: <span className="inline-flex items-center gap-1.5"><KeyRound className="size-4" />用户与权限</span>, children: <UsersTab /> },
                        { key: "stats", label: <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" />内容统计</span>, children: <StatsTab /> },
                        { key: "billing", label: <span className="inline-flex items-center gap-1.5"><Coins className="size-4" />计费设置</span>, children: <BillingTab /> },
                        { key: "api-map", label: <span className="inline-flex items-center gap-1.5"><Cable className="size-4" />渠道与模型</span>, children: <ApiMapTab /> },
                    ]}
                />
            </div>
        </main>
    );
}
