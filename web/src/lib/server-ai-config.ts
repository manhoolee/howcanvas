import { getToken, type ServerAiConfig } from "@/services/api/backend";
import { normalizeApiFormat, useConfigStore, type ModelChannel } from "@/stores/use-config-store";

// 服务器渠道在前端配置里的 id 前缀；真实 Base URL 与 API Key 只存在服务器 channels.json，
// 前端渠道的 baseUrl 指向 /api/ai/<渠道id> 代理，apiKey 填当前用户会话令牌（代理端校验登录后替换为真实密钥）。
const SERVER_CHANNEL_PREFIX = "srv_";
const SEP = "::";

export function isServerChannelId(id: string): boolean {
    return id.startsWith(SERVER_CHANNEL_PREFIX) || id === "server";
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
        const mapDefault = (value: string | undefined, fallback: string) => {
            if (!value || !value.includes(SEP)) return fallback;
            const [cid, ...rest] = value.split(SEP);
            const model = rest.join(SEP);
            const frontId = `${SERVER_CHANNEL_PREFIX}${cid}`;
            return channels.some((c) => c.id === frontId && c.models.some((m) => m.name === model)) ? `${frontId}${SEP}${model}` : fallback;
        };

        return {
            config: {
                ...state.config,
                channels,
                imageModel: mapDefault(server.defaultModels?.image, state.config.imageModel),
                videoModel: mapDefault(server.defaultModels?.video, state.config.videoModel),
                audioModel: mapDefault(server.defaultModels?.audio, state.config.audioModel),
                textModel: mapDefault(server.defaultModels?.text, state.config.textModel),
                model: mapDefault(server.defaultModels?.image, state.config.model),
            },
        };
    });
}
