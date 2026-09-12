import axios, { type AxiosRequestConfig } from "axios";
import { nanoid } from "nanoid";
import { getAuthEpoch } from "./backend";
import { useAuthStore } from "@/stores/use-auth-store";

export async function postGeneration<T>(url: string, body: unknown, config: AxiosRequestConfig, requestId = nanoid()) {
    const managed = /^\/api\/(?:ai|image-tasks|seedream-tasks)\//.test(url);
    const epoch = getAuthEpoch();
    const headers: Record<string, unknown> = { ...config.headers, ...(managed ? { "Idempotency-Key": requestId } : {}) };
    const channelId = url.match(/^\/api\/ai\/([^/]+)\/(?:v1\/)?(?:videos|contents\/generations\/tasks|v2\/videos\/generations|v2\/video_generation)$/)?.[1];
    if (channelId) {
        const model = body instanceof FormData ? String(body.get("model") || "") : String((body as { model?: string })?.model || "");
        const { data: quote } = await axios.get<{ token: string; unitPrice: number; pricingUnit: string }>(`/api/billing/video-quote/${channelId}`, { params: { model }, signal: config.signal });
        const state = useAuthStore.getState();
        const override = state.modelPricing[model] != null;
        const price = override ? state.modelPricing[model] : state.pricing.video;
        const unit = override ? state.modelVideoPricingUnits[model] || "task" : state.videoPricingUnit;
        if (quote.unitPrice !== price || quote.pricingUnit !== unit) throw new Error("视频价格已变化，请刷新后再生成");
        headers["X-Billing-Quote"] = quote.token;
    }
    for (let attempt = 0; ; attempt += 1) {
        if (getAuthEpoch() !== epoch) throw new Error("账号已切换，已停止提交原任务");
        try {
            return await axios.post<T>(url, body, { ...config, headers: headers as AxiosRequestConfig["headers"] });
        } catch (error) {
            const pending = axios.isAxiosError(error) && error.response?.data?.code === "GENERATION_PENDING";
            const networkFailure = axios.isAxiosError(error) && !error.response;
            if (!managed || axios.isCancel(error) || config.signal?.aborted || attempt >= 2 || (!pending && !networkFailure)) throw error;
            // Retries reuse the same operation ID, even when the first response was lost.
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}
