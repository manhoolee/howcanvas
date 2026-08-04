import { PLUGIN_REGISTRY_URL } from "@/constant/env";

// 官方插件清单里的一条(entry 已解析成绝对 URL)
export type OfficialPluginEntry = {
    id: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    url: string;
};

type RawEntry = { id?: string; name?: string; version?: string; description?: string; icon?: string; entry?: string; url?: string };
type RawManifest = { plugins?: RawEntry[] };
const PLUGIN_REGISTRY_TIMEOUT_MS = 20_000;

function validateRegistryUrl(value: string) {
    try {
        const parsed = new URL(value, window.location.origin);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("插件清单地址必须使用 HTTP 或 HTTPS");
        return value;
    } catch (error) {
        if (error instanceof Error && error.message.includes("插件清单地址必须")) throw error;
        throw new Error("插件清单地址无效");
    }
}

function isHttpUrl(value: string) {
    try {
        return /^https?:$/.test(new URL(value, window.location.origin).protocol);
    } catch {
        return false;
    }
}

// 拉取官方插件清单;entry(相对文件名)按清单地址解析成绝对 URL,再走既有 URL 安装流程
export async function fetchOfficialPlugins(registryUrl: string = PLUGIN_REGISTRY_URL): Promise<OfficialPluginEntry[]> {
    if (!registryUrl.trim()) return [];
    const safeUrl = validateRegistryUrl(registryUrl);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PLUGIN_REGISTRY_TIMEOUT_MS);
    let data: RawManifest;
    try {
        const response = await fetch(safeUrl, { headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error(`获取官方插件列表失败 (HTTP ${response.status})`);
        data = (await response.json()) as RawManifest;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw new Error("官方插件清单请求超时");
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
    const list = Array.isArray(data?.plugins) ? data.plugins : [];
    return list
        .filter((item): item is RawEntry & { id: string } => Boolean(item && item.id && (item.entry || item.url)))
        .map((item) => ({
            id: item.id,
            name: item.name || item.id,
            version: item.version || "0.0.0",
            description: item.description,
            icon: item.icon,
            url: item.url ? item.url : new URL(item.entry as string, registryUrl).toString(),
        }))
        .filter((item) => isHttpUrl(item.url));
}

// 语义化版本比较:返回 >0 表示 a 更高,<0 表示 b 更高,0 表示相等。
// 只按 major.minor.patch 数值比较,忽略非数字段(预发布标签等)。
function compareSemver(a: string, b: string): number {
    const parse = (v: string) => v.split(".").map((part) => parseInt(part, 10) || 0);
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// 远程版本是否比本地已安装版本更高(即有可升级的更新)
export function hasUpgrade(installedVersion: string, remoteVersion: string): boolean {
    return compareSemver(remoteVersion, installedVersion) > 0;
}
