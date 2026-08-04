import { useEffect, useMemo, useState } from "react";
import { App, AutoComplete, Button, Card, Drawer, Empty, Input, Modal, Pagination, Popconfirm, Space, Spin, Tag, Typography } from "antd";
import { Download, FolderInput, Globe2, Search, Trash2 } from "lucide-react";
import { saveAs } from "file-saver";

import { backend, publicAssetFileUrl, type PublicAsset } from "@/services/api/backend";
import { fetchPublicAssetText } from "@/services/public-assets";
import { useIsAdmin } from "@/hooks/use-nav-permissions";
import { cn } from "@/lib/utils";

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
] as const;

function kindLabel(kind: PublicAsset["kind"]) {
    return kind === "image" ? "图片" : kind === "video" ? "视频" : "文本";
}

export default function PublicAssetsPage() {
    const { message } = App.useApp();
    const isAdmin = useIsAdmin();
    const [assets, setAssets] = useState<PublicAsset[]>([]);
    const [loading, setLoading] = useState(true);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<PublicAsset["kind"] | "all">("all");
    const [folderFilter, setFolderFilter] = useState<string>("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(12);
    const [previewAsset, setPreviewAsset] = useState<PublicAsset | null>(null);
    const [moveTarget, setMoveTarget] = useState<PublicAsset | null>(null);
    const [moveFolder, setMoveFolder] = useState("");

    async function reload() {
        setLoading(true);
        try {
            const { assets } = await backend.publicAssets();
            setAssets(assets);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载公共资产失败");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const folders = useMemo(() => Array.from(new Set(assets.map((asset) => (asset.folder || "").trim()).filter(Boolean))).sort(), [assets]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (folderFilter === "none" && (asset.folder || "").trim()) return false;
            if (folderFilter !== "all" && folderFilter !== "none" && (asset.folder || "").trim() !== folderFilter) return false;
            if (!query) return true;
            return [asset.title, asset.note, asset.uploadedByName, asset.tags.join(" ")].join(" ").toLowerCase().includes(query);
        });
    }, [assets, keyword, kindFilter, folderFilter]);

    async function moveAsset() {
        if (!moveTarget) return;
        try {
            const { asset } = await backend.adminPatchPublicAsset(moveTarget.id, { folder: moveFolder.trim() });
            setAssets((prev) => prev.map((a) => (a.id === asset.id ? asset : a)));
            message.success(moveFolder.trim() ? `已移动到「${moveFolder.trim()}」` : "已移出文件夹");
            setMoveTarget(null);
            setMoveFolder("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "移动失败");
        }
    }

    const pageAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filtered.slice(start, start + pageSize);
    }, [filtered, page, pageSize]);

    async function remove(asset: PublicAsset) {
        try {
            await backend.deletePublicAsset(asset.id);
            message.success("公共资产已删除");
            setAssets((prev) => prev.filter((a) => a.id !== asset.id));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    }

    function download(asset: PublicAsset) {
        saveAs(publicAssetFileUrl(asset), `${asset.title || "public-asset"}.${asset.filename.split(".").pop()}`);
    }

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="inline-flex items-center gap-2 text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">
                            <Globe2 className="size-8 text-sky-500" />
                            公共资产
                        </h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">所有用户共享的资产库。在「我的资产」中可将个人资产设为公共。{isAdmin ? "（管理员可删除）" : ""}</p>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder="搜索标题、标签、备注或发布者"
                            onChange={(event) => {
                                setPage(1);
                                setKeyword(event.target.value);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 flex max-w-6xl flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-stone-500 dark:text-stone-400">类型</span>
                        {kindOptions.map((option) => (
                            <Tag.CheckableTag
                                key={option.value}
                                checked={kindFilter === option.value}
                                className={cn("prompt-filter-tag", kindFilter === option.value && "is-active")}
                                onChange={() => {
                                    setPage(1);
                                    setKindFilter(option.value as PublicAsset["kind"] | "all");
                                }}
                            >
                                {option.label}
                            </Tag.CheckableTag>
                        ))}
                    </div>
                    <div className="mx-auto mt-2 flex max-w-6xl flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-stone-500 dark:text-stone-400">文件夹</span>
                        {[{ value: "all", label: "全部" }, { value: "none", label: "未分类" }, ...folders.map((name) => ({ value: name, label: `📁 ${name}` }))].map((option) => (
                            <Tag.CheckableTag
                                key={option.value}
                                checked={folderFilter === option.value}
                                className={cn("prompt-filter-tag", folderFilter === option.value && "is-active")}
                                onChange={() => {
                                    setPage(1);
                                    setFolderFilter(option.value);
                                }}
                            >
                                {option.label}
                            </Tag.CheckableTag>
                        ))}
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    {loading ? (
                        <div className="flex justify-center py-20">
                            <Spin size="large" />
                        </div>
                    ) : (
                        <>
                            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {pageAssets.map((asset) => (
                                    <Card
                                        key={asset.id}
                                        hoverable
                                        className="overflow-hidden"
                                        styles={{ body: { padding: 0 } }}
                                        cover={
                                            <button type="button" className="block w-full text-left" onClick={() => setPreviewAsset(asset)}>
                                                {asset.kind === "image" ? (
                                                    <img src={publicAssetFileUrl(asset)} alt={asset.title} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                                                ) : asset.kind === "video" ? (
                                                    <video src={publicAssetFileUrl(asset)} className="aspect-[4/3] w-full bg-black object-contain" muted preload="metadata" />
                                                ) : (
                                                    <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-300">文本资产</div>
                                                )}
                                            </button>
                                        }
                                    >
                                        <div className="p-4">
                                            <div className="flex items-start justify-between gap-3">
                                                <h2 className="line-clamp-1 text-sm font-semibold">{asset.title}</h2>
                                                <Tag className="m-0 shrink-0 text-[11px]">{kindLabel(asset.kind)}</Tag>
                                            </div>
                                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                                由 {asset.uploadedByName} 发布 · {new Date(asset.uploadedAt).toLocaleDateString("zh-CN")}
                                                {asset.folder ? ` · 📁 ${asset.folder}` : ""}
                                            </Typography.Text>
                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                {asset.tags.slice(0, 3).map((tag) => (
                                                    <Tag key={tag} className="m-0 text-[11px]">
                                                        {tag}
                                                    </Tag>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
                                            <Button size="small" onClick={() => setPreviewAsset(asset)}>
                                                查看
                                            </Button>
                                            <Button size="small" icon={<Download className="size-3.5" />} onClick={() => download(asset)}>
                                                下载
                                            </Button>
                                            {isAdmin ? (
                                                <>
                                                    <Button
                                                        size="small"
                                                        icon={<FolderInput className="size-3.5" />}
                                                        onClick={() => {
                                                            setMoveTarget(asset);
                                                            setMoveFolder(asset.folder || "");
                                                        }}
                                                    >
                                                        移动
                                                    </Button>
                                                    <Popconfirm title={`删除公共资产「${asset.title}」？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void remove(asset)}>
                                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                                                            删除
                                                        </Button>
                                                    </Popconfirm>
                                                </>
                                            ) : null}
                                        </div>
                                    </Card>
                                ))}
                            </div>

                            {!pageAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公共资产" className="py-20" /> : null}

                            <div className="flex justify-center">
                                <Pagination
                                    current={page}
                                    pageSize={pageSize}
                                    total={filtered.length}
                                    showSizeChanger
                                    pageSizeOptions={[12, 24, 48]}
                                    onChange={(nextPage, nextPageSize) => {
                                        setPage(nextPage);
                                        setPageSize(nextPageSize);
                                    }}
                                />
                            </div>
                        </>
                    )}
                </div>
            </main>

            <PublicAssetDrawer asset={previewAsset} isAdmin={isAdmin} onClose={() => setPreviewAsset(null)} onDownload={download} onDelete={(asset) => void remove(asset).then(() => setPreviewAsset(null))} />

            <Modal title={`移动「${moveTarget?.title ?? ""}」到文件夹`} open={Boolean(moveTarget)} onCancel={() => setMoveTarget(null)} onOk={() => void moveAsset()} okText="移动" cancelText="取消">
                <p className="mb-2 text-sm text-stone-500">选择已有文件夹或输入新名称；留空表示移出文件夹（未分类）。</p>
                <AutoComplete
                    value={moveFolder}
                    onChange={(v) => setMoveFolder(String(v ?? ""))}
                    options={folders.map((value) => ({ value }))}
                    placeholder="文件夹名称"
                    style={{ width: "100%" }}
                    filterOption={(input, option) => String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
                />
            </Modal>
        </div>
    );
}

function PublicAssetDrawer({ asset, isAdmin, onClose, onDownload, onDelete }: { asset: PublicAsset | null; isAdmin: boolean; onClose: () => void; onDownload: (asset: PublicAsset) => void; onDelete: (asset: PublicAsset) => void }) {
    const [textContent, setTextContent] = useState("");

    useEffect(() => {
        setTextContent("");
        if (asset?.kind === "text") {
            void fetchPublicAssetText(publicAssetFileUrl(asset))
                .then(setTextContent)
                .catch(() => setTextContent("（加载失败）"));
        }
    }, [asset]);

    return (
        <Drawer title="公共资产详情" open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {asset.kind === "image" ? (
                        <img src={publicAssetFileUrl(asset)} alt={asset.title} className="w-full rounded-lg" />
                    ) : asset.kind === "video" ? (
                        <video src={publicAssetFileUrl(asset)} controls className="aspect-video w-full rounded-lg bg-black" />
                    ) : (
                        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-700 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{textContent || "加载中…"}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{kindLabel(asset.kind)}</Tag>
                            {asset.tags.map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                        <Typography.Text type="secondary" className="mt-2 block text-xs">
                            由 {asset.uploadedByName} 发布于 {new Date(asset.uploadedAt).toLocaleString("zh-CN")}
                        </Typography.Text>
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">备注</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space>
                        <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                            下载
                        </Button>
                        {isAdmin ? (
                            <Popconfirm title={`删除公共资产「${asset.title}」？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => onDelete(asset)}>
                                <Button danger icon={<Trash2 className="size-4" />}>
                                    删除
                                </Button>
                            </Popconfirm>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}
