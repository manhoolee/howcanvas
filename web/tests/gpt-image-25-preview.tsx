import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImageSettingsPanel } from "../src/components/image-settings-panel";
import { ModelPicker } from "../src/components/model-picker";
import { CanvasImageSettingsPopover } from "../src/components/canvas/canvas-image-settings-popover";
import { canvasThemes } from "../src/lib/canvas-theme";
import { defaultConfig } from "../src/stores/use-config-store";
import { useThemeStore } from "../src/stores/use-theme-store";
import "../src/styles/globals.css";

const models = ["flare", "sunburst"].flatMap((name) => ["", "-2k", "-4k"].map((suffix) => ({ name: `gpt-image-2.5-${name}${suffix}`, capability: "image" as const })));
const themeName = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
useThemeStore.getState().setTheme(themeName);
document.documentElement.classList.toggle("dark", themeName === "dark");
const theme = canvasThemes[themeName];
document.body.style.background = theme.toolbar.panel;

function Preview() {
    const [config, setConfig] = useState({ ...defaultConfig, model: "test::gpt-image-2.5-flare", imageModel: "test::gpt-image-2.5-flare", size: "auto", channels: [{ id: "test", name: "T8", baseUrl: "/api/ai/test", apiKey: "", apiFormat: "openai" as const, models }], models: models.map((model) => `test::${model.name}`) });
    Object.assign(window, { previewConfig: config });
    const change = (key: string, value: string) => setConfig((previous) => ({ ...previous, [key]: value }));
    return <main style={{ maxWidth: 380, padding: 20, margin: "0 auto", color: theme.node.text }}>
        <div style={{ marginBottom: 16 }}><ModelPicker config={config} value={config.model} onChange={(value) => change("model", value)} capability="image" fullWidth /></div>
        <div style={{ marginBottom: 16 }}><CanvasImageSettingsPopover config={config} onConfigChange={change} showStyle={false} placement="bottomLeft" /></div>
        <ImageSettingsPanel config={config} onConfigChange={change} theme={theme} className="space-y-4" maxCount={3} quickCount={3} />
    </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
