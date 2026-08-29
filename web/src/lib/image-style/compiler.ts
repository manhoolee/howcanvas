import { DEFAULT_IMAGE_STYLE_SELECTION, IMAGE_STYLE_CATALOG_VERSION, IMAGE_STYLE_DIMENSIONS, IMAGE_STYLE_GENRES, IMAGE_STYLE_SOURCE, IMAGE_STYLE_PRESETS, resolveImageStyleGenre, resolveImageStylePreset } from "@/lib/image-style/catalog";
import type { CompiledImagePrompt, ImageStyleCompileOptions, ImageStyleDimensionGroup, ImageStyleDimensionSelection, ImageStyleFragmentGroup, ImageStyleSelection, ImageStyleSnapshot, ResolvedImageStyleSelection } from "@/types/image-style";

const GROUP_ORDER: readonly ImageStyleFragmentGroup[] = ["composition", "palette", "lighting", "lens", "texture", "atmosphere"];
const GROUP_LABELS: Record<ImageStyleFragmentGroup, string> = {
    composition: "composition",
    palette: "palette",
    lighting: "lighting",
    lens: "lens and camera",
    texture: "texture",
    atmosphere: "atmosphere",
};

const DIMENSION_ORDER: readonly ImageStyleDimensionGroup[] = ["composition", "colorGrading", "lighting", "lens", "cameraMovement", "texture", "atmosphere", "editingRhythm"];

const DIMENSION_LABELS: Record<ImageStyleDimensionGroup, string> = {
    composition: "composition choices",
    colorGrading: "color grading",
    lighting: "lighting choices",
    lens: "lens choices",
    cameraMovement: "camera movement",
    texture: "texture choices",
    atmosphere: "atmosphere",
    editingRhythm: "editing rhythm",
};

const DEFAULT_MAX_PROMPT_LENGTH = 4_000;
const DEFAULT_MAX_CUSTOM_LENGTH = 500;
const DEFAULT_MAX_AVOID_ITEMS = 6;

// The catalog's director references are metadata.  These aliases also keep a
// user-entered "in the style of ..." note from leaking a named reference to a
// provider when the style controls are used as an attribute-only mode.
const DIRECTOR_NAME_PATTERNS: readonly RegExp[] = [
    /\b(?:stanley\s+)?kubrick\b/gi,
    /\b(?:steven\s+)?spielberg\b/gi,
    /\bdenis\s+villeneuve\b/gi,
    /\bvilleneuve\b/gi,
    /\bwes\s+anderson\b/gi,
    /\bmartin\s+scorsese\b/gi,
    /\bscorsese\b/gi,
    /\bbong\s+(?:joon[- ]?ho|jun[- ]?ho)\b/gi,
    /\bchristopher\s+nolan\b/gi,
    /\bnolan\b/gi,
    /\bguillermo\s+del\s+toro\b/gi,
    /\balfonso\s+cuar[oó]n\b/gi,
    /\bcuar[oó]n\b/gi,
    /\bdamien\s+chazelle\b/gi,
    /\byorgos\s+lanthimos\b/gi,
    /\blanthimos\b/gi,
    /\b(?:akira\s+)?kurosawa\b/gi,
    /\b(?:ingmar\s+)?bergman\b/gi,
    /\balfred\s+hitchcock\b/gi,
    /\bhitchcock\b/gi,
    /\borson\s+welles\b/gi,
    /\bwelles\b/gi,
    /\bjohn\s+ford\b/gi,
    /\bfederico\s+fellini\b/gi,
    /\bfellini\b/gi,
    /\bfrancis\s+ford\s+coppola\b/gi,
    /\bcoppola\b/gi,
    /\bdavid\s+lean\b/gi,
    /\balejandro\s+gonz[aá]lez\s+i[nñ][aá]rritu\b/gi,
    /\bi[nñ][aá]rritu\b/gi,
    /\bhitchcock\b/gi,
    /\borson\s+welles\b/gi,
    /\bwelles\b/gi,
    /\bjohn\s+ford\b/gi,
    /\bfederico\s+fellini\b/gi,
    /\bfellini\b/gi,
    /\bfrancis(?:\s+ford)?\s+coppola\b/gi,
    /\bbilly\s+wilder\b/gi,
    /\bwilder\b/gi,
    /\bcoen\s+brothers\b/gi,
    /\bridley\s+scott\b/gi,
    /\bjames\s+cameron\b/gi,
    /\bang\s+lee\b/gi,
    /\bpeter\s+jackson\b/gi,
    /\bjane\s+campion\b/gi,
    /\bchlo[eé]\s+zhao\b/gi,
    /\bdaniels\b/gi,
    /\bjonathan\s+glazer\b/gi,
    /\bquentin\s+tarantino\b/gi,
    /\bdanny\s+boyle\b/gi,
    /\bhayao\s+miyazaki\b/gi,
    /\bsofia\s+coppola\b/gi,
    /\bedward\s+berger\b/gi,
    /斯坦利[·・\s]?库布里克/gi,
    /史蒂文[·・\s]?斯皮尔伯格/gi,
    /丹尼斯[·・\s]?维伦纽瓦/gi,
    /韦斯[·・\s]?安德森/gi,
    /马丁[·・\s]?斯科塞斯/gi,
    /奉俊昊/gi,
    /克里斯托弗[·・\s]?诺兰/gi,
    /吉尔莫[·・\s]?德尔[·・\s]?托罗/gi,
    /阿方索[·・\s]?卡隆/gi,
    /达米恩[·・\s]?查泽雷/gi,
    /欧格斯[·・\s]?兰斯莫斯/gi,
    /黑泽明/gi,
    /伯格曼/gi,
    /希区柯克/gi,
    /奥逊[·・\s]?威尔斯/gi,
    /约翰[·・\s]?福特/gi,
    /费德里科[·・\s]?费里尼/gi,
    /弗朗西斯[·・\s]?福特[·・\s]?科波拉/gi,
    /大卫[·・\s]?里恩/gi,
    /亚历杭德罗[·・\s]?冈萨雷斯[·・\s]?伊纳里图/gi,
    /伊纳里图/gi,
    /希区柯克/gi,
    /奥逊[·・\s]?威尔斯/gi,
    /威尔斯/gi,
    /约翰[·・\s]?福特/gi,
    /费德里科[·・\s]?费里尼/gi,
    /费里尼/gi,
    /弗朗西斯[·・\s]?福特[·・\s]?科波拉/gi,
    /科波拉/gi,
    /比利[·・\s]?怀尔德/gi,
    /怀尔德/gi,
    /科恩(?:兄弟)?/gi,
    /雷德利[·・\s]?斯科特/gi,
    /詹姆斯[·・\s]?卡梅隆/gi,
    /李安/gi,
    /彼得[·・\s]?杰克逊/gi,
    /简[·・\s]?坎皮恩/gi,
    /赵婷/gi,
    /丹尼尔(?:关|关&施纳特|斯)?/gi,
    /格雷泽/gi,
    /塔伦蒂诺/gi,
    /博伊尔/gi,
    /宫崎骏/gi,
    /索菲亚[·・\s]?科波拉/gi,
    /贝尔格/gi,
];

function normalizeText(value: string) {
    return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/[.,;:!?，。；：！？、()[\]{}]/g, "")
        .replace(/\s+/g, " ");
}

function dedupe(values: readonly string[]) {
    const seen = new Set<string>();
    return values.filter((value) => {
        const text = normalizeText(value);
        const key = canonicalText(text);
        if (!text || !key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function stripDirectorNames(value: string) {
    return DIRECTOR_NAME_PATTERNS.reduce((text, pattern) => text.replace(pattern, " "), value);
}

function sanitizeCustom(value: unknown, maxLength: number) {
    if (typeof value !== "string" || !value) return undefined;
    const text = normalizeText(
        stripDirectorNames(value)
            .replace(/\b(?:in\s+the\s+style\s+of|inspired\s+by|in\s+the\s+manner\s+of|style\s+of)\b/gi, " ")
            .replace(/(?:参考|借鉴|受)\s*[,，;；]/g, " ")
            .replace(/\s+([,，。；;:：!?！？])/g, "$1")
            .replace(/[;,，；]+/g, ", "),
    );
    if (!text) return undefined;
    return (
        text
            .slice(0, maxLength)
            .trim()
            .replace(/[,:，、;；]+$/, "") || undefined
    );
}

function sanitizeDescriptor(value: string) {
    return normalizeText(stripDirectorNames(value)).replace(/[,:，、;；]+$/, "");
}

function clampIntensity(value: unknown, hasStyle: boolean) {
    if (typeof value !== "number" || !Number.isFinite(value)) return hasStyle ? 1 : 0;
    return Math.max(0, Math.min(1, value));
}

function requestedId(selection: ImageStyleSelection | undefined, shortKey: "preset" | "genre") {
    const explicitKey = `${shortKey}Id` as "presetId" | "genreId";
    const values = [selection?.[explicitKey], selection?.[shortKey]];
    return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function safeInteger(value: unknown, fallback: number, minimum: number) {
    const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(minimum, number);
}

function stringList(value: unknown) {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
}

function normalizeDimensions(input: ImageStyleSelection): ImageStyleDimensionSelection {
    const record = input as unknown as Record<string, unknown>;
    const containers = [record.dimensions, record.styleDimensions].filter((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown>[];
    const result: Partial<Record<ImageStyleDimensionGroup, readonly string[]>> = {};
    for (const group of DIMENSION_ORDER) {
        const alias = `style${group.charAt(0).toUpperCase()}${group.slice(1)}`;
        const values = dedupe([...containers.flatMap((container) => stringList(container[group])), ...stringList(record[group]), ...stringList(record[alias])]);
        if (values.length) result[group] = values;
    }
    return result;
}

/** Resolve IDs and apply defaults without mutating the caller's selection. */
export function resolveImageStyleSelection(selection?: ImageStyleSelection, options: ImageStyleCompileOptions = {}): ResolvedImageStyleSelection {
    const input = selection && typeof selection === "object" ? selection : DEFAULT_IMAGE_STYLE_SELECTION;
    const preset = resolveImageStylePreset(requestedId(input, "preset"));
    const genre = resolveImageStyleGenre(requestedId(input, "genre"));
    const maxCustomLength = safeInteger(options.maxCustomLength, DEFAULT_MAX_CUSTOM_LENGTH, 1);
    const custom = sanitizeCustom(input.custom, maxCustomLength);
    const dimensions = normalizeDimensions(input);
    const hasDimension = Object.values(dimensions).some((items) => Boolean(items?.length));
    const hasStyle = Boolean(preset || genre || custom || hasDimension);
    return {
        preset,
        genre,
        intensity: clampIntensity(input.intensity, hasStyle),
        preserveSubject: typeof input.preserveSubject === "boolean" ? input.preserveSubject : true,
        ...(custom ? { custom } : {}),
        dimensions,
    };
}

function fragmentCount(length: number, intensity: number) {
    if (!length || intensity <= 0) return 0;
    if (intensity >= 0.999) return length;
    return Math.max(1, Math.ceil(length * intensity));
}

function selectedDimensionItems(group: ImageStyleDimensionGroup, values: readonly string[], intensity: number) {
    const options = IMAGE_STYLE_DIMENSIONS[group] || [];
    const optionMap = new Map(options.map((option) => [option.id, option]));
    const items = values
        .map((value) => optionMap.get(value)?.prompt || value)
        .map((value) => sanitizeDescriptor(value))
        .filter(Boolean);
    return items.slice(0, fragmentCount(items.length, intensity));
}

function styleSections(resolved: ResolvedImageStyleSelection) {
    if (resolved.intensity <= 0) return [];
    const sections = GROUP_ORDER.map((group) => {
        const presetItems = resolved.preset?.fragments[group] || [];
        const genreItems = resolved.genre?.fragments[group] || [];
        const presetCount = fragmentCount(presetItems.length, resolved.intensity);
        const genreCount = fragmentCount(genreItems.length, resolved.intensity);
        const dimensionGroups = DIMENSION_ORDER.filter((dimension) => {
            if (dimension === "colorGrading") return group === "palette";
            return dimension === group;
        });
        const dimensionItems = dimensionGroups.flatMap((dimension) => selectedDimensionItems(dimension, resolved.dimensions[dimension] || [], resolved.intensity));
        const items = dedupe([...presetItems.slice(0, presetCount).map(sanitizeDescriptor), ...genreItems.slice(0, genreCount).map(sanitizeDescriptor), ...dimensionItems]);
        return items.length ? `${GROUP_LABELS[group]}: ${items.join(", ")}` : "";
    }).filter(Boolean);
    const standalone = (["cameraMovement", "editingRhythm"] as const)
        .map((dimension) => {
            const items = selectedDimensionItems(dimension, resolved.dimensions[dimension] || [], resolved.intensity);
            return items.length ? `${DIMENSION_LABELS[dimension]}: ${items.join(", ")}` : "";
        })
        .filter(Boolean);
    return [...sections, ...standalone];
}

function styleAvoid(resolved: ResolvedImageStyleSelection, maxItems: number) {
    if (resolved.intensity <= 0) return [];
    return dedupe([...(resolved.preset?.avoid || []), ...(resolved.genre?.avoid || [])].map(sanitizeDescriptor)).slice(0, maxItems);
}

function appendWithinLimit(base: string, addition: string, maxLength: number) {
    if (!addition) return base;
    const separator = base ? "\n\n" : "";
    const available = maxLength - base.length - separator.length;
    // The source prompt is always higher priority than style metadata.  If it
    // already exceeds the cap, leave it untouched instead of truncating user
    // content.
    if (available <= 0) return base;
    if (addition.length <= available) return `${base}${separator}${addition}`;
    const truncated = addition
        .slice(0, available)
        .trim()
        .replace(/[,:，、;；]+$/, "");
    return truncated ? `${base}${separator}${truncated}` : base;
}

function buildSnapshot(resolved: ResolvedImageStyleSelection): ImageStyleSnapshot {
    return {
        ...(resolved.preset ? { presetId: resolved.preset.id, presetLabel: resolved.preset.label, inspiration: resolved.preset.inspiration } : {}),
        ...(resolved.genre ? { genreId: resolved.genre.id, genreLabel: resolved.genre.label } : {}),
        intensity: resolved.intensity,
        preserveSubject: resolved.preserveSubject,
        ...(resolved.custom ? { custom: resolved.custom } : {}),
        ...(Object.keys(resolved.dimensions).length ? { dimensions: resolved.dimensions } : {}),
        version: IMAGE_STYLE_CATALOG_VERSION,
        source: { ...(resolved.preset?.source || resolved.genre?.source || IMAGE_STYLE_SOURCE) },
    };
}

/**
 * Compile a user's prompt with an optional cinematography recipe.
 *
 * The function is deterministic and side-effect free.  It never includes a
 * preset label or inspiration string in the provider prompt; only the
 * attribute fragments are compiled into `effectivePrompt`.
 */
export function compileImagePrompt(rawPrompt: string, selection?: ImageStyleSelection, options: ImageStyleCompileOptions = {}): CompiledImagePrompt {
    const sourcePrompt = String(rawPrompt ?? "").trim();
    const resolved = resolveImageStyleSelection(selection, options);
    const snapshot = buildSnapshot(resolved);
    const avoid = styleAvoid(resolved, safeInteger(options.maxAvoidItems, DEFAULT_MAX_AVOID_ITEMS, 0));
    const maxPromptLength = safeInteger(options.maxPromptLength ?? options.maxLength, DEFAULT_MAX_PROMPT_LENGTH, 1);
    const sections = styleSections(resolved);
    const activeCustom = resolved.intensity > 0 ? resolved.custom : undefined;
    if (!sections.length && !activeCustom) {
        return { sourcePrompt, effectivePrompt: sourcePrompt, avoid, styleSnapshot: snapshot };
    }

    const directionLines = [`Cinematography direction: ${sections.join("; ")}${sections.length ? "." : ""}`];
    if (activeCustom) directionLines.push(`Additional visual notes: ${activeCustom}.`);
    if (resolved.preserveSubject) directionLines.push("Preserve the requested subject, identity, key objects, count, and action.");
    if (options.includeAvoidInPrompt !== false && avoid.length) directionLines.push(`Avoid: ${avoid.join(", ")}.`);
    const effectivePrompt = appendWithinLimit(sourcePrompt, directionLines.join("\n"), maxPromptLength);
    return { sourcePrompt, effectivePrompt, avoid, styleSnapshot: snapshot };
}

/**
 * Recover the editable part of a prompt that may already contain the
 * compiler's generated direction block.  The workbench and canvas both show
 * the effective prompt in their editors, so keeping this operation shared
 * prevents a style change or retry from appending the same block twice.
 */
export function sourcePromptFromDisplay(value: unknown, previousSource = "", previousDisplay = "") {
    const next = String(value ?? "");
    const source = String(previousSource ?? "");
    const display = String(previousDisplay ?? "");
    if (!display || display === source) return stripGeneratedDirection(next).trim();

    // When the source is empty, the whole previous display is the generated
    // suffix. This also preserves text a user appends after that suffix.
    const suffix = source && display.startsWith(`${source}\n\n`) ? display.slice(source.length + 2) : source ? "" : display;
    if (suffix) {
        const suffixIndex = next.lastIndexOf(suffix);
        if (suffixIndex >= 0) {
            const before = next.slice(0, suffixIndex).trimEnd();
            const after = next.slice(suffixIndex + suffix.length).trimStart();
            return [before, after].filter(Boolean).join("\n\n").trim();
        }
    }

    return stripGeneratedDirection(next).trim();
}

function stripGeneratedDirection(value: string) {
    const markerIndex = value.search(/\n{1,2}Cinematography direction:/i);
    if (markerIndex >= 0) return value.slice(0, markerIndex);
    return /^Cinematography direction:/i.test(value.trim()) ? "" : value;
}

// Keep these exports available to lightweight UI consumers without requiring
// them to import the catalog module separately.
export { DEFAULT_IMAGE_STYLE_SELECTION, IMAGE_STYLE_GENRES, IMAGE_STYLE_PRESETS };
