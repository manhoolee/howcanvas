import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

export const minimaxH3ResolutionOptions = ["768P", "2K"] as const;
export const minimaxH3RatioOptions = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"] as const;

export function isMiniMaxH3VideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "apiFormat">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return requestConfig.apiFormat === "minimax-h3" && modelOptionName(requestConfig.model || requestConfig.videoModel).toLowerCase() === "minimax-h3";
}

export function normalizeMiniMaxH3Resolution(value: string) {
    return String(value).toUpperCase() === "2K" ? "2K" : "768P";
}

export function normalizeMiniMaxH3Ratio(value: string) {
    return minimaxH3RatioOptions.includes(value as (typeof minimaxH3RatioOptions)[number]) ? value : "16:9";
}

export function normalizeMiniMaxH3Duration(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return Math.max(4, Math.min(15, seconds));
}
