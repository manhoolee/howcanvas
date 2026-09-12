import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { useAuthStore, useCurrentUser } from "@/stores/use-auth-store";

export function VideoPriceSummary({ config }: { config: AiConfig }) {
    const user = useCurrentUser();
    const pricing = useAuthStore((s) => s.pricing);
    const modelPricing = useAuthStore((s) => s.modelPricing);
    const defaultUnit = useAuthStore((s) => s.videoPricingUnit);
    const units = useAuthStore((s) => s.modelVideoPricingUnits);
    const model = modelOptionName(config.model || config.videoModel);
    if (!resolveModelRequestConfig(config, config.model || config.videoModel).baseUrl.startsWith("/api/ai/")) return null;
    const override = modelPricing[model] != null;
    const price = override ? modelPricing[model] : pricing.video;
    const unit = override ? units[model] || "task" : defaultUnit;
    const reserved = user?.role === "admin" ? 0 : Math.round(price * (unit === "second" ? 15 : 1) * 1000000) / 1000000;
    return <div className="text-xs leading-5" aria-label="视频预扣报价">{price} 点/{unit === "second" ? "秒" : "条"} · 预扣 {reserved} 点{unit === "second" ? "（15 秒）" : ""}{unit === "second" && <div className="opacity-70">按实际时长结算，多扣退回</div>}</div>;
}
