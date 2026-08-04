export const APP_VERSION = __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://github.com/manhoolee/howcanvas/tree/main/docs";

// 分叉版本不再默认连接上游插件源；需要远程插件时必须显式配置自建清单地址。
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "";
