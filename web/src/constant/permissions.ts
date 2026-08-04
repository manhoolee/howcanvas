// 功能权限：对应导航中的各个工作台。管理员可为每个用户单独配置。
// 注意：「配置」不在此列——配置页为管理员专属，普通用户不可见、不可修改。
export const PERMISSIONS = [
    { key: "canvas", label: "我的画布" },
    { key: "image", label: "生图工作台" },
    { key: "video", label: "视频创作台" },
    { key: "prompts", label: "提示词库" },
    { key: "assets", label: "我的资产" },
    { key: "agent", label: "Agent 助手" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

// 新注册用户默认拥有的权限（管理员可在后台修改）。
export const DEFAULT_USER_PERMISSIONS: PermissionKey[] = ["canvas", "image", "prompts", "assets"];

export function permissionLabel(key: PermissionKey): string {
    return PERMISSIONS.find((p) => p.key === key)?.label ?? key;
}

// 计费维度：不同类型的生成内容各自计费与统计。
export const USAGE_KINDS = [
    { key: "image", label: "图片" },
    { key: "video", label: "视频" },
    { key: "audio", label: "音频" },
    { key: "text", label: "文本" },
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number]["key"];

export type Pricing = Record<UsageKind, number>;

// 默认单价（点/次）。
export const DEFAULT_PRICING: Pricing = { image: 1, video: 5, audio: 2, text: 0 };

// 新用户初始额度。
export const DEFAULT_USER_CREDITS = 100;

export function usageKindLabel(key: UsageKind): string {
    return USAGE_KINDS.find((k) => k.key === key)?.label ?? key;
}
