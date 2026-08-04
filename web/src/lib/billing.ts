import { backend, getToken } from "@/services/api/backend";
import { useAuthStore } from "@/stores/use-auth-store";
import { isServerProxyModel, modelOptionName, useConfigStore } from "@/stores/use-config-store";
import type { UsageKind } from "@/constant/permissions";

const PENDING_REFUNDS_KEY = "infinite-canvas:pending-refunds";

function readPendingRefunds(): string[] {
    try {
        const value = JSON.parse(localStorage.getItem(PENDING_REFUNDS_KEY) || "[]");
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function writePendingRefunds(receipts: string[]) {
    try {
        if (receipts.length) localStorage.setItem(PENDING_REFUNDS_KEY, JSON.stringify([...new Set(receipts)].slice(-100)));
        else localStorage.removeItem(PENDING_REFUNDS_KEY);
    } catch {
        // 隐私模式或禁用存储时仍继续使用服务端计费流程。
    }
}

function rememberRefund(receiptId: string) {
    writePendingRefunds([...readPendingRefunds(), receiptId]);
}

function forgetRefund(receiptId: string) {
    writePendingRefunds(readPendingRefunds().filter((item) => item !== receiptId));
}

async function refundWithRetry(receiptId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const { user } = await backend.refund(receiptId);
            useAuthStore.getState().applyUser(user);
            forgetRefund(receiptId);
            return true;
        } catch (error) {
            if (attempt === 2) {
                console.error("[billing] 退款重试耗尽，已保留待退款收据", error);
                return false;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
        }
    }
    return false;
}

async function reconcilePendingRefunds() {
    const pending = readPendingRefunds();
    for (const receiptId of pending) await refundWithRetry(receiptId);
}

/**
 * 在发起一次生成前调用：由后端校验并扣除额度、累计使用量统计。
 * - 未登录（无令牌）时直接放行，不影响既有逻辑。
 * - 管理员不扣费，但仍计入使用量统计。
 * - 额度不足时后端返回 402，此处抛出错误，从而在真正请求外部 API 之前中断本次生成。
 */
export async function chargeOrThrow(kind: UsageKind, model?: string): Promise<string | null> {
    if (!getToken() && !useAuthStore.getState().currentUserId) return null;
    if (model && isServerProxyModel(useConfigStore.getState().config, model)) return null;
    await reconcilePendingRefunds();
    const { receiptId, user } = await backend.charge(kind, model ? modelOptionName(model) : undefined);
    useAuthStore.getState().applyUser(user);
    return receiptId || null;
}

export async function withCharge<T>(kind: UsageKind, model: string | undefined, operation: () => Promise<T>): Promise<T> {
    const receiptId = await chargeOrThrow(kind, model);
    if (receiptId) rememberRefund(receiptId);
    try {
        const result = await operation();
        if (receiptId) forgetRefund(receiptId);
        return result;
    } catch (error) {
        if (receiptId) await refundWithRetry(receiptId);
        throw error;
    }
}
