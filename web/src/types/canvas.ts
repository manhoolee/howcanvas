import type { ImageStyleDimensionSelection, ImageStyleDimensionValue, ImageStyleSelection, ImageStyleSnapshot } from "@/types/image-style";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// 节点类型放开为字符串,内置类型用 CanvasNodeType,插件类型为 "<pluginId>:<name>"
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    /** 原始用户提示词；prompt 保持向后兼容，通常保存最终发送的提示词。 */
    sourcePrompt?: string;
    /** 经过电影摄影风格编译后的最终提示词，重试/恢复时优先复用。 */
    effectivePrompt?: string;
    /** 节点当前使用的电影摄影风格选择。 */
    imageStyle?: ImageStyleSelection;
    /** 生成时解析出的不可变风格快照，保证重试复现同一版本。 */
    imageStyleSnapshot?: ImageStyleSnapshot;
    /** 兼容 Agent/plugin 写入的顶层电影摄影维度。 */
    dimensions?: ImageStyleDimensionSelection;
    styleDimensions?: ImageStyleDimensionSelection;
    /** Agent/plugin flat aliases;宿主会归一化到 imageStyle。 */
    stylePresetId?: string;
    styleGenreId?: string;
    styleIntensity?: number;
    styleCustom?: string;
    preserveSubject?: boolean;
    stylePreserveSubject?: boolean;
    preset?: string;
    presetId?: string;
    genre?: string;
    genreId?: string;
    intensity?: number;
    strength?: number;
    custom?: string;
    customStyle?: string;
    customDescription?: string;
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
    status?: CanvasNodeStatus;
    errorDetails?: string;
    serverTaskId?: string;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "seedance" | "grok-v2" | "minimax-h3" | "plugin";
    videoTaskModel?: string;
    taskStatus?: string;
    taskStatusUpdatedAt?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    groupId?: string;
    interactive?: boolean; // 插件节点「交互 ⇄ 移动」开关状态(见 CanvasNodeDefinition.interactionToggle)
    isMaskLayer?: boolean; // 蒙版图层节点：内容为「原图挖空蒙版区域」的 PNG，保留蒙版步骤
    maskSourceNodeId?: string; // 蒙版图层对应的原图节点 id
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
