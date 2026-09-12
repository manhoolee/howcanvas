import { Sparkles } from "lucide-react";
import type { UsageKind } from "@/constant/permissions";
import type { AiConfig } from "@/stores/use-config-store";
import { useAuthStore, useCurrentUser } from "@/stores/use-auth-store";
import { formatGenerationCredits as format, generationPrice } from "@/lib/generation-price";

export function CanvasGenerationPrice({ config, kind }: { config: AiConfig; kind: UsageKind }) {
    const user = useCurrentUser();
    const pricing = useAuthStore((s) => s.pricing);
    const modelPricing = useAuthStore((s) => s.modelPricing);
    const videoPricingUnit = useAuthStore((s) => s.videoPricingUnit);
    const modelVideoPricingUnits = useAuthStore((s) => s.modelVideoPricingUnits);
    const billingLoaded = useAuthStore((s) => s.billingLoaded);
    if (!user || !billingLoaded || !config.model) return <span className="whitespace-nowrap text-xs opacity-60">{!user ? "登录后查看积分" : !config.model ? "选择模型后查看积分" : "积分价格加载中"}</span>;

    const quote = generationPrice(config, kind, { pricing, modelPricing, videoPricingUnit, modelVideoPricingUnits }, user.role === "admin");
    const label = user.role === "admin" ? "0 积分" : quote.perSecond ? quote.estimated == null ? `预扣 ${format(quote.reserved)} 积分` : `预计 ${format(quote.estimated)} 积分` : `${format(quote.reserved)} 积分`;
    const detail = user.role === "admin" ? "管理员免扣积分" : quote.perSecond ? `${format(quote.unitPrice)} 积分/秒；统一预扣 15 秒费用 ${format(quote.reserved)} 积分，按实际时长结算，多扣退回` : kind === "image" ? `${format(quote.unitPrice)} 积分/张 × ${quote.count} 张；尺寸、画质与风格不额外加价` : `${format(quote.unitPrice)} 积分/次`;

    return (
        <div className="flex shrink-0 flex-col items-end gap-0.5 whitespace-nowrap" role="status" aria-live="polite" aria-atomic="true" title={detail}>
            <span className="flex items-center gap-1.5 text-xs tabular-nums">
                <Sparkles className="size-3.5 opacity-60" aria-hidden="true" />
                <span>{label}</span>
            </span>
            {quote.perSecond && user.role !== "admin" && <span className="text-[10px] opacity-60">{quote.estimated == null ? "自动时长 · 按实结算" : `预扣 ${format(quote.reserved)} · 按实结算`}</span>}
        </div>
    );
}
