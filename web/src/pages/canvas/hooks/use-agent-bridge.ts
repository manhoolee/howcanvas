import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { useAgentStore } from "@/stores/use-agent-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { buildAgentCanvasSelection } from "@/lib/agent/agent-selection";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasConnection, CanvasNodeData, ContextMenuState, ViewportTransform } from "@/types/canvas";
import type { ImageStyleDimensionGroup, ImageStyleDimensionSelection, ImageStyleSelection } from "@/types/image-style";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>;

type AgentBridgeParams = {
    projectId: string;
    title: string | undefined;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    generateNodeRef: GenerateNodeRef;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

/**
 * 画布与本地 Agent 的桥接：把当前画布快照与 apply/undo 能力发布到 agent store，
 * 供本地 Codex 面板读取。除 applyAgentOps（配置节点插件宿主会用到）外均为内部实现。
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { projectId, title, projectLoaded, nodes, connections, selectedNodeIds, viewport, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, generateNodeRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setViewport, setContextMenu } =
        params;
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const setAgentCanvasSelection = useAgentStore((state) => state.setCanvasSelection);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || "未命名画布";

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({ projectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }), [connections, projectTitle, nodes, projectId, selectedNodeIds, viewport]);
    const agentSelection = useMemo(() => (projectLoaded ? buildAgentCanvasSelection(projectId, nodes, selectedNodeIds) : { projectId, items: [] }), [nodes, projectId, projectLoaded, selectedNodeIds]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const styleOps: CanvasAgentOp[] = generationOps.flatMap((op) => {
                const imageStyle = imageStyleFromGenerationOp(op);
                return imageStyle ? [{ type: "update_node" as const, id: op.nodeId, metadata: { imageStyle, effectivePrompt: undefined, imageStyleSnapshot: undefined } }] : [];
            });
            const next = applyCanvasAgentOps(before, [...safeOps.filter((op) => op.type !== "run_generation"), ...styleOps]);
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            setAgentUndoSnapshot(before);
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            if (generationOps.length) {
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    }),
                );
            }
            return { ...next, projectId, title: projectTitle };
        },
        [projectTitle, projectId],
    );
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle };
    }, [agentUndoSnapshot, projectTitle, projectId]);

    useEffect(() => {
        setAgentCanvasContext({ snapshot: agentSnapshot, applyOps: applyAgentOps, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot) });
        return () => setAgentCanvasContext(null);
    }, [agentSnapshot, applyAgentOps, agentUndoSnapshot, setAgentCanvasContext, undoAgentOps]);

    useLayoutEffect(() => {
        setAgentCanvasSelection(agentSelection);
    }, [agentSelection, setAgentCanvasSelection]);

    useEffect(() => {
        return () => {
            const current = useAgentStore.getState().canvasSelection;
            if (current?.projectId === projectId) setAgentCanvasSelection(null);
        };
    }, [projectId, setAgentCanvasSelection]);

    return { applyAgentOps };
}

function imageStyleFromGenerationOp(op: Extract<CanvasAgentOp, { type: "run_generation" }>): ImageStyleSelection | undefined {
    const raw = op as unknown as Record<string, unknown>;
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
    const nested = raw.imageStyle && typeof raw.imageStyle === "object" && !Array.isArray(raw.imageStyle) ? (raw.imageStyle as Record<string, unknown>) : {};
    const pickString = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
    const pickNumber = (...values: unknown[]) => values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
    const pickBoolean = (...values: unknown[]) => values.find((value): value is boolean => typeof value === "boolean");
    const presetId = pickString(raw.stylePresetId, raw.presetId, raw.preset, nested.presetId, nested.preset);
    const genreId = pickString(raw.styleGenreId, raw.genreId, raw.genre, nested.genreId, nested.genre);
    const custom = pickString(raw.styleCustom, raw.customStyle, raw.custom, raw.customDescription, nested.custom, nested.customStyle, nested.customDescription);
    const rawIntensity = pickNumber(raw.styleIntensity, raw.intensity, raw.strength, nested.intensity, nested.strength);
    const intensity = rawIntensity == null ? undefined : Math.max(0, Math.min(1, rawIntensity > 1 ? rawIntensity / 100 : rawIntensity));
    const preserveSubject = pickBoolean(raw.preserveSubject, raw.stylePreserveSubject, nested.preserveSubject);
    const { dimensions, hasDimensionField } = normalizeImageStyleDimensions(raw, nested);
    const hasNested = hasOwn("imageStyle") && raw.imageStyle !== undefined;
    const hasFlat = [
        "stylePresetId",
        "styleGenreId",
        "styleIntensity",
        "preserveSubject",
        "styleCustom",
        "stylePreserveSubject",
        "presetId",
        "preset",
        "genreId",
        "genre",
        "intensity",
        "strength",
        "custom",
        "customStyle",
        "customDescription",
        "dimensions",
        "styleDimensions",
        ...IMAGE_STYLE_DIMENSION_GROUPS,
        ...IMAGE_STYLE_DIMENSION_GROUPS.map(styleDimensionAlias),
    ].some(hasOwn);
    if (!hasNested && !hasFlat) return undefined;
    return {
        ...nested,
        ...(presetId ? { presetId } : {}),
        ...(genreId ? { genreId } : {}),
        ...(intensity != null ? { intensity } : {}),
        ...(preserveSubject !== undefined ? { preserveSubject } : {}),
        ...(custom ? { custom } : {}),
        ...(hasDimensionField ? { dimensions } : {}),
    };
}

const IMAGE_STYLE_DIMENSION_GROUPS: readonly ImageStyleDimensionGroup[] = ["composition", "colorGrading", "lighting", "lens", "cameraMovement", "texture", "atmosphere", "editingRhythm"];

function styleDimensionAlias(group: ImageStyleDimensionGroup) {
    return `style${group.charAt(0).toUpperCase()}${group.slice(1)}`;
}

function asRecord(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown) {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
}

function normalizeImageStyleDimensions(...sources: Record<string, unknown>[]) {
    const dimensions: Partial<Record<ImageStyleDimensionGroup, readonly string[]>> = {};
    let hasDimensionField = false;
    const valuesByGroup = new Map<ImageStyleDimensionGroup, string[]>();
    const collect = (value: unknown, allowContainer = false) => {
        const record = asRecord(value);
        if (!record) return;
        if (allowContainer) {
            for (const key of ["dimensions", "styleDimensions"]) {
                if (Object.prototype.hasOwnProperty.call(record, key)) {
                    hasDimensionField = true;
                    collect(record[key]);
                }
            }
        }
        for (const group of IMAGE_STYLE_DIMENSION_GROUPS) {
            const alias = styleDimensionAlias(group);
            for (const key of [group, alias]) {
                if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
                hasDimensionField = true;
                const values = valuesByGroup.get(group) || [];
                values.push(...stringList(record[key]));
                valuesByGroup.set(group, values);
            }
        }
    };
    sources.forEach((source) => collect(source, true));
    IMAGE_STYLE_DIMENSION_GROUPS.forEach((group) => {
        const values = valuesByGroup.get(group) || [];
        const deduped = Array.from(new Set(values));
        if (deduped.length) dimensions[group] = deduped;
    });
    return { dimensions: dimensions as ImageStyleDimensionSelection, hasDimensionField };
}
