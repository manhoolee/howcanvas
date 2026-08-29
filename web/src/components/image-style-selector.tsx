import { useMemo, type ReactNode } from "react";
import { Button, Input, Select, Slider, Switch } from "antd";
import { RotateCcw, Sparkles } from "lucide-react";

import { IMAGE_STYLE_DIMENSIONS, IMAGE_STYLE_DIMENSION_GROUPS, IMAGE_STYLE_GENRES, IMAGE_STYLE_PRESETS } from "@/lib/image-style/catalog";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { cn } from "@/lib/utils";
import type { ImageStyleDimensionGroup, ImageStyleGenre, ImageStylePreset, ImageStyleSelection } from "@/types/image-style";

/**
 * The style selector deliberately owns no state.  Workbench and canvas nodes
 * can therefore share it while keeping their own persistence and undo logic.
 */
export type ImageStyleSelectorProps = {
    value: ImageStyleSelection;
    onChange: (value: ImageStyleSelection) => void;
    theme?: CanvasTheme;
    compact?: boolean;
    className?: string;
    disabled?: boolean;
    showTitle?: boolean;
    showCustom?: boolean;
    showDimensions?: boolean;
    presets?: readonly ImageStylePreset[];
    genres?: readonly ImageStyleGenre[];
};

type CatalogItem = ImageStylePreset | ImageStyleGenre;

export function ImageStyleSelector({
    value,
    onChange,
    theme,
    compact = false,
    className = "",
    disabled = false,
    showTitle = true,
    showCustom = true,
    showDimensions = true,
    presets = IMAGE_STYLE_PRESETS,
    genres = IMAGE_STYLE_GENRES,
}: ImageStyleSelectorProps) {
    const current = readSelection(value);
    const presetOptions = useMemo(() => buildOptions(presets, current.presetId), [current.presetId, presets]);
    const genreOptions = useMemo(() => buildOptions(genres, current.genreId), [current.genreId, genres]);
    const hasDimensionSelection = Object.values(current.dimensions).some((items) => items.length > 0);
    const hasSelection = Boolean(current.presetId || current.genreId || current.custom.trim() || hasDimensionSelection);
    const enabled = hasSelection && current.intensity > 0;
    const textStyle = theme ? { color: theme.node.text } : undefined;
    const mutedStyle = theme ? { color: theme.node.muted } : undefined;
    const borderStyle = theme ? { borderColor: theme.node.stroke } : undefined;
    const fieldStyle = theme ? { borderColor: theme.node.stroke, color: theme.node.text, background: theme.toolbar.panel } : undefined;
    // The canvas settings panel sits above the page stack (z-index 1200),
    // while Ant Design renders Select popups under <body> by default.
    const selectStyles = theme ? { popup: { root: { zIndex: 1301 } } } : undefined;
    const update = (patch: Partial<ImageStyleSelection>) => {
        const next = { ...value, ...patch };
        const nextDimensions = readDimensions(next);
        const nextHasDimensions = Object.values(nextDimensions).some((items) => items.length > 0);
        const nextHasStyle = Boolean(next.presetId || next.preset || next.genreId || next.genre || (typeof next.custom === "string" && next.custom.trim()) || nextHasDimensions);
        onChange(nextHasStyle ? next : { ...next, intensity: 0 });
    };
    const clear = () => {
        update({
            presetId: undefined,
            preset: undefined,
            genreId: undefined,
            genre: undefined,
            custom: "",
            dimensions: {},
            styleDimensions: {},
            composition: undefined,
            colorGrading: undefined,
            lighting: undefined,
            lens: undefined,
            cameraMovement: undefined,
            texture: undefined,
            atmosphere: undefined,
            editingRhythm: undefined,
            styleComposition: undefined,
            styleColorGrading: undefined,
            styleLighting: undefined,
            styleLens: undefined,
            styleCameraMovement: undefined,
            styleTexture: undefined,
            styleAtmosphere: undefined,
            styleEditingRhythm: undefined,
            intensity: 0,
            preserveSubject: current.preserveSubject,
        });
    };

    const updateDimension = (group: ImageStyleDimensionGroup, values: string[]) => {
        const dimensions = { ...current.dimensions };
        if (values.length) dimensions[group] = values;
        else delete dimensions[group];
        const alias = `style${group.charAt(0).toUpperCase()}${group.slice(1)}` as keyof ImageStyleSelection;
        update({ dimensions, styleDimensions: undefined, [group]: undefined, [alias]: undefined, ...(values.length && current.intensity === 0 ? { intensity: 0.6 } : {}) });
    };

    return (
        <div data-canvas-no-zoom className={cn("space-y-4", compact && "space-y-3", className)} style={textStyle} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
            {showTitle ? (
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <Sparkles className="size-4 shrink-0 opacity-70" />
                        <div className="truncate text-sm font-semibold">电影摄影</div>
                        {enabled ? <span className="text-[11px] opacity-55">已启用</span> : <span className="text-[11px] opacity-55">未启用</span>}
                    </div>
                    {hasSelection ? (
                        <Button type="text" size="small" disabled={disabled} icon={<RotateCcw className="size-3.5" />} onClick={clear}>
                            清除
                        </Button>
                    ) : null}
                </div>
            ) : null}

            <div className={cn("grid gap-4", compact ? "grid-cols-1 gap-3" : "sm:grid-cols-2")}>
                <StyleField label="摄影配方" hint="构图、光线、色彩和镜头">
                    <Select
                        className="w-full"
                        disabled={disabled}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        styles={selectStyles}
                        placeholder="选择电影感风格"
                        value={current.presetId}
                        options={presetOptions}
                        onChange={(next) => update({ presetId: next || undefined, preset: undefined, ...(next && current.intensity === 0 ? { intensity: 0.6 } : {}) })}
                        onClear={() => update({ presetId: undefined, preset: undefined })}
                    />
                </StyleField>
                <StyleField label="影片类型" hint="为摄影语言提供语境">
                    <Select
                        className="w-full"
                        disabled={disabled}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        styles={selectStyles}
                        placeholder="选择类型（可选）"
                        value={current.genreId}
                        options={genreOptions}
                        onChange={(next) => update({ genreId: next || undefined, genre: undefined, ...(next && current.intensity === 0 ? { intensity: 0.6 } : {}) })}
                        onClear={() => update({ genreId: undefined, genre: undefined })}
                    />
                </StyleField>
            </div>

            {showDimensions ? (
                <div className={cn("grid gap-4", compact ? "grid-cols-1 gap-3" : "sm:grid-cols-2")}>
                    {IMAGE_STYLE_DIMENSION_GROUPS.map((group) => (
                        <StyleField key={group.id} label={group.label} hint={group.hint}>
                            <Select
                                className="w-full"
                                disabled={disabled}
                                allowClear
                                showSearch
                                mode="multiple"
                                maxTagCount={compact ? 1 : 2}
                                maxTagTextLength={compact ? 10 : 16}
                                optionFilterProp="label"
                                styles={selectStyles}
                                placeholder={`选择${group.label}（可多选）`}
                                value={current.dimensions[group.id] || []}
                                options={IMAGE_STYLE_DIMENSIONS[group.id].map((item) => ({ value: item.id, label: item.label, title: item.prompt }))}
                                onChange={(next) => updateDimension(group.id, Array.isArray(next) ? next.filter((item): item is string => typeof item === "string") : [])}
                            />
                        </StyleField>
                    ))}
                </div>
            ) : null}

            <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                    <StyleLabel color={mutedStyle?.color}>风格强度</StyleLabel>
                    <span className="text-xs tabular-nums opacity-70">{Math.round(current.intensity * 100)}%</span>
                </div>
                <Slider
                    disabled={disabled || !hasSelection}
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(current.intensity * 100)}
                    tooltip={{ formatter: (input) => `${input ?? 0}%` }}
                    onChange={(next) => {
                        const percent = Array.isArray(next) ? next[0] : next;
                        update({ intensity: normalizeIntensity(Number(percent) / 100) });
                    }}
                />
                <div className="flex justify-between text-[11px] opacity-50">
                    <span>仅轻微参考</span>
                    <span>完整摄影语言</span>
                </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5" style={borderStyle}>
                <div className="min-w-0">
                    <StyleLabel color={textStyle?.color}>保持主体和构图</StyleLabel>
                    <div className="mt-0.5 truncate text-[11px] opacity-55">风格只补充摄影语言，不改写主体</div>
                </div>
                <Switch disabled={disabled} size="small" checked={current.preserveSubject} onChange={(checked) => update({ preserveSubject: checked })} />
            </div>

            {showCustom ? (
                <StyleField label="自定义摄影描述" hint="可补充胶片、镜头或光线要求">
                    <Input.TextArea
                        disabled={disabled}
                        value={current.custom}
                        rows={compact ? 2 : 3}
                        maxLength={500}
                        showCount
                        placeholder="例如：35mm 胶片颗粒、雨后湿润反光、低饱和暖肤色"
                        style={fieldStyle}
                        onChange={(event) => {
                            const custom = event.target.value;
                            update({ custom, ...(custom.trim() && current.intensity === 0 ? { intensity: 0.6 } : {}) });
                        }}
                    />
                </StyleField>
            ) : null}
        </div>
    );
}

function StyleField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="min-w-0 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
                <StyleLabel>{label}</StyleLabel>
                {hint ? <span className="truncate text-[11px] opacity-50">{hint}</span> : null}
            </div>
            {children}
        </div>
    );
}

function StyleLabel({ children, color }: { children: ReactNode; color?: string }) {
    return (
        <div className="text-xs font-medium" style={color ? { color } : undefined}>
            {children}
        </div>
    );
}

function readSelection(value: ImageStyleSelection) {
    const presetId = firstText(value.presetId, value.preset);
    const genreId = firstText(value.genreId, value.genre);
    const custom = typeof value.custom === "string" ? value.custom : "";
    const dimensions = readDimensions(value);
    const hasStyle = Boolean(presetId || genreId || custom.trim() || Object.values(dimensions).some((items) => items.length > 0));
    // Keep the UI aligned with the compiler: an explicitly omitted intensity
    // means full strength whenever a style is selected.
    const intensity = value.intensity ?? (hasStyle ? 1 : 0);
    return {
        presetId,
        genreId,
        intensity: hasStyle ? normalizeIntensity(Number(intensity)) : 0,
        preserveSubject: value.preserveSubject !== false,
        custom,
        dimensions,
    };
}

function readDimensions(value: ImageStyleSelection) {
    const nestedValues = [value.dimensions, value.styleDimensions].filter((item): item is NonNullable<ImageStyleSelection["dimensions"]> => Boolean(item && typeof item === "object"));
    const result: Partial<Record<ImageStyleDimensionGroup, string[]>> = {};
    for (const group of IMAGE_STYLE_DIMENSION_GROUPS) {
        const alias = `style${group.id.charAt(0).toUpperCase()}${group.id.slice(1)}` as keyof ImageStyleSelection;
        const raw = [...nestedValues.map((nested) => nested[group.id]), value[group.id], value[alias]];
        const values = raw.flatMap((item) => (Array.isArray(item) ? item : typeof item === "string" ? [item] : [])).filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
        if (values.length) result[group.id] = [...new Set(values.map((item) => item.trim()))];
    }
    return result;
}

function firstText(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function buildOptions(items: readonly CatalogItem[], currentId?: string) {
    const options = items.map((item) => ({ value: catalogId(item), label: catalogLabel(item), title: catalogDescription(item) }));
    if (currentId && !options.some((item) => item.value === currentId)) options.unshift({ value: currentId, label: currentId, title: "当前风格" });
    return options.filter((item) => item.value);
}

function catalogRecord(item: CatalogItem) {
    return item as unknown as Record<string, unknown>;
}

function catalogId(item: CatalogItem) {
    const record = catalogRecord(item);
    return String(record.id ?? record.value ?? "");
}

function catalogLabel(item: CatalogItem) {
    const record = catalogRecord(item);
    return String(record.label ?? record.name ?? record.title ?? catalogId(item));
}

function catalogDescription(item: CatalogItem) {
    const record = catalogRecord(item);
    const description = record.description ?? record.summary ?? record.inspiration;
    return typeof description === "string" ? description : undefined;
}

function normalizeIntensity(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}
