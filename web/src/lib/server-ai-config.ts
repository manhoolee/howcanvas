import { getToken, type ServerAiConfig } from "@/services/api/backend";
import { decodeChannelModel, normalizeApiFormat, useConfigStore, type ModelChannel } from "@/stores/use-config-store";

// 服务器渠道在前端配置里的 id 前缀；真实 Base URL 与 API Key 只存在服务器 channels.json，
// 前端渠道的 baseUrl 指向 /api/ai/<渠道id> 代理，apiKey 填当前用户会话令牌（代理端校验登录后替换为真实密钥）。
const SERVER_CHANNEL_PREFIX = "srv_";
const SEP = "::";

function isValidModelSelection(value: string, channels: ModelChannel[], capability: string) {
    const selection = value.trim();
    if (!selection) return false;
    const decoded = decodeChannelModel(selection);
    if (!decoded) return channels.some((channel) => channel.models.some((model) => model.name === selection && model.capability === capability));
    const channel = channels.find((item) => item.id === decoded.channelId || item.id === `srv_${decoded.channelId}`);
    return Boolean(channel?.models.some((model) => model.name === decoded.model && model.capability === capability));
}

export function isServerChannelId(id: string): boolean {
    return id.startsWith(SERVER_CHANNEL_PREFIX) || id === "server";
}

/**
 * 将服务器保存的模型选择（`channelId::model`）转换成前端内存渠道选择。
 *
 * 服务器 API 不应暴露前端渠道前缀，后台设置因此保存原始渠道 id；前端
 * 合并渠道时会为每个渠道加上 `srv_` 前缀。Agent LLM 配置也经过同一
 * /api/config/ai 接口返回，调用前必须完成这个转换，否则 resolveModelChannel
 * 会回退到第一个渠道，在多渠道场景下把请求发给错误的 API Key。
 * 无法解析或模型已被删除时返回空字符串，让调用方显示配置提示。
 */
export function toFrontendServerModelSelection(value: string | undefined, serverChannels: ServerAiConfig["channels"] = [], capability?: string): string {
    const selection = String(value || "").trim();
    if (!selection) return "";
    const separator = selection.indexOf(SEP);
    if (separator < 0) {
        const channel = serverChannels.find((item) => item.models.some((model) => model.name === selection && (!capability || model.capability === capability)));
        return channel ? `${SERVER_CHANNEL_PREFIX}${channel.id}${SEP}${selection}` : "";
    }
    const channelId = selection.slice(0, separator).trim();
    const model = selection.slice(separator + SEP.length).trim();
    if (!channelId || !model) return "";
    const serverChannel = serverChannels.find((channel) => channel.id === channelId || `${SERVER_CHANNEL_PREFIX}${channel.id}` === channelId);
    const serverModel = serverChannel?.models.find((item) => item.name === model);
    if (!serverChannel || !serverModel || (capability && serverModel.capability !== capability)) return "";
    return `${SERVER_CHANNEL_PREFIX}${serverChannel.id}${SEP}${model}`;
}

/**
 * 将服务器下发的多渠道合并进前端配置：
 * 每个服务器渠道注入为一个「(服务器)」渠道，并按服务器设置的默认模型指向对应渠道。
 * 服务器无渠道时不做任何事。
 */
export function applyServerAiConfig(server: ServerAiConfig): void {
    const token = getToken();
    const proxied: ModelChannel[] = (server.channels || []).map((channel) => ({
        id: `${SERVER_CHANNEL_PREFIX}${channel.id}`,
        name: `${channel.name}（服务器）`,
        baseUrl: `/api/ai/${channel.id}`,
        apiKey: token,
        apiFormat: normalizeApiFormat(channel.apiFormat),
        models: channel.models.map((m) => ({ name: m.name, capability: m.capability })),
    }));

    useConfigStore.setState((state) => {
        // 移除旧的服务器渠道（含单渠道时代的 "server"），保留管理员本地手工渠道
        const others = state.config.channels.filter((c) => !isServerChannelId(c.id));
        const channels = [...proxied, ...others];

        // 服务器默认模型 "渠道id::模型名" → 前端选项 "srv_渠道id::模型名"
        const mapDefault = (value: string | undefined, fallback: string, capability: string) => {
            const mapped = toFrontendServerModelSelection(value, server.channels, capability);
            return mapped || (isValidModelSelection(fallback, channels, capability) ? fallback : "");
        };

        return {
            config: {
                ...state.config,
                channels,
                imageModel: mapDefault(server.defaultModels?.image, state.config.imageModel, "image"),
                videoModel: mapDefault(server.defaultModels?.video, state.config.videoModel, "video"),
                audioModel: mapDefault(server.defaultModels?.audio, state.config.audioModel, "audio"),
                textModel: mapDefault(server.defaultModels?.text, state.config.textModel, "text"),
                model: mapDefault(server.defaultModels?.image, state.config.model, "image"),
            },
        };
    });
}
