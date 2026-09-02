import axios from "axios";

import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, serverProxyHeaders, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import { withCharge } from "@/lib/billing";
import { saveGeneratedBlob } from "@/services/user-files";

type RequestOptions = { signal?: AbortSignal };
const AUDIO_PLUGIN_FETCH_TIMEOUT_MS = 20_000;

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        ...serverProxyHeaders(config),
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    return withCharge("audio", config.model || config.audioModel, async () => {
        const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
        const model = requestConfig.model.trim();
        const format = normalizeAudioFormatValue(config.audioFormat);
        const script = resolveModelScript(config, config.model || config.audioModel);
        if (script) {
            if (!model) throw new Error("请先配置音频模型");
            if (!requestConfig.baseUrl.trim()) throw new Error("请先配置 Base URL");
            if (!requestConfig.apiKey.trim()) throw new Error("请先配置 API Key");
            try {
                const result = await runModelPlugin({ capability: "audio", script, config: requestConfig, prompt, params: { voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: normalizeAudioSpeedValue(config.audioSpeed), instructions: config.audioInstructions.trim() }, signal: options?.signal });
                return await audioPluginBlob(result, format);
            } catch (error) {
                throw new Error(await readAxiosError(error, "音频生成失败"));
            }
        }
        assertAudioConfig(requestConfig, model);
        const instructions = config.audioInstructions.trim();

        try {
            const response = await axios.post<Blob>(aiApiUrl(requestConfig, "/audio/speech"), { model, input: prompt, voice: normalizeAudioVoiceValue(config.audioVoice), response_format: format, speed: Number(normalizeAudioSpeedValue(config.audioSpeed)), ...(instructions ? { instructions } : {}) }, { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal });
            await assertAudioBlob(response.data);
            return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
        } catch (error) {
            throw new Error(await readAxiosError(error, "音频生成失败"));
        }
    });
}

async function audioPluginBlob(result: unknown, format: string): Promise<Blob> {
    if (result instanceof Blob) return result.type.startsWith("audio/") ? result : new Blob([result], { type: audioMimeType(format) });
    let source = "";
    if (typeof result === "string") source = result;
    else if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        source = typeof record.b64_json === "string" ? record.b64_json : typeof record.data === "string" ? record.data : typeof record.url === "string" ? record.url : "";
    }
    if (!source) throw new Error("模型调用脚本没有返回音频");
    const url = source.startsWith("data:") || /^https?:/i.test(source) ? source : `data:${audioMimeType(format)};base64,${source}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), AUDIO_PLUGIN_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(url, { signal: controller.signal });
    } finally {
        window.clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`音频资源请求失败（${response.status}）`);
    const blob = await response.blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    saveGeneratedBlob("audio", audio, format);
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim() && !config.baseUrl.trim().startsWith("/api/ai/")) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; message?: string; error?: { message?: string } | string };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; message?: string; error?: { message?: string } | string };
    } catch {
        return;
    }
    const detail = readApiErrorMessage(payload);
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(detail || "音频生成失败");
    if (detail) throw new Error(detail);
}

async function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string } | string; msg?: string; code?: number }>(error)) {
        let responseData: unknown = error.response?.data;
        if (typeof Blob !== "undefined" && responseData instanceof Blob && (responseData.type.includes("json") || responseData.type.startsWith("text/"))) {
            const text = (await responseData.text()).trim();
            if (text) {
                try { responseData = JSON.parse(text); }
                catch { return text.slice(0, 300); }
            }
        }
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function readApiErrorMessage(value: unknown): string {
    if (typeof value === "string") {
        const text = value.trim();
        if (!text) return "";
        try { return readApiErrorMessage(JSON.parse(text)) || text; }
        catch { return text; }
    }
    if (!value || typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown };
    const nested = payload.error && typeof payload.error === "object" ? payload.error as { message?: unknown } : undefined;
    return [payload.msg, payload.message, typeof payload.error === "string" ? payload.error : undefined, nested?.message]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() || "";
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}
