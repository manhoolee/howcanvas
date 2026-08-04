import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import type { CanvasNodeDefinition, CanvasPlugin } from "@/types/canvas-plugin";

const cleanups = new Map<string, () => void>();
const PLUGIN_FETCH_TIMEOUT_MS = 20_000;
const MAX_PLUGIN_SOURCE_BYTES = 2 * 1024 * 1024;

function validatePluginUrl(value: string) {
    try {
        const parsed = new URL(value, window.location.origin);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("插件地址必须使用 HTTP 或 HTTPS");
        return value;
    } catch (error) {
        if (error instanceof Error && error.message.includes("插件地址必须")) throw error;
        throw new Error("插件地址无效");
    }
}

// 远程插件默认导出可以是 CanvasPlugin,或接收 runtime 返回 CanvasPlugin 的工厂
// (工厂形式用 runtime.React,无需 bundle 自带 React)
async function evaluatePluginSource(source: string): Promise<CanvasPlugin> {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
        const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown; plugin?: unknown };
        const exported = mod.default ?? mod.plugin;
        const plugin = typeof exported === "function" ? (exported as (runtime: unknown) => unknown)(getPluginRuntime()) : exported;
        assertPlugin(plugin);
        return plugin;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function assertPlugin(plugin: unknown): asserts plugin is CanvasPlugin {
    const value = plugin as Partial<CanvasPlugin> | null;
    if (!value || typeof value !== "object") throw new Error("插件未导出有效对象");
    if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.id)) throw new Error("插件 id 无效");
    if (!Array.isArray(value.nodes) || !value.nodes.length) throw new Error("插件缺少 nodes");
    for (const node of value.nodes) {
        const definition = node as Partial<CanvasNodeDefinition> | null;
        const size = definition?.defaultSize;
        if (
            !definition ||
            typeof definition.type !== "string" ||
            !definition.type.trim() ||
            typeof definition.title !== "string" ||
            !definition.title.trim() ||
            !size ||
            !Number.isFinite(size.width) ||
            !Number.isFinite(size.height) ||
            size.width <= 0 ||
            size.height <= 0
        ) throw new Error("插件包含无效节点定义");
    }
}

export function activatePlugin(plugin: CanvasPlugin) {
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    // 插件声明的样式:启用时注入,禁用/卸载时清理
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(plugin.id, () => disposers.forEach((dispose) => dispose()));
}

export function deactivatePlugin(pluginId: string) {
    cleanups.get(pluginId)?.();
    cleanups.delete(pluginId);
    unregisterPluginNodes(pluginId);
}

async function fetchPluginSource(url: string) {
    const safeUrl = validatePluginUrl(url);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(safeUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`);
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_PLUGIN_SOURCE_BYTES) throw new Error("插件源码超过 2MB 限制");
        const source = await response.text();
        if (new TextEncoder().encode(source).byteLength > MAX_PLUGIN_SOURCE_BYTES) throw new Error("插件源码超过 2MB 限制");
        return source;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw new Error("插件下载超时");
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

// 加缓存穿透参数,配合 watch 构建拿到最新产物
function withCacheBust(url: string) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

// 从 URL 安装(或覆盖更新)一个插件,成功后立即启用。
// bustCache=true 时下载绕过 HTTP/CDN 缓存(升级场景必需,避免拿到旧产物),
// 但落库的 url 始终保持干净(不带 ?t=),便于后续再次更新。
export async function installPluginFromUrl(url: string, opts?: { official?: boolean; bustCache?: boolean }) {
    const source = await fetchPluginSource(opts?.bustCache ? withCacheBust(url) : url);
    const plugin = await evaluatePluginSource(source);
    deactivatePlugin(plugin.id); // 覆盖旧版本
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url, source, enabled: true, official: opts?.official });
    activatePlugin(plugin);
    return plugin;
}

export async function updatePlugin(record: InstalledPlugin) {
    // 升级必须拿到最新产物,强制绕过缓存
    return installPluginFromUrl(record.url, { official: record.official, bustCache: true });
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    usePluginStore.getState().setEnabled(record.id, enabled);
    if (!enabled) {
        deactivatePlugin(record.id);
        return;
    }
    // 本地插件启用时按 url 重新拉取,拿到最新构建(缓存 source 可能已过期)
    const source = record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source;
    const plugin = await evaluatePluginSource(source);
    activatePlugin(plugin);
}

export function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
}

let loaded = false;
const MAX_PLUGIN_INDEX_BYTES = 256 * 1024;

// 应用启动时加载已安装且启用的插件
export async function ensurePluginsLoaded() {
    if (loaded) return;
    loaded = true;
    await usePluginStore.persist.rehydrate();
    await loadLocalPlugins(); // 先发现本地插件(默认关闭),再统一按 enabled 激活
    const records = usePluginStore.getState().plugins.filter((record) => record.enabled);
    await Promise.all(
        records.map(async (record) => {
            try {
                // 本地插件用最新产物,其余用缓存的源码
                const source = record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source;
                activatePlugin(await evaluatePluginSource(source));
            } catch (error) {
                console.error(`[plugin] 加载失败: ${record.id}`, error);
            }
        }),
    );
    await loadDevPlugins();
}

// 自动发现 web/public/plugins 下的本地插件:加入列表但默认关闭,
// 本地开发放好插件文件即可在管理器里看到并一键启用,无需手动填 URL。
// 已在列表中的:刷新元数据(version/name/description/source)到最新产物,
// 但保留用户的 enabled 开关 —— 否则改了插件版本后,持久化 store 里的旧 version 永不更新。
async function loadLocalPlugins() {
    let urls: unknown;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch("/plugins/index.json", { signal: controller.signal });
        if (!response.ok) return;
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_PLUGIN_INDEX_BYTES) return;
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_PLUGIN_INDEX_BYTES) return;
        urls = JSON.parse(text);
    } catch {
        return; // 无本地清单(如生产环境未构建插件)则跳过
    } finally {
        window.clearTimeout(timer);
    }
    if (!Array.isArray(urls) || !urls.length) return;
    const store = usePluginStore.getState();
    await Promise.all(
        urls.map(async (url: string) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                const existing = store.plugins.find((item) => item.id === plugin.id);
                store.upsert({
                    id: plugin.id,
                    name: plugin.name || plugin.id,
                    version: plugin.version || "0.0.0",
                    description: plugin.description,
                    url,
                    source,
                    enabled: existing?.enabled ?? false, // 保留用户开关,新发现默认关闭
                    local: true,
                });
            } catch (error) {
                console.error(`[plugin] 本地插件发现失败: ${url}`, error);
            }
        }),
    );
}

// 本地开发:VITE_DEV_PLUGINS 里的 URL 每次启动都重新拉取(不缓存、不落库),
// 配合 watch 构建即可「改代码→刷新页面」看到最新插件,无需反复安装。
async function loadDevPlugins() {
    const raw = import.meta.env.VITE_DEV_PLUGINS;
    if (!raw) return;
    const urls = raw.split(",").map((item) => item.trim()).filter(Boolean);
    await Promise.all(
        urls.map(async (url) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                deactivatePlugin(plugin.id);
                activatePlugin(plugin);
                console.info(`[plugin] dev 插件已加载: ${plugin.id} (${url})`);
            } catch (error) {
                console.error(`[plugin] dev 插件加载失败: ${url}`, error);
            }
        }),
    );
}
