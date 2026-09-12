import { useEffect, useState } from "react";
import { Alert, App, Button, Checkbox, DatePicker, Drawer, Form, Grid, Input, Select, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { RefreshCw, Search } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { backend, type BillingEvent, type BillingReceipt } from "@/services/api/backend";

const kinds: Record<string, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const events: Record<string, string> = { precharged: "预扣", charged: "扣费", "task-associated": "关联任务", "task-status": "更新任务状态", "outcome-unknown": "结果待确认", "query-failed": "查询失败", "delivery-failed": "取回失败", confirmed: "确认扣费", refunded: "退款", "difference-returned": "退回差额", "media-verified": "视频核验完成", "channel-recovered": "恢复渠道凭据", "review-retry": "核实后重试", imported: "历史账单导入" };
const time = (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm:ss");
const statusLabel = (receipt: BillingReceipt) => receipt.refunded ? "已退款" : receipt.status === "completed" ? "已确认" : "预扣待确认";
const seconds = (value: number) => `${Number.isInteger(value) ? "" : "约 "}${Math.round(value)} 秒`;

export function BillingLedger({ ownAccount = false }: { ownAccount?: boolean }) {
    const { message } = App.useApp();
    const screens = Grid.useBreakpoint();
    const compact = !screens.md;
    const [form] = Form.useForm();
    const [filters, setFilters] = useState<Record<string, string>>({});
    const [page, setPage] = useState(1);
    const [revision, setRevision] = useState(0);
    const [rows, setRows] = useState<BillingReceipt[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState<BillingReceipt | null>(null);
    const [history, setHistory] = useState<BillingEvent[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState("");
    const [reason, setReason] = useState("");
    const [undeliverable, setUndeliverable] = useState(false);
    const [resolving, setResolving] = useState(false);
    const [recoveryKey, setRecoveryKey] = useState("");
    const [recoveryUrl, setRecoveryUrl] = useState("");

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError("");
        void backend.billingLedger({ ...filters, offset: String((page - 1) * 20), limit: "20" }, ownAccount)
            .then((result) => { if (active) { setRows(result.items); setTotal(result.total); } })
            .catch((reason) => { if (active) { setRows([]); setTotal(0); setError(reason.message || "台账读取失败"); } })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [filters, page, revision, ownAccount]);

    useEffect(() => {
        if (!selected) return;
        setReason(""); setUndeliverable(false); setRecoveryKey(""); setRecoveryUrl("");
        let active = true;
        setHistory([]);
        setHistoryError("");
        setHistoryLoading(true);
        void backend.billingEvents(selected.id, ownAccount)
            .then((result) => { if (active) setHistory(result.events); })
            .catch((reason) => { if (active) setHistoryError(reason.message || "日志读取失败"); })
            .finally(() => { if (active) setHistoryLoading(false); });
        return () => { active = false; };
    }, [selected, ownAccount]);

    const columns: ColumnsType<BillingReceipt> = [
        { title: "产生时间", dataIndex: "createdAt", width: 170, render: time },
        { title: "账单 ID", dataIndex: "id", width: 280, render: (id: string, row) => <Button type="link" className="!h-auto !p-0 !text-left !whitespace-normal !break-all" onClick={() => setSelected(row)}>{id}</Button> },
        ...(!ownAccount ? [{ title: "用户 ID", dataIndex: "userId", width: 280 }] : []),
        { title: "类型", dataIndex: "kind", width: 70, render: (kind: string) => kinds[kind] || kind },
        { title: "模型", dataIndex: "model", width: 200 },
        { title: "单价", width: 110, render: (_, row) => `${row.unitPrice} 点/${row.pricingUnit === "second" ? "秒" : row.kind === "video" ? "条" : "次"}` },
        { title: "计费数量", width: 100, render: (_, row) => row.status === "pending" ? "待结算" : row.pricingUnit === "second" ? seconds(row.quantity) : row.quantity },
        { title: "预扣（点）", width: 100, render: (_, row) => row.reservedCost ?? row.cost },
        { title: "实耗（点）", width: 100, render: (_, row) => row.confirmedCost ?? (row.status === "completed" ? row.cost : 0) },
        { title: "退回（点）", width: 100, render: (_, row) => row.returnedCost ?? (row.refunded ? row.cost : 0) },
        { title: "任务 ID", dataIndex: "taskId", width: 280, render: (value: string) => value || "待渠道返回" },
        { title: "状态", width: 130, render: (_, row) => <Tag color={row.refunded ? "default" : row.status === "completed" ? "green" : "gold"}>{statusLabel(row)}</Tag> },
    ];

    const compactColumns: ColumnsType<BillingReceipt> = [
        { title: "生成任务", render: (_, row) => <button className="w-full min-w-0 text-left" onClick={() => setSelected(row)}>
            <div className="break-all">{kinds[row.kind] || row.kind} · {row.model}</div>
            <div className="mt-1 text-xs opacity-60">{time(row.createdAt)}</div>
        </button> },
        { title: "积分", width: 120, align: "right", render: (_, row) => <div><div className="mb-1 tabular-nums">{row.status === "pending" ? row.reservedCost ?? row.cost : row.confirmedCost ?? 0} 点</div>{Boolean(row.returnedCost) && <div className="text-xs">退回 {row.returnedCost}</div>}<Tag className="!m-0">{statusLabel(row)}</Tag></div> },
    ];

    return <section className="min-w-0 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-medium">{ownAccount ? "消耗记录" : "扣费台账"}</h3>
            <Tooltip title="刷新台账"><Button aria-label="刷新台账" icon={<RefreshCw className="size-4" />} onClick={() => setRevision((value) => value + 1)} /></Tooltip>
        </div>
        <Form form={form} layout="inline" className="!mb-4 !gap-y-2" onFinish={(values) => {
            const next: Record<string, string> = {};
            for (const key of ["userId", "taskId", "model", "kind", "status"]) if (values[key]?.trim()) next[key] = values[key].trim();
            const range = values.range as [Dayjs, Dayjs] | undefined;
            if (range?.[0]) next.from = range[0].startOf("day").toISOString();
            if (range?.[1]) next.to = range[1].add(1, "day").startOf("day").toISOString();
            setFilters(next); setPage(1);
        }}>
            {!ownAccount && <Form.Item name="userId"><Input allowClear placeholder="用户 ID" aria-label="用户 ID" style={{ width: 190 }} /></Form.Item>}
            <Form.Item name="taskId"><Input allowClear placeholder="任务 ID" aria-label="任务 ID" style={{ width: 190 }} /></Form.Item>
            <Form.Item name="model"><Input allowClear placeholder="模型" aria-label="模型" style={{ width: 170 }} /></Form.Item>
            <Form.Item name="kind"><Select allowClear placeholder="生成类型" aria-label="生成类型" style={{ width: 110 }} options={Object.entries(kinds).map(([value, label]) => ({ value, label }))} /></Form.Item>
            <Form.Item name="status"><Select allowClear placeholder="扣费状态" aria-label="扣费状态" style={{ width: 140 }} options={[{ value: "pending", label: "预扣待确认" }, { value: "completed", label: "已确认" }, { value: "failed", label: "已退款" }]} /></Form.Item>
            <Form.Item name="range"><DatePicker.RangePicker style={{ maxWidth: "100%" }} /></Form.Item>
            <Form.Item><Button htmlType="submit" icon={<Search className="size-4" />}>查询</Button></Form.Item>
        </Form>
        {error && <Alert type="error" title={error} className="mb-3" />}
        <Table rowKey="id" size="small" loading={loading} dataSource={rows} columns={compact ? compactColumns : columns} scroll={compact ? undefined : { x: 1800 }} pagination={{ current: page, pageSize: 20, total, showSizeChanger: false, onChange: setPage, showTotal: (count) => `共 ${count} 条` }} />
        <Drawer title="扣费变更日志" open={Boolean(selected)} onClose={() => setSelected(null)} size={compact ? "100%" : "large"}>
            {selected && <div className="mb-4 space-y-2 break-all text-sm"><div>账单 ID：{selected.id}</div><div>用户 ID：{selected.userId}</div><div>任务 ID：{selected.taskId || "待渠道返回"}</div><div>内部任务：{selected.generationTaskId || "历史记录"}</div><div>{kinds[selected.kind] || selected.kind} · {selected.model}</div><div>单价 {selected.unitPrice} 点/{selected.pricingUnit === "second" ? "秒" : "次"}</div><div>预扣 {selected.reservedCost ?? selected.cost} 点 · 实耗 {selected.confirmedCost ?? 0} 点 · 退回 {selected.returnedCost ?? 0} 点</div>{selected.actualDurationMs !== undefined && <div>实际时长：{seconds(selected.actualDurationMs / 1000)}</div>}{selected.lastError && <Alert type="warning" title={selected.lastError} />}</div>}
            {!ownAccount && selected?.status === "pending" && <div className="mb-4 space-y-3">
                <Input.TextArea aria-label="核实依据" placeholder="核实依据" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                <Checkbox checked={undeliverable} onChange={(e) => setUndeliverable(e.target.checked)}>已核实此任务无法交付</Checkbox>
                <div className="flex flex-wrap gap-2">{(["retry", "release"] as const).map((action) => <Button key={action} loading={resolving} disabled={!reason.trim() || (action === "release" && !undeliverable)} danger={action === "release"} onClick={async () => {
                    setResolving(true);
                    try { await backend.resolveBilling(selected.id, { action, reason, confirmedUndeliverable: undeliverable }); setSelected(null); setRevision((v) => v + 1); message.success("处理完成"); }
                    catch (error) { message.error(error instanceof Error ? error.message : "处理失败"); }
                    finally { setResolving(false); }
                }}>{action === "retry" ? "取回原任务" : "退回预扣"}</Button>)}</div>
                {selected.channelRevisionId && <div className="flex flex-wrap gap-2"><Input.Password aria-label="同账号新密钥" placeholder="同一上游账号的新密钥" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} className="!w-full" /><Input aria-label="原渠道迁移地址" placeholder="原渠道迁移后的 Base URL（选填）" value={recoveryUrl} onChange={(e) => setRecoveryUrl(e.target.value)} /><Button disabled={!recoveryKey} loading={resolving} onClick={async () => {
                    setResolving(true);
                    try { await backend.recoverVideoChannel(selected.channelId!, selected.id, recoveryKey, recoveryUrl); setRecoveryKey(""); setSelected(null); message.success("原任务权限已验证并恢复"); }
                    catch (error) { message.error(error instanceof Error ? error.message : "恢复失败"); }
                    finally { setResolving(false); }
                }}>验证并恢复原渠道</Button></div>}
            </div>}
            {historyError && <Alert type="error" title={historyError} className="mb-3" />}
            <Table rowKey="id" size="small" loading={historyLoading} dataSource={history} pagination={false} scroll={{ x: 600 }} columns={[
                { title: "时间", dataIndex: "createdAt", width: 170, render: time },
                { title: "变更", dataIndex: "event", width: 130, render: (value: string) => events[value] || value },
                { title: "金额（点）", width: 100, render: (_, row) => row.event === "difference-returned" ? row.receipt.returnedCost : row.event === "precharged" ? row.receipt.reservedCost ?? row.receipt.cost : row.event === "refunded" ? row.receipt.confirmedCost || row.receipt.reservedCost || row.receipt.cost : row.receipt.cost },
                { title: "状态", width: 130, render: (_, row) => statusLabel(row.receipt) },
                { title: "原因", render: (_, row) => row.receipt.lastError || row.receipt.upstreamState || "" },
            ]} />
        </Drawer>
    </section>;
}
