import { create } from "zustand";
import { persist } from "zustand/middleware";

import { DEFAULT_IMAGE_STYLE_SELECTION as CATALOG_DEFAULT_IMAGE_STYLE_SELECTION } from "@/lib/image-style/catalog";
import type { ImageStyleSelection } from "@/types/image-style";

export const DEFAULT_IMAGE_STYLE_SELECTION: ImageStyleSelection = CATALOG_DEFAULT_IMAGE_STYLE_SELECTION;

const IMAGE_STYLE_STORE_KEY = "infinite-canvas:image_style_store_v1";

type ImageStyleStore = {
    selection: ImageStyleSelection;
    setSelection: (selection: ImageStyleSelection) => void;
    resetSelection: () => void;
};

export const useImageStyleStore = create<ImageStyleStore>()(
    persist(
        (set) => ({
            selection: DEFAULT_IMAGE_STYLE_SELECTION,
            setSelection: (selection) => set({ selection }),
            resetSelection: () => set({ selection: DEFAULT_IMAGE_STYLE_SELECTION }),
        }),
        {
            name: IMAGE_STYLE_STORE_KEY,
            partialize: (state) => ({ selection: state.selection }),
            merge: (persisted, current) => ({
                ...current,
                selection: {
                    ...DEFAULT_IMAGE_STYLE_SELECTION,
                    ...((persisted as Partial<ImageStyleStore> | null)?.selection || {}),
                },
            }),
        },
    ),
);
