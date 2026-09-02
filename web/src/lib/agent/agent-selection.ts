import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasNodeData, CanvasNodeTypeId } from "@/types/canvas";

/**
 * Marker used when the current canvas selection is appended to an Agent turn.
 * The marker is deliberately plain text so it survives both the local Agent
 * and the server LLM request paths; it is removed before rendering a user
 * message back into the chat.
 */
export const CANVAS_SELECTION_CONTEXT_MARKER = "[[CANVAS_SELECTION_CONTEXT]]";
const CANVAS_SELECTION_CONTEXT_END_MARKER = "[[/CANVAS_SELECTION_CONTEXT]]";
const MAX_SELECTION_SUMMARY_LENGTH = 240;

export type AgentCanvasSelectionItem = {
    id: string;
    type: string;
    title: string;
    summary: string;
    status?: string;
};

export type AgentCanvasSelection = {
    projectId: string;
    items: AgentCanvasSelectionItem[];
};

/**
 * Build the small, model-safe representation of the currently selected nodes.
 * Full node metadata can contain image/video data URLs, so it is intentionally
 * never copied into this object.
 */
export function buildAgentCanvasSelection(projectId: string, nodes: CanvasNodeData[], selectedNodeIds: Iterable<string> | readonly string[] = []): AgentCanvasSelection {
    const selected = new Set(Array.from(selectedNodeIds, (id) => String(id)));
    return {
        projectId: String(projectId || ""),
        items: nodes.filter((node) => selected.has(node.id)).map(compactSelectionItem),
    };
}

/** Convenience adapter for callers that already hold a canvas snapshot. */
export function buildAgentCanvasSelectionFromSnapshot(snapshot: CanvasAgentSnapshot | null | undefined) {
    return snapshot ? buildAgentCanvasSelection(snapshot.projectId, snapshot.nodes, snapshot.selectedNodeIds) : { projectId: "", items: [] };
}

export function formatAgentCanvasSelectionContext(selection: AgentCanvasSelection | null | undefined) {
    const items = selection?.items || [];
    if (!items.length) return "";
    const project = selection?.projectId ? `项目 ID：${selection.projectId}\n` : "";
    const rows = items
        .map((item, index) => {
            const detail = item.summary ? `：${item.summary}` : "";
            return `${index + 1}. [${agentSelectionTypeLabel(item.type)}] ${item.title}（节点 ID：${item.id}）${detail}`;
        })
        .join("\n");
    return [CANVAS_SELECTION_CONTEXT_MARKER, "当前画布选中的元素（仅作为本轮对话上下文）：", project + rows, "请优先依据这些节点的事实回答；需要修改画布时使用节点 ID。", CANVAS_SELECTION_CONTEXT_END_MARKER].join("\n");
}

/** Remove the internal selection block before displaying/storing user text. */
export function stripAgentCanvasSelectionContext(text: string) {
    if (!text) return "";
    const marker = escapeRegExp(CANVAS_SELECTION_CONTEXT_MARKER);
    const end = escapeRegExp(CANVAS_SELECTION_CONTEXT_END_MARKER);
    return text
        .replace(new RegExp(`${marker}[\\s\\S]*?${end}`, "g"), "")
        .replace(new RegExp(marker, "g"), "")
        .replace(new RegExp(end, "g"), "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function agentSelectionTypeLabel(type: CanvasNodeTypeId | string) {
    switch (String(type)) {
        case "image":
            return "图片";
        case "text":
            return "文本";
        case "config":
            return "生成配置";
        case "video":
            return "视频";
        case "audio":
            return "音频";
        case "group":
            return "组";
        default: {
            const value = String(type || "节点").split(":").filter(Boolean).pop() || "节点";
            return value.length > 24 ? `${value.slice(0, 23)}…` : value;
        }
    }
}

function compactSelectionItem(node: CanvasNodeData): AgentCanvasSelectionItem {
    const type = String(node.type || "node");
    const title = compactText(node.title).replace(selectionMarkerPattern(), "") || agentSelectionTypeLabel(type);
    const metadata = node.metadata || {};
    const summary = selectionSummary(node, metadata);
    const status = selectionStatus(metadata);
    return { id: String(node.id), type, title, summary, ...(status ? { status } : {}) };
}

function selectionSummary(node: CanvasNodeData, metadata: NonNullable<CanvasNodeData["metadata"]>) {
    const candidates = node.type === "text" ? [metadata.content, metadata.prompt, metadata.composerContent] : [metadata.prompt, metadata.sourcePrompt, metadata.effectivePrompt, metadata.composerContent];
    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const value = compactText(candidate);
        if (!value || value === "[媒体已省略]" || looksLikeMediaUrl(value)) continue;
        return value;
    }
    return "";
}

function selectionStatus(metadata: NonNullable<CanvasNodeData["metadata"]>) {
    const raw = typeof metadata.taskStatus === "string" ? metadata.taskStatus : typeof metadata.status === "string" ? metadata.status : "";
    if (!raw) return "";
    if (/^(?:loading|running|queued)$/i.test(raw)) return raw.toLowerCase() === "queued" ? "排队中" : "生成中";
    if (/^(?:success|succeeded|completed)$/i.test(raw)) return "已完成";
    if (/^(?:error|failed|failure)$/i.test(raw)) return "失败";
    if (/^(?:idle|pending)$/i.test(raw)) return "待处理";
    return compactText(raw);
}

function compactText(value: unknown) {
    if (typeof value !== "string") return "";
    const normalized = value
        .replace(/data:(?:[a-z0-9.+-]+\/)?[a-z0-9.+-]+;base64,[^\s)]+/gi, "[媒体已省略]")
        .replace(/blob:[^\s)]+/gi, "[媒体已省略]")
        .replace(selectionMarkerPattern(), "")
        .replace(/[ \t\r\n]+/g, " ")
        .trim();
    if (!normalized) return "";
    return normalized.length > MAX_SELECTION_SUMMARY_LENGTH ? `${normalized.slice(0, MAX_SELECTION_SUMMARY_LENGTH - 1)}…` : normalized;
}

function looksLikeMediaUrl(value: string) {
    return isForbiddenMediaUrl(value) || /^\/api\/media\//i.test(value.trim());
}

function isForbiddenMediaUrl(value: string) {
    return /^(?:data:|blob:)/i.test(value.trim());
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectionMarkerPattern() {
    return new RegExp(`${escapeRegExp(CANVAS_SELECTION_CONTEXT_MARKER)}|${escapeRegExp(CANVAS_SELECTION_CONTEXT_END_MARKER)}`, "g");
}
