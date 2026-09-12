import { formatBytes } from "@/lib/image-utils";

export type VideoTaskProgress = {
    id?: string;
    phase: string;
    receivedBytes?: number;
    totalBytes?: number;
    retryAt?: string;
    updatedAt?: string;
};

const labels: Record<string, string> = {
    queued: "排队中", generating: "生成中", retrieving: "生成完成，取回中",
    verifying: "取回完成，核验中", retrying: "取回异常，等待重试", review: "结果待核实",
    persisted: "加载视频中", failed: "生成失败",
};

export function videoTaskStatusLabel(progress?: VideoTaskProgress) {
    return labels[progress?.phase || "generating"] || "生成中";
}

export function videoTaskProgressDetail(progress?: VideoTaskProgress) {
    if (progress?.phase === "retrieving" && (progress.receivedBytes || progress.totalBytes)) {
        return `已取回 ${formatBytes(progress.receivedBytes || 0)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ""}`;
    }
    if (progress?.phase === "retrying" && progress.retryAt && Number.isFinite(Date.parse(progress.retryAt))) {
        return `${new Date(progress.retryAt).toLocaleTimeString("zh-CN", { hour12: false })} 后重试`;
    }
    return "";
}

export function videoTaskDownloadPercent(progress?: VideoTaskProgress) {
    return progress?.phase === "retrieving" && progress.totalBytes && progress.totalBytes > 0
        ? Math.min(100, Math.max(0, Math.floor((progress.receivedBytes || 0) / progress.totalBytes * 100))) : undefined;
}
