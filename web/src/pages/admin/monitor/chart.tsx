import { useEffect, useRef } from "react";
import { theme } from "antd";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, HeatmapChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, VisualMapComponent, AriaComponent } from "echarts/components";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([BarChart, LineChart, PieChart, HeatmapChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, VisualMapComponent, AriaComponent, CanvasRenderer, LegacyGridContainLabel]);
export const chartColors = ["#0891b2", "#6366f1", "#16a34a", "#d97706", "#e11d48", "#8b5cf6"];
export function Chart({ option, height = 300, onSelect, label }: { option: EChartsCoreOption; height?: number; onSelect?: (value: string, index: number) => void; label: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
    const selectRef = useRef(onSelect);
    selectRef.current = onSelect;
    const { token } = theme.useToken();
    useEffect(() => {
        if (!ref.current) return;
        const chart = echarts.init(ref.current);
        instance.current = chart;
        chart.on("click", (p) => selectRef.current?.(String(p.name), p.dataIndex));
        const observer = new ResizeObserver(() => chart.resize());
        observer.observe(ref.current);
        return () => {
            observer.disconnect();
            chart.dispose();
            instance.current = null;
        };
    }, []);
    useEffect(() => {
        const chart = instance.current;
        if (!chart) return;
        const tooltip = option.tooltip && typeof option.tooltip === "object" ? (option.tooltip as Record<string, unknown>) : {};
        chart.setOption(
            {
                color: chartColors,
                backgroundColor: "transparent",
                textStyle: { color: token.colorText, fontFamily: "inherit" },
                animation: false,
                aria: { enabled: true, decal: { show: false } },
                grid: { left: 12, right: 22, top: 40, bottom: 42, containLabel: true },
                legend: { type: "scroll", textStyle: { color: token.colorTextSecondary }, top: 0 },
                ...option,
                tooltip: { trigger: "axis", confine: true, backgroundColor: token.colorBgElevated, textStyle: { color: token.colorText }, borderColor: token.colorBorder, ...tooltip, renderMode: "richText" },
            },
            { replaceMerge: ["series"] },
        );
    }, [option, token.colorText, token.colorTextSecondary, token.colorBgElevated, token.colorBorder, onSelect]);
    return <div ref={ref} style={{ height, width: "100%", minWidth: 0 }} role="img" aria-label={label} />;
}
