import type { PromptSource } from "./prompt-source-presets";

export type RawPrompt = {
    id: string;
    title: string;
    prompt: string;
    description: string;
    coverUrl: string;
    referenceImageUrls: string[];
    tags: string[];
    preview: string;
    createdAt: string;
    updatedAt: string;
    author?: string;
    sourceUrl?: string;
    imageMode?: string;
    imageModel?: string;
    imageSize?: string;
    imageCount?: number;
};

type RunOptions = { signal?: AbortSignal };
const PROMPT_SOURCE_TIMEOUT_MS = 20_000;

async function fetchPromptSource(url: string, signal?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROMPT_SOURCE_TIMEOUT_MS);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
        return await fetch(url, { cache: "no-store", signal: controller.signal });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
    }
}

async function fetchSource(source: PromptSource, options?: RunOptions) {
    try {
        const response = await fetchPromptSource(source.url, options?.signal);
        if (!response.ok) throw new Error(`请求失败（${response.status}）`);
        return { data: await response.json(), baseUrl: source.url };
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        const fallbackUrl = promptRegistryCdnUrl(source.url);
        if (!fallbackUrl) throw error;
        const response = await fetchPromptSource(fallbackUrl, options?.signal);
        if (!response.ok) throw new Error(`备用提示词源请求失败（${response.status}）`);
        return { data: await response.json(), baseUrl: fallbackUrl };
    }
}

function promptRegistryCdnUrl(value: string) {
    try {
        const url = new URL(value);
        if (url.hostname !== "raw.githubusercontent.com" || url.pathname.startsWith("/yukkcat/image-prompts/") === false) return "";
        const path = url.pathname.replace("/yukkcat/image-prompts/", "");
        return `https://cdn.jsdelivr.net/gh/yukkcat/image-prompts@main/${path}`;
    } catch {
        return "";
    }
}

export async function runPromptSource(source: PromptSource, options?: RunOptions): Promise<RawPrompt[]> {
    if (!source.url.trim()) throw new Error("JSON URL 不能为空");
    let data: unknown;
    try {
        const fetched = await fetchSource(source, options);
        data = parseJsonSource(fetched.data, { ...source, url: fetched.baseUrl });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(`「${source.name}」拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const items = Array.isArray(data) ? data : [];
    if (source.builtIn && !items.length) throw new Error(`「${source.name}」未解析到有效提示词`);
    return items;
}

function parseJsonSource(data: unknown, source: PromptSource) {
    if (!Array.isArray(data)) throw new Error(`「${source.name}」格式错误：根节点必须是数组`);
    return normalizeItems(data, source);
}

function normalizeItems(values: unknown[], source: PromptSource) {
    const seen = new Set<string>();
    const items: RawPrompt[] = [];
    values.forEach((value, index) => {
        const record = asRecord(value);
        const title = stringValue(record.title).trim();
        const prompt = stringValue(record.prompt).trim();
        if (!title || !prompt) return;
        const id = stringValue(record.id).trim() || `${source.id}-${leftPad(index + 1)}`;
        if (seen.has(id)) return;
        seen.add(id);
        const referenceImageUrls = stringArray(record.referenceImageUrls).map((url) => absoluteUrl(source.url, url));
        const coverUrl = absoluteUrl(source.url, stringValue(record.coverUrl)) || referenceImageUrls[0] || "";
        items.push({
            id,
            title,
            prompt,
            description: stringValue(record.description),
            coverUrl,
            referenceImageUrls,
            tags: stringArray(record.tags),
            preview: stringValue(record.preview),
            createdAt: stringValue(record.createdAt),
            updatedAt: stringValue(record.updatedAt),
            author: stringValue(record.author),
            sourceUrl: absoluteUrl(source.url, stringValue(record.sourceUrl)),
            imageMode: optionalString(record.imageMode),
            imageModel: optionalString(record.imageModel),
            imageSize: optionalString(record.imageSize),
            imageCount: optionalNumber(record.imageCount),
        });
    });
    return items;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? value.map(stringValue).map((item) => item.trim()).filter(Boolean) : [];
}

function optionalString(value: unknown) {
    const result = stringValue(value).trim();
    return result || undefined;
}

function optionalNumber(value: unknown) {
    const result = Number(value);
    return Number.isFinite(result) && result > 0 ? result : undefined;
}

function absoluteUrl(baseUrl: string, path: string) {
    if (!path) return "";
    try {
        return new URL(path, baseUrl).toString();
    } catch {
        return path;
    }
}

function leftPad(value: number) {
    return String(value).padStart(4, "0");
}
