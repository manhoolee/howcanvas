// 把个人资产发布为公共资产（上传到服务器公共文件夹）。
import { backend } from "@/services/api/backend";
import type { Asset } from "@/stores/use-asset-store";

const PUBLIC_ASSET_FETCH_TIMEOUT_MS = 20_000;

async function fetchPublicAsset(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PUBLIC_ASSET_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`公共资产请求失败（${response.status}）`);
        return response;
    } finally {
        window.clearTimeout(timer);
    }
}

export async function fetchPublicAssetText(url: string): Promise<string> {
    return (await fetchPublicAsset(url)).text();
}

function extFromMime(mime: string, fallback: string): string {
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/webm": "webm",
    };
    return map[(mime || "").toLowerCase()] || fallback;
}

export async function publishAssetToPublic(asset: Asset): Promise<void> {
    const meta = { title: asset.title, tags: asset.tags || [], note: asset.note, folder: asset.folder };

    if (asset.kind === "text") {
        await backend.publishPublicAsset({ ...meta, kind: "text", ext: "txt" }, new Blob([asset.data.content], { type: "text/plain" }));
        return;
    }

    const url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
    if (!url) throw new Error("资产内容为空，无法发布");
    const response = await fetchPublicAsset(url);
    const blob = await response.blob();
    if (!blob.size || blob.type.includes("json")) throw new Error("资产内容异常，请刷新页面后重试");
    const mime = blob.type || asset.data.mimeType || "";
    const ext = extFromMime(mime, asset.kind === "image" ? "png" : "mp4");
    await backend.publishPublicAsset({ ...meta, kind: asset.kind, ext }, blob);
}
