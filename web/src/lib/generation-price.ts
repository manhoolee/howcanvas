import type { Pricing, UsageKind } from "@/constant/permissions";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { isSeedanceVideoConfig, normalizeSeedanceDuration } from "@/lib/seedance-video";
import { isMiniMaxH3VideoConfig, normalizeMiniMaxH3Duration } from "@/lib/minimax-h3-video";

type BillingSettings = {
    pricing: Pricing;
    modelPricing: Record<string, number>;
    videoPricingUnit: "task" | "second";
    modelVideoPricingUnits: Record<string, "task" | "second">;
};

/** Quote the same model and task count sent by the canvas generation path. */
export function generationPrice(config: AiConfig, kind: UsageKind, billing: BillingSettings, exempt: boolean) {
    const request = resolveModelRequestConfig(config, config.model);
    const override = billing.modelPricing[request.model] != null;
    const unitPrice = override ? billing.modelPricing[request.model] : billing.pricing[kind];
    const perSecond = kind === "video" && request.baseUrl.trim().startsWith("/api/ai/") && (override ? billing.modelVideoPricingUnits[request.model] || "task" : billing.videoPricingUnit) === "second";
    const count = kind === "image" ? Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1))) : 1;
    let seconds = Math.max(1, Math.min(20, Math.floor(Number(config.videoSeconds) || 6)));
    if (kind === "video") {
        if (isSeedanceVideoConfig(config)) seconds = normalizeSeedanceDuration(config.videoSeconds);
        else if (isMiniMaxH3VideoConfig(config)) seconds = normalizeMiniMaxH3Duration(config.videoSeconds);
        else if (request.apiFormat === "grok-video-v2") seconds = Number(config.videoSeconds) >= 8 ? 10 : 6;
    }
    // Server prices have at most six decimals. Multiply integer credit units.
    const cost = (quantity: number) => exempt ? 0 : Math.round(unitPrice * 1000000) * quantity / 1000000;
    return {
        unitPrice, count, perSecond, seconds,
        estimated: perSecond && seconds === -1 ? null : cost(perSecond ? seconds : count),
        reserved: cost(perSecond ? 15 : count),
    };
}

export function formatGenerationCredits(value: number) {
    return value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
}
