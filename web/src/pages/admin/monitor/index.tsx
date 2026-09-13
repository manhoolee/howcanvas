import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Select, Space, Spin, Switch, Table, Tag, Timeline, Tooltip, theme } from "antd";
import { Activity, ArrowLeft, BarChart3, CheckCircle2, Coins, Download, Gauge, Sun, HardDrive, Layers3, RefreshCw, Settings2, ShieldCheck, Users } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import {
    observabilityApi as api,
    type Usage,
    type Report,
    type Snapshot,
    type Options,
    type Task,
    type TaskDetail,
    type Credits,
    type Runtime,
    type Group,
    type Filters,
    type Artifacts,
    type ActivityEvent,
    type UserRow,
} from "@/services/api/observability";
import { useThemeStore } from "@/stores/use-theme-store";
import { Chart, chartColors } from "./chart";
import "./monitor.css";

const kindName: Record<string, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const statusName: Record<string, string> = { succeeded: "成功", partial: "部分成功", failed: "失败", canceled: "已取消", queued: "排队", running: "进行中", unknown: "待核实", pending: "待结算", completed: "已结算" };
const errorName: Record<string, string> = {
    rate_limit: "上游限流",
    provider_auth: "渠道鉴权",
    timeout: "超时",
    quota: "额度不足",
    storage: "存储异常",
    verification: "验证失败",
    retrieval: "取回失败",
    provider_5xx: "上游服务错误",
    other: "其他错误",
    unknown: "历史原因未知",
    stream_or_transport: "响应中断",
};
const fmt = (n: number | null | undefined, digits = 0) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("zh-CN", { maximumFractionDigits: digits }));
const percent = (n: number | null | undefined) => (n == null ? "—" : `${fmt(n, 2)}%`);
const bytes = (n: number | null | undefined) => (n == null ? "—" : n >= 1073741824 ? `${fmt(n / 1073741824, 2)} GB` : `${fmt(n / 1048576, 1)} MB`);
const duration = (n: number | null | undefined) => (n == null ? "—" : n > 60000 ? `${fmt(n / 60000, 1)} 分钟` : `${fmt(n / 1000, 1)} 秒`);
const time = (value: string | null | undefined) => (value ? dayjs(value).format("MM-DD HH:mm:ss") : "—");
const statusTag = (value: string) => <Tag color={value === "succeeded" || value === "completed" ? "success" : value === "failed" ? "error" : value === "partial" || value === "unknown" ? "warning" : "default"}>{statusName[value] || value}</Tag>;
const sections = [
    ["overview", "运行总览", Gauge],
    ["success", "生成成功率", CheckCircle2],
    ["services", "服务与负荷", Activity],
    ["users", "用户与在线", Users],
    ["usage", "使用与留存", BarChart3],
    ["models", "模型与渠道", Layers3],
    ["tasks", "任务与交付", BarChart3],
    ["artifacts", "成品与存储", HardDrive],
    ["credits", "积分与对账", Coins],
    ["events", "告警与审计", ShieldCheck],
    ["manage", "管理处置", Settings2],
] as const;

function Panel({ title, description, children, action }: { title: string; description?: string; children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <section className="monitor-panel">
            <div className="monitor-panel-title">
                <div>
                    <h2>{title}</h2>
                    {description && <p>{description}</p>}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}
function Stat({ label, value, detail, warning }: { label: string; value: React.ReactNode; detail?: string; warning?: boolean }) {
    return (
        <div className={`monitor-stat${warning ? " monitor-warning" : ""}`}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail || "\u00a0"}</small>
        </div>
    );
}

export default function MonitorPage() {
    const themeMode = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const [search, setSearch] = useSearchParams();
    const section = search.get("view") || "overview";
    const [range, setRange] = useState("24h");
    const [custom, setCustom] = useState<[string, string] | null>(null);
    const [filters, setFilters] = useState<Filters>({});
    const [auto, setAuto] = useState(true);
    const [report, setReport] = useState<Report | null>(null);
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [options, setOptions] = useState<Options | null>(null);
    const [usage, setUsage] = useState<Usage | null>(null);
    const [runtime, setRuntime] = useState<Runtime | null>(null);
    const [credits, setCredits] = useState<Credits | null>(null);
    const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [tasks, setTasks] = useState<{ total: number; items: Task[] }>({ total: 0, items: [] });
    const [page, setPage] = useState(1);
    const [taskStatus, setTaskStatus] = useState("");
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [drawer, setDrawer] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const epoch = useRef(0);
    const [action, setAction] = useState<{ action: string; id?: string; title: string; value?: number } | null>(null);
    const [reason, setReason] = useState("");
    const [acting, setActing] = useState(false);
    const filter = (key: string, value: string) => {
        setFilters((f) => {
            const next = { ...f };
            value ? (next[key] = value) : delete next[key];
            return next;
        });
        setPage(1);
    };
    const refresh = useCallback(async () => {
        const current = ++epoch.current;
        setRefreshing(true);
        const end = custom?.[1] || new Date().toISOString();
        const start = custom?.[0] || new Date(Date.parse(end) - ({ "2h": 2, "24h": 24, "7d": 168, "30d": 720 }[range] || 24) * 3600000).toISOString();
        const query = { ...filters, from: start, to: end };
        try {
            const {
                report: r,
                options: o,
                runtime: rt,
                credits: c,
                artifacts: a,
                tasks: ts,
                events: ev,
                usage: us,
            } = await api.dashboard({ ...query, offset: String((page - 1) * 25), limit: "25", ...(taskStatus ? { status: taskStatus } : {}), entity: section === "events" ? search.get("event") || "audit" : "activity" });
            if (epoch.current !== current) return;
            setReport(r);
            setOptions(o);
            setRuntime(rt);
            setCredits(c);
            setArtifacts(a);
            setTasks(ts);
            setEvents(ev.items);
            setUsage(us);
            setError("");
        } catch (e) {
            if (epoch.current === current) setError(e instanceof Error ? e.message : "后台数据查询失败");
        } finally {
            if (epoch.current === current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, [range, custom, filters, page, taskStatus, section, search]);
    useEffect(() => {
        void refresh();
        if (!auto || custom) return;
        const t = setInterval(() => void refresh(), 30000);
        return () => {
            clearInterval(t);
        };
    }, [refresh, auto, custom]);
    useEffect(() => {
        let alive = true;
        const fetch = () =>
            api
                .snapshot()
                .then((s) => {
                    if (alive) setSnapshot(s);
                })
                .catch(() => {});
        void fetch();
        const source = new EventSource("/api/admin/observability/stream", { withCredentials: true });
        source.onmessage = (e) => {
            try {
                if (alive) setSnapshot(JSON.parse(e.data));
            } catch {}
        };
        source.onerror = () => {
            void fetch();
        };
        const t = setInterval(() => {
            if (source.readyState !== EventSource.OPEN) void fetch();
        }, 15000);
        return () => {
            alive = false;
            clearInterval(t);
            source.close();
        };
    }, []);
    const openTask = async (id: string) => {
        setDrawer(true);
        setDetail(null);
        try {
            setDetail(await api.task(id));
        } catch (e) {
            void message.error(e instanceof Error ? e.message : "无法打开任务");
        }
    };
    const manage = async () => {
        if (!action) return;
        setActing(true);
        try {
            await api.action({ ...action, reason });
            void message.success("操作已完成并记录审计");
            setAction(null);
            setReason("");
            void refresh();
            setSnapshot(await api.snapshot());
        } catch (e) {
            void message.error(e instanceof Error ? e.message : "操作失败");
        } finally {
            setActing(false);
        }
    };
    const userName = (id: string) => options?.users.find((u) => u.id === id)?.name || "历史用户";
    const channelName = (id: string) => snapshot?.channels.find((c) => c.id === id)?.name || id || "未知渠道";
    const labels = report?.series.map((p) => dayjs(p.at).format(range === "2h" || range === "24h" ? "HH:mm" : "MM-DD HH:mm")) || [];
    const trend = (keys: { key: keyof Report["series"][number]; name: string }[], percentAxis = false) => ({
        tooltip: { trigger: "axis" },
        xAxis: { type: "category", data: labels, axisLabel: { color: token.colorTextSecondary, hideOverlap: true } },
        yAxis: { type: "value", max: percentAxis ? 100 : undefined, axisLabel: { color: token.colorTextSecondary, formatter: percentAxis ? "{value}%" : "{value}" }, splitLine: { lineStyle: { color: token.colorBorderSecondary } } },
        dataZoom: [{ type: "inside" }],
        series: keys.map((k) => ({ name: k.name, type: "line", showSymbol: true, symbolSize: 4, connectNulls: false, smooth: false, data: report?.series.map((p) => p[k.key]) || [] })),
    });
    const runtimeTrend = (keys: { key: string; name: string; divisor?: number }[]) => ({
        xAxis: { type: "time", axisLabel: { color: token.colorTextSecondary } },
        yAxis: { type: "value", axisLabel: { color: token.colorTextSecondary }, splitLine: { lineStyle: { color: token.colorBorderSecondary } } },
        dataZoom: [{ type: "inside" }],
        series: keys.map((k) => ({ name: k.name, type: "line", showSymbol: false, connectNulls: false, data: runtime?.series.map((p) => [p.at, p[k.key] == null ? null : Number(p[k.key]) / (k.divisor || 1)]) || [] })),
    });
    const ranking = (rows: Group[], label: (r: Group) => string, success = false) => ({
        grid: { left: 12, right: 42, top: 20, bottom: 25, containLabel: true },
        xAxis: { type: "value", max: success ? 100 : undefined, splitLine: { lineStyle: { color: token.colorBorderSecondary } } },
        yAxis: { type: "category", inverse: true, data: rows.slice(0, 10).map(label), axisLabel: { color: token.colorTextSecondary, width: 160, overflow: "truncate" } },
        series: [
            {
                type: "bar",
                barMaxWidth: 20,
                data: rows.slice(0, 10).map((r) => (success ? r.successRate : r.total)),
                label: { show: true, position: "right", color: token.colorTextSecondary, formatter: (p: { value: number }) => (success ? percent(p.value) : fmt(p.value)) },
                itemStyle: { borderRadius: [0, 3, 3, 0] },
            },
        ],
    });
    const s = report?.summary;
    const groupColumns = [
        { title: "任务", dataIndex: "total", sorter: (a: Group, b: Group) => a.total - b.total },
        {
            title: "成功率",
            dataIndex: "successRate",
            render: (v: number | null, r: Group) => (
                <Tooltip title={`成功 ${r.succeeded} / 有效分母 ${r.denominator}；未决 ${r.running + r.queued + r.unknown}`}>
                    <span className="monitor-rate">
                        {percent(v)} {r.denominator < 30 && <small>小样本</small>}
                    </span>
                </Tooltip>
            ),
        },
        { title: "成功 / 部分 / 失败", render: (_: unknown, r: Group) => `${r.succeeded} / ${r.partial} / ${r.failed}` },
        { title: "成品", dataIndex: "outputs" },
        { title: "交付 P95", dataIndex: "p95Ms", render: duration },
    ];
    const taskColumns = [
        {
            title: "任务",
            dataIndex: "id",
            render: (id: string, r: Task) => (
                <button className="monitor-link" onClick={() => void openTask(id)}>
                    {kindName[r.kind] || r.kind} · {id.slice(0, 8)}
                </button>
            ),
        },
        {
            title: "用户",
            dataIndex: "userId",
            render: (id: string) => (
                <button className="monitor-link" onClick={() => filter("userId", id)}>
                    {userName(id)}
                </button>
            ),
        },
        { title: "模型", dataIndex: "model", ellipsis: true },
        { title: "状态", dataIndex: "status", render: statusTag },
        { title: "成品", render: (_: unknown, r: Task) => `${r.delivered} / ${r.expected ?? "未知"}` },
        { title: "受理时间", dataIndex: "createdAt", render: time },
        { title: "异常", dataIndex: "errorCode", render: (v: string) => errorName[v] || v || "—" },
    ];
    const successContent = (
        <>
            <div className="monitor-stats">
                <Stat label="完整交付成功率" value={percent(s?.successRate)} detail={`成功 ${fmt(s?.succeeded)} / 分母 ${fmt(s?.denominator)}`} />
                <Stat label="首次成功率" value={percent(s?.firstSuccessRate)} detail={`已记录重试情况 ${fmt(s?.retryKnown)} 个任务`} />
                <Stat label="上游生成成功率" value={percent(s?.upstreamSuccessRate)} detail="上游结果已确定的任务" />
                <Stat label="输出成功率" value={percent(s?.outputSuccessRate)} detail="预期数量已知的已终止任务" />
                <Stat label="重试挽回率" value={percent(s?.retryRecoveryRate)} detail="已终止且发生重试的任务" />
            </div>
            <div className="monitor-grid">
                <Panel title="成功率与首次成功率" description="按任务受理时间分组；尚未结束的任务单独保留">
                    <Chart
                        label="生成成功率时间趋势"
                        option={trend(
                            [
                                { key: "successRate", name: "完整交付成功率" },
                                { key: "firstSuccessRate", name: "首次成功率" },
                            ],
                            true,
                        )}
                    />
                </Panel>
                <Panel title="有效样本与任务结果" description="部分成功纳入严格成功率的分母">
                    <Chart
                        label="成功失败部分成功与未决任务堆叠柱图"
                        option={{
                            ...trend([]),
                            series: ["succeeded", "partial", "failed", "unknown", "running", "queued"].map((key, i) => ({
                                name: statusName[key],
                                type: "bar",
                                stack: "result",
                                itemStyle: { color: [chartColors[2], chartColors[3], chartColors[4], token.colorTextQuaternary, chartColors[0], chartColors[1]][i] },
                                data: report?.series.map((p) => p[key as keyof typeof p]) || [],
                            })),
                        }}
                    />
                </Panel>
            </div>
            <div className="monitor-grid">
                <Panel title="模型成功率" description="点击模型继续筛选；同时查看下方样本数">
                    <Chart label="各模型生成成功率比较" option={ranking(report?.models || [], (r) => r.id, true)} onSelect={(id) => filter("model", id)} />
                </Panel>
                <Panel title="失败原因" description="点击任务明细查看具体失败阶段">
                    <Chart label="失败原因分布" option={ranking(report?.errors || [], (r) => errorName[r.id] || r.id)} />
                </Panel>
            </div>
            <Panel title="用户 × 模型成功率" description="每格对应当前时间段的去重任务；灰色表示没有已确定样本">
                {report?.matrix.length ? (
                    <Chart
                        label="用户与模型生成成功率交叉热力图"
                        height={Math.max(300, Math.min(620, (report?.users.length || 0) * 36 + 120))}
                        onSelect={(_, index) => {
                            const g = report.matrix.filter((g) => report.models.slice(0, 15).some((m) => m.id === g.model) && report.users.slice(0, 20).some((u) => u.id === g.userId))[index];
                            if (g?.userId) filter("userId", g.userId);
                        }}
                        option={{
                            tooltip: { trigger: "item", renderMode: "richText", formatter: (p: { data: [number, number, number, string] }) => p.data[3] },
                            grid: { left: 110, right: 30, top: 25, bottom: 100 },
                            xAxis: { type: "category", data: report.models.slice(0, 15).map((g) => g.id), axisLabel: { rotate: 20, width: 120, overflow: "truncate", color: token.colorTextSecondary } },
                            yAxis: { type: "category", data: report.users.slice(0, 20).map((u) => u.name), axisLabel: { width: 90, overflow: "truncate", color: token.colorTextSecondary } },
                            visualMap: {
                                dimension: 2,
                                min: 0,
                                max: 100,
                                orient: "horizontal",
                                bottom: 0,
                                left: "center",
                                calculable: true,
                                outOfRange: { color: token.colorFillSecondary },
                                inRange: { color: ["#be123c", "#fbbf24", "#059669"] },
                                textStyle: { color: token.colorText },
                            },
                            series: [
                                {
                                    type: "heatmap",
                                    data: report.matrix
                                        .filter((g) => report.models.slice(0, 15).some((m) => m.id === g.model) && report.users.slice(0, 20).some((u) => u.id === g.userId))
                                        .map((g) => [
                                            report.models.findIndex((m) => m.id === g.model),
                                            report.users.findIndex((u) => u.id === g.userId),
                                            g.successRate ?? -1,
                                            `${userName(g.userId || "")} · ${g.model}\n成功率 ${percent(g.successRate)}\n成功 ${g.succeeded} / 分母 ${g.denominator}`,
                                        ]),
                                    label: { show: true, formatter: (p: { data: [number, number, number] }) => (p.data[2] < 0 ? "—" : `${Math.round(p.data[2])}%`) },
                                },
                            ],
                        }}
                    />
                ) : (
                    <Empty description="此时间段没有可比较的任务" />
                )}
            </Panel>
            <Panel title="模型成功率明细">
                <Table
                    rowKey="id"
                    size="small"
                    scroll={{ x: 850 }}
                    dataSource={report?.models}
                    columns={[
                        {
                            title: "模型",
                            dataIndex: "id",
                            render: (id: string) => (
                                <button className="monitor-link" onClick={() => filter("model", id)}>
                                    {id}
                                </button>
                            ),
                        },
                        ...groupColumns,
                    ]}
                />
            </Panel>
        </>
    );
    return (
        <main
            className="monitor-shell"
            style={
                {
                    "--monitor-bg": token.colorBgLayout,
                    "--monitor-panel": token.colorBgContainer,
                    "--monitor-text": token.colorText,
                    "--monitor-muted": token.colorTextSecondary,
                    "--monitor-line": token.colorBorderSecondary,
                    "--monitor-hover": token.colorFillTertiary,
                } as React.CSSProperties
            }
        >
            <aside className="monitor-nav">
                <Link className="monitor-brand" to="/admin/monitor">
                    <Activity size={23} />
                    <span>
                        画布运行中心<small>HowCanvas / Operations</small>
                    </span>
                </Link>
                <nav>
                    {sections.map(([id, label, Icon]) => (
                        <button key={id} className={section === id ? "selected" : ""} onClick={() => setSearch({ view: id })}>
                            <Icon size={17} />
                            {label}
                        </button>
                    ))}
                </nav>
                <div className="monitor-nav-footer">
                    <Link to="/admin">
                        <Settings2 size={15} />
                        账户、计费与渠道设置
                    </Link>
                    <Link to="/">
                        <ArrowLeft size={15} />
                        返回画布
                    </Link>
                    <small>{snapshot?.version ? `版本 ${snapshot.version}` : "正在连接后台"}</small>
                </div>
            </aside>
            <div className="monitor-main">
                <header className="monitor-header">
                    <div>
                        <div className="monitor-kicker">运行 · 产出 · 交付</div>
                        <h1>{sections.find((x) => x[0] === section)?.[1] || "运行总览"}</h1>
                        <p>让每次生成、每件成品与每笔积分都有据可查。</p>
                    </div>
                    <Space>
                        <Button aria-label="切换主题" icon={<Sun size={15} />} onClick={() => setTheme(themeMode === "dark" ? "light" : "dark")} />
                        <Tag color={snapshot?.worker.error ? "warning" : "success"}>{snapshot?.worker.error ? "数据延迟" : snapshot ? "已连接" : "连接中"}</Tag>
                        <Tooltip title="自动更新历史图表；实时状态独立更新">
                            <Switch checked={auto} onChange={setAuto} checkedChildren="自动" unCheckedChildren="暂停" />
                        </Tooltip>
                        <Button icon={<RefreshCw size={15} />} loading={refreshing} onClick={() => void refresh()}>
                            刷新
                        </Button>
                        <Button
                            icon={<Download size={15} />}
                            onClick={() => {
                                if (report) void api.export({ ...filters, from: report.from, to: report.to, type: ["users", "models", "credits", "artifacts"].includes(section) ? section : "tasks" }).catch((e) => message.error(e.message));
                            }}
                        >
                            导出
                        </Button>
                    </Space>
                </header>
                <div className="monitor-filters">
                    <Select
                        aria-label="时间范围"
                        value={custom ? "custom" : range}
                        style={{ width: 140 }}
                        onChange={(v) => {
                            if (v !== "custom") {
                                setRange(v);
                                setCustom(null);
                            }
                        }}
                        options={[
                            { value: "2h", label: "最近 2 小时" },
                            { value: "24h", label: "最近 24 小时" },
                            { value: "7d", label: "最近 7 天" },
                            { value: "30d", label: "最近 30 天" },
                            { value: "custom", label: "自定义时间" },
                        ]}
                    />
                    <DatePicker.RangePicker
                        showTime
                        allowClear
                        value={custom ? [dayjs(custom[0]), dayjs(custom[1])] : null}
                        onChange={(v) => {
                            setCustom(v?.[0] && v?.[1] ? [v[0].toISOString(), v[1].toISOString()] : null);
                        }}
                    />
                    <Select
                        aria-label="筛选用户"
                        mode="multiple"
                        maxTagCount={1}
                        allowClear
                        placeholder="全部用户"
                        style={{ minWidth: 170, maxWidth: 250 }}
                        value={filters.userId?.split(",") || []}
                        onChange={(v) => filter("userId", v.join(","))}
                        options={options?.users.map((u) => ({ value: u.id, label: u.name }))}
                    />
                    <Select
                        aria-label="筛选模型"
                        showSearch
                        allowClear
                        placeholder="全部模型"
                        style={{ minWidth: 170, maxWidth: 250 }}
                        value={filters.model}
                        onChange={(v) => filter("model", v || "")}
                        options={options?.models.map((m) => ({ value: m.id, label: m.id }))}
                    />
                    <Select aria-label="筛选类型" allowClear placeholder="全部类型" style={{ width: 115 }} value={filters.kind} onChange={(v) => filter("kind", v || "")} options={Object.entries(kindName).map(([value, label]) => ({ value, label }))} />
                    <Select
                        aria-label="筛选渠道"
                        allowClear
                        placeholder="全部渠道"
                        style={{ width: 160 }}
                        value={filters.channelId}
                        onChange={(v) => filter("channelId", v || "")}
                        options={snapshot?.channels.map((c) => ({ value: c.id, label: c.name }))}
                    />
                    <Select
                        aria-label="账户类型"
                        allowClear
                        placeholder="含管理员"
                        style={{ width: 125 }}
                        value={filters.role}
                        onChange={(v) => filter("role", v || "")}
                        options={[
                            { value: "user", label: "普通用户" },
                            { value: "admin", label: "管理员" },
                        ]}
                    />
                    {Object.keys(filters).length > 0 && (
                        <Button type="text" onClick={() => setFilters({})}>
                            清除筛选
                        </Button>
                    )}
                </div>
                <div className="monitor-meta">
                    <span>北京时间 · {report ? `${time(report.from)} — ${time(report.to)}` : "正在查询"}</span>
                    <span>
                        数据截止 {time(report?.asOf)} · 实时快照 {time(snapshot?.at)}
                    </span>
                </div>
                {error && <Alert type="error" showIcon title={error} description="页面保留上次数据。请重试或缩短查询区间；未知与过期数据不视为零值。" action={<Button onClick={() => void refresh()}>重试</Button>} />}
                {report && (
                    <div className="monitor-coverage">
                        历史任务自 {time(report.coverage.historicalFrom)}；在线、调用与负荷自 {time(report.coverage.telemetryFrom)} 开始采集。未决任务 {s ? s.running + s.queued + s.unknown : 0}；预期产出数量已知 {report.coverage.strictOutputMeasured}/
                        {s?.total}。
                        <Tooltip title={`${report.coverage.legacy}；${report.coverage.external}`}>
                            <span>统计范围说明 ⓘ</span>
                        </Tooltip>
                    </div>
                )}
                {loading && (
                    <div className="monitor-loading">
                        <Spin size="large" />
                        <p>正在汇总任务、交付与积分数据</p>
                    </div>
                )}
                {!loading && (
                    <div className="monitor-content">
                        {section === "overview" && (
                            <>
                                <div className="monitor-stats">
                                    <Stat label="此刻在线用户" value={fmt(snapshot?.online)} detail={`${fmt(snapshot?.active)} 人最近5分钟活跃`} />
                                    <Stat label="图片执行 / 排队" value={`${fmt(snapshot?.running)} / ${fmt(snapshot?.queued)}`} detail={`执行上限 ${fmt(snapshot?.imageLimit)} · 等待 ${duration(snapshot?.oldestWaitMs)}`} />
                                    <Stat label="上游请求并发" value={fmt(snapshot?.upstreamConcurrent)} detail="生成、状态查询、取回分别追踪" />
                                    <Stat label="区间生成任务" value={fmt(s?.total)} detail={`${fmt(report?.users.length)} 位用户提交生成`} />
                                    <Stat label="完整交付成功率" value={percent(s?.successRate)} detail={`成功 ${fmt(s?.succeeded)} / 分母 ${fmt(s?.denominator)}`} />
                                    <Stat label="区间交付成品" value={fmt(artifacts?.total)} detail={`当前筛选 · ${bytes(artifacts?.bytes)}`} />
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="在线与活跃" description="全站去重用户数；按时间桶显示平均值">
                                        <Chart
                                            label="在线用户与活跃用户趋势"
                                            option={runtimeTrend([
                                                { key: "online", name: "在线用户" },
                                                { key: "active", name: "活跃用户" },
                                            ])}
                                        />
                                    </Panel>
                                    <Panel title="执行、排队与上游并发" description="全站图片执行数与队列，上游请求包含查询和取回">
                                        <Chart
                                            label="任务并发与排队趋势"
                                            option={runtimeTrend([
                                                { key: "runningMax", name: "图片执行峰值" },
                                                { key: "queuedMax", name: "排队峰值" },
                                                { key: "upstreamConcurrentMax", name: "上游并发峰值" },
                                            ])}
                                        />
                                    </Panel>
                                    <Panel title="任务结果趋势" description="点击成功率页查看用户、模型交叉分析">
                                        <Chart
                                            label="生成成功失败趋势"
                                            option={trend([
                                                { key: "succeeded", name: "成功" },
                                                { key: "failed", name: "失败" },
                                                { key: "partial", name: "部分成功" },
                                            ])}
                                        />
                                    </Panel>
                                    <Panel title="模型调用与任务分布" description="任务数按请求模型归属；点击筛选模型">
                                        <Chart label="模型任务排行" option={ranking(report?.models || [], (r) => r.id)} onSelect={(id) => filter("model", id)} />
                                    </Panel>
                                </div>
                                <Panel title="需要关注" description="未决任务与当前告警持续保留">
                                    <Space wrap>
                                        {snapshot?.alerts.map((a) => (
                                            <Tag key={a.id} color="warning">
                                                {a.title}
                                            </Tag>
                                        ))}
                                        <Tag color={s?.unknown ? "warning" : "default"}>结果待核实 {fmt(s?.unknown)}</Tag>
                                        <Tag>取消 {fmt(s?.canceled)}</Tag>
                                        <Tag>排队 {fmt(s?.queued)}</Tag>
                                        <Tag>进行中 {fmt(s?.running)}</Tag>
                                        <Tag color={credits?.pending.length ? "warning" : "default"}>待结算 {fmt(credits?.pending.length)}</Tag>
                                    </Space>
                                </Panel>
                            </>
                        )}
                        {section === "success" && successContent}
                        {section === "services" && (
                            <>
                                <Alert type="info" title="资源负荷为全站指标，用户、模型和类型筛选不分摊服务器资源。" />
                                <div className="monitor-stats">
                                    <Stat label="宿主机 CPU" value={percent(snapshot?.hostCpuPercent)} detail="按宿主机总核心容量归一化" />
                                    <Stat label="宿主机内存" value={percent(snapshot?.hostMemoryPercent)} />
                                    <Stat label="磁盘使用" value={percent(snapshot?.diskUsedPercent)} />
                                    <Stat label="Node 进程内存" value={bytes(snapshot?.memoryBytes)} />
                                    <Stat label="事件循环 P95" value={`${fmt(snapshot?.eventLoopP95Ms, 1)} ms`} />
                                    <Stat label="HTTP / SSE 连接" value={`${fmt(snapshot?.httpConcurrent)} / ${fmt(snapshot?.sseConnections)}`} />
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="服务器资源趋势">
                                        <Chart
                                            label="服务器CPU内存和磁盘负荷折线图"
                                            option={runtimeTrend([
                                                { key: "hostCpuPercent", name: "CPU %" },
                                                { key: "hostMemoryPercent", name: "内存 %" },
                                                { key: "diskUsedPercent", name: "磁盘 %" },
                                            ])}
                                        />
                                    </Panel>
                                    <Panel title="进程内存与事件循环">
                                        <Chart label="进程内存趋势" option={runtimeTrend([{ key: "memoryBytes", name: "进程内存 MB", divisor: 1048576 }])} />
                                    </Panel>
                                </div>
                                <Panel title="容器与服务">
                                    <Table
                                        rowKey="name"
                                        size="small"
                                        dataSource={snapshot?.host?.containers || []}
                                        columns={[
                                            { title: "服务", dataIndex: "name" },
                                            { title: "CPU", dataIndex: "cpu" },
                                            { title: "内存", dataIndex: "memory" },
                                            { title: "状态", dataIndex: "status" },
                                        ]}
                                        locale={{ emptyText: "主机采集尚未接入或已过期" }}
                                    />
                                    <Space wrap>
                                        {snapshot?.host?.checks?.map((c) => (
                                            <Tag key={c.name} color={c.ok ? "success" : "error"}>
                                                {c.name} · {c.ok ? "可达" : "异常"} · {c.latencyMs} ms
                                            </Tag>
                                        ))}
                                    </Space>
                                </Panel>
                            </>
                        )}
                        {section === "users" && (
                            <>
                                <div className="monitor-grid">
                                    <Panel title="用户生成任务" description="点击用户下钻">
                                        <Chart
                                            label="按用户生成任务排行"
                                            option={ranking(report?.users || [], (r) => r.name || r.id)}
                                            onSelect={(_, i) => {
                                                const u = report?.users[i];
                                                if (u) filter("userId", u.id);
                                            }}
                                        />
                                    </Panel>
                                    <Panel title="用户成功率">
                                        <Chart label="按用户生成成功率排行" option={ranking(report?.users || [], (r) => r.name || r.id, true)} />
                                    </Panel>
                                </div>
                                <Panel title="此刻在线" description="全站近期收到客户端心跳的去重账户；浏览器挂起后90秒过期">
                                    <Table
                                        rowKey="userId"
                                        size="small"
                                        dataSource={snapshot?.people}
                                        columns={[
                                            { title: "用户", dataIndex: "name" },
                                            { title: "位置", dataIndex: "page" },
                                            {
                                                title: "状态",
                                                render: (_: unknown, r: Snapshot["people"][number]) => (
                                                    <Tag color={r.active ? "success" : "default"}>
                                                        {r.active ? "活跃" : "空闲"} · {r.visible ? "前台" : "后台"}
                                                    </Tag>
                                                ),
                                            },
                                            { title: "最后心跳", dataIndex: "seenAt", render: time },
                                        ]}
                                    />
                                </Panel>
                                <Panel title="用户使用与余额" description="保留无生成记录的账户；余额为当前值">
                                    <Table<Group & UserRow>
                                        rowKey="id"
                                        scroll={{ x: 1000 }}
                                        size="small"
                                        dataSource={options?.users
                                            .filter((u) => (!filters.role || u.role === filters.role) && (!filters.userId || filters.userId.split(",").includes(u.id)))
                                            .map((u) => ({
                                                total: 0,
                                                succeeded: 0,
                                                denominator: 0,
                                                successRate: null,
                                                outputs: 0,
                                                failed: 0,
                                                partial: 0,
                                                p95Ms: null,
                                                canceled: 0,
                                                queued: 0,
                                                running: 0,
                                                unknown: 0,
                                                upstreamSuccessRate: null,
                                                firstSuccessRate: null,
                                                outputSuccessRate: null,
                                                retryRecoveryRate: null,
                                                completionRate: null,
                                                waitP95Ms: null,
                                                retryKnown: 0,
                                                ...report?.users.find((r) => r.id === u.id),
                                                ...u,
                                            }))}
                                        columns={[
                                            {
                                                title: "用户",
                                                dataIndex: "name",
                                                render: (name: string, r: Group) => (
                                                    <button className="monitor-link" onClick={() => filter("userId", r.id)}>
                                                        {name}
                                                    </button>
                                                ),
                                            },
                                            ...groupColumns,
                                            { title: "可用积分", dataIndex: "credits", render: (n: number) => fmt(n, 6) },
                                            { title: "冻结积分", dataIndex: "reservedCredits", render: (n: number) => fmt(n, 6) },
                                            { title: "存储", dataIndex: "storageBytes", render: bytes },
                                        ]}
                                    />
                                </Panel>
                            </>
                        )}
                        {section === "models" && (
                            <>
                                <div className="monitor-stats">
                                    <Stat label="实际生成调用" value={fmt(report?.attempts.total)} detail="一次重试也计一次上游调用" />
                                    <Stat label="成功 / 失败调用" value={`${fmt(report?.attempts.succeeded)} / ${fmt(report?.attempts.failed)}`} />
                                    <Stat label="状态查询" value={fmt(report?.attempts.query)} />
                                    <Stat label="媒体取回" value={fmt(report?.attempts.retrieval)} />
                                    <Stat label="实测输入 / 输出 Token" value={`${fmt(report?.attempts.inputTokens)} / ${fmt(report?.attempts.outputTokens)}`} detail={`${fmt(report?.attempts.measured)} 次调用返回用量；其他未知`} />
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="模型使用量">
                                        <Chart label="模型使用量条形图" option={ranking(report?.models || [], (r) => r.id)} onSelect={(id) => filter("model", id)} />
                                    </Panel>
                                    <Panel title="渠道成功率">
                                        <Chart
                                            label="渠道成功率条形图"
                                            option={ranking(report?.channels || [], (r) => channelName(r.id), true)}
                                            onSelect={(_, i) => {
                                                const c = report?.channels[i];
                                                if (c) filter("channelId", c.id);
                                            }}
                                        />
                                    </Panel>
                                </div>
                                <Panel title="渠道与模型表现">
                                    <Table rowKey="id" scroll={{ x: 850 }} dataSource={report?.channels} columns={[{ title: "渠道", dataIndex: "id", render: channelName }, ...groupColumns]} />
                                </Panel>
                            </>
                        )}
                        {section === "tasks" && (
                            <>
                                <div className="monitor-grid">
                                    <Panel title="任务阶段分布">
                                        <Chart
                                            label="任务状态环形分布图"
                                            option={{
                                                tooltip: { trigger: "item" },
                                                legend: { bottom: 0 },
                                                series: [
                                                    {
                                                        type: "pie",
                                                        radius: ["45%", "72%"],
                                                        center: ["50%", "45%"],
                                                        data: ["succeeded", "partial", "failed", "canceled", "queued", "running", "unknown"].map((k) => ({ name: statusName[k], value: Number(s?.[k as keyof typeof s] || 0) })),
                                                        label: { color: token.colorText, formatter: "{b}: {c}" },
                                                    },
                                                ],
                                            }}
                                        />
                                    </Panel>
                                    <Panel title="排队等待与交付耗时">
                                        <Chart
                                            label="任务交付与等待P95时间趋势"
                                            option={trend([
                                                { key: "p95Ms", name: "交付 P95 毫秒" },
                                                { key: "waitP95Ms", name: "等待 P95 毫秒" },
                                            ])}
                                        />
                                    </Panel>
                                </div>
                                <Panel
                                    title="任务明细"
                                    action={
                                        <Select
                                            allowClear
                                            placeholder="全部状态"
                                            value={taskStatus || undefined}
                                            onChange={(v) => {
                                                setTaskStatus(v || "");
                                                setPage(1);
                                            }}
                                            style={{ width: 140 }}
                                            options={Object.entries(statusName)
                                                .filter(([k]) => !["pending", "completed"].includes(k))
                                                .map(([value, label]) => ({ value, label }))}
                                        />
                                    }
                                >
                                    <Table
                                        rowKey="id"
                                        scroll={{ x: 950 }}
                                        size="small"
                                        dataSource={tasks.items}
                                        columns={taskColumns}
                                        pagination={{ current: page, pageSize: 25, total: tasks.total, showSizeChanger: false, onChange: setPage, showTotal: (n) => `共 ${n} 个任务` }}
                                    />
                                </Panel>
                            </>
                        )}
                        {section === "artifacts" && (
                            <>
                                <div className="monitor-stats">
                                    <Stat label="区间交付成品" value={fmt(artifacts?.total)} detail="按独立输出去重" />
                                    <Stat label="区间成品体积" value={bytes(artifacts?.bytes)} />
                                    <Stat label="区间音视频总时长" value={duration(artifacts?.durationMs)} />
                                    <Stat label="当前全站素材存量" value={fmt(options?.users.reduce((n, u) => n + u.storedAssets, 0))} detail="包含上传素材，与生成成品分开" />
                                    <Stat label="当前全站素材体积" value={bytes(options?.users.reduce((n, u) => n + u.storageBytes, 0))} />
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="成品分类" description="图片张数、视频/音频条数与已保存文本分别展示">
                                        <Chart
                                            label="成品类型环形分布图"
                                            option={{
                                                tooltip: { trigger: "item" },
                                                series: [
                                                    { type: "pie", radius: ["45%", "72%"], data: artifacts?.kinds.map((k) => ({ name: kindName[k.kind] || k.kind, value: k.count })) || [], label: { color: token.colorText, formatter: "{b}\n{c} 件" } },
                                                ],
                                            }}
                                        />
                                    </Panel>
                                    <Panel title="成品产出趋势" description="本图按任务受理时间归属；交付成品卡片按成品可用时间归属">
                                        <Chart label="成品产出时间趋势" option={trend([{ key: "outputs", name: "产出成品" }])} />
                                    </Panel>
                                    <Panel title="用户存储占用">
                                        <Chart
                                            label="用户存储占用条形图"
                                            option={{
                                                ...ranking([], (r) => r.id),
                                                yAxis: {
                                                    type: "category",
                                                    inverse: true,
                                                    data: options?.users
                                                        .slice()
                                                        .sort((a, b) => b.storageBytes - a.storageBytes)
                                                        .slice(0, 10)
                                                        .map((u) => u.name),
                                                    axisLabel: { color: token.colorTextSecondary },
                                                },
                                                series: [
                                                    {
                                                        type: "bar",
                                                        barMaxWidth: 20,
                                                        data: options?.users
                                                            .slice()
                                                            .sort((a, b) => b.storageBytes - a.storageBytes)
                                                            .slice(0, 10)
                                                            .map((u) => u.storageBytes / 1048576),
                                                        name: "MB",
                                                    },
                                                ],
                                            }}
                                        />
                                    </Panel>
                                    <Panel title="生成类型贡献">
                                        <Chart
                                            label="生成类型成品与任务对比柱图"
                                            option={{
                                                xAxis: { type: "category", data: report?.kinds.map((k) => kindName[k.id] || k.id) },
                                                yAxis: { type: "value" },
                                                series: [
                                                    { name: "任务", type: "bar", data: report?.kinds.map((k) => k.total) },
                                                    { name: "成品", type: "bar", data: report?.kinds.map((k) => k.outputs) },
                                                ],
                                            }}
                                        />
                                    </Panel>
                                </div>
                                <Panel title="最近交付成品">
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        scroll={{ x: 800 }}
                                        dataSource={artifacts?.items}
                                        columns={[
                                            {
                                                title: "成品",
                                                dataIndex: "id",
                                                render: (id: string, r: Artifacts["items"][number]) => (
                                                    <button className="monitor-link" onClick={() => void openTask(r.taskId)}>
                                                        {kindName[r.kind]} · {id.slice(0, 10)}
                                                    </button>
                                                ),
                                            },
                                            { title: "用户", dataIndex: "userId", render: userName },
                                            { title: "模型", dataIndex: "model" },
                                            { title: "体积", dataIndex: "bytes", render: bytes },
                                            { title: "时长", dataIndex: "durationMs", render: duration },
                                            { title: "交付时间", dataIndex: "createdAt", render: time },
                                        ]}
                                    />
                                </Panel>
                            </>
                        )}
                        {section === "credits" && (
                            <>
                                <Alert type="info" title="积分按用户和时间统计；模型/渠道/类型筛选不拆分账户余额。供应商费用尚未接入，不把积分视为人民币收入。" />
                                <div className="monitor-stats">
                                    <Stat label="当前可用积分" value={fmt(credits?.totals.credits, 6)} />
                                    <Stat label="当前冻结积分" value={fmt(credits?.totals.reservedCredits, 6)} />
                                    <Stat label="区间确认消费" value={fmt(credits?.totals.spent, 6)} />
                                    <Stat label="结算后退款" value={fmt(credits?.totals.refund, 6)} />
                                    <Stat label="释放及结算差额退回" value={fmt(credits?.totals.released, 6)} />
                                    <Stat label="区间净消费" value={fmt(credits?.totals.net, 6)} />
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="积分变化" description="冻结属于余额内部转移；差额退回不重复冲减消费">
                                        <Chart
                                            label="积分期初授予消费退款期末变化图"
                                            option={{
                                                xAxis: { type: "category", data: ["期初总额", "授予/调整", "确认消费", "结算后退款", "期末总额"] },
                                                yAxis: { type: "value" },
                                                series: [
                                                    {
                                                        type: "bar",
                                                        barMaxWidth: 40,
                                                        data: credits
                                                            ? [
                                                                  credits.totals.openingAvailable + credits.totals.openingReserved,
                                                                  credits.totals.granted,
                                                                  -credits.totals.spent,
                                                                  credits.totals.refund,
                                                                  credits.totals.closingAvailable + credits.totals.closingReserved,
                                                              ]
                                                            : [],
                                                        label: { show: true, position: "top", color: token.colorText },
                                                    },
                                                ],
                                            }}
                                        />
                                    </Panel>
                                    <Panel title="用户积分消费">
                                        <Chart
                                            label="按用户积分消费图"
                                            option={{
                                                xAxis: { type: "value" },
                                                yAxis: {
                                                    type: "category",
                                                    inverse: true,
                                                    data: credits?.rows
                                                        .slice()
                                                        .sort((a, b) => b.net - a.net)
                                                        .slice(0, 10)
                                                        .map((u) => u.name),
                                                },
                                                series: [
                                                    {
                                                        type: "bar",
                                                        barMaxWidth: 22,
                                                        data: credits?.rows
                                                            .slice()
                                                            .sort((a, b) => b.net - a.net)
                                                            .slice(0, 10)
                                                            .map((u) => u.net),
                                                    },
                                                ],
                                            }}
                                        />
                                    </Panel>
                                </div>
                                <Panel title="账户对账" description={credits?.billingHistorical}>
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        scroll={{ x: 950 }}
                                        dataSource={credits?.rows}
                                        columns={[
                                            { title: "用户", dataIndex: "name" },
                                            ...["credits", "reservedCredits", "spent", "refund", "net"].map((key, i) => ({ title: ["当前可用", "当前冻结", "确认消费", "退款", "净消费"][i], dataIndex: key, render: (n: number) => fmt(n, 6) })),
                                            {
                                                title: "余额与分录",
                                                render: (_: unknown, r: Credits["rows"][number]) => (
                                                    <Tag color={r.availableDifference || r.reservedDifference ? "error" : "success"}>{r.availableDifference || r.reservedDifference ? "存在差异" : "一致"}</Tag>
                                                ),
                                            },
                                        ]}
                                    />
                                </Panel>
                                <Panel title="待结算与待核实" action={<Link to="/admin?tab=billing">打开账单处置</Link>}>
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        scroll={{ x: 800 }}
                                        dataSource={credits?.pending}
                                        columns={[
                                            { title: "账单", dataIndex: "id", ellipsis: true },
                                            { title: "用户", dataIndex: "userId", render: (v: string) => userName(v) },
                                            { title: "模型", dataIndex: "model" },
                                            { title: "预扣", dataIndex: "reservedCost" },
                                            { title: "开始时间", dataIndex: "createdAt", render: (v: string) => time(v) },
                                            { title: "核实原因", dataIndex: "lastError", ellipsis: true },
                                        ]}
                                    />
                                </Panel>
                            </>
                        )}
                        {section === "events" && (
                            <>
                                <Panel title="当前告警">
                                    <div className="monitor-alerts">
                                        {snapshot?.alerts.length ? (
                                            snapshot.alerts.map((a) => (
                                                <Alert
                                                    key={a.id}
                                                    type={a.severity === "error" ? "error" : "warning"}
                                                    showIcon
                                                    title={a.title}
                                                    description={`${a.detail} · 首次发生 ${time(a.firstAt)}`}
                                                    action={
                                                        <Button size="small" disabled={Boolean(a.acknowledgedBy)} onClick={() => setAction({ action: "ack-alert", id: a.id, title: "确认告警" })}>
                                                            {a.acknowledgedBy ? "已确认" : "确认"}
                                                        </Button>
                                                    }
                                                />
                                            ))
                                        ) : (
                                            <Empty description="当前没有触发的运行告警" />
                                        )}
                                    </div>
                                </Panel>
                                <Panel
                                    title="事件时间线"
                                    action={
                                        <Select
                                            value={search.get("event") || "audit"}
                                            style={{ width: 160 }}
                                            onChange={(v) => setSearch({ view: "events", event: v })}
                                            options={[
                                                { value: "audit", label: "管理审计" },
                                                { value: "alert", label: "告警历史" },
                                                { value: "request-error", label: "请求异常" },
                                                { value: "activity", label: "使用与前端事件" },
                                            ]}
                                        />
                                    }
                                >
                                    <Timeline
                                        items={events.slice(0, 40).map((e) => ({
                                            title: time(e.at),
                                            content: (
                                                <>
                                                    <strong>{e.title || e.action || e.route || e.entity}</strong>
                                                    <p>
                                                        {userName(e.actorId || e.userId || "")} · {e.reason || e.code || e.page || ""} {e.status ?? ""}
                                                    </p>
                                                </>
                                            ),
                                        }))}
                                    />
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        dataSource={events}
                                        columns={[
                                            { title: "时间", dataIndex: "at", render: time },
                                            { title: "用户/操作人", render: (_: unknown, e: ActivityEvent) => userName(e.actorId || e.userId || "") },
                                            { title: "事件", render: (_: unknown, e: ActivityEvent) => e.title || e.action || e.route },
                                            { title: "状态", dataIndex: "status" },
                                            { title: "说明", render: (_: unknown, e: ActivityEvent) => e.reason || e.code || "" },
                                        ]}
                                    />
                                </Panel>
                            </>
                        )}
                        {section === "usage" && usage && (
                            <>
                                <Alert type="info" showIcon title={usage.scope} description={`行为数据自 ${time(usage.coverageFrom)} 开始采集；历史未采集的在线、访问和错误不补造。`} />
                                <div className="monitor-stats">
                                    <Stat label="活跃用户" value={fmt(usage.activeUsers)} detail="区间去重，含有操作的页面心跳" />
                                    <Stat label="新增用户" value={fmt(usage.newUsers)} />
                                    <Stat label="提交生成用户" value={fmt(usage.generationUsers)} />
                                    <Stat label="成功生成用户" value={fmt(usage.successUsers)} />
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="每日活跃用户" description="北京时间自然日去重">
                                        <Chart
                                            label="每日活跃用户折线图"
                                            option={{ xAxis: { type: "category", data: usage.days.map((d) => d.day) }, yAxis: { type: "value", minInterval: 1 }, series: [{ type: "line", data: usage.days.map((d) => d.users), showSymbol: true }] }}
                                        />
                                    </Panel>
                                    <Panel title="次日与七日生成留存" description={usage.retentionDefinition}>
                                        <Chart
                                            label="次日七日留存率柱图"
                                            option={{
                                                xAxis: { type: "category", data: usage.retention.map((r) => `第${r.day}日 · ${r.eligible}人已到观察期`) },
                                                yAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%" } },
                                                series: [{ type: "bar", barMaxWidth: 60, data: usage.retention.map((r) => r.rate), label: { show: true, position: "top", formatter: (p: { value: number }) => percent(p.value) } }],
                                            }}
                                        />
                                    </Panel>
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="每周活跃时段" description="北京时间；同一星期几、小时内按用户去重">
                                        <Chart
                                            label="星期与小时活跃用户热力图"
                                            height={360}
                                            option={{
                                                tooltip: { trigger: "item" },
                                                grid: { left: 40, right: 20, top: 20, bottom: 70 },
                                                xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => `${i}时`) },
                                                yAxis: { type: "category", data: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] },
                                                visualMap: { min: 0, max: Math.max(1, ...usage.hours.map((h) => h.users)), orient: "horizontal", bottom: 0, left: "center", inRange: { color: [token.colorFillSecondary, "#0891b2"] } },
                                                series: [{ type: "heatmap", data: usage.hours.map((h) => [h.hour, h.day, h.users]) }],
                                            }}
                                        />
                                    </Panel>
                                    <Panel title="页面与业务活动" description="已采集的活动事件次数，不等于页面访问量">
                                        <Chart
                                            label="页面业务活动柱图"
                                            option={{
                                                xAxis: { type: "category", data: usage.pages.slice(0, 10).map((p) => p.page), axisLabel: { rotate: 25 } },
                                                yAxis: { type: "value" },
                                                series: [{ type: "bar", data: usage.pages.slice(0, 10).map((p) => p.count) }],
                                            }}
                                        />
                                    </Panel>
                                </div>
                            </>
                        )}
                        {section === "manage" && (
                            <>
                                <div className="monitor-stats">
                                    <Stat label="统计积压事件" value={fmt(report?.coverage.pendingEvents)} />
                                    <Stat label="统计延迟" value={`${fmt(report?.coverage.dataLagSeconds, 1)} 秒`} />
                                    <Stat label="可选采集写入失败" value={fmt(snapshot?.dropped)} warning={Boolean(snapshot?.dropped)} />
                                    <Stat label="当前图片并发上限" value={fmt(snapshot?.imageLimit)} />
                                    <Stat label="最近备份" value={snapshot?.host?.backup?.ok ? "已完成" : "待核验"} detail={time(snapshot?.host?.backup?.at)} />
                                </div>
                                <div className="monitor-grid">
                                    <Panel title="图片队列" description="调整执行上限只影响后续调度；已开始任务继续运行">
                                        <p>
                                            正在执行 {fmt(snapshot?.running)}，排队 {fmt(snapshot?.queued)}，当前上限 {fmt(snapshot?.imageLimit)}。
                                        </p>
                                        <Button onClick={() => setAction({ action: "image-limit", title: "调整图片并发", value: snapshot?.imageLimit || 2 })}>调整并发上限</Button>
                                    </Panel>
                                    <Panel title="统计作业" description="幂等同步未处理事件，检查分析库写入状态">
                                        <p>
                                            最后更新 {time(report?.asOf)}；{snapshot?.worker.error || "统计进程已连接"}。
                                        </p>
                                        <Button onClick={() => setAction({ action: "resync", title: "重新同步统计" })}>重新同步</Button>
                                    </Panel>
                                </div>
                                <Panel title="渠道接单状态" description="暂停新任务后，原视频任务继续使用原渠道凭据取回">
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        dataSource={snapshot?.channels}
                                        columns={[
                                            { title: "渠道", dataIndex: "name" },
                                            { title: "模型", render: (_: unknown, c: Snapshot["channels"][number]) => c.models.map((m) => m.name).join("、") },
                                            { title: "状态", render: (_: unknown, c: Snapshot["channels"][number]) => <Tag color={c.paused ? "warning" : "success"}>{c.paused ? "已暂停" : "接收任务"}</Tag> },
                                            {
                                                title: "操作",
                                                render: (_: unknown, c: Snapshot["channels"][number]) => (
                                                    <Button size="small" onClick={() => setAction({ action: c.paused ? "resume-channel" : "pause-channel", id: c.id, title: `${c.paused ? "恢复" : "暂停"}渠道 ${c.name}` })}>
                                                        {c.paused ? "恢复" : "暂停"}
                                                    </Button>
                                                ),
                                            },
                                        ]}
                                    />
                                </Panel>
                                <Panel title="用户会话管理" action={<Link to="/admin?tab=users">用户权限与积分调整</Link>}>
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        dataSource={options?.users.filter((u) => !u.deleted)}
                                        columns={[
                                            { title: "用户", dataIndex: "name" },
                                            { title: "角色", dataIndex: "role", render: (r: string) => (r === "admin" ? "管理员" : "用户") },
                                            { title: "最后登录", dataIndex: "lastLoginAt", render: time },
                                            {
                                                title: "操作",
                                                render: (_: unknown, u: Options["users"][number]) => (
                                                    <Button size="small" onClick={() => setAction({ action: "kick-user", id: u.id, title: `退出用户 ${u.name} 的会话` })}>
                                                        强制退出
                                                    </Button>
                                                ),
                                            },
                                        ]}
                                    />
                                </Panel>
                            </>
                        )}
                    </div>
                )}
            </div>
            <Drawer title="任务交付追踪" size={Math.min(900, window.innerWidth - 24)} open={drawer} onClose={() => setDrawer(false)}>
                {detail ? (
                    <>
                        <Descriptions
                            column={2}
                            bordered
                            size="small"
                            items={[
                                { key: "id", label: "任务", children: detail.task.id, span: 2 },
                                { key: "user", label: "用户", children: userName(detail.task.userId) },
                                { key: "status", label: "状态", children: statusTag(detail.task.status) },
                                { key: "model", label: "模型", children: detail.task.model },
                                { key: "channel", label: "渠道", children: channelName(detail.task.channelId) },
                                { key: "output", label: "已交付 / 预期", children: `${detail.task.delivered} / ${detail.task.expected ?? "历史未记录"}` },
                                { key: "evidence", label: "覆盖", children: detail.task.evidence },
                            ]}
                        />
                        <div className="my-6">
                            <Timeline
                                items={Object.entries(detail.task.stages)
                                    .filter(([, at]) => at)
                                    .map(([stage, at]) => ({ title: time(at), content: { queued: "任务受理", generating: "开始生成", upstream: "上游返回", retrieving: "取回成品", persisted: "验证并保存", rendered: "客户端渲染确认" }[stage] || stage }))}
                            />
                        </div>
                        {detail.task.error && <Alert type="warning" title={detail.task.error} />}
                        <h3>实际模型调用与取回</h3>
                        <Table
                            rowKey="id"
                            size="small"
                            pagination={false}
                            dataSource={detail.attempts}
                            columns={[
                                { title: "阶段", dataIndex: "purpose", render: (p: string) => ({ generation: "生成", query: "状态查询", retrieval: "取回" })[p] || p },
                                { title: "模型", dataIndex: "model" },
                                { title: "结果", dataIndex: "status", render: statusTag },
                                { title: "用时", dataIndex: "durationMs", render: duration },
                                { title: "HTTP", dataIndex: "httpStatus" },
                            ]}
                        />
                        <h3 className="mt-6">关联账单</h3>
                        {detail.receipt ? (
                            <Descriptions
                                column={1}
                                size="small"
                                items={Object.entries(detail.receipt)
                                    .filter(([k]) => ["id", "status", "cost", "reservedCost", "confirmedCost", "returnedCost", "exempt"].includes(k))
                                    .map(([k, v]) => ({ key: k, label: { id: "账单编号", status: "账单状态", cost: "费用", reservedCost: "预扣积分", confirmedCost: "确认积分", returnedCost: "退回积分", exempt: "免扣" }[k] || k, children: String(v) }))}
                            />
                        ) : (
                            <Empty description="该历史任务没有关联账单" />
                        )}
                    </>
                ) : (
                    <Spin />
                )}
            </Drawer>
            <Modal
                title={action?.title}
                open={Boolean(action)}
                onCancel={() => {
                    setAction(null);
                    setReason("");
                }}
                onOk={() => void manage()}
                confirmLoading={acting}
                okButtonProps={{ disabled: reason.trim().length < 2 }}
                okText="执行并记录"
                cancelText="取消"
            >
                <p>操作会影响实际运行状态，并记录操作人、对象、原因与结果。</p>
                {action?.action === "image-limit" && <InputNumber aria-label="图片并发上限" min={1} max={10} value={action.value} onChange={(v) => setAction((a) => (a ? { ...a, value: v || 1 } : a))} />}
                <Input.TextArea className="mt-4" aria-label="操作原因" placeholder="填写操作原因或核实依据" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} />
            </Modal>
        </main>
    );
}
