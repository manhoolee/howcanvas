import React from "react";
import DOMPurify from "dompurify";

import { emitCanvasEvent, onCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import type { CanvasPluginApp } from "@/types/canvas-plugin";

// 插件运行时:远程插件通过它拿到宿主的 React 实例,避免多份 React 实例
export type PluginRuntime = CanvasPluginApp & {
    React: typeof React;
    jsx: typeof React.createElement;
    Fragment: typeof React.Fragment;
    injectCSS: (css: string, key?: string) => () => void;
    sanitizeHTML: (value: string, profile?: "html" | "svg") => string;
};

let runtime: PluginRuntime | null = null;

// 注入插件样式:同 key 覆盖旧样式,返回移除函数
function injectCSS(css: string, key?: string) {
    const id = key ? `canvas-plugin-style-${key}` : undefined;
    if (id) document.getElementById(id)?.remove();
    const style = document.createElement("style");
    if (id) style.id = id;
    style.dataset.canvasPluginStyle = "true";
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
}

function sanitizeHTML(value: string, profile: "html" | "svg" = "html") {
    if (profile === "svg") {
        return String(DOMPurify.sanitize(value, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["script", "foreignObject"] }));
    }
    return String(DOMPurify.sanitize(value, { USE_PROFILES: { html: true } }));
}

export function getPluginRuntime(): PluginRuntime {
    if (!runtime) {
        runtime = {
            React,
            jsx: React.createElement,
            Fragment: React.Fragment,
            injectCSS,
            sanitizeHTML,
            version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
            emit: emitCanvasEvent,
            on: onCanvasEvent,
        };
        (window as unknown as { InfiniteCanvasRuntime?: PluginRuntime }).InfiniteCanvasRuntime = runtime;
    }
    return runtime;
}
