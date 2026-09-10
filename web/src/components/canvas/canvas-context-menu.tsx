import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlignStartVertical, AlignEndVertical, AlignStartHorizontal, AlignEndHorizontal, AlignCenterVertical, AlignCenterHorizontal, Plus, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "@/types/canvas";
import type { NodeAlignment } from "@/lib/canvas/canvas-node-geometry";

const alignments = [
    { value: "left", label: "左对齐", icon: AlignStartVertical },
    { value: "right", label: "右对齐", icon: AlignEndVertical },
    { value: "top", label: "顶对齐", icon: AlignStartHorizontal },
    { value: "bottom", label: "底对齐", icon: AlignEndHorizontal },
    { value: "horizontal-center", label: "水平居中", icon: AlignCenterVertical },
    { value: "vertical-center", label: "垂直居中", icon: AlignCenterHorizontal },
] as const;

export function CanvasNodeContextMenu({ menu, onClose, onDuplicate, onDelete, onAlign }: { menu: ContextMenuState; onClose: () => void; onDuplicate: () => void; onDelete: () => void; onAlign: (alignment: NodeAlignment) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

    useLayoutEffect(() => {
        const place = () => {
            const rect = menuRef.current?.getBoundingClientRect();
            if (rect) setPosition({ x: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8)) });
        };
        place();
        window.addEventListener("resize", place);
        return () => window.removeEventListener("resize", place);
    }, [menu]);

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        const keyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("pointerdown", close);
        window.addEventListener("keydown", keyDown);
        return () => {
            window.removeEventListener("pointerdown", close);
            window.removeEventListener("keydown", keyDown);
        };
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            role="menu"
            aria-label="画布右键菜单"
            className="fixed z-[80] min-w-44 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-lg border py-1 shadow-2xl"
            style={{ left: position.x, top: position.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            {menu.type === "selection" ? <>
                {alignments.map(({ value, label, icon: Icon }) => <MenuButton key={value} icon={<Icon className="size-4" />} label={label} onClick={() => onAlign(value)} />)}
                <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />
            </> : null}
            {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label="复制" onClick={onDuplicate} /> : null}
            <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={onDelete} danger />
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
