import { nanoid } from "nanoid";

import { getNodeSpec, isRegisteredNodeType } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type ViewportTransform } from "@/types/canvas";
import type { ImageStyleDimensionGroup, ImageStyleDimensionSelection, ImageStyleDimensionValue, ImageStyleSelection } from "@/types/image-style";

export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeTypeId; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string }
    | { type: "set_viewport"; viewport: ViewportTransform }
    | { type: "select_nodes"; ids: string[] }
    | {
          type: "run_generation";
          nodeId: string;
          mode?: "text" | "image" | "video" | "audio";
          prompt?: string;
          imageStyle?: ImageStyleSelection;
          // Flat aliases are accepted for Agent/MCP callers; the bridge
          // normalizes them to imageStyle before invoking generation.
          stylePresetId?: string;
          styleGenreId?: string;
          styleIntensity?: number;
          preserveSubject?: boolean;
          styleCustom?: string;
          stylePreserveSubject?: boolean;
          preset?: string;
          genre?: string;
          presetId?: string;
          genreId?: string;
          intensity?: number;
          strength?: number;
          custom?: string;
          customStyle?: string;
          customDescription?: string;
          dimensions?: ImageStyleDimensionSelection;
          styleDimensions?: ImageStyleDimensionSelection;
          composition?: ImageStyleDimensionValue;
          colorGrading?: ImageStyleDimensionValue;
          lighting?: ImageStyleDimensionValue;
          lens?: ImageStyleDimensionValue;
          cameraMovement?: ImageStyleDimensionValue;
          texture?: ImageStyleDimensionValue;
          atmosphere?: ImageStyleDimensionValue;
          editingRhythm?: ImageStyleDimensionValue;
          styleComposition?: ImageStyleDimensionValue;
          styleColorGrading?: ImageStyleDimensionValue;
          styleLighting?: ImageStyleDimensionValue;
          styleLens?: ImageStyleDimensionValue;
          styleCameraMovement?: ImageStyleDimensionValue;
          styleTexture?: ImageStyleDimensionValue;
          styleAtmosphere?: ImageStyleDimensionValue;
          styleEditingRhythm?: ImageStyleDimensionValue;
      };

export type CanvasAgentSnapshot = {
    projectId: string;
    title: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: string[];
    viewport: ViewportTransform;
};

export function summarizeCanvasAgentOps(ops?: CanvasAgentOp[]) {
    const counts = (Array.isArray(ops) ? ops : []).reduce<Record<string, number>>((acc, op) => {
        if (!op?.type) return acc;
        acc[op.type] = (acc[op.type] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .map(([type, count]) => `${opLabel(type)} ${count}`)
        .join("，");
}

export function applyCanvasAgentOps(snapshot: CanvasAgentSnapshot, ops?: CanvasAgentOp[]) {
    let nodes = snapshot.nodes;
    let connections = snapshot.connections;
    let selectedNodeIds = snapshot.selectedNodeIds;
    let viewport = snapshot.viewport;

    (Array.isArray(ops) ? ops : []).forEach((op, index) => {
        if (!op?.type) return;
        if (op.type === "add_node") {
            const nodeType = op.nodeType && isRegisteredNodeType(op.nodeType) ? op.nodeType : CanvasNodeType.Text;
            const spec = getNodeSpec(nodeType);
            const node: CanvasNodeData = {
                id: op.id || `${nodeType}-${Date.now()}-${index}`,
                type: nodeType,
                title: op.title || spec.title,
                position: op.position || { x: op.x ?? index * 36, y: op.y ?? index * 36 },
                width: op.width || spec.width,
                height: op.height || spec.height,
                metadata: { ...spec.metadata, ...op.metadata },
            };
            nodes = [...nodes, node];
            selectedNodeIds = [node.id];
        }
        if (op.type === "update_node") {
            if (!op.id) return;
            nodes = nodes.map((node) => {
                if (node.id !== op.id) return node;
                const metadataPatch = { ...op.patch?.metadata, ...op.metadata };
                return { ...node, ...op.patch, metadata: mergeCanvasNodeMetadata(node.metadata, metadataPatch) };
            });
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            nodes = nodes.filter((node) => !ids.has(node.id));
            connections = connections.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId));
            selectedNodeIds = selectedNodeIds.filter((id) => !ids.has(id));
        }
        if (op.type === "delete_connections") {
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            connections = op.all ? [] : connections.filter((conn) => !ids.has(conn.id));
        }
        if (op.type === "connect_nodes") {
            if (!op.fromNodeId || !op.toNodeId) return;
            const exists = connections.some((conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId);
            const hasNodes = nodes.some((node) => node.id === op.fromNodeId) && nodes.some((node) => node.id === op.toNodeId);
            if (!exists && hasNodes) connections = [...connections, { id: op.id || nanoid(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId }];
        }
        if (op.type === "set_viewport" && op.viewport) viewport = op.viewport;
        if (op.type === "select_nodes") selectedNodeIds = (op.ids || []).filter((id) => nodes.some((node) => node.id === id));
    });

    return { ...snapshot, nodes, connections, selectedNodeIds, viewport };
}

/**
 * Merge metadata patches while invalidating provider-facing prompt fields when
 * their source inputs (prompt/composer/style) change.  Both Agent operations
 * and plugin host updates use this boundary so a stale compiled prompt cannot
 * survive a user edit and be appended again on retry.
 */
export function mergeCanvasNodeMetadata(current: CanvasNodeMetadata | undefined, patch: CanvasNodeMetadata) {
    const normalizedPatch = normalizeCanvasStyleMetadataPatch(current, patch);
    const record = normalizedPatch as Record<string, unknown>;
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(record, key);
    const composerChanged = hasOwn("composerContent");
    const promptFieldChanged = hasOwn("prompt");
    const sourcePromptChanged = hasOwn("sourcePrompt");
    const promptChanged = promptFieldChanged || composerChanged || sourcePromptChanged;
    const styleChanged = ["imageStyle", "stylePresetId", "styleGenreId", "styleIntensity", "preserveSubject", "styleCustom", "dimensions", "styleDimensions", ...IMAGE_STYLE_DIMENSION_GROUPS, ...IMAGE_STYLE_DIMENSION_GROUPS.map(styleDimensionAlias)].some(
        hasOwn,
    );
    const next: CanvasNodeMetadata = { ...current, ...normalizedPatch };

    // A source/style edit makes the previously compiled provider prompt and
    // immutable recipe snapshot stale.  Explicit values supplied by an
    // advanced Agent operation still win.
    if ((promptChanged || styleChanged) && !hasOwn("effectivePrompt")) next.effectivePrompt = undefined;
    if ((promptChanged || styleChanged) && !hasOwn("imageStyleSnapshot")) next.imageStyleSnapshot = undefined;
    if (promptChanged && !hasOwn("sourcePrompt")) next.sourcePrompt = undefined;
    if (promptChanged && !hasOwn("effectivePrompt")) {
        // Do not leave two competing source representations behind.  A
        // prompt-only Agent edit should not be shadowed by old composer
        // tokens, and a composer edit should not fall back to old metadata.prompt.
        if (composerChanged && !promptFieldChanged) next.prompt = undefined;
        if (promptFieldChanged && !composerChanged) next.composerContent = undefined;
    }
    return next;
}

const IMAGE_STYLE_DIMENSION_GROUPS: readonly ImageStyleDimensionGroup[] = ["composition", "colorGrading", "lighting", "lens", "cameraMovement", "texture", "atmosphere", "editingRhythm"];

const IMAGE_STYLE_DIMENSION_METADATA_KEYS = ["dimensions", "styleDimensions", ...IMAGE_STYLE_DIMENSION_GROUPS, ...IMAGE_STYLE_DIMENSION_GROUPS.map(styleDimensionAlias)] as const;

const IMAGE_STYLE_LEGACY_METADATA_KEYS = [
    "preset",
    "presetId",
    "genre",
    "genreId",
    "intensity",
    "strength",
    "custom",
    "customStyle",
    "customDescription",
    "preserveSubject",
    "stylePreserveSubject",
    "stylePresetId",
    "styleGenreId",
    "styleIntensity",
    "styleCustom",
    ...IMAGE_STYLE_DIMENSION_METADATA_KEYS,
] as const;

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

function canonicalDimensionSource(record: Record<string, unknown>) {
    const hasContainer = ["dimensions", "styleDimensions"].some((key) => Object.prototype.hasOwnProperty.call(record, key));
    return hasContainer ? { dimensions: record.dimensions, styleDimensions: record.styleDimensions } : record;
}

function normalizeImageStyleDimensions(...sources: Record<string, unknown>[]) {
    const dimensions: Partial<Record<ImageStyleDimensionGroup, readonly string[]>> = {};
    const valuesByGroup = new Map<ImageStyleDimensionGroup, string[]>();
    let hasDimensionField = false;
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
        const values = Array.from(new Set(valuesByGroup.get(group) || []));
        if (values.length) dimensions[group] = values;
    });
    return { dimensions: dimensions as ImageStyleDimensionSelection, hasDimensionField };
}

function normalizeCanvasStyleMetadataPatch(current: CanvasNodeMetadata | undefined, patch: CanvasNodeMetadata) {
    const patchRecord = patch as Record<string, unknown>;
    const currentRecord = (current || {}) as Record<string, unknown>;
    const hasImageStyleField = Object.prototype.hasOwnProperty.call(patchRecord, "imageStyle");
    const nestedPatch = asRecord(patchRecord.imageStyle);
    const currentStyle = asRecord(currentRecord.imageStyle);
    const styleKeys = ["stylePresetId", "styleGenreId", "styleIntensity", "preserveSubject", "styleCustom", "preset", "genre", "presetId", "genreId", "intensity", "custom", "customStyle", "customDescription", "stylePreserveSubject", "strength"];
    const hasStyleField = hasImageStyleField || styleKeys.some((key) => Object.prototype.hasOwnProperty.call(patchRecord, key)) || Boolean(nestedPatch);
    const { dimensions, hasDimensionField } = normalizeImageStyleDimensions(patchRecord, nestedPatch || {});
    if (!hasStyleField && !hasDimensionField) return patch;

    // Treat an explicit null/undefined imageStyle as a recipe clear. Remove
    // legacy root dimension aliases too, otherwise a later retry can revive
    // a supposedly cleared option from stale metadata.
    if (hasImageStyleField && !nestedPatch && !hasDimensionField) {
        const cleared = { ...patch, imageStyle: undefined } as Record<string, unknown>;
        IMAGE_STYLE_LEGACY_METADATA_KEYS.forEach((key) => {
            cleared[key] = undefined;
        });
        return cleared as CanvasNodeMetadata;
    }

    const style: Record<string, unknown> = { ...(currentStyle || {}), ...(nestedPatch || {}) };
    const pickString = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
    const pickNumber = (...values: unknown[]) => values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
    const pickBoolean = (...values: unknown[]) => values.find((value): value is boolean => typeof value === "boolean");
    const hasAny = (...keys: string[]) => keys.some((key) => Object.prototype.hasOwnProperty.call(patchRecord, key) || Boolean(nestedPatch && Object.prototype.hasOwnProperty.call(nestedPatch, key)));
    if (hasAny("stylePresetId", "presetId", "preset")) {
        const value = pickString(patchRecord.stylePresetId, patchRecord.presetId, nestedPatch?.presetId, nestedPatch?.preset);
        style.presetId = value;
    } else {
        style.presetId = pickString(style.presetId, style.preset);
    }
    delete style.preset;
    delete style.stylePresetId;
    if (hasAny("styleGenreId", "genreId", "genre")) {
        const value = pickString(patchRecord.styleGenreId, patchRecord.genreId, nestedPatch?.genreId, nestedPatch?.genre);
        style.genreId = value;
    } else {
        style.genreId = pickString(style.genreId, style.genre);
    }
    delete style.genre;
    delete style.styleGenreId;
    if (hasAny("styleIntensity", "intensity", "strength")) {
        const value = pickNumber(patchRecord.styleIntensity, patchRecord.intensity, nestedPatch?.intensity, nestedPatch?.strength);
        style.intensity = value == null ? undefined : Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
    } else {
        const value = pickNumber(style.intensity, style.strength);
        style.intensity = value == null ? undefined : Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
    }
    delete style.strength;
    delete style.styleIntensity;
    if (hasAny("preserveSubject", "stylePreserveSubject")) {
        style.preserveSubject = pickBoolean(patchRecord.preserveSubject, patchRecord.stylePreserveSubject, nestedPatch?.preserveSubject);
    } else {
        style.preserveSubject = pickBoolean(style.preserveSubject, style.stylePreserveSubject);
    }
    delete style.stylePreserveSubject;
    if (hasAny("styleCustom", "customStyle", "custom", "customDescription")) {
        style.custom = pickString(patchRecord.styleCustom, patchRecord.customStyle, patchRecord.custom, nestedPatch?.custom, nestedPatch?.customDescription);
    } else {
        style.custom = pickString(style.custom, style.customStyle, style.customDescription);
    }
    delete style.customStyle;
    delete style.customDescription;
    delete style.styleCustom;
    if (hasDimensionField) {
        // Once a caller supplies a dimension container (including an empty
        // object to clear it), the nested canonical representation is the
        // source of truth. Remove legacy flat aliases inherited from the
        // current node so a cleared option cannot be reintroduced by the
        // prompt compiler on the next retry.
        for (const group of IMAGE_STYLE_DIMENSION_GROUPS) {
            delete style[group];
            delete style[styleDimensionAlias(group)];
        }
        style.dimensions = dimensions;
        delete style.styleDimensions;
    } else {
        const currentDimensions = normalizeImageStyleDimensions(canonicalDimensionSource(currentStyle || {})).dimensions;
        if (Object.keys(currentDimensions).length) style.dimensions = currentDimensions;
        for (const group of IMAGE_STYLE_DIMENSION_GROUPS) {
            delete style[group];
            delete style[styleDimensionAlias(group)];
        }
        delete style.styleDimensions;
    }

    const normalized = { ...patch, imageStyle: style as ImageStyleSelection } as Record<string, unknown>;
    if (hasStyleField || hasDimensionField) {
        // The nested canonical field is now the sole source of truth. Clear
        // all legacy root aliases so removing imageStyle later cannot revive
        // an old recipe or dimension.
        IMAGE_STYLE_LEGACY_METADATA_KEYS.forEach((key) => {
            normalized[key] = undefined;
        });
    }
    return normalized as CanvasNodeMetadata;
}

function opLabel(type: string) {
    if (type === "add_node") return "新增节点";
    if (type === "update_node") return "更新节点";
    if (type === "delete_node") return "删除节点";
    if (type === "delete_connections") return "删除连线";
    if (type === "connect_nodes") return "连接";
    if (type === "set_viewport") return "调整视图";
    if (type === "select_nodes") return "选择节点";
    if (type === "run_generation") return "触发生成";
    return type;
}
