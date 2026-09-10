import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CanvasProjectPage from "../src/pages/canvas/project";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import { useThemeStore } from "../src/stores/use-theme-store";
import { useAgentStore } from "../src/stores/use-agent-store";
import { useCanvasSidePanelStore } from "../src/stores/use-canvas-side-panel-store";
import { CanvasNodeType } from "../src/types/canvas";
import "../src/styles/globals.css";

await useCanvasStore.persist.rehydrate();
useCanvasStore.getState().setOwner("alignment-test");
useAgentStore.setState({ enabled: false, panelOpen: false });
useCanvasSidePanelStore.setState({ panelOpen: false });
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
useThemeStore.getState().setTheme(theme);
document.documentElement.classList.toggle("dark", theme === "dark");
if (!useCanvasStore.getState().projects.length || new URLSearchParams(location.search).has("reset")) {
    useCanvasStore.getState().replaceProjects([{
        id: "alignment", ownerId: "alignment-test", title: "对齐验证", createdAt: "", updatedAt: "",
        nodes: [
            { id: "a", x: 180, y: 170, width: 180, height: 130 },
            { id: "b", x: 510, y: 360, width: 230, height: 170 },
            { id: "c", x: 1000, y: 500, width: 140, height: 100 },
        ].map(({ id, x, y, width, height }) => ({ id, position: { x, y }, width, height, type: CanvasNodeType.Text, title: id.toUpperCase(), status: "idle", metadata: { content: `Card ${id.toUpperCase()}` } })),
        connections: new URLSearchParams(location.search).has("connections") ? [
            { id: "ab", fromNodeId: "a", toNodeId: "b" },
            { id: "bc", fromNodeId: "b", toNodeId: "c" },
            { id: "ac", fromNodeId: "a", toNodeId: "c" },
        ] : [],
        chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "lines", showImageInfo: false,
    }]);
}
useCanvasStore.setState({ hydrated: true });
Object.assign(window, { alignmentStore: useCanvasStore });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
    <ConfigProvider><App style={{ height: "100dvh" }}><QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/canvas/alignment"]}><Routes><Route path="/canvas/:id" element={<CanvasProjectPage />} /></Routes></MemoryRouter></QueryClientProvider></App></ConfigProvider>,
);
