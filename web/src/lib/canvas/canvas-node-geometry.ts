import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

export type NodeAlignment = "left" | "right" | "top" | "bottom" | "horizontal-center" | "vertical-center";

export function alignCanvasNodes(nodes: CanvasNodeData[], selectedIds: Set<string>, alignment: NodeAlignment) {
    const children = new Map<string, Set<string>>();
    for (const node of nodes) {
        const childIds = children.get(node.id) ?? new Set<string>();
        node.metadata?.batchChildIds?.forEach((id) => childIds.add(id));
        children.set(node.id, childIds);
        if (node.metadata?.groupId) {
            const siblings = children.get(node.metadata.groupId) ?? new Set<string>();
            siblings.add(node.id);
            children.set(node.metadata.groupId, siblings);
        }
    }
    const descendants = (id: string) => {
        const ids = new Set<string>();
        const pending = [...(children.get(id) ?? [])];
        while (pending.length) {
            const childId = pending.pop()!;
            if (childId === id || ids.has(childId)) continue;
            ids.add(childId);
            pending.push(...(children.get(childId) ?? []));
        }
        return ids;
    };
    // A selected group or batch moves as one unit, including selected descendants.
    const selected = nodes.filter((node) => selectedIds.has(node.id));
    const childIds = new Set(selected.flatMap((node) => [...descendants(node.id)]));
    const roots = selected.filter((node) => !childIds.has(node.id));
    if (roots.length < 2) return nodes;
    const bounds = nodeBounds(roots);
    const offsets = new Map<string, { x: number; y: number }>();
    for (const node of roots) {
        const x = alignment === "left" ? bounds.left : alignment === "right" ? bounds.right - node.width : alignment === "horizontal-center" ? (bounds.left + bounds.right - node.width) / 2 : node.position.x;
        const y = alignment === "top" ? bounds.top : alignment === "bottom" ? bounds.bottom - node.height : alignment === "vertical-center" ? (bounds.top + bounds.bottom - node.height) / 2 : node.position.y;
        const offset = { x: x - node.position.x, y: y - node.position.y };
        offsets.set(node.id, offset);
        descendants(node.id).forEach((id) => offsets.set(id, offset));
    }
    if (![...offsets.values()].some(({ x, y }) => x || y)) return nodes;
    return nodes.map((node) => {
        const offset = offsets.get(node.id);
        return offset && (offset.x || offset.y) ? { ...node, position: { x: node.position.x + offset.x, y: node.position.y + offset.y } } : node;
    });
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group)) return null;
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    return (
        [...nodes].reverse().find((group) => {
            if (group.type !== CanvasNodeType.Group || movedIds.has(group.id)) return false;
            return movingNodes.some((node) => {
                const centerX = node.position.x + node.width / 2;
                const centerY = node.position.y + node.height / 2;
                return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
            });
        }) || null
    );
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return (
        [...nodes]
            .reverse()
            .find((group) => group.type === CanvasNodeType.Group && group.id !== node.id && centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height)?.id ||
        undefined
    );
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Group || second.type === CanvasNodeType.Group) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

export function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}
