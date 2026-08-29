/**
 * A small, provider-agnostic vocabulary for cinematic image prompting.
 *
 * The catalog intentionally stores visual attributes rather than putting
 * director names in the prompt sent to an image provider.  Inspiration and
 * source information are metadata only.
 */
export type ImageStyleFragmentGroup = "composition" | "palette" | "lighting" | "lens" | "texture" | "atmosphere";

/**
 * Independent cinematography controls exposed by the style picker.  The
 * source skill groups these as composition, colour grading, lighting, lens /
 * movement, texture, atmosphere, and editing rhythm.  Values are stable IDs;
 * the English prompt text lives in the local, versioned catalog.
 */
export type ImageStyleDimensionGroup = "composition" | "colorGrading" | "lighting" | "lens" | "cameraMovement" | "texture" | "atmosphere" | "editingRhythm";

export type ImageStyleDimensionOption = {
    id: string;
    label: string;
    prompt: string;
    group: ImageStyleDimensionGroup;
    tags?: readonly string[];
};

export type ImageStyleDimensionSelection = Partial<Record<ImageStyleDimensionGroup, readonly string[]>>;

/** Accept a string for compatibility with hand-authored JSON/Agent calls. */
export type ImageStyleDimensionValue = readonly string[] | string;

export type ImageStyleFamily = "cinematography" | "genre";

export type ImageStyleFragments = Readonly<Record<ImageStyleFragmentGroup, readonly string[]>>;

export type ImageStyleSource = {
    repository: string;
    commit: string;
    section: string;
};

export type ImageStylePreset = {
    id: string;
    label: string;
    family: ImageStyleFamily;
    /** Display/source metadata. Never included in an outbound prompt. */
    inspiration?: string;
    tags: readonly string[];
    fragments: ImageStyleFragments;
    avoid: readonly string[];
    version: string;
    source: ImageStyleSource;
};

export type ImageStyleGenre = ImageStylePreset & {
    family: "genre";
};

/**
 * Both `preset`/`genre` and their explicit `*Id` aliases are accepted so that
 * serialized canvas data can use the more descriptive names without making
 * the public compiler API cumbersome.
 */
export type ImageStyleSelection = {
    preset?: string;
    presetId?: string;
    genre?: string;
    genreId?: string;
    intensity?: number;
    preserveSubject?: boolean;
    custom?: string;
    /** Independent controls selected in addition to a recipe/type. */
    dimensions?: ImageStyleDimensionSelection;
    /** Explicitly prefixed alias used by Agent/MCP payloads. */
    styleDimensions?: ImageStyleDimensionSelection;
    /** Flat aliases accepted by Agent/plugin callers and older JSON. */
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
};

export type ResolvedImageStyleSelection = {
    preset?: ImageStylePreset;
    genre?: ImageStyleGenre;
    intensity: number;
    preserveSubject: boolean;
    custom?: string;
    dimensions: ImageStyleDimensionSelection;
};

export type ImageStyleSnapshot = {
    presetId?: string;
    presetLabel?: string;
    /** Source inspiration for UI attribution; not an outbound prompt field. */
    inspiration?: string;
    genreId?: string;
    genreLabel?: string;
    intensity: number;
    preserveSubject: boolean;
    custom?: string;
    dimensions?: ImageStyleDimensionSelection;
    version: string;
    source: ImageStyleSource;
};

export type ImageStyleCompileOptions = {
    /** Maximum length of the generated provider prompt. Defaults to 4,000. */
    maxPromptLength?: number;
    /** Alias useful to callers that already use a generic max-length option. */
    maxLength?: number;
    /** Maximum length of user-supplied style notes. Defaults to 500. */
    maxCustomLength?: number;
    /** Maximum number of negative descriptors returned. Defaults to 6. */
    maxAvoidItems?: number;
    /** Include the negative descriptors in effectivePrompt as an Avoid clause. */
    includeAvoidInPrompt?: boolean;
};

export type CompiledImagePrompt = {
    sourcePrompt: string;
    effectivePrompt: string;
    avoid: string[];
    styleSnapshot: ImageStyleSnapshot;
};
