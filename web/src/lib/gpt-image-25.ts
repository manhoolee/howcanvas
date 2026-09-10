export const gptImage25Qualities = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "超高" },
    { value: "max", label: "最高" },
];
export const gptImage25Ratios = ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "16:9", "9:16", "21:9"];
export const gptImage25Resolutions = ["1K", "2K", "4K"] as const;
export type GptImage25Resolution = (typeof gptImage25Resolutions)[number];

export function gptImage25BaseModel(value: string) {
    const name = value.split("::").pop() || "";
    return /^(gpt-image-2\.5-(?:flare|sunburst))(?:-[124]k)?$/i.exec(name)?.[1] || "";
}

export function gptImage25ModelSelection(value: string) {
    const base = gptImage25BaseModel(value);
    const separator = value.lastIndexOf("::");
    return base ? (separator < 0 ? "" : value.slice(0, separator + 2)) + base : value;
}

export function visibleImageModelSelections(values: string[]) {
    const available = new Set(values);
    return values.filter((value) => {
        const base = gptImage25ModelSelection(value);
        return base === value || !available.has(base);
    });
}

function ratioParts(ratio: string) {
    const parts = ratio.split(/[:x]/i).map(Number);
    if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part) || part <= 0)) throw new Error("请输入有效的宽高比或像素尺寸");
    if (Math.max(...parts) / Math.min(...parts) > 3) throw new Error("图像宽高比不能超过 3:1");
    let a = parts[0], b = parts[1];
    while (b) [a, b] = [b, a % b];
    return { width: parts[0] / a, height: parts[1] / a };
}

export function gptImage25PresetSize(resolution: GptImage25Resolution, ratio: string) {
    const { width, height } = ratioParts(ratio);
    const edge = resolution === "4K" ? 3840 : resolution === "2K" ? 2048 : width === height ? 1024 : 1536;
    // Use a shared 16-pixel unit so both alignment and the selected ratio stay exact.
    const scale = Math.min(edge / Math.max(width, height), Math.sqrt(8294400 / (width * height)));
    const unit = Math.floor(scale / 16) * 16;
    return unit ? `${width * unit}x${height * unit}` : `${Math.floor(width * scale / 16) * 16}x${Math.floor(height * scale / 16) * 16}`;
}

export function gptImage25Settings(model: string, size: string) {
    if (!size || size === "auto") return { resolution: "auto" as const, size: "auto", width: 0, height: 0, ratio: "auto" };
    const pixels = /^(\d+)x(\d+)$/i.exec(size);
    const suffix = /-([24])k$/i.exec(model)?.[1];
    const resolution: GptImage25Resolution = pixels
        ? Math.max(Number(pixels[1]), Number(pixels[2])) > 2048 ? "4K" : Math.max(Number(pixels[1]), Number(pixels[2])) > 1536 ? "2K" : "1K"
        : suffix === "4" ? "4K" : suffix === "2" ? "2K" : "1K";
    const dimensions = pixels ? `${Number(pixels[1])}x${Number(pixels[2])}` : gptImage25PresetSize(resolution, gptImage25Ratios.includes(size) ? size : "1:1");
    const [width, height] = dimensions.split("x").map(Number);
    const matchedRatio = gptImage25Ratios.find((ratio) => {
        const [w, h] = ratio.split(":").map(Number);
        return width * h === height * w;
    });
    return { resolution, size: dimensions, width, height, ratio: matchedRatio || `${width}:${height}` };
}

export function gptImage25RequestSize(model: string, size: string) {
    if (!size || size === "auto") return "auto";
    if (size && size !== "auto" && !/^\d+x\d+$/i.test(size) && !gptImage25Ratios.includes(size)) throw new Error("请选择宽高比或输入有效的像素尺寸");
    const settings = gptImage25Settings(model, size);
    const { width, height } = settings;
    if (width <= 0 || height <= 0 || width % 16 || height % 16) throw new Error("图像宽高必须是正整数且为 16 的倍数");
    if (Math.max(width, height) > 3840) throw new Error("图像最长边不能超过 3840px");
    if (Math.max(width, height) / Math.min(width, height) > 3) throw new Error("图像宽高比不能超过 3:1");
    if (width * height < 655360 || width * height > 8294400) throw new Error("图像总像素需在 655360 到 8294400 之间");
    return settings.size;
}
