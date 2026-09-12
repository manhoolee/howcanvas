import { Link } from "react-router-dom";
import { useEffect } from "react";
import { ArrowLeft, Coins } from "lucide-react";
import { BillingLedger } from "@/components/billing-ledger";
import { useAuthStore, useCurrentUser } from "@/stores/use-auth-store";
import { backend } from "@/services/api/backend";

export default function AccountBillingPage() {
    const user = useCurrentUser();
    useEffect(() => {
        let active = true;
        void backend.me().then(({ user: latest }) => {
            if (active && useAuthStore.getState().currentUserId === latest.id) useAuthStore.getState().applyUser(latest);
        }).catch(() => undefined);
        return () => { active = false; };
    }, [user?.id]);
    return <main className="h-full overflow-y-auto bg-background px-4 py-6 text-foreground sm:px-6">
        <div className="mx-auto max-w-7xl min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-xl font-semibold">积分明细</h1>
                <Link to="/account" className="inline-flex items-center gap-1 text-sm"><ArrowLeft className="size-4" />我的账号</Link>
            </div>
            <div className="flex flex-wrap items-center gap-4 py-3 text-sm"><span className="inline-flex items-center gap-2"><Coins className="size-4" />可用积分 <span className="text-xl font-semibold tabular-nums">{user?.credits ?? 0}</span></span><span>预扣中 {user?.reservedCredits ?? 0} 点</span><span>累计消费 {user?.usage.creditsSpent ?? 0} 点</span></div>
            <BillingLedger key={user?.id} ownAccount />
        </div>
    </main>;
}
