import axios from "axios";

import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, serverProxyHeaders, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import { withCharge } from "@/lib/billing";
import { refreshServerImageTask, requestServerImageTask, supportsServerImageTasks, type ServerImageTask, type ServerImageTaskOptions } from "./image-task";
import { saveGeneratedDataUrl, saveGeneratedText } from "@/services/user-files";
import type { ReferenceImage } from "@/types/image";

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

export type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ChatCompletionChoice = {
    message?: { content?: unknown; tool_calls?: unknown; toolCalls?: unknown };
    delta?: { content?: unknown; tool_calls?: unknown; toolCalls?: unknown };
};
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: unknown;
    choices?: ChatCompletionChoice[];
    content?: unknown;
    tool_calls?: unknown;
    toolCalls?: unknown;
    error?: { message?: string } | string;
    message?: string;
    code?: number;
    msg?: string;
};
type ChatStreamToolCall = { id: string; name: string; arguments: string };
type ResponseStreamToolCall = { id: string; name: string; arguments: string };
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string; chatToolCalls: Map<number, ChatStreamToolCall>; responseToolCalls: Map<string, ResponseStreamToolCall> };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
export type GeneratedApiImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    bytes?: number;
    mimeType?: string;
    sha256?: string;
    persistedAt?: string;
    serverTaskId?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal; charge?: boolean } & ServerImageTaskOptions;

export type ImageGenerationTaskState =
    | { status: "pending"; task: ServerImageTask }
    | { status: "completed"; task: ServerImageTask; images: GeneratedApiImage[] }
    | { status: "failed"; task: ServerImageTask; error: string };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = config.size.trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.quality, dimensions) : undefined;
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { responseFormat: { image } } : {};
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(quality: string, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(quality);
    if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageData(item: Record<string, unknown>): GeneratedApiImage | null {
    let dataUrl = "";
    if (typeof item.b64_json === "string" && item.b64_json) {
        dataUrl = `data:image/png;base64,${item.b64_json}`;
    }
    if (!dataUrl && typeof item.url === "string" && item.url) dataUrl = item.url;
    if (!dataUrl && typeof item.image_url === "string" && item.image_url) dataUrl = item.image_url;
    if (!dataUrl && typeof item.data === "string" && item.data.startsWith("data:image/")) dataUrl = item.data;
    if (!dataUrl) return null;
    return {
        id: nanoid(),
        dataUrl,
        ...(typeof item.storageKey === "string" ? { storageKey: item.storageKey } : {}),
        ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}),
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
        ...(typeof item.persistedAt === "string" ? { persistedAt: item.persistedAt } : {}),
        ...(typeof item.serverTaskId === "string" ? { serverTaskId: item.serverTaskId } : {}),
    };
}

function parseImagePayload(payload: ImageApiResponse | string) {
    if (typeof payload === "string") {
        try {
            return parseImagePayload(JSON.parse(payload) as ImageApiResponse);
        } catch {
            return [];
        }
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    const candidates = [payload.data, (payload as ImageApiResponse & { images?: Array<Record<string, unknown>> }).images]
        .filter((value): value is Array<Record<string, unknown>> => Array.isArray(value))
        .flat();
    const images = candidates.map(resolveImageData).filter((value): value is GeneratedApiImage => Boolean(value));

    if (!images.length) throw new Error(readAxiosErrorMessage(payload) || "接口没有返回图片");
    return images;
}

/** 刷新服务器中已存在的图片任务，不经过计费和创建流程。 */
export async function refreshImageGenerationTask(taskId: string, signal?: AbortSignal): Promise<ImageGenerationTaskState> {
    const snapshot = await refreshServerImageTask(taskId, signal);
    if (snapshot.status === "pending") return snapshot;
    if (snapshot.status === "failed") return snapshot;
    return { status: "completed", task: snapshot.task, images: parseImagePayload(snapshot.result as ImageApiResponse | string) };
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData: unknown = error.response?.data;
        if (typeof responseData === "string" && responseData.trim()) {
            try {
                return readAxiosErrorMessage(JSON.parse(responseData)) || responseData.trim();
            } catch {
                return responseData.trim();
            }
        }
        return readAxiosErrorMessage(responseData) || readStatusError(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

function readAxiosErrorMessage(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; details?: unknown };
    const nested = typeof payload.error === "object" ? payload.error as { message?: unknown } : undefined;
    const details = typeof payload.details === "object" ? payload.details as { message?: unknown } : undefined;
    return [payload.msg, payload.message, nested?.message, typeof payload.error === "string" ? payload.error : undefined, details?.message]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() || "";
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}：${status}` : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        ...serverProxyHeaders(config),
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function geminiHeaders(config: Pick<AiConfig, "apiKey" | "baseUrl" | "model">) {
    return {
        ...serverProxyHeaders(config),
        ...(config.apiKey.trim() ? { "x-goog-api-key": config.apiKey } : {}),
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function textContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (isRecord(value)) {
        return stringValue(value.text) || textContent(value.content) || textContent(value.output_text);
    }
    if (!Array.isArray(value)) return "";
    return value.map(textContent).join("");
}

function chatToolCalls(value: unknown): ResponseToolCall[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => {
            if (!isRecord(item)) return null;
            const fn = isRecord(item.function) ? item.function : item;
            const id = stringValue(item.id) || stringValue(item.call_id);
            const name = stringValue(fn.name);
            const args = stringValue(fn.arguments) || (fn.arguments == null ? "{}" : JSON.stringify(fn.arguments));
            return id && name ? { id, type: "function" as const, function: { name, arguments: args } } : null;
        })
        .filter((item): item is ResponseToolCall => Boolean(item));
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        textContent(payload.output_text) ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => textContent(item))
            .join("");
    const responseToolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) },
        }))
        .filter((item) => item.id && item.function.name);
    if (content || responseToolCalls.length) return { content, toolCalls: responseToolCalls };

    const choice = payload.choices?.[0];
    const message = choice?.message || choice?.delta;
    const chatContent = textContent(message?.content) || textContent(payload.content);
    const toolCalls = chatToolCalls(message?.tool_calls ?? message?.toolCalls ?? payload.tool_calls ?? payload.toolCalls);
    return { content: chatContent, toolCalls };
}

function ensureToolResponse(result: ToolResponseResult) {
    if (!result.content && !result.toolCalls.length) throw new Error("AI 响应未包含文本或工具调用，请检查模型协议与权限配置");
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    // 后端错误统一使用 `{ error: string }`，上游 OpenAI/Gemini 也可能返回
    // `{ message }` 或嵌套 error；先保留服务端给出的具体原因，再按状态码
    // 映射通用提示，避免把“模型未授权/账户无权限”误报成 API Key 失效。
    return stringValue(value.msg) || stringValue(value.message) || stringValue(value.error) || stringValue(error?.message) || stringValue(responseError?.message) || stringValue(response?.error);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    const detail = responseErrorMessage(payload);
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(detail || payload.msg || "请求失败");
    if (detail) throw new Error(detail);
}

function validateGeminiPayload(payload: GeminiPayload) {
    const detail = responseErrorMessage(payload);
    if (detail) throw new Error(detail);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function isEventStreamResponse(response: Response) {
    return (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
}

async function readJsonResponse<T>(response: Response, fallback: T): Promise<T> {
    return parseJsonText(await response.text(), fallback);
}

function parseJsonText<T>(text: string, fallback: T): T {
    if (!text.trim()) return fallback;
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`AI 响应格式无效：${text.slice(0, 300)}`);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const raw = block.trim();
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data) {
        if (!raw || raw === "[DONE]") return;
        try {
            consumeResponseStreamEvent(JSON.parse(raw) as Record<string, unknown>, state, onDelta);
        } catch {
            return;
        }
        return;
    }
    if (data === "[DONE]") return;
    consumeResponseStreamEvent(JSON.parse(data) as Record<string, unknown>, state, onDelta);
}

function consumeResponseStreamEvent(event: Record<string, unknown>, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && typeof event.text === "string" && event.text.length >= state.text.length) {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done" || type === "response.output_item.added") {
        const key = stringValue(event.item_id) || stringValue(event.call_id) || String(event.output_index ?? "0");
        const current = state.responseToolCalls.get(key) || { id: "", name: "", arguments: "" };
        const item: Record<string, unknown> = isRecord(event.item) ? event.item : {};
        const name = stringValue(event.name) || stringValue(item.name);
        const args = type === "response.function_call_arguments.done" ? stringValue(event.arguments) : type === "response.function_call_arguments.delta" ? stringValue(event.delta) : stringValue(item.arguments);
        state.responseToolCalls.set(key, {
            id: current.id || stringValue(event.call_id) || stringValue(item.call_id) || stringValue(item.id) || stringValue(event.item_id) || key,
            name: current.name || name,
            arguments: args ? (type === "response.function_call_arguments.done" ? args : `${current.arguments}${args}`) : current.arguments,
        });
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    choices.forEach((choice) => {
        if (!isRecord(choice)) return;
        const hasDelta = isRecord(choice.delta);
        const delta: Record<string, unknown> = hasDelta ? choice.delta as Record<string, unknown> : isRecord(choice.message) && !state.text ? choice.message as Record<string, unknown> : {};
        const content = textContent(delta.content);
        if (content) {
            state.text += content;
            onDelta?.(state.text);
        }
        const calls = delta.tool_calls ?? delta.toolCalls;
        if (!Array.isArray(calls)) return;
        calls.forEach((rawCall, fallbackIndex) => {
            if (!isRecord(rawCall)) return;
            const index = typeof rawCall.index === "number" ? rawCall.index : fallbackIndex;
            const fn = isRecord(rawCall.function) ? rawCall.function : {};
            const current = state.chatToolCalls.get(index) || { id: "", name: "", arguments: "" };
            state.chatToolCalls.set(index, {
                id: current.id || stringValue(rawCall.id) || stringValue(rawCall.call_id),
                name: current.name + stringValue(fn.name),
                arguments: current.arguments + stringValue(fn.arguments),
            });
        });
        if (isRecord(choice.message)) state.payload = event as ResponseApiPayload;
    });
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function responseStreamToolCalls(state: ResponseStreamState): ResponseToolCall[] {
    const responses = [...state.responseToolCalls.values()]
        .filter((call) => call.id && call.name)
        .map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments || "{}" } }));
    const chats = [...state.chatToolCalls.values()]
        .filter((call) => call.id && call.name)
        .map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments || "{}" } }));
    return [...responses, ...chats];
}

function finalizeResponseStream(state: ResponseStreamState, onDelta?: (text: string) => void): ToolResponseResult {
    if (state.error) throw new Error(state.error);
    if (!state.payload) return ensureToolResponse({ content: state.text, toolCalls: responseStreamToolCalls(state) });
    validateResponsePayload(state.payload);
    const parsed = parseToolResponse(state.payload);
    const finalContent = parsed.content && (!state.text || parsed.content.length >= state.text.length) ? parsed.content : state.text;
    const result = ensureToolResponse({ content: finalContent, toolCalls: parsed.toolCalls.length ? parsed.toolCalls : responseStreamToolCalls(state) });
    if (!state.text && result.content) onDelta?.(result.content);
    return result;
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!isEventStreamResponse(response)) {
        const raw = await response.text();
        try {
            const payload = parseJsonText<ResponseApiPayload>(raw, {});
            validateResponsePayload(payload);
            const result = ensureToolResponse(parseToolResponse(payload));
            if (result.content) onDelta?.(result.content);
            return result;
        } catch (error) {
            if (!/^\s*(?::|data:|event:)/m.test(raw)) throw error;
            const state: ResponseStreamState = { buffer: "", text: "", chatToolCalls: new Map(), responseToolCalls: new Map() };
            consumeResponseStreamText(state, raw, onDelta, true);
            return finalizeResponseStream(state, onDelta);
        }
    }
    if (!response.body) {
        const payload = await readJsonResponse<ResponseApiPayload>(response, {});
        validateResponsePayload(payload);
        const result = ensureToolResponse(parseToolResponse(payload));
        if (result.content) onDelta?.(result.content);
        return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "", chatToolCalls: new Map(), responseToolCalls: new Map() };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    return finalizeResponseStream(state, onDelta);
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!isEventStreamResponse(response)) {
        const raw = await response.text();
        try {
            const result = ensureToolResponse(parseGeminiToolResponse(parseJsonText<GeminiPayload>(raw, {})));
            if (result.content) onDelta?.(result.content);
            return result;
        } catch (error) {
            if (!/^\s*(?::|data:|event:)/m.test(raw)) throw error;
            const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
            consumeGeminiStreamText(state, raw, onDelta, true);
            if (state.error) throw new Error(state.error);
            return ensureToolResponse({ content: state.text, toolCalls: state.toolCalls });
        }
    }
    if (!response.body) {
        const payload = await readJsonResponse<GeminiPayload>(response, {});
        const result = ensureToolResponse(parseGeminiToolResponse(payload));
        if (result.content) onDelta?.(result.content);
        return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return ensureToolResponse({ content: state.text, toolCalls: state.toolCalls });
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const raw = block.trim();
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data) {
        if (!raw || raw === "[DONE]") return;
        try {
            consumeGeminiStreamBlock(`data: ${raw}`, state, onDelta);
        } catch {
            return;
        }
        return;
    }
    if (data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) } }),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error("Gemini 接口没有返回图片");
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<GeneratedApiImage[]> {
    return withCharge("image", config.model || config.imageModel, async () => {
        const images = await requestGenerationImpl(config, prompt, options);
        images.forEach((image) => saveGeneratedDataUrl("image", image.dataUrl));
        return images;
    });
}

async function requestGenerationImpl(config: AiConfig, prompt: string, options?: RequestOptions): Promise<GeneratedApiImage[]> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const payload = {
        model: requestConfig.model,
        prompt: withSystemPrompt(requestConfig, prompt),
        n,
        ...(quality ? { quality } : {}),
        ...(requestSize ? { size: requestSize } : {}),
        ...(background ? { background } : {}),
        response_format: "b64_json",
        output_format: IMAGE_OUTPUT_FORMAT,
    };
    try {
        if (supportsServerImageTasks(requestConfig)) {
            const data = await requestServerImageTask(requestConfig, "generations", JSON.stringify(payload), "application/json", options);
            return parseImagePayload(data as ImageApiResponse | string);
        }
        const response = await axios.post<ImageApiResponse>(
            aiApiUrl(requestConfig, "/images/generations"),
            payload,
            {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
            },
        );
        const images = parseImagePayload(response.data);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions): Promise<GeneratedApiImage[]> {
    return withCharge("image", config.model || config.imageModel, async () => {
        const images = await requestEditImpl(config, prompt, references, mask, options);
        images.forEach((image) => saveGeneratedDataUrl("image", image.dataUrl));
        return images;
    });
}

async function requestEditImpl(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions): Promise<GeneratedApiImage[]> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs,
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        if (mask) throw new Error("Gemini 调用格式暂不支持蒙版编辑");
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    formData.set("n", String(n));
    formData.set("response_format", "b64_json");
    formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    if (background) {
        formData.set("background", background);
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));
    if (mask) formData.set("mask", dataUrlToFile({ ...mask, dataUrl: await imageToDataUrl(mask) }));

    try {
        if (supportsServerImageTasks(requestConfig)) {
            const data = await requestServerImageTask(requestConfig, "edits", formData, undefined, options);
            return parseImagePayload(data as ImageApiResponse | string);
        }
        // 即使渠道错误码是 500，也先尝试从响应体中恢复已经生成的图片。
        const response = await axios.post<ImageApiResponse | string>(aiApiUrl(requestConfig, "/images/edits"), formData, {
            headers: aiHeaders(requestConfig),
            signal: options?.signal,
            validateStatus: () => true,
        });
        return parseImagePayload(response.data);
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    return withCharge("text", config.model || config.textModel, async () => {
        const answer = await requestImageQuestionImpl(config, messages, onDelta, options);
        saveGeneratedText(answer);
        return answer;
    });
}

/** Agent 方案三使用的文本 + function calling 请求。一次用户请求只扣一次文本费用。 */
export async function requestAgentLlmTurn(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], onDelta: (text: string) => void, options?: RequestOptions) {
    const operation = async () => {
        const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
        const preparedMessages = withSystemMessage(requestConfig, messages);
        if (resolveModelScript(requestConfig, requestConfig.model)) throw new Error("当前 Agent LLM 插件脚本暂不支持工具调用，请切换到服务器文本模型");
        try {
            if (requestConfig.apiFormat === "gemini") {
                return await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, preparedMessages, toGeminiToolOptions(tools, "auto")), onDelta, options);
            }
            return await requestStreamingResponse(requestConfig, { model: requestConfig.model, input: toResponseInput(preparedMessages), tools: tools.map(toResponseTool), tool_choice: "auto" }, onDelta, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "Agent LLM 请求失败"));
        }
    };
    return options?.charge === false ? operation() : withCharge("text", config.model || config.textModel, operation);
}

async function requestImageQuestionImpl(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        try {
            const answer = await runModelPlugin<string>({
                capability: "text",
                script,
                config: requestConfig,
                messages: withSystemMessage(requestConfig, messages),
                signal: options?.signal,
                onDelta,
            });
            const text = String(answer ?? "").trim() || "没有返回内容";
            if (text === "没有返回内容") onDelta(text);
            return text;
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    try {
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        }
        const answer = (await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
        }, onDelta, options)).content || "没有返回内容";
        if (answer === "没有返回内容") onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export async function fetchChannelModels(channel: ModelChannel) {
    return fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
