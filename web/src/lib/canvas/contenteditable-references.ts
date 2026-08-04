export function serializeContentEditable(editor: HTMLElement, referenceValue: (element: HTMLElement) => string | undefined) {
    return serializeNodes(editor.childNodes, referenceValue).replace(/\uFEFF/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>, referenceValue: (element: HTMLElement) => string | undefined) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const reference = referenceValue(node);
        if (reference !== undefined) result += reference;
        else if (node.tagName === "BR") result += "\n";
        else result += serializeNodes(node.childNodes, referenceValue);
    });
    return result;
}

export function insertReferenceAtSelection(editor: HTMLElement, chip: HTMLElement) {
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range) {
        range.insertNode(space);
        range.insertNode(chip);
        range.setStartAfter(space);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
    }
    editor.append(chip, space);
    placeCaretAtEnd(editor);
}

export function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const match = /@([^\s@]*)$/.exec(textBeforeCaret());
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

export function deleteAdjacentReference(key: string, referenceDataKey: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key, referenceDataKey);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string, referenceDataKey: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous, referenceDataKey);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, referenceDataKey, true);
}

function findReferenceSibling(node: Node, previous: boolean, referenceDataKey: string, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset[referenceDataKey] ? current : null;
}

export function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}
