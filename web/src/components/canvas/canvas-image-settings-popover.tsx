import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2, Sparkles } from "lucide-react";
import { Button } from "antd";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { ImageStyleSelector } from "@/components/image-style-selector";
import { canvasThemes } from "@/lib/canvas-theme";
import { DEFAULT_IMAGE_STYLE_SELECTION } from "@/lib/image-style";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ImageStyleSelection, ImageStyleSnapshot } from "@/types/image-style";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    imageStyle?: ImageStyleSelection;
    imageStyleSnapshot?: ImageStyleSnapshot;
    onImageStyleChange?: (selection: ImageStyleSelection) => void;
    /** Keep the legacy Config node usage working while image nodes use a separate style control. */
    showStyle?: boolean;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onImageStyleChange, imageStyle, imageStyleSnapshot, onOpenChange, buttonClassName, placement = "topLeft", showStyle = true }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            // Ant Design renders Select menus under <body>, outside panelRef.
            // Treat them as part of this popover so selecting a style does not
            // trigger the capture-phase outside-click handler first.
            if (target instanceof Element && target.closest(".ant-select-dropdown")) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
            onOpenChange?.(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [onOpenChange, open]);

    const panel =
        open && buttonRect ? (
            <ImageSettingsPortal
                buttonRect={buttonRect}
                panelRef={panelRef}
                placement={placement}
                theme={theme}
                config={config}
                onConfigChange={onConfigChange}
                showStyle={showStyle}
                imageStyle={imageStyle}
                imageStyleSnapshot={imageStyleSnapshot}
                onImageStyleChange={onImageStyleChange}
            />
        ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    icon={<Settings2 className="size-3.5" />}
                    onClick={() => updateOpen(!open)}
                >
                    <span className="truncate">
                        {imageQualityLabel(quality)} · {imageSizeLabel(activeSize)} · {count} 张
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

/**
 * Standalone cinematography control for the canvas prompt toolbar. Technical
 * image settings and visual direction stay in separate popovers so a style
 * can be chosen without opening the parameter panel.
 */
export function CanvasImageStylePopover({
    imageStyle,
    imageStyleSnapshot,
    onImageStyleChange,
    onOpenChange,
    buttonClassName,
    placement = "topLeft",
}: {
    imageStyle?: ImageStyleSelection;
    imageStyleSnapshot?: ImageStyleSnapshot;
    onImageStyleChange: (selection: ImageStyleSelection) => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    placement?: CanvasImageSettingsPopoverProps["placement"];
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    // A present selection is authoritative.  Do not let an older snapshot
    // keep the toolbar highlighted after the user explicitly set intensity
    // to zero or cleared the recipe.
    const active = imageStyle !== undefined ? hasImageStyle(imageStyle) : hasImageStyle(snapshotSelection(imageStyleSnapshot));
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (target instanceof Element && target.closest(".ant-select-dropdown")) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
            onOpenChange?.(false);
        };
        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [onOpenChange, open]);

    const panel = open && buttonRect ? <ImageStylePortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} imageStyle={imageStyle} imageStyleSnapshot={imageStyleSnapshot} onImageStyleChange={onImageStyleChange} /> : null;
    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    data-canvas-style-control="true"
                    aria-label={active ? "电影风格（已启用）" : "电影风格"}
                    aria-pressed={active}
                    title={active ? "电影风格（已启用）" : "电影风格（未启用）"}
                    className={buttonClassName || "!h-8 !max-w-[150px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: active ? theme.toolbar.activeBg : "transparent", color: active ? theme.toolbar.activeText : theme.node.text }}
                    icon={<Sparkles className="size-3.5" />}
                    onClick={() => updateOpen(!open)}
                >
                    <span className="truncate">电影风格{active ? " · 已启用" : ""}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function ImageSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    showStyle,
    imageStyle,
    imageStyleSnapshot,
    onImageStyleChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    showStyle: boolean;
    imageStyle?: ImageStyleSelection;
    imageStyleSnapshot?: ImageStyleSnapshot;
    onImageStyleChange?: (selection: ImageStyleSelection) => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div ref={panelRef} className="canvas-image-settings-popover" style={style} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
            {showStyle && onImageStyleChange ? (
                <>
                    <div className="my-4 border-t" style={{ borderColor: theme.node.stroke }} />
                    <ImageStyleSelector compact value={imageStyle || snapshotSelection(imageStyleSnapshot) || DEFAULT_IMAGE_STYLE_SELECTION} onChange={onImageStyleChange} theme={theme} />
                </>
            ) : null}
        </div>,
        document.body,
    );
}

function ImageStylePortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    imageStyle,
    imageStyleSnapshot,
    onImageStyleChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    imageStyle?: ImageStyleSelection;
    imageStyleSnapshot?: ImageStyleSnapshot;
    onImageStyleChange: (selection: ImageStyleSelection) => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div ref={panelRef} className="canvas-image-style-popover" style={style} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <ImageStyleSelector compact value={imageStyle || snapshotSelection(imageStyleSnapshot) || DEFAULT_IMAGE_STYLE_SELECTION} onChange={onImageStyleChange} theme={theme} />
        </div>,
        document.body,
    );
}

function snapshotSelection(snapshot?: ImageStyleSnapshot): ImageStyleSelection | undefined {
    if (!snapshot) return undefined;
    return {
        ...(snapshot.presetId ? { presetId: snapshot.presetId } : {}),
        ...(snapshot.genreId ? { genreId: snapshot.genreId } : {}),
        intensity: snapshot.intensity,
        preserveSubject: snapshot.preserveSubject,
        ...(snapshot.custom ? { custom: snapshot.custom } : {}),
        ...(snapshot.dimensions ? { dimensions: snapshot.dimensions } : {}),
    };
}

function hasImageStyle(selection?: ImageStyleSelection) {
    if (!selection || selection.intensity === 0) return false;
    if (selection.presetId || selection.preset || selection.genreId || selection.genre || selection.custom?.trim()) return true;
    const dimensionKeys = ["composition", "colorGrading", "lighting", "lens", "cameraMovement", "texture", "atmosphere", "editingRhythm", "styleComposition", "styleColorGrading", "styleLighting", "styleLens", "styleCameraMovement", "styleTexture", "styleAtmosphere", "styleEditingRhythm"] as const;
    if (dimensionKeys.some((key) => (Array.isArray(selection[key]) && selection[key].length > 0) || (typeof selection[key] === "string" && selection[key].trim().length > 0))) return true;
    const dimensions = [selection.dimensions, selection.styleDimensions].filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
    return (
        Object.values(selection).some((value) => (Array.isArray(value) ? value.length > 0 : false)) ||
        dimensions.some((value) => Object.values(value).some((items) => (Array.isArray(items) ? items.length > 0 : typeof items === "string" && items.trim().length > 0)))
    );
}
