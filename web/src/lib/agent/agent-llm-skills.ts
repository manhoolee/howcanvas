import type { AgentSkillId } from "@/services/api/backend";
import type { ResponseFunctionTool } from "@/services/api/image";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { randomId } from "@/lib/utils";

type AddNodeOp = Extract<CanvasAgentOp, { type: "add_node" }>;
type UpdateNodeOp = Extract<CanvasAgentOp, { type: "update_node" }>;
type ViewportOp = Extract<CanvasAgentOp, { type: "set_viewport" }>;

export const AGENT_LLM_SKILL_LABELS: Record<AgentSkillId, string> = {
    "image-creation": "图片创作",
    "video-creation": "视频创作",
    "canvas-orchestration": "画布编排",
    "quality-review": "质量检查",
};

const SKILL_PROMPTS: Record<AgentSkillId, string> = {
    "image-creation": "图片创作 Skill：先明确主体、数量、场景、构图、视角、镜头、光线、材质、风格、文字和输出比例；缺少关键信息时提出最少的澄清问题。把方案整理成可直接执行的提示词和模型参数，并优先使用画布生成流程或生图工作台工具。",
    "video-creation": "视频创作 Skill：先拆解主体、动作顺序、镜头运动、景别、时间节奏、首尾状态、画面连续性、声音、时长和比例；避免一个镜头塞入过多动作。生成前先说明提示词、参数和费用风险，完成后用任务状态工具跟踪异步结果。",
    "canvas-orchestration": "画布编排 Skill：所有画布写操作前先读取状态；优先使用高层工具创建文本节点、配置节点和生成流程，复杂批量修改才使用 canvas_apply_ops。节点要有清晰标题、合理位置和可追踪的 metadata，生成流程应连接提示词、参考图、配置和结果。",
    "quality-review": "质量检查 Skill：根据用户目标检查主体数量、构图、文字、人物细节、风格一致性、动作连续性、时长和输出参数；生成任务要查询真实状态，不要猜测结果。发现问题时给出具体的下一轮修改动作，并在必要时回到画布更新提示词或配置。",
};

export function buildAgentLlmSystemPrompt(skillIds: AgentSkillId[]) {
    const skills = skillIds.map((id) => SKILL_PROMPTS[id]).filter(Boolean);
    return [
        "你是 HowCanvas（浩瀚画布）的完整 Canvas Agent，负责帮助用户完成图片、视频、文本和画布编排任务。",
        "工作顺序：理解目标 → 读取页面/画布状态 → 拆解创作方案 → 创建或更新画布流程 → 在需要时请求确认 → 执行生成 → 查询异步状态 → 检查结果并提出下一步。",
        "规则：不要编造节点 ID、任务 ID、模型、生成结果或状态；需要操作画布时先 canvas_get_state；当前不在画布页先 site_navigate 到画布；需要打开已有画布先 canvas_list_projects，再跳转到 /canvas/{id}。",
        "规则：不要创建空图片占位节点代替用户附件；有附件时必须使用 canvas_create_attachment_nodes，并把返回的真实节点 ID 作为 referenceNodeIds。不要模拟鼠标点击，不要要求用户手动复制 JSON。",
        "规则：canvas_apply_ops 只提交合法的 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation 操作；删除、批量修改、触发生成和工作台生图/生视频前必须说明影响。",
        "规则：会产生费用或不可逆修改的工具调用必须先暂停等待用户确认；用户拒绝后不要重复调用。生成是异步的，提交后使用 generation_get_status，不要把提交成功当成生成完成。",
        "规则：每轮优先完成一个明确问题；工具失败时读取错误并调整参数，不要重复发送相同调用；最终用简短中文说明完成了什么、仍在进行什么以及下一步。",
        ...skills,
    ].join("\n");
}

type JsonSchema = Record<string, unknown>;
const schema = (properties: JsonSchema, required: string[] = []): JsonSchema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const string = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const number = (description?: string) => ({ type: "number", ...(description ? { description } : {}) });
const boolean = (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) });
const anyObject = { type: "object", additionalProperties: true };
const nodeTypes = { type: "string", enum: ["image", "text", "config", "video", "audio"] };
const generationModes = { type: "string", enum: ["text", "image", "video", "audio"] };
const generationOptions = { model: string(), size: string(), quality: string(), count: number(), seconds: string(), resolution: string(), vquality: string(), generateAudio: boolean(), watermark: boolean() };
const flowProperties = { prompt: string("提示词"), title: string(), x: number(), y: number(), referenceNodeIds: { type: "array", items: string() }, ...generationOptions };

const TOOL_SPECS: Array<{ name: string; description: string; parameters: JsonSchema; skills: AgentSkillId[] }> = [
    { name: "site_navigate", description: "打开站内页面。画布页面 /canvas，指定画布 /canvas/:id，生图 /image，视频 /video，提示词 /prompts，素材 /assets。", parameters: schema({ path: string("站内路径") }, ["path"]), skills: ["canvas-orchestration"] },
    { name: "canvas_list_projects", description: "列出用户画布摘要，返回 id 后用 site_navigate 打开。", parameters: schema({ keyword: string(), page: number(), pageSize: number() }), skills: ["canvas-orchestration"] },
    { name: "canvas_get_state", description: "读取当前画布节点、连线、选区和视口。", parameters: schema({}), skills: ["canvas-orchestration", "quality-review"] },
    { name: "canvas_get_selection", description: "读取当前画布选中的节点。", parameters: schema({}), skills: ["canvas-orchestration", "quality-review"] },
    { name: "canvas_export_snapshot", description: "读取当前画布的紧凑快照，用于理解布局和复盘。", parameters: schema({}), skills: ["canvas-orchestration", "quality-review"] },
    { name: "canvas_apply_ops", description: "批量操作画布，ops 支持节点增删改、连线、视口、选区和触发生成。", parameters: schema({ ops: { type: "array", minItems: 1, items: anyObject } }, ["ops"]), skills: ["canvas-orchestration"] },
    { name: "canvas_create_node", description: "创建 image、text、config、video 或 audio 节点。", parameters: schema({ nodeType: nodeTypes, title: string(), x: number(), y: number(), width: number(), height: number(), metadata: anyObject }, ["nodeType"]), skills: ["canvas-orchestration"] },
    { name: "canvas_create_attachment_nodes", description: "把本轮用户图片附件创建成真实图片节点，返回节点 ID 供参考图使用。", parameters: schema({ attachmentIds: { type: "array", minItems: 1, items: string() }, x: number(), y: number(), gap: number(), direction: { type: "string", enum: ["row", "column"] } }, ["attachmentIds"]), skills: ["canvas-orchestration", "image-creation"] },
    { name: "canvas_create_text_node", description: "创建单个文本节点。", parameters: schema({ text: string(), title: string(), x: number(), y: number(), width: number(), height: number() }), skills: ["canvas-orchestration"] },
    { name: "canvas_create_text_nodes", description: "批量创建文本节点，适合标题、脚本和分镜内容。", parameters: schema({ items: { type: "array", minItems: 1, items: anyObject }, x: number(), y: number(), gap: number(), direction: { type: "string", enum: ["row", "column"] } }, ["items"]), skills: ["canvas-orchestration"] },
    { name: "canvas_create_config_node", description: "创建图片、视频、文本或音频生成配置节点，可选择立即触发。", parameters: schema({ prompt: string(), mode: generationModes, title: string(), x: number(), y: number(), width: number(), height: number(), autoRun: boolean(), ...generationOptions }), skills: ["canvas-orchestration", "image-creation", "video-creation"] },
    { name: "canvas_create_image_prompt_flow", description: "创建提示词节点、图片配置节点并自动连接，可选择立即生图。", parameters: schema({ prompt: string(), x: number(), y: number(), autoRun: boolean(), ...generationOptions }, ["prompt"]), skills: ["canvas-orchestration", "image-creation"] },
    { name: "canvas_create_generation_flow", description: "创建提示词、参考图、配置节点组成的通用生成流程。", parameters: schema({ ...flowProperties, mode: generationModes, autoRun: boolean() }, ["prompt"]), skills: ["canvas-orchestration"] },
    { name: "canvas_generate_text", description: "创建并立即运行文本生成流程。", parameters: schema(flowProperties, ["prompt"]), skills: ["canvas-orchestration"] },
    { name: "canvas_generate_image", description: "创建并立即运行图片生成流程。", parameters: schema(flowProperties, ["prompt"]), skills: ["canvas-orchestration", "image-creation"] },
    { name: "canvas_generate_video", description: "创建并立即运行视频生成流程。", parameters: schema(flowProperties, ["prompt"]), skills: ["canvas-orchestration", "video-creation"] },
    { name: "canvas_generate_audio", description: "创建并立即运行音频生成流程。", parameters: schema(flowProperties, ["prompt"]), skills: ["canvas-orchestration"] },
    { name: "canvas_update_node", description: "更新节点字段或 metadata。", parameters: schema({ id: string(), patch: anyObject, metadata: anyObject }, ["id"]), skills: ["canvas-orchestration"] },
    { name: "canvas_update_node_text", description: "更新文本节点内容和标题。", parameters: schema({ id: string(), text: string(), title: string() }, ["id", "text"]), skills: ["canvas-orchestration"] },
    { name: "canvas_move_nodes", description: "按绝对坐标或 dx/dy 移动一个或多个节点。", parameters: schema({ items: { type: "array", minItems: 1, items: anyObject } }, ["items"]), skills: ["canvas-orchestration"] },
    { name: "canvas_resize_node", description: "调整节点尺寸。", parameters: schema({ id: string(), width: number(), height: number(), freeResize: boolean() }, ["id", "width", "height"]), skills: ["canvas-orchestration"] },
    { name: "canvas_delete_nodes", description: "删除节点及其关联连线。", parameters: schema({ ids: { type: "array", minItems: 1, items: string() } }, ["ids"]), skills: ["canvas-orchestration"] },
    { name: "canvas_connect_nodes", description: "批量连接节点。", parameters: schema({ connections: { type: "array", minItems: 1, items: anyObject } }, ["connections"]), skills: ["canvas-orchestration"] },
    { name: "canvas_select_nodes", description: "设置当前选中节点。", parameters: schema({ ids: { type: "array", items: string() } }, ["ids"]), skills: ["canvas-orchestration"] },
    { name: "canvas_set_viewport", description: "调整画布视口 x、y、k。", parameters: schema({ viewport: anyObject }, ["viewport"]), skills: ["canvas-orchestration"] },
    { name: "canvas_run_generation", description: "触发指定配置或媒体节点生成。", parameters: schema({ nodeId: string(), mode: generationModes, prompt: string() }, ["nodeId"]), skills: ["canvas-orchestration", "image-creation", "video-creation"] },
    { name: "generation_get_status", description: "查询画布和工作台真实生成任务状态。", parameters: schema({ scope: { type: "string", enum: ["all", "canvas", "image", "video"] }, taskId: string(), nodeIds: { type: "array", items: string() }, limit: number() }), skills: ["quality-review", "image-creation", "video-creation"] },
    { name: "workbench_image_get_config", description: "读取生图工作台可用模型、质量、尺寸和张数。", parameters: schema({}), skills: ["image-creation"] },
    { name: "workbench_image_generate", description: "在生图工作台填入参数并生成图片，可能产生费用。", parameters: schema({ prompt: string(), model: string(), quality: string(), size: string(), count: number(), run: boolean() }, ["prompt"]), skills: ["image-creation"] },
    { name: "workbench_video_get_config", description: "读取视频创作台可用模型、尺寸、时长、分辨率和音频选项。", parameters: schema({}), skills: ["video-creation"] },
    { name: "workbench_video_generate", description: "在视频创作台填入参数并生成视频，可能产生费用。", parameters: schema({ prompt: string(), model: string(), size: string(), seconds: string(), resolution: string(), generateAudio: boolean(), watermark: boolean(), run: boolean() }, ["prompt"]), skills: ["video-creation"] },
    { name: "prompts_search", description: "分页搜索提示词库。", parameters: schema({ keyword: string(), category: string(), tags: { type: "array", items: string() }, page: number(), pageSize: number() }), skills: ["image-creation", "video-creation", "quality-review"] },
    { name: "assets_list", description: "分页查看我的素材。", parameters: schema({ kind: { type: "string", enum: ["all", "text", "image", "video"] }, keyword: string(), page: number(), pageSize: number() }), skills: ["image-creation", "video-creation", "quality-review"] },
    { name: "assets_add", description: "新增文本或图片素材。", parameters: schema({ kind: { type: "string", enum: ["text", "image"] }, title: string(), content: string(), imageUrl: string(), tags: { type: "array", items: string() }, source: string(), note: string() }, ["kind", "title"]), skills: ["image-creation", "video-creation"] },
];

export const AGENT_LLM_TOOLS: ResponseFunctionTool[] = TOOL_SPECS.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));

export function toolsForAgentSkills(skillIds: AgentSkillId[]) {
    const enabled = new Set(skillIds);
    return AGENT_LLM_TOOLS.filter((tool) => TOOL_SPECS.find((item) => item.name === tool.function.name)?.skills.some((skill) => enabled.has(skill)));
}

export const CANVAS_AGENT_TOOL_NAMES = new Set(TOOL_SPECS.map((tool) => tool.name).filter((name) => name.startsWith("canvas_")));

export function expandCanvasTool(name: string, input: Record<string, unknown>, snapshot: CanvasAgentSnapshot | null): CanvasAgentOp[] | null {
    const x = typeof input.x === "number" ? input.x : nextCanvasX(snapshot);
    const y = typeof input.y === "number" ? input.y : 0;
    const mode = typeof input.mode === "string" ? input.mode as "text" | "image" | "video" | "audio" : undefined;
    const id = () => `${name}-${randomId()}`;
    const flow = (flowInput: Record<string, unknown>, forcedMode?: "text" | "image" | "video" | "audio"): CanvasAgentOp[] => {
        const flowMode = forcedMode || (flowInput.mode as "text" | "image" | "video" | "audio") || "image";
        const textId = id();
        const configId = id();
        const refs = Array.isArray(flowInput.referenceNodeIds) ? flowInput.referenceNodeIds.filter((item): item is string => typeof item === "string") : [];
        const prompt = String(flowInput.prompt || "");
        const config: Record<string, unknown> = { generationMode: flowMode, composerContent: [`@[node:${textId}]`, ...refs.map((ref) => `@[node:${ref}]`)].join("\n"), prompt, status: "idle", model: flowInput.model, size: flowInput.size, quality: flowInput.quality, count: flowInput.count, seconds: flowInput.seconds, vquality: flowInput.vquality, generateAudio: flowInput.generateAudio, watermark: flowInput.watermark };
        const ops: CanvasAgentOp[] = [
            { type: "add_node", id: textId, nodeType: "text", title: String(flowInput.title || "提示词"), position: { x, y }, metadata: { content: prompt, status: "success", fontSize: 14 } },
            { type: "add_node", id: configId, nodeType: "config", title: String(flowInput.title || `${flowMode} 生成配置`), position: { x: x + 420, y }, metadata: cleanObject(config) },
            { type: "connect_nodes", fromNodeId: textId, toNodeId: configId },
            ...refs.map((ref) => ({ type: "connect_nodes" as const, fromNodeId: ref, toNodeId: configId })),
        ];
        if (flowInput.autoRun === true || name.startsWith("canvas_generate_")) ops.push({ type: "run_generation", nodeId: configId, mode: flowMode, prompt });
        return ops;
    };
    if (name === "canvas_apply_ops") return Array.isArray(input.ops) ? input.ops as CanvasAgentOp[] : [];
    if (name === "canvas_create_node") return [{ type: "add_node", nodeType: input.nodeType as AddNodeOp["nodeType"], title: input.title as string | undefined, position: { x, y }, width: input.width as number | undefined, height: input.height as number | undefined, metadata: input.metadata as AddNodeOp["metadata"] }];
    if (name === "canvas_create_text_node") return [{ type: "add_node", nodeType: "text", title: input.title as string | undefined, position: { x, y }, width: input.width as number | undefined, height: input.height as number | undefined, metadata: { content: String(input.text || ""), status: "success", fontSize: 14 } }];
    if (name === "canvas_create_text_nodes") {
        const items = Array.isArray(input.items) ? input.items as Array<Record<string, unknown>> : [];
        const gap = typeof input.gap === "number" ? input.gap : 40;
        return items.map((item, index) => ({ type: "add_node" as const, nodeType: "text" as const, title: item.title as string | undefined, position: { x: typeof item.x === "number" ? item.x : (input.direction === "row" ? x + index * (340 + gap) : x), y: typeof item.y === "number" ? item.y : (input.direction === "row" ? y : y + index * (240 + gap)) }, width: item.width as number | undefined, height: item.height as number | undefined, metadata: { content: String(item.text || ""), status: "success", fontSize: 14 } }));
    }
    if (name === "canvas_create_config_node") return [{ type: "add_node", id: id(), nodeType: "config", title: String(input.title || `${mode || "image"} 生成配置`), position: { x, y }, width: input.width as number | undefined, height: input.height as number | undefined, metadata: cleanObject({ generationMode: mode || "image", composerContent: String(input.prompt || ""), prompt: String(input.prompt || ""), status: "idle", ...input }) }];
    if (name === "canvas_create_image_prompt_flow") return flow(input, "image");
    if (name === "canvas_create_generation_flow") return flow(input, mode);
    if (["canvas_generate_text", "canvas_generate_image", "canvas_generate_video", "canvas_generate_audio"].includes(name)) return flow(input, name.replace("canvas_generate_", "") as "text" | "image" | "video" | "audio");
    if (name === "canvas_update_node") return [{ type: "update_node", id: String(input.id), patch: input.patch as UpdateNodeOp["patch"], metadata: input.metadata as UpdateNodeOp["metadata"] }];
    if (name === "canvas_update_node_text") return [{ type: "update_node", id: String(input.id), patch: { title: input.title as string | undefined }, metadata: { content: String(input.text || ""), status: "success" } }];
    if (name === "canvas_move_nodes") {
        return (Array.isArray(input.items) ? input.items as Array<Record<string, unknown>> : []).map((item) => {
            const node = snapshot?.nodes.find((candidate) => candidate.id === item.id);
            return { type: "update_node" as const, id: String(item.id), patch: { position: { x: typeof item.x === "number" ? item.x : (node?.position.x || 0) + Number(item.dx || 0), y: typeof item.y === "number" ? item.y : (node?.position.y || 0) + Number(item.dy || 0) } } };
        });
    }
    if (name === "canvas_resize_node") return [{ type: "update_node", id: String(input.id), patch: { width: Number(input.width), height: Number(input.height) } }];
    if (name === "canvas_delete_nodes") return [{ type: "delete_node", ids: Array.isArray(input.ids) ? input.ids.filter((item): item is string => typeof item === "string") : [] }];
    if (name === "canvas_connect_nodes") return (Array.isArray(input.connections) ? input.connections as Array<Record<string, unknown>> : []).map((item) => ({ type: "connect_nodes" as const, fromNodeId: String(item.fromNodeId), toNodeId: String(item.toNodeId) }));
    if (name === "canvas_select_nodes") return [{ type: "select_nodes", ids: Array.isArray(input.ids) ? input.ids.filter((item): item is string => typeof item === "string") : [] }];
    if (name === "canvas_set_viewport") return [{ type: "set_viewport", viewport: input.viewport as ViewportOp["viewport"] }];
    if (name === "canvas_run_generation") return [{ type: "run_generation", nodeId: String(input.nodeId), mode, prompt: input.prompt as string | undefined }];
    return null;
}

function nextCanvasX(snapshot: CanvasAgentSnapshot | null) {
    if (!snapshot?.nodes.length) return 0;
    return Math.max(...snapshot.nodes.map((node) => node.position.x + node.width)) + 80;
}

function cleanObject(input: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
