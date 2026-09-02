import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = "你正在帮助用户操作 HowCanvas 网站。切换网站页面用 site_navigate，可跳 / (首页)、/canvas (我的画布)、/canvas/:id (指定画布)、/image、/video、/prompts、/assets、/config。需要改动画布时优先使用已配置的 infinite-canvas MCP 工具：先 canvas_get_state 读取当前画布，再根据任务使用 canvas_create_text_node、canvas_generate_text、canvas_generate_image、canvas_generate_video、canvas_generate_audio、canvas_create_generation_flow、canvas_create_config_node、canvas_run_generation、canvas_update_node、canvas_connect_nodes 等通用工具；复杂批量改动再用 canvas_apply_ops，删除连线可用 delete_connections。本轮若有用户上传的图片附件，会同时给出 attachmentId；用户要求把附件放入画布或作为生成参考图时，必须先用 canvas_create_attachment_nodes 创建真实图片节点，再把返回的节点 ID 传给 canvas_create_generation_flow.referenceNodeIds，不要创建空图片占位节点。若当前不在画布页，画布工具会报错，需先用 site_navigate 打开画布。想了解或打开用户已有画布，用 canvas_list_projects 获取画布清单和 id，再用 site_navigate 跳 /canvas/:id 打开。生图工作台可用 workbench_image_get_config 看可选项、workbench_image_generate 填提示词并生成；视频创作台对应 workbench_video_get_config 与 workbench_video_generate；用 prompts_search 分页搜索提示词库；用 assets_list 查看「我的素材」、assets_add 新增文本或图片素材。需要生成内容时直接调用对应生成工具，不要绑定特定业务场景。若请求中包含 [[CANVAS_SELECTION_CONTEXT]] 选区上下文，应把其中的节点 ID、类型和摘要作为本轮参考，并在需要时用 canvas_get_selection 复核最新选区。不要模拟鼠标点击，不要要求用户手动复制 JSON。";

export const AGENT_EXECUTION_PROMPT = "任务执行契约：用户本轮要求是唯一任务边界。识别交付结果、目标节点和硬性约束后立即执行，持续到完成或出现真实阻塞。不扩大范围，不把明确指令改写成建议、计划或方案讨论；不询问无关偏好，不重复确认已给出的要求，不猜测用户意图、节点、模型或结果。只有缺失信息会显著改变结果、安全边界或产生不可逆后果时，才可提出一个具体问题；其余情况使用保守默认值继续。[[CANVAS_SELECTION_CONTEXT]] 中的选区是发送时已固定的消息级快照，必须使用其节点 ID 执行；禁止调用 canvas_get_selection 用实时选区替换它。需要节点最新数据时，从 canvas_get_state 按固定 ID 匹配。只根据工具真实返回报告状态。任务结束时只简短说明已完成内容、真实未完成项和阻塞，不输出无关建议、猜测、反问或延伸选项。";

export const EFFECTIVE_AGENT_PROMPT = AGENT_PROMPT.replace(
    "若请求中包含 [[CANVAS_SELECTION_CONTEXT]] 选区上下文，应把其中的节点 ID、类型和摘要作为本轮参考，并在需要时用 canvas_get_selection 复核最新选区。",
    "若请求中包含 [[CANVAS_SELECTION_CONTEXT]]，应把其中的节点 ID、类型和摘要作为发送时已固定的消息级快照，不得用 canvas_get_selection 或当前实时选区替换。",
);

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type CanvasAgentConfig = { url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig };

export function loadConfig(create = false): CanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

export function saveConfig(config: CanvasAgentConfig) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(CONFIG_DIR, 0o700);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(CONFIG_FILE, 0o600);
}

export function ensureSiteWorkspace(config: CanvasAgentConfig) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        fs.mkdirSync(workspacePath, { recursive: true });
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    fs.mkdirSync(workspacePath, { recursive: true });
    saveConfig(config);
    return { workspacePath };
}

export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    fs.mkdirSync(workspacePath, { recursive: true });
    saveConfig(config);
    return config.workspace;
}

function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
