import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input, Segmented, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { Bot, ChevronDown, Copy, FolderOpen, History, KeyRound, Link2, LoaderCircle, MessageSquare, PlugZap, Plus, RefreshCw, Square, Terminal, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import { uploadImage } from "@/services/image-storage";
import { requestAgentLlmTurn, type ResponseInputMessage } from "@/services/api/image";
import { backend, getAuthEpoch, type AgentSkillId, type ServerAgentLlmConfig } from "@/services/api/backend";
import { buildAgentLlmSystemPrompt, AGENT_LLM_SKILL_LABELS, expandCanvasTool, getAgentSkillDefinition, toolsForAgentSkills } from "@/lib/agent/agent-llm-skills";
import { formatAgentCanvasSelectionContext, stripAgentCanvasSelectionContext } from "@/lib/agent/agent-selection";
import { applyServerAiConfig, toFrontendServerModelSelection } from "@/lib/server-ai-config";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCurrentUser } from "@/stores/use-auth-store";
import { useUserStore } from "@/stores/use-user-store";
import { useShallow } from "zustand/react/shallow";
import { useAgentStore, type AgentAttachment, type AgentCanvasContext, type AgentChatItem, type AgentConversationState, type AgentEventLog, type AgentPanelTab, type AgentPendingToolCall, type AgentThreadSummary } from "@/stores/use-agent-store";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { isSiteTool, runSiteTool, SITE_TOOL_LABELS } from "@/lib/agent/agent-site-tools";
import { AgentChatComposer, AgentChatMessage, AgentPanelTabs, AgentPendingToolCard, AgentWorkingMessage, type CanvasAgentChatAttachment } from "./canvas-agent-chat-ui";

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;
const SCROLL_BOTTOM_THRESHOLD = 48;
const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";
const AGENT_CONNECT_STEPS = [
    { title: "方式一：在 Codex 中使用插件", text: "在 Codex app 安装 HowCanvas 插件后，通过插件启动画布，插件会自动启动本地 Agent 并带上连接信息。" },
    { title: "方式二：直接运行 Agent", text: "不使用 Codex 插件时，在终端运行下面命令，再回到网页里连接或手动填入 Local URL 和 Connect token。", command: "npx -y @basketikun/canvas-agent" },
];
const DEFAULT_AGENT_LLM_CONFIG: ServerAgentLlmConfig = { enabled: false, model: "", skills: [] };
const AGENT_PLUGIN_REMOVE_COMMAND = "codex plugin remove infinite-canvas";
const AGENT_MCP_REMOVE_COMMAND = "codex mcp remove infinite-canvas";

type AgentEventPayload = {
    agent?: string;
    type?: string;
    threadId?: string;
    thread_id?: string;
    turnId?: string;
    turn_id?: string;
    sourceClientId?: string;
    status?: string;
    turn?: { status?: string; error?: unknown };
    item?: AgentEventItem;
    error?: unknown;
    message?: unknown;
    usage?: Record<string, unknown>;
};
type AgentEventItem = { id?: string; type?: string; text?: unknown; delta?: unknown; message?: unknown; server?: string; tool?: string; status?: string; arguments?: unknown; result?: unknown; error?: unknown };

type AgentLogContext = { endpoint: string; connected: boolean; enabled: boolean; activity: string; waiting: boolean; sending: boolean; messages: number; pendingTool?: string };
type AgentWorkspace = { workspacePath: string; activeThreadId?: string };
type AgentThreadsResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; data?: AgentThreadSummary[] };
type AgentThreadResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; thread?: AgentThreadSummary; messages?: AgentChatItem[] };
type AgentConfigResponse = { ok?: boolean; url?: string; token?: string; hasToken?: boolean };
type AgentCodexState = { busy?: boolean; threadId?: string; turnId?: string };
type AgentHelloEvent = { ok?: boolean; protocolVersion?: number; clientId?: string; workspace?: AgentWorkspace; conversation?: AgentConversationState; codex?: AgentCodexState };
type AgentWorkspaceEvent = { activeThreadId?: string; threadId?: string; emptyThread?: boolean; conversation?: AgentConversationState };
type AgentBootstrapEvent = { type?: string; phase?: string; error?: unknown; failureReason?: unknown; additionalDetails?: unknown; threadId?: string; sourceClientId?: string; conversation?: AgentConversationState };
type AgentConversationEvent = AgentConversationState & { sourceClientId?: string };
type AgentChatEvent = { threadId?: string; sourceClientId?: string; message?: AgentChatItem };

export function CanvasLocalAgentPanel({ embedded, headless, autoConnect }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const currentAuthUser = useCurrentUser();
    const { message, modal } = App.useApp();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    // 逐字段 selector + useShallow：只有这些字段变化时才重渲染。
    // 注意：canvasContext 不在此订阅内 —— 它在拖拽/resize 时会被 project 每帧写入，
    // 但面板只在 ref 同步与防抖 postState 中用到它、渲染层从不读它。若把它放进订阅，
    // 面板会随画布每帧重渲染（性能问题，也是 #185 崩溃的放大器）。改为下方 subscribe 命令式监听。
    const { width, url, token, connected, enabled, prompt, attachments, sending, waiting, messages, eventLogs, threads, conversation, activeThreadId, workspacePath, loadingThreads, activeTab, agentMode, confirmTools, activity, connectError, pendingTool, canvasSelection } = useAgentStore(
        useShallow((state) => ({
            width: state.width,
            url: state.url,
            token: state.token,
            connected: state.connected,
            enabled: state.enabled,
            prompt: state.prompt,
            attachments: state.attachments,
            sending: state.sending,
            waiting: state.waiting,
            messages: state.messages,
            eventLogs: state.eventLogs,
            threads: state.threads,
            conversation: state.conversation,
            activeThreadId: state.activeThreadId,
            workspacePath: state.workspacePath,
            loadingThreads: state.loadingThreads,
            activeTab: state.activeTab,
            agentMode: state.agentMode,
            confirmTools: state.confirmTools,
            activity: state.activity,
            connectError: state.connectError,
            pendingTool: state.pendingTool,
            canvasSelection: state.canvasSelection,
        })),
    );
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const config = useConfigStore((state) => state.config);
    const pushMessage = useAgentStore((state) => state.addMessage);
    const pushEventLog = useAgentStore((state) => state.addEventLog);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const listRef = useRef<HTMLDivElement>(null);
    const followMessagesRef = useRef(true);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const [agentLlmConfig, setAgentLlmConfig] = useState<ServerAgentLlmConfig>(DEFAULT_AGENT_LLM_CONFIG);
    const [agentLlmLoading, setAgentLlmLoading] = useState(false);
    const canvasContextRef = useRef<AgentCanvasContext | null>(useAgentStore.getState().canvasContext);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const llmPendingRef = useRef<{ payload: AgentPendingToolCall; resolve: (result: unknown) => void } | null>(null);
    const codexOutputRef = useRef(false);
    const localTurnActiveRef = useRef(false);
    const autoConnectRef = useRef(false);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef(randomId());
    const loadThreadsSequenceRef = useRef(0);
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");

    useEffect(() => {
        let active = true;
        const requestEpoch = getAuthEpoch();
        setAgentLlmLoading(true);
        void backend
            .aiConfig()
            .then((data) => {
                if (active && requestEpoch === getAuthEpoch()) {
                    // 面板与登录后的全局配置请求可能并发完成；在启用 Agent 前
                    // 先同步注入服务器代理渠道，避免首轮请求回退到本地空 Key 渠道。
                    applyServerAiConfig(data);
                    const next = data.agentLlm || DEFAULT_AGENT_LLM_CONFIG;
                    // 后端保存的是 `channelId::model`，而前端服务器渠道带有
                    // `srv_` 前缀；统一转换后才能让 Agent LLM 命中所选渠道。
                    setAgentLlmConfig({ ...next, model: toFrontendServerModelSelection(next.model, data.channels, "text") });
                }
            })
            .catch(() => {
                if (active && requestEpoch === getAuthEpoch()) setAgentLlmConfig(DEFAULT_AGENT_LLM_CONFIG);
            })
            .finally(() => {
                if (active) setAgentLlmLoading(false);
            });
        return () => {
            active = false;
        };
    }, []);
    const loadThreads = useCallback(async (skipHistory = false) => {
        if (!connectedRef.current && !useAgentStore.getState().connected) return;
        const sequence = ++loadThreadsSequenceRef.current;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, `/agent/codex/threads`);
            const nextThreadId = data.workspace?.activeThreadId || "";
            let nextMessages: AgentChatItem[] = [];
            if (nextThreadId && !skipHistory) {
                const thread = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(nextThreadId)}`);
                nextMessages = normalizeHistoryMessages(thread.messages || []);
            }
            if (sequence !== loadThreadsSequenceRef.current) return;
            const liveState = useAgentStore.getState();
            const hasLiveOutput = liveState.messages.some((item) => Boolean(item.streamId || item.streamDelta));
            const preserveLiveTurn = localTurnActiveRef.current || liveState.sending || liveState.waiting || hasLiveOutput;
            const sameThread = !nextThreadId || nextThreadId === liveState.activeThreadId;
            setAgentState({
                threads: data.data || [],
                workspacePath: data.workspace?.workspacePath || "",
                ...(data.conversation && !preserveLiveTurn ? { conversation: normalizeConversation(data.conversation) } : {}),
                ...(preserveLiveTurn ? {} : { activeThreadId: nextThreadId, messages: sameThread ? mergeAgentHistoryMessages(nextMessages, liveState.messages) : nextMessages }),
            });
        } catch (error) {
            addEventLog("读取历史失败", error);
            const text = errorText(error) || "读取历史失败，请检查本地 Agent 连接和 Codex 权限";
            const current = useAgentStore.getState().messages;
            if (!current.some((item) => item.role === "error" && item.title === "读取历史失败" && item.text === text)) {
                useAgentStore.getState().addMessage({ id: createId(), role: "error", title: "读取历史失败", text, detail: error });
            }
        } finally {
            if (sequence === loadThreadsSequenceRef.current) setAgentState({ loadingThreads: false });
        }
    }, [endpoint, setAgentState, token]);

    // canvasContext 命令式订阅：保持 ref 最新，并在快照变化时防抖上报，全程不触发面板重渲染。
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            if (!useAgentStore.getState().connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, canvasContextRef.current?.snapshot || null), 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [endpoint, token]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    const updateScrollState = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
        followMessagesRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
    }, []);
    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        const list = listRef.current;
        if (!list) return;
        followMessagesRef.current = true;
        list.scrollTo({ top: list.scrollHeight, behavior });
        setShowScrollToBottom(false);
    }, []);
    useEffect(() => {
        if (activeTab !== "chat") return;
        const frame = requestAnimationFrame(() => scrollToBottom("auto"));
        return () => cancelAnimationFrame(frame);
    }, [activeTab, activeThreadId, scrollToBottom]);
    useEffect(() => {
        if (activeTab !== "chat") return;
        const frame = requestAnimationFrame(() => (followMessagesRef.current ? scrollToBottom("auto") : updateScrollState()));
        return () => cancelAnimationFrame(frame);
    }, [activeTab, messages, pendingTool, scrollToBottom, updateScrollState, waiting]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (!enabled || !token.trim()) return;
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.removeItem("canvas-agent-token");
        sessionStorage.setItem("canvas-agent-token", token);
        const clientId = clientIdRef.current;
        let eventQueue = Promise.resolve();
        const enqueueEvent = (task: () => void | Promise<void>) => {
            eventQueue = eventQueue.then(task).catch((error) => {
                addEventLog("同步会话失败", error);
                addMessage({ role: "error", title: "Agent 事件处理失败", text: error instanceof Error ? error.message : "Agent 事件处理失败" });
            });
        };
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", (event) => {
            const data = parseEventData<AgentHelloEvent>(event);
            const busy = Boolean(data?.codex?.busy) || data?.conversation?.status === "running";
            errorLoggedRef.current = false;
            connectedRef.current = true;
            setAgentState({ connected: true, activity: busy ? "Codex 正在运行" : "已连接", waiting: busy, sending: false, connectError: "", silentConnect: false, conversation: normalizeConversation(data?.conversation), ...(data?.workspace?.activeThreadId !== undefined ? { activeThreadId: data.workspace.activeThreadId || "" } : {}), messages: useAgentStore.getState().messages.filter((item) => !isConnectionErrorMessage(item)) });
            if (!headless) message.success("本地 Agent 已连接");
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
        });
        source.addEventListener("codex_state", (event) => {
            const data = parseEventData<AgentCodexState>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const busy = Boolean(data.busy);
                setAgentState({ activity: busy ? "Codex 正在运行" : "完成", waiting: busy, ...(busy ? {} : { sending: false }) });
                if (!busy) localTurnActiveRef.current = false;
                if (!busy) void loadThreads();
            });
        });
        source.addEventListener("tool_call", (event) => {
            const data = parseEventData<AgentPendingToolCall>(event);
            if (data) void handleToolCall(endpoint, token, data).catch((error) => {
                const text = error instanceof Error ? error.message : "工具执行失败";
                addMessage({ role: "error", title: "工具执行失败", text });
                addEventLog("工具执行失败", error, data);
            });
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (data) enqueueEvent(() => {
                const state = useAgentStore.getState();
                const allowUnscoped = Boolean(eventFailureText(data) && state.connected);
                if (isCurrentThreadEvent(data, { clientId, allowUnscoped })) handleAgentEvent(data);
            });
        });
        source.addEventListener("conversation_changed", (event) => {
            const data = parseEventData<AgentConversationEvent>(event);
            if (!data) return;
            enqueueEvent(() => {
                const next = normalizeConversation(data);
                if (!next) return;
                setAgentState({ conversation: next, ...(next.threadId !== undefined ? { activeThreadId: next.threadId || "" } : {}) });
            });
        });
        source.addEventListener("agent_bootstrap", (event) => {
            const data = parseEventData<AgentBootstrapEvent>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (data.conversation) setAgentState({ conversation: normalizeConversation(data.conversation) });
                if (data.type === "codex.prepare_failed") {
                    const text = errorText(data.error) || errorText(data.failureReason) || errorText(data.additionalDetails) || "Codex 初始化失败";
                    addMessage({ role: "error", title: "Codex 初始化失败", text });
                    addEventLog("Codex 初始化失败", data, data);
                }
            });
        });
        source.addEventListener("workspace_changed", (event) => {
            const data = parseEventData<AgentWorkspaceEvent>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const nextThreadId = data.activeThreadId ?? data.threadId ?? "";
                const liveState = useAgentStore.getState();
                const preserveLiveTurn = localTurnActiveRef.current || liveState.sending || liveState.waiting || liveState.messages.some((item) => Boolean(item.streamId || item.streamDelta));
                const sameThread = Boolean(nextThreadId && nextThreadId === liveState.activeThreadId);
                pendingToolRef.current = null;
                setAgentState({ activeThreadId: nextThreadId, ...(data.conversation ? { conversation: normalizeConversation(data.conversation) } : {}), ...(preserveLiveTurn || sameThread ? {} : { messages: [] }), pendingTool: null });
                void loadThreads(data.emptyThread);
            });
        });
        source.addEventListener("chat_message", (event) => {
            const data = parseEventData<AgentChatEvent>(event);
            if (!data?.message) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data, { clientId, allowUnscoped: data.sourceClientId === clientId })) return;
                addMessage(data.message!);
            });
        });
        source.addEventListener("agent_log", (event) => {
            const text = parseEventData<{ text?: unknown }>(event)?.text;
            addEventLog("日志", text, text);
        });
        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (!data) return;
            enqueueEvent(() => {
                const state = useAgentStore.getState();
                if (!isCurrentThreadEvent(data, { clientId, allowUnscoped: state.connected })) return;
                const text = errorText(data.error) || normalizeText(data.message) || "本地 Agent 执行失败";
                const current = state.messages;
                if (current.some((message) => message.title === "Codex" && (message.streamId || message.streamDelta))) {
                    setAgentState({ messages: current.map((message) => (message.title === "Codex" ? { ...message, streamId: undefined, streamDelta: undefined } : message)) });
                }
                addMessage({ role: "error", title: "错误", text, detail: data });
                addEventLog("错误", text, data);
                localTurnActiveRef.current = false;
            });
        });
        source.onerror = () => {
            const wasConnected = connectedRef.current;
            const silent = useAgentStore.getState().silentConnect && !wasConnected;
            const text = wasConnected ? "本地 Agent 连接失败或已断开" : "连接失败，请检查地址和 token";
            if (!errorLoggedRef.current || wasConnected) {
                addEventLog(wasConnected ? "连接断开" : "连接失败", { endpoint, error: text });
                if (!headless && !silent) message.error(text);
            }
            errorLoggedRef.current = true;
            connectedRef.current = false;
            clearAgentSession({ activity: wasConnected ? "连接断开" : "连接失败", connected: false, connectError: silent ? "" : text, silentConnect: false });
            if (!wasConnected) {
                source.close();
                setAgentState({ enabled: false });
            }
        };
        return () => {
            source.close();
            connectedRef.current = false;
            localTurnActiveRef.current = false;
            codexOutputRef.current = false;
            loadThreadsSequenceRef.current += 1;
        };
    }, [enabled, endpoint, loadThreads, message, setAgentState, token]);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads]);

    useEffect(() => {
        if (!connected) return;
        const activate = () => void activateAgentClient(endpoint, token, clientIdRef.current);
        const activateVisible = () => {
            if (document.visibilityState === "visible") activate();
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activateVisible);
        return () => {
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activateVisible);
        };
    }, [connected, endpoint, token]);

    const executeLlmTool = async (payload: AgentPendingToolCall): Promise<unknown> => {
        const input = payload.input || {};
        addEventLog(`Skill + LLM：${payload.name}`, payload, payload);
        let result: unknown;
        if (payload.name === "skill") {
            const requested = typeof input.name === "string" ? input.name : "";
            if (!agentLlmConfig.skills.includes(requested as AgentSkillId)) throw new Error(`Skill 未启用：${requested || "未指定"}`);
            const definition = getAgentSkillDefinition(requested);
            if (!definition) throw new Error(`未知视觉 Skill：${requested}`);
            result = { ok: true, loaded: true, name: definition.id, label: definition.label, instructions: definition.instructions };
        } else if (payload.name === "canvas_get_state") {
            result = canvasContextRef.current?.snapshot || { error: "当前不在画布页" };
        } else if (payload.name === "canvas_get_selection") {
            const snapshot = canvasContextRef.current?.snapshot;
            result = snapshot ? { nodes: snapshot.nodes.filter((node) => snapshot.selectedNodeIds.includes(node.id)) } : { error: "当前不在画布页" };
        } else if (payload.name === "canvas_export_snapshot") {
            result = canvasContextRef.current?.snapshot || { error: "当前不在画布页" };
        } else if (payload.name === "canvas_create_attachment_nodes") {
            const context = canvasContextRef.current;
            if (!context) throw new Error("当前不在画布页，请先让 Agent 打开画布");
            const ids = Array.isArray(input.attachmentIds) ? input.attachmentIds.filter((id): id is string => typeof id === "string") : [];
            if (!ids.length) throw new Error("没有可添加的图片附件");
            const startX = typeof input.x === "number" ? input.x : (context.snapshot.nodes.length ? Math.max(...context.snapshot.nodes.map((node) => node.position.x + node.width)) + 80 : 0);
            const startY = typeof input.y === "number" ? input.y : 0;
            const gap = typeof input.gap === "number" ? input.gap : 40;
            const direction = input.direction === "column" ? "column" : "row";
            const ops: CanvasAgentOp[] = [];
            for (const [index, attachmentId] of ids.entries()) {
                const attachment = attachments.find((item) => item.id === attachmentId);
                if (!attachment) throw new Error(`找不到本轮图片附件：${attachmentId}`);
                const image = await uploadImage(attachment.dataUrl);
                const size = fitNodeSize(image.width, image.height);
                ops.push({ type: "add_node", id: `image-${randomId()}`, nodeType: "image", title: attachment.name || `参考图 ${index + 1}`, position: { x: direction === "row" ? startX + index * (size.width + gap) : startX, y: direction === "column" ? startY + index * (size.height + gap) : startY }, width: size.width, height: size.height, metadata: imageMetadata(image) });
            }
            result = context.applyOps(ops);
        } else if (payload.name.startsWith("canvas_")) {
            const context = canvasContextRef.current;
            if (!context) throw new Error("当前不在画布页，请先让 Agent 打开画布");
            const ops = expandCanvasTool(payload.name, input, context.snapshot);
            if (!ops) throw new Error(`方案三不支持工具：${payload.name}`);
            result = context.applyOps(ops);
        } else if (payload.name === "site_navigate") {
            const path = typeof input.path === "string" ? input.path : "/";
            navigate(path);
            result = { ok: true, path };
        } else if (isSiteTool(payload.name)) {
            result = await runSiteTool(payload.name, input, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
        } else {
            throw new Error(`方案三不支持工具：${payload.name}`);
        }
        addMessage({ role: "tool", title: `Skill + LLM：${payload.name}`, text: toolResultSummary(payload.name, result), detail: { name: payload.name, input, result } });
        addEventLog(`Skill + LLM：${payload.name}完成`, result, result);
        return result;
    };

    const runLlmTool = async (payload: AgentPendingToolCall) => {
        const needsConfirmation = payload.name.startsWith("canvas_") || ["workbench_image_generate", "workbench_video_generate", "assets_add"].includes(payload.name);
        if (confirmToolsRef.current && needsConfirmation) {
            if (pendingToolRef.current || llmPendingRef.current) throw new Error("仍有待确认的工具调用");
            setAgentState({ pendingTool: payload });
            pendingToolRef.current = payload;
            addEventLog("Skill + LLM 等待确认", payload, payload);
            return await new Promise<unknown>((resolve) => {
                llmPendingRef.current = { payload, resolve };
            });
        }
        return await executeLlmTool(payload);
    };

    const sendLlmPrompt = async () => {
        const text = prompt.trim();
        if (!text || sending || waiting) return;
        if (!agentLlmConfig.enabled) {
            addMessage({ role: "error", title: "方案三未启用", text: "请管理员先在后台启用 Agent LLM 并选择文本模型。" });
            return;
        }
        const model = agentLlmConfig.model;
        if (!model) {
            addMessage({ role: "error", title: "未配置 Agent LLM 模型", text: "请管理员先在后台选择文本模型。" });
            return;
        }
        const separator = model.indexOf("::");
        const channelId = separator >= 0 ? model.slice(0, separator) : "";
        const modelName = separator >= 0 ? model.slice(separator + 2) : "";
        const channel = config.channels.find((item) => item.id === channelId);
        if (!channel?.baseUrl.trim().startsWith("/api/ai/") || !modelName || !channel.models.some((item) => item.name === modelName && item.capability === "text")) {
            addMessage({ role: "error", title: "Agent LLM 渠道未就绪", text: "服务器文本模型渠道尚未加载或已失效，请刷新页面或联系管理员。" });
            return;
        }
        const selection = useAgentStore.getState().canvasSelection;
        const selectedNodes = selection?.items || [];
        const messageId = createId();
        const history = messages
            .filter((item) => item.role === "user" || item.role === "assistant")
            .slice(-12)
            .map((item) => ({ role: item.role as "user" | "assistant", content: item.text }));
        const llmConfig = { ...config, model, textModel: model };
        setAgentState({ activity: "Skill + LLM 思考中", sending: true, waiting: true });
        addMessage({ id: messageId, role: "user", text, ...(selectedNodes.length ? { canvasSelection: selectedNodes } : {}) });
        addEventLog("Skill + LLM 用户发送", { text, model, skills: agentLlmConfig.skills, selectedNodes: selectedNodes.length });
        let activeAssistantId = "";
        try {
            const enabledTools = toolsForAgentSkills(agentLlmConfig.skills as AgentSkillId[]);
            if (!enabledTools.length) throw new Error("当前没有可用 Skill 工具，请管理员先配置 Skill");
            const attachmentHint = attachments.length ? `\n\n本轮可用图片附件：\n${attachments.map((item, index) => `${index + 1}. attachmentId=${item.id}, name=${item.name}`).join("\n")}\n需要使用附件时，先调用 canvas_create_attachment_nodes，再使用返回的真实节点 ID 作为 referenceNodeIds。` : "";
            const selectionHint = formatAgentCanvasSelectionContext(selection);
            const conversation: ResponseInputMessage[] = [{ role: "system", content: buildAgentLlmSystemPrompt(agentLlmConfig.skills as AgentSkillId[]) }, ...history, { role: "user", content: `${text}${selectionHint ? `\n\n${selectionHint}` : ""}${attachmentHint}` }];
            let hasAssistantOutput = false;
            for (let round = 0; round < 5; round += 1) {
                const assistantId = createId();
                activeAssistantId = assistantId;
                const result = await requestAgentLlmTurn(llmConfig, conversation, enabledTools, (nextText) => {
                    if (nextText) {
                        hasAssistantOutput = true;
                        addMessage({ id: assistantId, role: "assistant", title: "Skill + LLM", text: nextText, streamId: assistantId });
                    }
                }, { charge: round === 0 });
                if (result.content) {
                    hasAssistantOutput = true;
                    conversation.push({ role: "assistant", content: result.content });
                    // 某些代理会在响应结束时才返回完整文本，没有任何 delta；
                    // 用最终结果兜底，并清除流式状态，避免面板只显示空白或首段。
                    addMessage({ id: assistantId, role: "assistant", title: "Skill + LLM", text: result.content });
                } else {
                    const current = useAgentStore.getState().messages;
                    if (current.some((item) => item.id === assistantId && (item.streamId || item.streamDelta))) setAgentState({ messages: current.map((item) => (item.id === assistantId ? { ...item, streamId: undefined, streamDelta: undefined } : item)) });
                }
                if (!result.toolCalls.length) {
                    if (!result.content) addMessage({ id: assistantId, role: "assistant", title: "Skill + LLM", text: "没有返回内容。" });
                    break;
                }
                for (const call of result.toolCalls) {
                    const input = parseToolArguments(call.function.arguments);
                    const payload: AgentPendingToolCall = { requestId: call.id, toolCallId: call.id, source: "llm", name: call.function.name, input };
                    conversation.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) });
                    try {
                        const toolResult = await runLlmTool(payload);
                        conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult) });
                    } catch (error) {
                        const errorText = error instanceof Error ? error.message : "工具执行失败";
                        conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: errorText }) });
                        addMessage({ role: "tool", title: `Skill + LLM：${call.function.name}失败`, text: errorText, detail: payload });
                    }
                }
            }
            if (!hasAssistantOutput) addMessage({ role: "assistant", title: "Skill + LLM", text: "任务已执行，但模型未返回文字结果。" });
            addEventLog("Skill + LLM 完成", { model });
            setAgentState({ prompt: "" });
        } catch (error) {
            if (activeAssistantId) {
                const current = useAgentStore.getState().messages;
                if (current.some((item) => item.id === activeAssistantId && (item.streamId || item.streamDelta))) {
                    setAgentState({ messages: current.map((item) => (item.id === activeAssistantId ? { ...item, streamId: undefined, streamDelta: undefined } : item)) });
                }
            }
            const errorText = error instanceof Error ? error.message : "Agent LLM 请求失败";
            addMessage({ role: "error", title: "Skill + LLM 失败", text: errorText });
            addEventLog("Skill + LLM 失败", error);
        } finally {
            if (activeAssistantId) {
                const current = useAgentStore.getState().messages;
                if (current.some((item) => item.id === activeAssistantId && (item.streamId || item.streamDelta))) {
                    setAgentState({ messages: current.map((item) => (item.id === activeAssistantId ? { ...item, streamId: undefined, streamDelta: undefined } : item)) });
                }
            }
            setAgentState({ sending: false, waiting: false, pendingTool: null, activity: "已完成" });
            pendingToolRef.current = null;
            llmPendingRef.current = null;
        }
    };

    const sendPrompt = async () => {
        if (agentMode === "llm") {
            await sendLlmPrompt();
            return;
        }
        const text = prompt.trim();
        const files = attachments;
        const requestPromptBase = promptWithAttachments(text, files);
        if (!connected || !requestPromptBase || sending || waiting) return;
        let currentConversation = useAgentStore.getState().conversation;
        let requestThreadId = useAgentStore.getState().activeThreadId || currentConversation?.threadId || "";
        // 新版 Canvas Agent 会在启动后处于 idle，必须先创建并预热一个草稿线程；
        // 旧版 Agent 没有 conversation 字段，也可以沿用服务端自动建线程的行为。
        const needsNewThread = !requestThreadId && (!currentConversation || ["idle", "completed"].includes(currentConversation.status || ""));
        if (needsNewThread || ["idle", "completed"].includes(currentConversation?.status || "")) {
            const started = await startNewThread();
            currentConversation = useAgentStore.getState().conversation;
            requestThreadId = useAgentStore.getState().activeThreadId || currentConversation?.threadId || "";
            if (!started && currentConversation?.status !== "ready" && currentConversation?.status !== "warning") return;
        }
        if (currentConversation?.status && !["ready", "warning"].includes(currentConversation.status)) {
            const text = currentConversation.status === "preparing" ? "Codex 对话仍在初始化，请稍候再发送" : currentConversation.error || "当前 Codex 对话不可用，请先刷新或恢复会话";
            addMessage({ role: "error", title: "对话尚未就绪", text });
            return;
        }
        if (attachmentPayloadBytes(files) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            addMessage({ role: "error", title: "图片过大", text: "图片附件超过 30MB，请删减后再发送。" });
            return;
        }
        setAgentState({ activity: "发送中", sending: true });
        localTurnActiveRef.current = true;
        const selection = useAgentStore.getState().canvasSelection;
        const selectedNodes = selection?.items || [];
        const selectionHint = formatAgentCanvasSelectionContext(selection);
        const requestPrompt = `${requestPromptBase}${selectionHint ? `\n\n${selectionHint}` : ""}`;
        const messageId = createId();
        addMessage({ id: messageId, role: "user", text: text || "发送了图片", attachments: files, clientMessageId: messageId, ...(selectedNodes.length ? { canvasSelection: selectedNodes } : {}) });
        addEventLog("用户发送", { text, attachments: files.map(({ name, type, size }) => ({ name, type, size })), selectedNodes: selectedNodes.length });
        try {
            const data = await fetchAgentJson<{ threadId?: string }>(endpoint, token, "/agent/codex/turn", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    prompt: requestPrompt,
                    messageText: text || `发送了 ${files.length} 张图片`,
                    messageId,
                    clientId: clientIdRef.current,
                    threadId: requestThreadId || undefined,
                    permissionMode: "request",
                    ...(currentConversation?.conversationId ? { conversationId: currentConversation.conversationId } : {}),
                    ...(typeof currentConversation?.revision === "number" ? { expectedRevision: currentConversation.revision } : {}),
                    ...(selectedNodes.length ? { selectionContext: formatAgentCanvasSelectionContext(selection), canvasSelection: selectedNodes } : {}),
                    attachments: files.map(({ id, name, type, size, width, height, dataUrl }) => ({ id, name, type, size, width, height, dataUrl })),
                }),
            });
            if (data.threadId) setAgentState({ activeThreadId: data.threadId });
            addEventLog("本地 Agent 已接收", { threadId: data.threadId });
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
            setAgentState({ prompt: "", attachments: [] });
        } catch (error) {
            localTurnActiveRef.current = false;
            updateConversationFromError(error);
            const text = error instanceof Error ? error.message : "发送失败";
            const busy = text.includes("Codex 正在运行");
            setAgentState({ activity: busy ? "Codex 正在运行" : "发送失败" });
            addMessage({ role: "error", title: busy ? "任务仍在运行" : "发送失败", text });
            addEventLog("发送失败", error);
        } finally {
            setAgentState({ sending: false });
        }
    };

    const stopTurn = async () => {
        if (!connected || (!sending && !waiting)) return;
        setAgentState({ activity: "停止中" });
        try {
            await fetch(`${endpoint}/agent/codex/interrupt`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": token }, body: JSON.stringify({ threadId: useAgentStore.getState().activeThreadId || undefined }) });
            addEventLog("用户停止", {});
        } catch {
            setAgentState({ activity: "停止失败" });
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useAgentStore.getState().attachments;
        try {
            const next = await Promise.all(
                images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                    const dataUrl = await readDataUrl(file);
                    const meta = await readImageMeta(dataUrl);
                    const url = URL.createObjectURL(file);
                    attachmentUrlsRef.current.add(url);
                    return { id: createId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url, dataUrl };
                }),
            );
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: "图片过大", text: "图片附件最多约 30MB。" });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            addMessage({ role: "error", title: "图片读取失败", text: error instanceof Error ? error.message : "图片读取失败" });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (confirmToolsRef.current && isCanvasWriteTool(payload.name)) {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: "仍有待确认的画布工具调用" });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload });
            addEventLog("等待确认", payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (isSiteTool(payload.name)) {
            try {
                addEventLog(toolName(payload.name), payload, payload);
                const result = await runSiteTool(payload.name, payload.input || {}, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
                addEventLog(`${toolName(payload.name)}完成`, result, result);
                addMessage({ role: "tool", title: `${toolName(payload.name)}完成`, text: siteToolSummary(payload.name, result), detail: { requestId: payload.requestId, name: payload.name, input: payload.input, result } });
            } catch (error) {
                const message = error instanceof Error ? error.message : "工具执行失败";
                addMessage({ role: "tool", title: "工具失败", text: message, detail: payload });
                try {
                    await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
                } catch (submitError) {
                    addEventLog("提交工具结果失败", submitError, payload);
                }
            }
            return;
        }
        try {
            const input: { ops?: CanvasAgentOp[]; path?: string } = payload.input || {};
            addEventLog(toolName(payload.name), payload, payload);
            let result: unknown;
            let appliedOps = input.ops || [];
            if (payload.name === "site_navigate") {
                const path = input.path || "/";
                navigate(path);
                result = { ok: true, path };
            } else if (payload.name === "canvas_apply_ops") {
                const context = canvasContextRef.current;
                if (!context) throw new Error("当前不在画布页，请先用 site_navigate 打开画布");
                result = context.applyOps(appliedOps);
                void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (payload.name === "canvas_create_attachment_nodes") {
                const context = canvasContextRef.current;
                if (!context) throw new Error("当前不在画布页，请先用 site_navigate 打开画布");
                appliedOps = await attachmentNodeOps(endpoint, token, clientIdRef.current, payload.input?.nodes);
                result = context.applyOps(appliedOps);
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else {
                const snapshot = canvasContextRef.current?.snapshot;
                if (!snapshot) throw new Error("当前不在画布页，请先用 site_navigate 打开画布");
                result = snapshot;
            }
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            addEventLog(`${toolName(payload.name)}完成`, result, result);
            addMessage({
                role: "tool",
                title: `${toolName(payload.name)}完成`,
                text: appliedOps.length ? summarizeCanvasAgentOps(appliedOps) || "画布操作" : payload.name === "site_navigate" ? `已跳转到 ${input.path || "/"}` : "已完成",
                detail: { requestId: payload.requestId, name: payload.name, input, result },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "画布操作失败";
            addMessage({ role: "tool", title: "工具失败", text: message, detail: payload });
            try {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
            } catch (submitError) {
                addEventLog("提交工具结果失败", submitError, payload);
            }
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        if (pendingTool.source === "llm") {
            llmPendingRef.current?.resolve({ ok: false, error: "用户取消了工具调用" });
            llmPendingRef.current = null;
            pendingToolRef.current = null;
            setAgentState({ pendingTool: null });
            addMessage({ role: "tool", title: "拒绝执行", text: toolName(pendingTool.name), detail: pendingTool });
            return;
        }
        try {
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: "用户取消了画布工具调用" });
        } catch (error) {
            addMessage({ role: "error", title: "取消工具失败", text: error instanceof Error ? error.message : "取消工具失败" });
        }
        addMessage({ role: "tool", title: "拒绝执行", text: toolName(pendingTool.name), detail: { requestId: pendingTool.requestId, name: pendingTool.name, input: pendingTool.input } });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        if (tool.source === "llm") {
            pendingToolRef.current = null;
            setAgentState({ pendingTool: null });
            try {
                const result = await executeLlmTool(tool);
                llmPendingRef.current?.resolve(result);
            } catch (error) {
                llmPendingRef.current?.resolve({ ok: false, error: error instanceof Error ? error.message : "工具执行失败" });
            } finally {
                llmPendingRef.current = null;
            }
            return;
        }
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const toggleAgentConnection = async ({ silent = false }: { silent?: boolean } = {}) => {
        if (enabled) {
            clearAgentSession({ enabled: false, connected: false, activity: "离线", connectError: "" });
            return;
        }
        const urlToken = searchParams.get("agentToken") || "";
        const urlEndpoint = searchParams.get("agentUrl") || "";
        const discovered = urlToken ? null : await discoverAgentConfig(endpoint || DEFAULT_AGENT_URL);
        const nextEndpoint = (urlEndpoint || discovered?.url || endpoint || DEFAULT_AGENT_URL).trim().replace(/\/$/, "");
        const nextToken = (urlToken || token.trim() || discovered?.token || "").trim();
        if (!nextEndpoint) {
            const text = "请填写本地 Agent 地址";
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        if (!nextToken) {
            const text = "没有发现本地 Agent，请先在 Codex 使用插件或手动启动 Canvas Agent";
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        try {
            const parsed = new URL(nextEndpoint);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
        } catch {
            const text = "本地 Agent 地址格式不正确";
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: nextEndpoint, token: nextToken, enabled: true, connected: false, silentConnect: silent, activity: "连接中", connectError: "", activeTab: "setup" });
    };

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    useEffect(() => {
        if (!autoConnect || autoConnectRef.current || enabled || connected) return;
        autoConnectRef.current = true;
        void toggleAgentConnection({ silent: true });
    }, [autoConnect, connected, enabled]);

    function clearAgentSession(patch: Parameters<typeof setAgentState>[0] = {}) {
        loadThreadsSequenceRef.current += 1;
        localTurnActiveRef.current = false;
        codexOutputRef.current = false;
        setAgentState({
            messages: [],
            threads: [],
            conversation: null,
            activeThreadId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            pendingTool: null,
            ...patch,
        });
        pendingToolRef.current = null;
    }

    function updateConversationFromError(error: unknown) {
        const payload = error && typeof error === "object" ? (error as { payload?: unknown }).payload : undefined;
        const state = objectField(payload, "state") || objectField(payload, "conversation");
        const next = normalizeConversation(state);
        if (next) setAgentState({ conversation: next, ...(next.threadId !== undefined ? { activeThreadId: next.threadId || "" } : {}) });
    }

    const startNewThread = async () => {
        if (!connected || sending || waiting) return false;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadResponse>(endpoint, token, "/agent/codex/threads/new", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current, permissionMode: "request" }) });
            const nextConversation = normalizeConversation(data.conversation);
            setAgentState({ ...(nextConversation ? { conversation: nextConversation } : {}), activeThreadId: data.thread?.id || data.workspace?.activeThreadId || nextConversation?.threadId || "", messages: [], activeTab: "chat", activity: "新对话" });
            return true;
        } catch (error) {
            updateConversationFromError(error);
            addEventLog("新建对话失败", error);
            const text = errorText(error) || "新建对话失败，请检查 Codex 登录、套餐和模型权限";
            addMessage({ role: "error", title: "新建对话失败", text, detail: error });
            message.error(text);
            return false;
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const resumeThread = async (threadId: string) => {
        if (!connected || !threadId || sending || waiting) return;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current, permissionMode: "request" }) });
            setAgentState({ ...(data.conversation ? { conversation: normalizeConversation(data.conversation) } : {}), activeThreadId: data.thread?.id || threadId, messages: normalizeHistoryMessages(data.messages || []), activeTab: "chat", activity: "已恢复会话" });
        } catch (error) {
            updateConversationFromError(error);
            addEventLog("恢复对话失败", error);
            message.error(error instanceof Error ? error.message : "恢复对话失败");
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const deleteThread = async (threadId: string) => {
        if (!connected || !threadId || sending || waiting) return;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current }) });
            const current = useAgentStore.getState();
            setAgentState({
                ...(data.conversation ? { conversation: normalizeConversation(data.conversation) } : {}),
                threads: current.threads.filter((thread) => thread.id !== threadId),
                activeThreadId: current.activeThreadId === threadId ? "" : current.activeThreadId,
                messages: current.activeThreadId === threadId ? [] : current.messages,
            });
            message.success("记录已删除");
        } catch (error) {
            updateConversationFromError(error);
            addEventLog("删除对话失败", error);
            message.error(error instanceof Error ? error.message : "删除对话失败");
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const confirmDeleteThread = (thread: AgentThreadSummary) => {
        const label = thread.name || thread.preview || "未命名对话";
        modal.confirm({
            title: "删除对话记录",
            content: `确定删除「${label.length > 48 ? `${label.slice(0, 48)}...` : label}」吗？`,
            okText: "删除",
            okType: "danger",
            cancelText: "取消",
            onOk: () => deleteThread(thread.id),
        });
    };

    const addMessage = (item: Omit<AgentChatItem, "id"> & { id?: string }) => {
        const text = item.streamDelta && typeof item.text === "string" ? item.text : normalizeText(item.text);
        const next = { ...item, id: item.id || `${Date.now()}-${Math.random()}`, text } as AgentChatItem;
        const currentMessages = useAgentStore.getState().messages;
        if (next.clientMessageId && currentMessages.some((message) => message.clientMessageId === next.clientMessageId && message.role === next.role)) return;
        const existingAssistantIndex = next.role === "assistant"
            ? (next.streamId
                ? currentMessages.findIndex((message) => message.streamId === next.streamId)
                : currentMessages.findIndex((message) => message.role === "assistant" && (message.id === next.id || Boolean(next.threadId && next.turnId && message.threadId === next.threadId && message.turnId === next.turnId))))
            : -1;
        if (!text && !item.attachments?.length && existingAssistantIndex < 0) return;
        if (next.role === "assistant") {
            const index = existingAssistantIndex;
            if (index >= 0) {
                const previous = currentMessages[index];
                const mergedText = next.streamDelta ? `${previous.text}${next.text}` : next.text || previous.text;
                if (mergedText === previous.text && previous.streamId === next.streamId && previous.streamDelta === next.streamDelta && previous.meta === next.meta) return;
                setAgentState({ messages: currentMessages.map((message, i) => (i === index ? { ...message, ...next, id: message.id, text: mergedText, streamId: next.streamId, streamDelta: next.streamDelta } : message)) });
                return;
            }
        }
        if (currentMessages.some((message) => message.id === next.id)) return;
        pushMessage(next);
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString(), title, text: normalizeText(text) || title, raw });
    };

    const handleAgentEvent = (event: AgentEventPayload) => {
        if (shouldLogAgentEvent(event)) addEventLog(eventTitle(event), event, event);
        const eventThreadId = event.thread_id || event.threadId;
        if (event.type === "thread.started" && eventThreadId) setAgentState({ activeThreadId: eventThreadId });
        if (event.type === "turn.started") {
            codexOutputRef.current = false;
            if (useAgentStore.getState().conversation) setAgentState({ conversation: { ...useAgentStore.getState().conversation!, status: "running" } });
        }
        if (["turn.completed", "turn.failed", "error"].includes(event.type || "")) {
            const current = useAgentStore.getState().messages;
            if (current.some((message) => message.title === "Codex" && (message.streamId || message.streamDelta))) {
                setAgentState({ messages: current.map((message) => (message.title === "Codex" ? { ...message, streamId: undefined, streamDelta: undefined } : message)) });
            }
            localTurnActiveRef.current = false;
        }
        const item = formatAgentEvent(event);
        if (item) {
            if (item.role === "assistant" && item.text) codexOutputRef.current = true;
            addMessage(item);
        }
        if (event.type === "turn.completed") {
            const failure = eventFailureText(event);
            if (!failure && !codexOutputRef.current) addMessage({ role: "assistant", title: "Codex", text: "任务已完成，但 Codex 未返回文字结果。" });
            if (!failure && useAgentStore.getState().conversation) setAgentState({ conversation: { ...useAgentStore.getState().conversation!, status: "ready", error: undefined } });
            codexOutputRef.current = false;
        }
    };

    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                items={[
                    { value: "setup", label: "连接", icon: <PlugZap className="size-3.5" /> },
                    { value: "chat", label: "对话", icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: threads.length },
                    { value: "log", label: "日志", icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        <Button size="small" type="text" disabled={agentMode !== "local" || !connected || loadingThreads || sending || waiting} icon={<Plus className="size-3.5" />} onClick={startNewThread}>
                            新对话
                        </Button>
                    </>
                }
            />

            {agentMode === "local" && connected && conversation && (conversation.error || ["preparing", "failed"].includes(conversation.status || "")) ? (
                <div className="mx-4 mt-2 rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                    {conversation.error || (conversation.status === "preparing" ? "Codex 正在初始化，请稍候" : "Codex 对话不可用，请新建或恢复会话")}
                </div>
            ) : null}

            {activeTab === "setup" ? (
                <AgentConnectView
                    theme={theme}
                    agentMode={agentMode}
                    agentLlmConfig={agentLlmConfig}
                    agentLlmLoading={agentLlmLoading}
                    canConfigureSkills={currentAuthUser?.role === "admin"}
                    onOpenSkillConfig={() => navigate("/admin?tab=api-map&focus=agent-llm")}
                    onModeChange={(mode) => {
                        setAgentState({ agentMode: mode, activeTab: mode === "llm" ? "chat" : "setup" });
                        localStorage.setItem("canvas-agent-mode", mode);
                    }}
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    theme={theme}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    busy={sending || waiting}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThread={confirmDeleteThread}
                />
            ) : activeTab === "log" ? (
                <AgentLogView
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messages.length, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    <div className="relative min-h-0 flex-1">
                        <div ref={listRef} className="thin-scrollbar h-full space-y-4 overflow-y-auto px-4 pb-12 pt-4" onScroll={updateScrollState}>
                            {messages.map((item) => (
                                <AgentChatMessage key={item.id} item={agentMessageToChatMessage(item)} theme={theme} user={user} />
                            ))}
                            {pendingTool ? (
                                <AgentPendingToolCard
                                    summary={summarizeCanvasAgentOps(pendingTool.input?.ops || []) || toolName(pendingTool.name)}
                                    detail={{ requestId: pendingTool.requestId, name: pendingTool.name, input: pendingTool.input }}
                                    theme={theme}
                                    onReject={rejectPendingTool}
                                    onApprove={approvePendingTool}
                                />
                            ) : null}
                            {waiting && !pendingTool ? <AgentWorkingMessage theme={theme} /> : null}
                        </div>
                        {showScrollToBottom ? (
                            <Tooltip title="滚动到底部" placement="left">
                                <Button
                                    type="text"
                                    shape="circle"
                                    aria-label="滚动到底部"
                                    className="!absolute bottom-3 left-1/2 z-10 !h-8 !w-8 !min-w-8 -translate-x-1/2 backdrop-blur transition hover:-translate-y-0.5"
                                    style={{ background: theme.toolbar.panel, border: `1px solid ${theme.node.stroke}`, color: theme.node.text }}
                                    icon={<ChevronDown className="size-4" />}
                                    onClick={() => scrollToBottom()}
                                />
                            </Tooltip>
                        ) : null}
                    </div>
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={attachments.map(agentAttachmentToChatAttachment)}
                        selectedNodes={canvasSelection?.items || []}
                        disabled={agentMode === "local" ? !connected || Boolean(conversation?.status && !["ready", "warning", "idle", "completed"].includes(conversation.status)) : !agentLlmConfig.enabled}
                        sending={sending || waiting}
                        placeholder={agentMode === "llm" ? "描述你想完成的图片或视频创作任务" : "询问 Codex，或让它操作网站/画布"}
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onStop={stopTurn}
                        onAddFiles={addAttachments}
                        onRemoveAttachment={removeAttachment}
                        left={
                            attachments.length ? (
                                <span className="text-[11px]" style={{ color: theme.node.muted }}>
                                    {formatBytes(attachmentPayloadBytes(attachments))} / 30MB
                                </span>
                            ) : null
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    return embedded ? content : null;
}

function AgentLogView({
    logs,
    theme,
    context,
    onClear,
    onCopied,
    onCopyBlocked,
}: {
    logs: AgentEventLog[];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    context: AgentLogContext;
    onClear: () => void;
    onCopied: (text: string) => void;
    onCopyBlocked: (text: string) => void;
}) {
    const [mode, setMode] = useState<"text" | "json">("text");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const content = mode === "text" ? formatLogText(logs, context) : formatLogJson(logs, context);
    const lastError = [...logs].reverse().find((item) => /错误|失败|error/i.test(`${item.title}\n${item.text}`));
    const copy = async (value = content, tip = "日志已复制") => {
        if (await copyToClipboard(value)) {
            onCopied(tip);
            return;
        }
        textareaRef.current?.focus();
        textareaRef.current?.select();
        onCopyBlocked("已选中日志，请手动复制");
    };
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="flex min-h-full flex-col gap-3">
                <div>
                    <div className="text-base font-semibold leading-6">运行日志</div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Segmented
                        size="small"
                        value={mode}
                        onChange={(value) => setMode(value as "text" | "json")}
                        options={[
                            { label: "排查日志", value: "text" },
                            { label: "原始 JSON", value: "json" },
                        ]}
                    />
                    <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: theme.node.muted }}>
                            {logs.length} 条
                        </span>
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>
                            复制
                        </Button>
                        <Button size="small" disabled={!lastError} onClick={() => lastError && void copy(formatLogText([lastError], context), "最近错误已复制")}>
                            最近错误
                        </Button>
                        <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={onClear}>
                            清空
                        </Button>
                    </div>
                </div>
                <textarea
                    ref={textareaRef}
                    readOnly
                    value={content}
                    className="thin-scrollbar min-h-[360px] flex-1 resize-none rounded-lg border bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    onFocus={(event) => event.currentTarget.select()}
                />
            </div>
        </div>
    );
}

function AgentConnectView({
    theme,
    agentMode,
    agentLlmConfig,
    agentLlmLoading,
    canConfigureSkills,
    onOpenSkillConfig,
    onModeChange,
    url,
    token,
    enabled,
    connected,
    activity,
    connectError,
    onUrlChange,
    onTokenChange,
    onToggleEnabled,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    agentMode: "local" | "llm";
    agentLlmConfig: ServerAgentLlmConfig;
    agentLlmLoading: boolean;
    canConfigureSkills: boolean;
    onOpenSkillConfig: () => void;
    onModeChange: (mode: "local" | "llm") => void;
    url: string;
    token: string;
    enabled: boolean;
    connected: boolean;
    activity: string;
    connectError: string;
    onUrlChange: (value: string) => void;
    onTokenChange: (value: string) => void;
    onToggleEnabled: () => void;
}) {
    const { message } = App.useApp();
    const statusText = connectError ? "连接失败" : connected ? activity : enabled ? "连接中" : "未连接";
    const statusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;
    const copyCommand = (command: string) => {
        copyToClipboard(command);
        message.success("命令已复制");
    };
    const codexPluginReminder = (
        <div className="rounded-lg border px-3 py-2.5 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
            <div className="font-medium" style={{ color: theme.node.text }}>
                Codex 插件提醒
            </div>
            <div className="mt-1">只有安装 Codex 插件或手动添加 MCP 后，工具列表才会进入 Codex 上下文并增加 token 消耗；仅运行 `npx -y @basketikun/canvas-agent` 启动本地 Agent 不会安装 MCP。</div>
            <div className="mt-2 grid gap-1.5">
                {[
                    ["移除插件", AGENT_PLUGIN_REMOVE_COMMAND],
                    ["移除手动 MCP", AGENT_MCP_REMOVE_COMMAND],
                ].map(([label, command]) => (
                    <div key={command} className="flex items-center gap-2 rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                        <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                            {label}
                        </span>
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] leading-5">{command}</code>
                        <Tooltip title="复制命令">
                            <Button size="small" type="text" className="!h-6 !w-6 !min-w-6" icon={<Copy className="size-3.5" />} onClick={() => copyCommand(command)} />
                        </Tooltip>
                    </div>
                ))}
            </div>
        </div>
    );
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">选择 Agent 方案</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        保留本机 Codex 方案，同时可使用服务器配置的 Skill + LLM。
                    </div>
                </div>
                <Segmented
                    block
                    value={agentMode}
                    onChange={(value) => onModeChange(value as "local" | "llm")}
                    options={[{ value: "local", label: "方案一 / 二 · 本机 Codex" }, { value: "llm", label: "方案三 · Skill + LLM" }]}
                />
                <div className="rounded-xl border p-4" style={{ borderColor: agentMode === "llm" ? "rgba(139,92,246,.55)" : "rgba(139,92,246,.32)", background: "rgba(139,92,246,.05)" }}>
                        <div className="flex items-start gap-3">
                            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-500"><Bot className="size-5" /></span>
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                                    <span>Skill + LLM 创作助手</span>
                                    <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ borderColor: agentLlmConfig.enabled ? "rgba(22,163,74,.3)" : "rgba(217,119,6,.3)", color: agentLlmConfig.enabled ? "#16a34a" : "#d97706" }}>
                                        {agentLlmLoading ? "读取配置中" : agentLlmConfig.enabled ? "已启用" : "未启用"}
                                    </span>
                                </div>
                                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                    用服务器配置的文本模型帮助你拆解图片/视频需求、设计提示词和检查质量。生成前会先给出方案，不会自动扣费生成。
                                </div>
                                <div className="mt-3 flex flex-wrap gap-1.5">
                                    {agentLlmConfig.skills.map((skill) => <span key={skill} className="rounded-full border px-2 py-1 text-[11px]" style={{ borderColor: "rgba(139,92,246,.25)", color: theme.node.text }}>{AGENT_LLM_SKILL_LABELS[skill] || skill}</span>)}
                                    {!agentLlmConfig.skills.length ? <span className="text-xs" style={{ color: theme.node.muted }}>请管理员在后台启用 Skill</span> : null}
                                </div>
                                <Button className="mt-3" type={agentMode === "llm" ? "default" : "primary"} disabled={!agentLlmConfig.enabled || agentLlmLoading} onClick={() => onModeChange("llm")}>
                                    {agentMode === "llm" ? "方案三运行中" : "启动方案三"}
                                </Button>
                                {canConfigureSkills ? (
                                    <Button className="mt-3 ml-2" onClick={onOpenSkillConfig}>配置 Skill</Button>
                                ) : (
                                    <span className="ml-2 text-xs" style={{ color: theme.node.muted }}>Skill 由管理员配置</span>
                                )}
                            </div>
                        </div>
                </div>
                <div className="space-y-2">
                    {AGENT_CONNECT_STEPS.map((step, index) => {
                        const command = "command" in step ? step.command : "";
                        return (
                            <Fragment key={step.title}>
                                <div className="rounded-lg px-3 py-2.5">
                                    <div className="text-sm font-medium leading-5">{step.title}</div>
                                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                        {step.text}
                                    </div>
                                    {command ? (
                                        <div className="mt-2 flex items-center gap-2 rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                                            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] leading-5">{command}</code>
                                            <Tooltip title="复制命令">
                                                <Button size="small" type="text" className="!h-6 !w-6 !min-w-6" icon={<Copy className="size-3.5" />} onClick={() => copyCommand(command)} />
                                            </Tooltip>
                                        </div>
                                    ) : null}
                                </div>
                                {index === 0 ? codexPluginReminder : null}
                            </Fragment>
                        );
                    })}
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 text-sm font-medium leading-5">网页连接</span>
                                <span
                                    className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4"
                                    style={{ borderColor: connected || enabled || connectError ? statusColor : theme.node.stroke, color: statusColor }}
                                >
                                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: statusColor }} />
                                    <span className="truncate">{statusText}</span>
                                </span>
                            </div>
                            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                默认自动读取 Local URL 和 Connect token，失败时再手动填写。
                            </div>
                        </div>
                        <Button className="!h-8 !px-3" type={enabled ? "default" : "primary"} icon={<PlugZap className="size-4" />} onClick={onToggleEnabled}>
                            {enabled ? "断开" : "连接"}
                        </Button>
                    </div>
                    <div className="mt-3 grid gap-2.5">
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <Link2 className="size-3.5" />
                                本地地址
                                <span className="font-normal opacity-70">Local URL</span>
                            </span>
                            <Input size="large" prefix={<Link2 className="mr-1 size-4" style={{ color: theme.node.faint }} />} value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder="例如 http://127.0.0.1:17371" />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <KeyRound className="size-3.5" />
                                连接 Token
                                <span className="font-normal opacity-70">Connect token</span>
                            </span>
                            <Input.Password
                                size="large"
                                prefix={<KeyRound className="mr-1 size-4" style={{ color: theme.node.faint }} />}
                                value={token}
                                onChange={(event) => onTokenChange(event.target.value)}
                                placeholder="自动发现，或手动填入 Connect token"
                            />
                        </label>
                        {connectError ? (
                            <div className="rounded-md border px-2.5 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.35)", color: "#dc2626" }}>
                                {connectError}
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

function AgentHistoryView({
    theme,
    threads,
    activeThreadId,
    workspacePath,
    loading,
    busy,
    connected,
    onRefresh,
    onNewThread,
    onResumeThread,
    onDeleteThread,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    threads: AgentThreadSummary[];
    activeThreadId: string;
    workspacePath: string;
    loading: boolean;
    busy: boolean;
    connected: boolean;
    onRefresh: () => void;
    onNewThread: () => void;
    onResumeThread: (threadId: string) => void;
    onDeleteThread: (thread: AgentThreadSummary) => void;
}) {
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-3">
                <div className="flex min-w-0 items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="shrink-0">工作空间</span>
                    <span className="min-w-0 truncate" title={workspacePath}>
                        {workspacePath || "默认画布目录"}
                    </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm" style={{ color: theme.node.muted }}>
                        {threads.length ? `${threads.length} 条历史` : connected ? "暂无历史" : "未连接"}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={!connected || loading} onClick={onRefresh}>
                            刷新
                        </Button>
                        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} disabled={!connected || loading || busy} onClick={onNewThread}>
                            新对话
                        </Button>
                    </div>
                </div>
                <div className="space-y-2">
                    {threads.map((thread) => {
                        const active = thread.id === activeThreadId;
                        return (
                            <div key={thread.id} className="rounded-lg border px-2.5 py-1.5 transition" style={{ borderColor: active ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}>
                                <div className="flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {active ? (
                                                <span className="shrink-0 text-[10px] font-medium" style={{ color: theme.node.text }}>
                                                    当前
                                                </span>
                                            ) : null}
                                            <div className="truncate text-sm font-medium leading-5">{thread.name || thread.preview || "未命名对话"}</div>
                                        </div>
                                        <div className="truncate text-[11px] leading-4 opacity-65">{thread.preview || thread.id}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <span className="text-[10px] opacity-55">{formatThreadTime(thread.updatedAt || thread.createdAt)}</span>
                                        <Button size="small" className="!h-6 !px-2" disabled={loading || busy} onClick={() => onResumeThread(thread.id)}>
                                            进入
                                        </Button>
                                        <Tooltip title="删除记录">
                                            <Button size="small" danger type="text" className="!h-6 !w-6 !min-w-6" disabled={loading || busy} icon={<Trash2 className="size-3.5" />} onClick={() => onDeleteThread(thread)} />
                                        </Tooltip>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {!threads.length ? (
                        <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>
                            {connected ? "当前工作空间还没有对话记录" : "连接本地 Agent 后显示历史记录"}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        await fetch(`${endpoint}/canvas/state?clientId=${encodeURIComponent(clientId)}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-canvas-agent-token": token },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
    } catch {}
}

async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetch(`${endpoint}/canvas/activate?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "x-canvas-agent-token": token } });
    } catch {}
}

async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    const response = await fetch(`${endpoint}/canvas/result?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": token }, body: JSON.stringify(body) });
    if (response.ok) return;
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof payload?.error === "string" ? payload.error : `提交工具结果失败：${response.status}`);
}

function agentMessageToChatMessage(item: AgentChatItem) {
    return { ...item, attachments: item.attachments?.map(agentAttachmentToChatAttachment) };
}

function agentAttachmentToChatAttachment(item: AgentAttachment): CanvasAgentChatAttachment {
    return { id: item.id, name: item.name, url: item.dataUrl || item.url };
}

function formatAgentEvent(event: AgentEventPayload): Omit<AgentChatItem, "id"> & { id?: string } | null {
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "error") return { role: "error", title: "错误", text: errorText(item.message) || errorText(item.error) || "Codex 返回了错误", detail: item };
    const failure = eventFailureText(event);
    if (failure) return { role: "error", title: "本轮失败", text: failure, detail: event };
    const isAgentMessage = item?.type === "agent_message" || item?.type === "agentMessage";
    if ((event.type === "item.updated" || event.type === "item.completed") && isAgentMessage) {
        const snapshot = stringText(item.text);
        const delta = stringText(item.delta);
        const isDelta = event.type === "item.updated" && !snapshot && Boolean(delta);
        const threadId = event.thread_id || event.threadId;
        const turnId = event.turn_id || event.turnId;
        const messageId = item.id || [threadId, turnId, "agent-message"].filter(Boolean).join(":") || undefined;
        // item.completed 是最终快照；若某个旧 Agent 只发 delta，则不要再次把
        // 已累计的片段当成新快照覆盖，也不要让流式动画一直保持在运行态。
        const text = snapshot || (event.type === "item.updated" ? delta : "");
        return { id: messageId, role: "assistant", title: "Codex", text, meta: usageText(event), ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}), ...(event.type === "item.updated" && messageId ? { streamId: messageId } : {}), ...(isDelta ? { streamDelta: true } : {}) };
    }
    if (event.type === "item.completed" && isMcpToolItem(item) && isReadTool(String(item?.tool || ""))) return { role: "tool", title: `${toolName(String(item?.tool || ""))}完成`, text: errorText(item?.error) || toolSummary(item), detail: toolDetail(item) };
    const text = eventText(event);
    if (text) return { role: "assistant", title: "Codex", text, meta: usageText(event) };
    return null;
}

function parseEventData<T>(event: Event) {
    try {
        return JSON.parse((event as MessageEvent).data) as T;
    } catch {
        return null;
    }
}

function isCurrentThreadEvent(event: { threadId?: string; thread_id?: string; type?: string; sourceClientId?: string }, options: { clientId?: string; allowUnscoped?: boolean } = {}) {
    const threadId = event.threadId || event.thread_id || "";
    const activeThreadId = useAgentStore.getState().activeThreadId;
    const sourceClientId = event.sourceClientId || "";
    if (threadId) {
        if (threadId === activeThreadId) return true;
        const state = useAgentStore.getState();
        return event.type === "thread.started" && (!activeThreadId || state.sending || state.waiting) && (!sourceClientId || sourceClientId === options.clientId);
    }
    return Boolean(options.allowUnscoped || (sourceClientId && sourceClientId === options.clientId));
}

function formatLogText(logs: AgentEventLog[], context: AgentLogContext) {
    const head = [
        "HowCanvas Agent 诊断日志",
        `Canvas Agent: ${context.endpoint}`,
        `连接: ${context.connected ? "在线" : context.enabled ? "连接中" : "未启用"}`,
        `状态: ${context.activity}`,
        `waiting: ${context.waiting}`,
        `sending: ${context.sending}`,
        `messages: ${context.messages}`,
        `pendingTool: ${context.pendingTool ? toolName(context.pendingTool) : "none"}`,
        `logs: ${logs.length}`,
    ].join("\n");
    const body = logs
        .map((item, index) => {
            const detail = item.raw == null ? item.text : JSON.stringify(item.raw, null, 2);
            return [`#${index + 1} ${item.time} ${item.title}`, detail].filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");
    return [head, body || "暂无事件日志"].join("\n\n");
}

function formatLogJson(logs: AgentEventLog[], context: AgentLogContext) {
    return JSON.stringify({ context, logs: logs.map(({ time, title, text, raw }) => ({ time, title, text, raw })) }, null, 2);
}

function normalizeConversation(value: unknown): AgentConversationState | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as AgentConversationState;
    return {
        ...record,
        ...(typeof record.revision === "number" ? { revision: record.revision } : {}),
        ...(typeof record.conversationId === "string" ? { conversationId: record.conversationId } : {}),
        ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
        ...(typeof record.status === "string" ? { status: record.status } : {}),
    };
}

function errorText(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (Array.isArray(value)) return value.map(errorText).find(Boolean) || "";
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    return errorText(record.message) || errorText(record.error) || errorText(record.details) || errorText(record.additionalDetails) || errorText(record.failureReason) || errorText(record.reason) || errorText(record.data);
}

function eventFailureText(event: AgentEventPayload) {
    const status = String(event.status || event.turn?.status || "").toLowerCase();
    const failure = errorText(event.error) || errorText(event.turn?.error) || normalizeText(event.message);
    if (event.type === "turn.failed" || event.type === "error" || (event.type === "turn.completed" && Boolean(failure)) || ["failed", "cancelled", "canceled", "interrupted", "aborted", "error"].includes(status)) return failure || (status ? `Codex 任务${["cancelled", "canceled", "interrupted", "aborted"].includes(status) ? "已取消" : "失败"}` : "Codex 未返回执行结果");
    return "";
}

function eventText(event: AgentEventPayload) {
    const item = event.item;
    return event.type === "item.completed" && (item?.type === "agent_message" || item?.type === "agentMessage") ? stringText(item.text) || stringText(item.delta) : "";
}

function usageText(event: AgentEventPayload) {
    const usage = event.usage;
    if (!usage || typeof usage !== "object") return undefined;
    const total = numberField(usage, "total_tokens");
    const input = numberField(usage, "input_tokens");
    const output = numberField(usage, "output_tokens");
    if (total) return `${total} tok`;
    if (input || output) return `${input || 0}/${output || 0} tok`;
    return undefined;
}

function eventTitle(event: AgentEventPayload) {
    const item = event.item;
    if (event.type === "thread.started") return "已创建 Codex 会话";
    if (event.type === "turn.started") return "开始处理";
    if (event.type === "turn.completed") return "本轮完成";
    if (event.type === "stream.summary") return "流式摘要";
    if (event.type === "turn.failed" || event.type === "error") return "本轮失败";
    if (event.type === "item.started" && isMcpToolItem(item)) return `调用工具：${toolName(String(item?.tool || ""))}`;
    if (event.type === "item.completed" && isMcpToolItem(item)) return `工具完成：${toolName(String(item?.tool || ""))}`;
    if (event.type === "item.completed" && item?.type === "agent_message") return "Codex 回复";
    return event.type || "Codex 事件";
}

function shouldLogAgentEvent(event: AgentEventPayload) {
    const itemType = event.item?.type || "";
    return !["item.updated"].includes(event.type || "") && !["reasoning"].includes(itemType) && !(event.type === "item.started" && itemType === "agent_message");
}

function isConnectionErrorMessage(item: AgentChatItem) {
    return item.role === "error" && /连接失败|无法连接本地 Agent|本地 Agent 连接失败/.test(item.text);
}

function toolName(name: string) {
    if (name === "skill") return "加载视觉 Skill";
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_node") return "创建节点";
    if (name === "canvas_create_attachment_nodes") return "添加附件图片";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_text_nodes") return "批量创建文本";
    if (name === "canvas_create_config_node") return "创建生成配置";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    if (name === "canvas_create_generation_flow") return "创建生成流程";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_audio") return "生成音频";
    if (name === "canvas_update_node") return "更新节点";
    if (name === "canvas_update_node_text") return "更新文本";
    if (name === "canvas_move_nodes") return "移动节点";
    if (name === "canvas_resize_node") return "调整节点尺寸";
    if (name === "canvas_delete_nodes") return "删除节点";
    if (name === "canvas_connect_nodes") return "连接节点";
    if (name === "canvas_select_nodes") return "选择节点";
    if (name === "canvas_set_viewport") return "调整视口";
    if (name === "canvas_run_generation") return "触发生成";
    if (name === "site_navigate") return "网站跳转";
    if (isSiteTool(name)) return SITE_TOOL_LABELS[name];
    return name;
}

function siteToolSummary(name: string, result: unknown) {
    const data = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    if (name === "canvas_list_projects") return `共 ${numberField(data, "total")} 个画布`;
    if (name === "prompts_search") return `找到 ${numberField(data, "total")} 条提示词`;
    if (name === "assets_list") return `共 ${numberField(data, "total")} 个资产`;
    if (name === "assets_add") return "已加入我的资产";
    if (name === "generation_get_status") {
        const summary = data.summary && typeof data.summary === "object" ? (data.summary as Record<string, unknown>) : {};
        return `共 ${numberField(data, "total")} 个任务，排队 ${numberField(summary, "queued")}，运行中 ${numberField(summary, "running")}，成功 ${numberField(summary, "succeeded")}，失败 ${numberField(summary, "failed")}`;
    }
    if (name === "workbench_image_generate" || name === "workbench_video_generate") return typeof data.note === "string" ? data.note : "已在工作台执行";
    if (name === "workbench_image_get_config" || name === "workbench_video_get_config") return "已读取工作台配置";
    return "已完成";
}

function parseToolArguments(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function toolResultSummary(name: string, result: unknown) {
    if (name === "skill") return `已加载 ${(result as { label?: string })?.label || "视觉 Skill"}`;
    if (name === "canvas_apply_ops") return "已完成画布操作";
    if (name === "site_navigate") return `已打开 ${(result as { path?: string })?.path || "/"}`;
    if (name === "workbench_image_generate" || name === "workbench_video_generate") return siteToolSummary(name, result);
    if (name === "canvas_get_state") {
        const data = result && typeof result === "object" ? (result as { nodes?: unknown[]; connections?: unknown[] }) : {};
        return `已读取 ${data.nodes?.length || 0} 个节点，${data.connections?.length || 0} 条连线`;
    }
    return "已完成";
}

function isReadTool(name: string) {
    return name === "canvas_get_state" || name === "canvas_get_selection" || name === "canvas_export_snapshot";
}

function isMcpToolItem(item?: AgentEventItem) {
    return item?.type === "mcp_tool_call";
}

function toolDetail(item?: AgentEventItem) {
    return { server: item?.server, tool: item?.tool, status: item?.status, arguments: item?.arguments, result: parseToolResult(item?.result), error: item?.error };
}

function toolSummary(item?: AgentEventItem) {
    const result = parseToolResult(item?.result);
    const nodeField = objectField(result, "nodes");
    const connectionField = objectField(result, "connections");
    const nodes = Array.isArray(nodeField) ? nodeField : [];
    const connections = Array.isArray(connectionField) ? connectionField : [];
    if (Array.isArray(nodeField) || Array.isArray(connectionField)) return `读取到 ${nodes.length} 个节点，${connections.length} 条连线`;
    return "工具调用完成";
}

function parseToolResult(result: unknown) {
    const content = objectField(result, "content");
    const text = Array.isArray(content)
        ? content
              .map((item) => objectField(item, "text"))
              .filter((item): item is string => typeof item === "string")
              .join("\n")
        : "";
    try {
        return text ? JSON.parse(text) : result;
    } catch {
        return text || result;
    }
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

function stringText(value: unknown) {
    return typeof value === "string" ? value : "";
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function numberField(value: unknown, key: string) {
    const field = objectField(value, key);
    return typeof field === "number" ? field : 0;
}

function promptWithAttachments(text: string, attachments: AgentAttachment[]) {
    return text || (attachments.length ? "请处理上传的图片附件。" : "");
}

function attachmentPayloadBytes(attachments: AgentAttachment[]) {
    return attachments.reduce((total, item) => total + item.dataUrl.length, 0);
}

function formatBytes(bytes: number) {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

function isCanvasWriteTool(name: string) {
    return name === "canvas_apply_ops" || name === "canvas_create_attachment_nodes";
}

async function attachmentNodeOps(endpoint: string, token: string, clientId: string, value: unknown): Promise<CanvasAgentOp[]> {
    const nodes = Array.isArray(value) ? value : [];
    if (!nodes.length) throw new Error("没有可添加的图片附件");
    return await Promise.all(
        nodes.map(async (value) => {
            const item = value as { id?: unknown; attachmentId?: unknown; title?: unknown; position?: unknown };
            const id = String(item.id || "");
            const attachmentId = String(item.attachmentId || "");
            if (!id || !attachmentId) throw new Error("图片附件节点参数无效");
            const res = await fetch(`${endpoint}/agent/attachments/${encodeURIComponent(attachmentId)}?clientId=${encodeURIComponent(clientId)}`, { headers: { "x-canvas-agent-token": token } });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error || "读取图片附件失败");
            }
            const image = await uploadImage(await res.blob());
            const size = fitNodeSize(image.width, image.height);
            const position = item.position && typeof item.position === "object" ? (item.position as { x?: unknown; y?: unknown }) : {};
            return {
                type: "add_node" as const,
                id,
                nodeType: "image" as const,
                title: String(item.title || "参考图"),
                position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
                width: size.width,
                height: size.height,
                metadata: imageMetadata(image),
            };
        }),
    );
}

async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    headers.set("x-canvas-agent-token", token);
    const res = await fetch(`${endpoint}${path}`, { ...init, headers });
    const data = (await res.json().catch(() => ({}))) as T & { error?: unknown; msg?: unknown };
    if (!res.ok) {
        const error = new Error(errorText(data.error) || errorText(data.msg) || "本地 Agent 请求失败") as Error & { payload?: unknown; status?: number };
        error.payload = data;
        error.status = res.status;
        throw error;
    }
    return data;
}

async function discoverAgentConfig(endpoint: string) {
    try {
        const res = await fetch(`${endpoint}/config`);
        if (!res.ok) return null;
        const data = (await res.json()) as AgentConfigResponse;
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

function normalizeHistoryMessages(messages: AgentChatItem[]) {
    return messages
        .map((item, index) => ({
            ...item,
            id: item.id || `history-${index}`,
            text: item.role === "user" ? stripAgentCanvasSelectionContext(normalizeText(item.text)) : normalizeText(item.text),
            streamId: undefined,
            streamDelta: undefined,
        }))
        .filter((item) => item.text);
}

function mergeAgentHistoryMessages(history: AgentChatItem[], current: AgentChatItem[]) {
    if (!current.length) return history;
    const merged = [...history];
    current.forEach((item) => {
        const byId = merged.findIndex((existing) => existing.id === item.id);
        if (byId >= 0) {
            const existing = merged[byId];
            if (item.text.length >= existing.text.length || item.streamId || item.streamDelta) merged[byId] = { ...existing, ...item };
            return;
        }
        const equivalent = merged.findIndex((existing) => existing.role === item.role && existing.text === item.text && existing.title === item.title);
        if (equivalent < 0) merged.push(item);
    });
    return merged.slice(-120);
}

function formatThreadTime(value?: number) {
    if (!value) return "";
    return new Date(value * 1000).toLocaleString();
}

function createId() {
    return randomId();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function readDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}
