import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal, Slider } from "antd";
import { Brush, Eraser, RotateCcw, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";

export type CanvasImageMaskEditPayload = {
    imageDataUrl: string;
};

type DrawMode = "paint" | "erase";

const defaultBrushSize = 100;
const brushColorOptions = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ffffff"];

export function CanvasNodeMaskEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageMaskEditPayload) => void }) {
    const paintCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [brushColor, setBrushColor] = useState(brushColorOptions[0]);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!open) return;
        setBrushSize(defaultBrushSize);
        setBrushColor(brushColorOptions[0]);
        setMode("paint");
        setError("");
        setSubmitting(false);
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(paintCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    }, [image]);

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const paintCanvas = paintCanvasRef.current;
        const context = paintCanvas?.getContext("2d");
        if (!paintCanvas || !context) return;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = brushSize;
        context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out";
        context.strokeStyle = brushColor;
        context.fillStyle = brushColor;
        if (!drawingRef.current.last) {
            drawMaskStroke(context, point, point, brushSize);
        } else {
            drawMaskStroke(context, drawingRef.current.last, point, brushSize);
        }
        renderPaintPreview(paintCanvas, previewCanvasRef.current);
        drawingRef.current.last = point;
        if (mode === "paint") {
            setError("");
        }
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null };
        if (paintCanvasRef.current) renderPaintPreview(paintCanvasRef.current, previewCanvasRef.current);
        draw(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active) return;
        event.preventDefault();
        draw(event);
    };

    const stopDraw = () => {
        drawingRef.current = { active: false, last: null };
        const paintCanvas = paintCanvasRef.current;
        if (paintCanvas) renderPaintPreview(paintCanvas, previewCanvasRef.current);
    };

    const resetMask = () => {
        clearCanvas(paintCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        setError("");
    };

    const submit = async () => {
        const canvas = paintCanvasRef.current;
        if (!canvas) return;
        if (!canvasHasPaint(canvas)) return setError("请先用画笔修改图片");
        setSubmitting(true);
        try {
            onConfirm({ imageDataUrl: await buildCompositeImage(dataUrl, canvas) });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_320px]">
                <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[68vh] max-w-full bg-transparent" draggable={false} />
                        {image ? (
                            <>
                                <canvas ref={paintCanvasRef} width={image.width} height={image.height} className="hidden" />
                                <canvas
                                    ref={previewCanvasRef}
                                    width={image.width}
                                    height={image.height}
                                    className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                    onPointerDown={startDraw}
                                    onPointerMove={moveDraw}
                                    onPointerUp={stopDraw}
                                    onPointerCancel={stopDraw}
                                />
                            </>
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[360px] flex-col gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">画笔修改</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : "读取中"}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={mode === "paint" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                            画笔
                        </Button>
                        <Button type={mode === "erase" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                            擦除
                        </Button>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">笔刷大小</span>
                            <span className="font-semibold">{brushSize}px</span>
                        </div>
                        <Slider min={8} max={160} step={2} value={brushSize} onChange={setBrushSize} />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">画笔颜色</span>
                            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-black/10 px-2 py-1 dark:border-white/10">
                                <input type="color" value={brushColor} onChange={(event) => setBrushColor(event.target.value)} className="size-5 cursor-pointer border-0 bg-transparent p-0" aria-label="选择画笔颜色" />
                                <span className="font-mono text-xs uppercase">{brushColor}</span>
                            </label>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {brushColorOptions.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    aria-label={`选择颜色 ${color}`}
                                    aria-pressed={brushColor === color}
                                    className={`size-6 rounded-full border-2 transition-transform hover:scale-110 ${brushColor === color ? "scale-110 border-stone-900 dark:border-white" : "border-transparent"}`}
                                    style={{ backgroundColor: color }}
                                    onClick={() => setBrushColor(color)}
                                />
                            ))}
                        </div>
                        <div className="text-xs opacity-55">修改会直接叠加到原图，确认后生成新的图片节点。</div>
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetMask}>
                            重置
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" loading={submitting} icon={<Brush className="size-4" />} onClick={() => void submit()}>
                                生成新图片
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true;
    }
    return false;
}

function renderPaintPreview(paintCanvas: HTMLCanvasElement, previewCanvas: HTMLCanvasElement | null) {
    const context = previewCanvas?.getContext("2d");
    if (!previewCanvas || !context) return;
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.drawImage(paintCanvas, 0, 0);
}

function buildCompositeImage(dataUrl: string, paintCanvas: HTMLCanvasElement) {
    return new Promise<string>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = paintCanvas.width;
            canvas.height = paintCanvas.height;
            const context = canvas.getContext("2d");
            if (!context) return reject(new Error("无法创建图片画布"));
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            context.drawImage(paintCanvas, 0, 0);
            resolve(canvas.toDataURL("image/png"));
        };
        image.onerror = () => reject(new Error("原图读取失败"));
        image.src = dataUrl;
    });
}
