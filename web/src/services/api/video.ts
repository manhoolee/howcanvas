import axios from "axios";
import { nanoid } from "nanoid";

import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { isMiniMaxH3VideoConfig, normalizeMiniMaxH3Duration, normalizeMiniMaxH3Ratio, normalizeMiniMaxH3Resolution } from "@/lib/minimax-h3-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, serverProxyHeaders, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import { chargeOrThrow, withCharge } from "@/lib/billing";
import { saveGeneratedBlob } from "@/services/user-files";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string }; url?: string; output?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null; metadata?: { url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type SeedanceTask = {
    id: string;
    task_id?: string;
    status?: "queued" | "running" | "in_progress" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    metadata?: { url?: string } | null;
    url?: string;
    output?: string;
    result_url?: string;
    video_url?: string;
};
type GrokVideoTask = {
    task_id?: string;
    status?: "NOT_START" | "IN_PROGRESS" | "SUCCESS" | "FAILURE" | string;
    fail_reason?: string;
    data?: VideoResponse | null;
    video_url?: string;
};
type MiniMaxH3Task = {
    id?: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    content?: { url?: string } | null;
    error?: { code?: string; message?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal; skipCharge?: boolean; onTaskSubmitted?: (task: VideoGenerationTask) => void };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "grok-v2" | "minimax-h3" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending"; retryAfterMs?: number } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...serverProxyHeaders(config),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    return withCharge("video", modelOptionName(config.model || config.videoModel), async () => {
        const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, { ...options, skipCharge: true });
        options?.onTaskSubmitted?.(task);
        return waitForVideoGenerationTask(config, task, options);
    });
}

/** 继续查询一个已经创建的任务，不创建新任务，也不再次扣费。 */
export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<RequestOptions, "signal">): Promise<VideoGenerationResult> {
    // H3 tasks may take several minutes.  A 5-second poll would exhaust the server's
    // shared AI-proxy allowance before the task completes, so keep it deliberately low.
    const delayMs = task.provider === "minimax-h3" ? 20_000 : task.provider === "seedance" ? 5000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === 119) throw new Error(`${task.provider === "seedance" ? "Seedance " : task.provider === "minimax-h3" ? "MiniMax H3 " : ""}视频生成超时，可稍后再次取回结果`);
        await delay(Math.max(delayMs, state.retryAfterMs || 0), options?.signal);
    }
    throw new Error("视频生成超时，可稍后再次取回结果");
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    if (!options?.skipCharge) await chargeOrThrow("video", modelOptionName(selectedModel));
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isGrokVideoV2Config(requestConfig)) {
        if (videoReferences.length || audioReferences.length) throw new Error("Grok Video V2 仅支持参考图片，不支持参考视频或参考音频");
        return createGrokVideoTask(requestConfig, selectedModel, prompt, references, options);
    }
    if (isMiniMaxH3VideoConfig(requestConfig)) return createMiniMaxH3Task(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    if (isSeedanceVideoConfig(requestConfig)) return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    // T8 Grok Video 3 接收 JSON 任务参数；Seedance 仍走上面的专用协议。
    if (modelOptionName(selectedModel).toLowerCase() === "grok-video-3") {
        return createCompatibleGrokVideoTask(requestConfig, selectedModel, prompt, references, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan 模型，或移除参考资产");
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: "插件视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "grok-v2") return pollGrokVideoTask(requestConfig, task, options);
    if (task.provider === "minimax-h3") return pollMiniMaxH3Task(requestConfig, task, options);
    return task.provider === "seedance" ? pollSeedanceTask(requestConfig, task, options) : pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) saveGeneratedBlob("video", result.blob, "mp4");
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            const downloadUrl = /^https?:\/\//i.test(result.url) ? `/api/media/proxy?url=${encodeURIComponent(result.url)}` : result.url;
            return await uploadMediaFile(downloadUrl, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error("视频接口没有返回可播放的视频");
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || "视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务查询失败"));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const modelName = modelOptionName(model);
    const apiModel = seedanceApiModel(config, modelName);
    const payload = isSeedanceApi(config)
        ? {
            model: apiModel,
            ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
            ...(apiModel.endsWith("-i2v") ? { images: await Promise.all(references.slice(0, 2).map((image) => resolveSeedanceImageUrl(config, image))) } : {}),
            seconds: String(normalizeSeedanceDuration(config.videoSeconds)),
            metadata: {
                resolution: normalizeSeedanceResolution(config.vquality, apiModel),
                ratio: normalizeSeedanceRatio(config.size),
                generate_audio: boolConfig(config.videoGenerateAudio, true),
                ...(apiModel.endsWith("-multi") ? { content } : {}),
            },
        }
        : {
            model: modelName,
            content,
            ratio: normalizeSeedanceRatio(config.size),
            resolution: normalizeSeedanceResolution(config.vquality, modelName),
            duration: normalizeSeedanceDuration(config.videoSeconds),
            generate_audio: boolConfig(config.videoGenerateAudio, true),
            watermark: boolConfig(config.videoWatermark, false),
        };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, undefined, model), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id, task.model), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (state.status === "succeeded" || state.status === "completed") return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL" };
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: readApiErrorMessage(state.error?.message) || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string, model = "") {
    if (isSeedanceApi(config)) return buildApiUrl(config.baseUrl, `/videos${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
    const path = `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
    if (isT8StarSeedanceModel(config, model)) return `${new URL(config.baseUrl).origin}/seedance/v3${path}`;
    return buildApiUrl(config.baseUrl, path);
}

async function createGrokVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(
        references.slice(0, 7).map(async (image) => {
            const dataUrl = await imageToDataUrl(image);
            if (!dataUrl) throw new Error("Grok 参考图读取失败，请重新连接图片节点");
            return dataUrl;
        }),
    );
    const payload = {
        model: modelOptionName(model),
        prompt: buildGrokVideoPrompt(prompt, images.length),
        ratio: normalizeGrokVideoRatio(config.size),
        resolution: normalizeGrokVideoResolution(config.vquality),
        duration: normalizeGrokVideoDuration(config.videoSeconds),
        ...(images.length ? { images } : {}),
    };
    try {
        const response = (await axios.post<GrokVideoTask>(grokVideoApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data;
        if (!response?.task_id) throw new Error("Grok Video V2 接口没有返回 task_id");
        return { id: response.task_id, provider: "grok-v2", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Grok Video V2 任务创建失败"));
    }
}

async function pollGrokVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const response = (await axios.get<GrokVideoTask>(grokVideoApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data;
        const status = String(response?.status || "").toUpperCase();
        const result = response?.data || response;
        const url = videoResultUrl(result);
        if (status === "SUCCESS" || url) {
            if (!url) return { status: "failed", error: "Grok Video V2 任务成功但没有返回视频 URL" };
            return { status: "completed", result: await videoResultFromUrl(url, options) };
        }
        if (status === "FAILURE") return { status: "failed", error: response.fail_reason || "Grok Video V2 生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Grok Video V2 任务查询失败"));
    }
}

async function createMiniMaxH3Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const text = prompt.trim();
    if (!text) throw new Error("MiniMax H3 必须填写视频提示词");
    const hasMultimodalReferences = videoReferences.length > 0 || audioReferences.length > 0;
    if (!hasMultimodalReferences && references.length > 2) throw new Error("MiniMax H3 首尾帧最多支持 2 张图片；如需多张参考图，请同时添加参考视频或参考音频");
    const content: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const [index, image] of references.entries()) {
        const url = await imageToDataUrl(image);
        if (!url) throw new Error("MiniMax H3 参考图读取失败，请重新连接图片节点");
        content.push({ type: "image_url", image_url: { url }, role: hasMultimodalReferences ? "reference_image" : index === 0 ? "first_frame" : "last_frame" });
    }
    for (const video of videoReferences) content.push({ type: "video_url", video_url: { url: await resolveMiniMaxH3MediaUrl(video, "视频") }, role: "reference_video" });
    for (const audio of audioReferences) content.push({ type: "audio_url", audio_url: { url: await resolveMiniMaxH3MediaUrl(audio, "音频") }, role: "reference_audio" });
    const ratio = references.length && !hasMultimodalReferences ? "adaptive" : normalizeMiniMaxH3Ratio(config.size);
    try {
        const response = await axios.post<{ task_id?: string }>(
            miniMaxH3ApiUrl(config),
            {
                model: modelOptionName(model),
                content,
                resolution: normalizeMiniMaxH3Resolution(config.vquality),
                duration: normalizeMiniMaxH3Duration(config.videoSeconds),
                ratio,
                aigc_watermark: boolConfig(config.videoWatermark, false),
            },
            { headers: aiHeaders(config, "application/json"), signal: options?.signal },
        );
        if (!response.data?.task_id) throw new Error("MiniMax H3 接口没有返回 task_id");
        return { id: response.data.task_id, provider: "minimax-h3", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "MiniMax H3 视频任务创建失败"));
    }
}

async function pollMiniMaxH3Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const response = await axios.get<{ task?: MiniMaxH3Task }>(miniMaxH3ApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal });
        const state = response.data?.task;
        if (!state) throw new Error("MiniMax H3 接口没有返回任务");
        const url = videoResultUrl(state);
        if (state.status === "succeeded") return url ? { status: "completed", result: await videoResultFromUrl(url, options) } : { status: "failed", error: "MiniMax H3 任务成功但没有返回视频 URL" };
        if (state.status === "failed" || state.status === "cancelled") return { status: "failed", error: state.error?.message || "MiniMax H3 视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
            const seconds = Number(error.response.headers?.["retry-after"]);
            return { status: "pending", retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000 };
        }
        throw new Error(readAxiosError(error, "MiniMax H3 视频任务查询失败"));
    }
}

function isSeedanceApi(config: AiConfig) {
    return config.baseUrl.toLowerCase().includes("api.seedance.nz");
}

function seedanceApiModel(config: AiConfig, model: string) {
    if (!isSeedanceApi(config)) return model;
    const normalized = model.toLowerCase();
    if (/^seedance-2\.0-(?:global-)?(?:standard|fast|mini)-(?:t2v|i2v|multi)$/.test(normalized)) return model;
    const tier = normalized.includes("mini") ? "mini" : normalized.includes("fast") ? "fast" : "standard";
    return `seedance-2.0-global-${tier}-multi`;
}

async function createCompatibleGrokVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const images = await Promise.all(references.slice(0, 7).map((image) => imageToDataUrl(image)));
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(
                    aiApiUrl(config, "/videos"),
                    {
                        duration: Number(normalizeVideoSeconds(config.videoSeconds)),
                        ...(images.length ? { images } : {}),
                        model: modelOptionName(model),
                        prompt,
                        ratio: normalizeCompatibleGrokRatio(config.size),
                        resolution: normalizeVideoResolution(config.vquality).toUpperCase(),
                    },
                    { headers: aiHeaders(config, "application/json"), signal: options?.signal },
                )
            ).data,
        );
        if (!created.id) throw new Error("Grok Video 3 接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Grok Video 3 视频任务创建失败"));
    }
}

function isT8StarSeedanceModel(config: AiConfig, model: string) {
    return config.baseUrl.toLowerCase().includes("ai.t8star.org") && modelOptionName(model).toLowerCase().includes("seedance");
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、资产 ID，或本地已保存的视频");
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、资产 ID，或本地已保存的音频");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    // 对象存储签名 URL 通常不提供 CORS；交给同源代理下载并保存，避免浏览器先发起一次必然失败的跨域请求。
    if (/^https?:\/\//i.test(url)) return { url, mimeType: "video/mp4" };
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim() && !config.baseUrl.trim().startsWith("/api/ai/")) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "data" in payload) {
        if ("code" in payload && payload.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data as T;
    }
    return payload as T;
}

async function resolveMiniMaxH3MediaUrl(media: ReferenceVideo | ReferenceAudio, label: string) {
    if (isPublicMediaUrl(media.url)) return media.url;
    let blob: Blob | null = media.storageKey ? await getMediaBlob(media.storageKey) : null;
    if (!blob && media.url?.startsWith("blob:")) blob = await (await fetch(media.url)).blob();
    if (!blob) throw new Error(`MiniMax H3 参考${label}必须是公网 URL 或本地已保存的文件`);
    return blobToDataUrl(blob);
}

function isGrokVideoV2Config(config: AiConfig) {
    return config.apiFormat === "grok-video-v2" && modelOptionName(config.model).toLowerCase() === "grok-video-3";
}

function miniMaxH3ApiUrl(config: AiConfig, taskId = "") {
    const base = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${base}${taskId ? `/v2/query/video_generation/${encodeURIComponent(taskId)}` : "/v2/video_generation"}`;
}

function grokVideoApiUrl(config: AiConfig, taskId = "") {
    const base = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${base}/v2/videos/generations${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
}

function buildGrokVideoPrompt(prompt: string, imageCount: number) {
    let text = prompt.trim();
    if (imageCount <= 1) return text;
    for (let index = imageCount; index >= 1; index -= 1) text = text.replace(new RegExp(`图片${index}(?!\\d)`, "g"), `@img${index}`);
    const missing = Array.from({ length: imageCount }, (_, index) => `@img${index + 1}`).filter((token) => !text.includes(token));
    return missing.length ? `${missing.join(" ")} ${text}`.trim() : text;
}

function normalizeGrokVideoRatio(value: string) {
    const supported = ["2:3", "3:2", "1:1", "16:9", "9:16"] as const;
    if (supported.includes(value as (typeof supported)[number])) return value;
    const dimensions = value.match(/^(\d+)x(\d+)$/i);
    if (!dimensions) return "16:9";
    const ratio = Number(dimensions[1]) / Number(dimensions[2]);
    return supported.reduce((best, current) => {
        const [bestWidth, bestHeight] = best.split(":").map(Number);
        const [width, height] = current.split(":").map(Number);
        return Math.abs(width / height - ratio) < Math.abs(bestWidth / bestHeight - ratio) ? current : best;
    });
}

function normalizeGrokVideoResolution(value: string) {
    return /1080/i.test(value) ? "1080P" : "720P";
}

function normalizeGrokVideoDuration(value: string) {
    return Number(value) >= 8 ? 10 : 6;
}

function normalizeCompatibleGrokRatio(value: string) {
    if (["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(value)) return value;
    const match = String(value || "").match(/^(\d+)x(\d+)$/);
    if (!match) return "16:9";
    const ratio = Number(match[1]) / Number(match[2]);
    const options = [
        { value: "16:9", ratio: 16 / 9 },
        { value: "9:16", ratio: 9 / 16 },
        { value: "1:1", ratio: 1 },
        { value: "4:3", ratio: 4 / 3 },
        { value: "3:4", ratio: 3 / 4 },
        { value: "21:9", ratio: 21 / 9 },
    ];
    return options.reduce((closest, option) => Math.abs(option.ratio - ratio) < Math.abs(closest.ratio - ratio) ? option : closest).value;
}

function videoResultUrl(payload: { video_url?: string; result_url?: string; url?: string; output?: string; content?: { video_url?: string; url?: string } | null; metadata?: { url?: string } | null }) {
    return [payload.video_url, payload.result_url, payload.url, payload.output, payload.content?.video_url, payload.content?.url, payload.metadata?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            return readApiErrorMessage(JSON.parse(value)) || value;
        } catch {
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: { message?: unknown } };
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(payload.error?.message);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || "视频下载失败");
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地资产失败"));
        reader.readAsDataURL(blob);
    });
}
