import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    ownerId?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

type CanvasStore = {
    hydrated: boolean;
    ownerId: string | null;
    serverUpdatedAt: string;
    serverUpdatedAtByOwner: Record<string, string>;
    projects: CanvasProject[];
    allProjects: CanvasProject[];
    setOwner: (ownerId: string | null) => void;
    setServerUpdatedAt: (updatedAt: string) => void;
    replaceServerProjects: (projects: CanvasProject[], updatedAt: string) => void;
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "allProjects" | "serverUpdatedAtByOwner"> & { projects?: CanvasProject[]; serverUpdatedAt?: string };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        const persistedProjects = Array.isArray((parsed.state as PersistedCanvasState).allProjects) ? (parsed.state as PersistedCanvasState).allProjects : ((parsed.state as PersistedCanvasState).projects || []);
        const serverUpdatedAtByOwner = (parsed.state as PersistedCanvasState).serverUpdatedAtByOwner || {};
        queuedPersistState = { allProjects: persistedProjects, serverUpdatedAtByOwner };
        return { ...parsed, state: { ...parsed.state, allProjects: persistedProjects, projects: [], serverUpdatedAt: "", serverUpdatedAtByOwner } } as StorageValue<CanvasStore>;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.allProjects === nextState.allProjects && queuedPersistState.serverUpdatedAtByOwner === nextState.serverUpdatedAtByOwner) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify({ ...value, state: { ...value.state, projects: nextState.allProjects, allProjects: nextState.allProjects, serverUpdatedAtByOwner: nextState.serverUpdatedAtByOwner } }));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            ownerId: null,
            serverUpdatedAt: "",
            serverUpdatedAtByOwner: {},
            projects: [],
            allProjects: [],
            setOwner: (ownerId) =>
                set((state) => {
                    let allProjects = state.allProjects;
                    // 旧版本没有 ownerId。首次登录时将历史本地画布迁移给当前账户，避免升级后丢失。
                    // Only migrate a purely legacy cache. If owned projects are
                    // already present, never claim unowned data for this account.
                    if (ownerId && allProjects.length > 0 && allProjects.every((project) => !project.ownerId)) {
                        allProjects = allProjects.map((project) => ({ ...project, ownerId }));
                    }
                    return {
                        ownerId,
                        allProjects,
                        projects: ownerId ? allProjects.filter((project) => project.ownerId === ownerId) : [],
                        serverUpdatedAt: ownerId ? state.serverUpdatedAtByOwner[ownerId] || "" : "",
                    };
                }),
            setServerUpdatedAt: (serverUpdatedAt) =>
                set((state) => ({
                    serverUpdatedAt,
                    serverUpdatedAtByOwner: state.ownerId ? { ...state.serverUpdatedAtByOwner, [state.ownerId]: serverUpdatedAt } : state.serverUpdatedAtByOwner,
                })),
            replaceServerProjects: (projects, serverUpdatedAt) =>
                set((state) => {
                    const nextProjects = projects.map((project) => ({ ...project, ownerId: state.ownerId || project.ownerId }));
                    const allProjects = [...state.allProjects.filter((project) => project.ownerId !== state.ownerId), ...nextProjects];
                    return {
                        allProjects,
                        projects: state.ownerId ? nextProjects.filter((project) => project.ownerId === state.ownerId) : [],
                        serverUpdatedAt,
                        serverUpdatedAtByOwner: state.ownerId ? { ...state.serverUpdatedAtByOwner, [state.ownerId]: serverUpdatedAt } : state.serverUpdatedAtByOwner,
                    };
                }),
            createProject: (title = "未命名画布") => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                        id,
                    ownerId: get().ownerId || undefined,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => {
                    const allProjects = [project, ...state.allProjects];
                    return { allProjects, projects: state.ownerId ? allProjects.filter((item) => item.ownerId === state.ownerId) : [] };
                });
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    ownerId: get().ownerId || undefined,
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => {
                    const allProjects = [project, ...state.allProjects];
                    return { allProjects, projects: state.ownerId ? allProjects.filter((item) => item.ownerId === state.ownerId) : [] };
                });
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    allProjects: state.allProjects.map((project) => (project.id === id && project.ownerId === state.ownerId ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const allProjects = state.allProjects.filter((project) => !(project.ownerId === state.ownerId && ids.includes(project.id)));
                    return { allProjects, projects: state.projects.filter((project) => !ids.includes(project.id)) };
                }),
            replaceProjects: (projects) =>
                set((state) => {
                    const nextProjects = projects.map((project) => ({ ...project, ownerId: project.ownerId || state.ownerId || undefined }));
                    const allProjects = [...state.allProjects.filter((project) => project.ownerId !== state.ownerId), ...nextProjects];
                    return { allProjects, projects: state.ownerId ? nextProjects.filter((project) => project.ownerId === state.ownerId) : [] };
                }),
            updateProject: (id, patch) =>
                set((state) => {
                    const allProjects = state.allProjects.map((project) => (project.id === id && project.ownerId === state.ownerId ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project));
                    return { allProjects, projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)) };
                }),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    allProjects: state.allProjects,
                    serverUpdatedAtByOwner: state.serverUpdatedAtByOwner,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
