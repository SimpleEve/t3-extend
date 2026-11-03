// @effect-diagnostics nodeBuiltinImport:off - a build-time image pipeline, not server code.
// T3 Extend: render the fork's brand icons from assets/fork/mark.svg. Upstream's `vp run
// icons:export` drives Icon Composer on macOS and never exports the macOS preset from its CLI, so
// the fork composes the same tracked outputs itself: each variant's own icon.json layers, the fork
// mark, and the corner shapes in assets/fork/masks, which were extracted from upstream's last icon
// exports. Upstream's `icons:check` still validates against Icon Composer sources and is not the
// fork's check; re-running this script and `vp run fork:guard` are.
//
// `vp run fork:icons` runs this, then upstream's Android exporter, which reads the mark out of
// `assets/prod/app-icon.icon/Assets/text.svg`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import sharp, { type OverlayOptions } from "sharp";

import { BRAND_ASSET_PATHS, resolveWebIconOverrides } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
const CANVAS = 1024;
const MARK_RELATIVE_PATH = "assets/fork/mark.svg";
// The mark's ink box inside its 128-unit art board: 16-wide round-capped strokes on a board the
// layers scale. Everything that places the mark (Icon Composer layers, the Android exporter, the
// widget SVG) works in those units.
const MARK_BOX = { x: 26, y: 26, width: 76, height: 76 };
const MASK_DIRECTORY = "assets/fork/masks";
const WEB_PUBLIC_DIRECTORY = "apps/web/public";
const MOBILE_ASSETS_DIRECTORY = "apps/mobile/assets";
const MONOCHROME_MARK_SIZE = 432;
const MONOCHROME_MARK_FRACTION = 0.48;
const NOTIFICATION_ICON_SIZE = 96;

const VARIANTS = [
  {
    label: "development",
    bundle: "assets/dev/app-icon.icon",
    outputs: {
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  },
  {
    label: "nightly",
    bundle: "assets/nightly/app-icon.icon",
    outputs: {
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    },
  },
  {
    label: "production",
    bundle: "assets/prod/app-icon.icon",
    outputs: {
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    },
  },
] as const;

type IconVariant = (typeof VARIANTS)[number];
type MaskKind = "macos" | "square";

const toRepositoryPath = (relativePath: string): string =>
  NodePath.join(repositoryRoot, relativePath);

function writeRepositoryFile(relativePath: string, contents: Buffer | string): void {
  const target = toRepositoryPath(relativePath);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, contents);
  process.stdout.write(`wrote ${relativePath}\n`);
}

function svgIntrinsicSize(svg: string): { width: number; height: number } {
  const width = /\bwidth="([\d.]+)"/.exec(svg);
  const height = /\bheight="([\d.]+)"/.exec(svg);
  return { width: width ? Number(width[1]) : 128, height: height ? Number(height[1]) : 128 };
}

interface IconLayer {
  readonly imageName: string;
  readonly scale: number;
  readonly translation: readonly [number, number];
}

const IconComposerLayer = Schema.Struct({
  "image-name": Schema.String,
  scale: Schema.optionalKey(Schema.Number),
  "translation-in-points": Schema.optionalKey(Schema.Tuple([Schema.Number, Schema.Number])),
});
const decodeIconComposerConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      groups: Schema.Array(Schema.Struct({ layers: Schema.Array(IconComposerLayer) })),
    }),
  ),
);

function readIconLayers(bundle: string): ReadonlyArray<IconLayer> {
  const config = decodeIconComposerConfig(
    NodeFS.readFileSync(toRepositoryPath(`${bundle}/icon.json`), "utf8"),
  );
  const group = config.groups[0];
  if (!group) throw new Error(`${bundle}/icon.json has no groups[0].`);
  // Layers are listed front-to-back; paint them back-to-front.
  return [...group.layers].reverse().map((layer) => ({
    imageName: layer["image-name"],
    scale: layer.scale ?? 8,
    translation: layer["translation-in-points"] ?? [0, 0],
  }));
}

async function composeVariantCanvas(bundle: string, markSvg: string): Promise<Buffer> {
  // The mark is scaled past the canvas, so compose oversized and crop back.
  const padding = 4096;
  const size = CANVAS + 2 * padding;
  const tiles: OverlayOptions[] = [];
  for (const layer of readIconLayers(bundle)) {
    const svg =
      layer.imageName === "text.svg"
        ? markSvg
        : NodeFS.readFileSync(toRepositoryPath(`${bundle}/Assets/${layer.imageName}`), "utf8");
    const intrinsic = svgIntrinsicSize(svg);
    const width = Math.round(intrinsic.width * layer.scale);
    const height = Math.round(intrinsic.height * layer.scale);
    tiles.push({
      input: await sharp(Buffer.from(svg)).resize(width, height).png().toBuffer(),
      left: Math.round(padding + (CANVAS - width) / 2 + layer.translation[0]),
      top: Math.round(padding + (CANVAS - height) / 2 + layer.translation[1]),
    });
  }
  const composed = await sharp({
    create: { width: size, height: size, channels: 4, background: "#000000" },
  })
    .composite(tiles)
    .png()
    .toBuffer();
  return await sharp(composed)
    .extract({ left: padding, top: padding, width: CANVAS, height: CANVAS })
    .png()
    .toBuffer();
}

// Masks carry upstream's corner shapes: macOS insets the artwork the way its own preset does, the
// square one is the iOS/web/Windows silhouette.
async function applyMask(render: Buffer, size: number, kind: MaskKind): Promise<Buffer> {
  const mask = await sharp(toRepositoryPath(`${MASK_DIRECTORY}/mask-${kind}-${size}.png`))
    .extractChannel(0)
    .raw()
    .toBuffer();
  // A white RGB image whose alpha is the mask, then `dest-in` keeps the render where the shape is.
  // (`joinChannel` cannot do this after `removeAlpha`: sharp runs removeAlpha after it, dropping the
  // channel again.)
  const silhouette = await sharp({
    create: { width: size, height: size, channels: 3, background: "#ffffff" },
  })
    .joinChannel(mask, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
  return await sharp(render)
    .resize(size, size)
    .ensureAlpha()
    .composite([{ input: silhouette, blend: "dest-in" }])
    .png()
    .toBuffer();
}

// Android shows the mark alone: an adaptive-icon foreground, and a silhouette Android reads as
// alpha only. Same placement transform upstream's Android exporter uses.
async function renderStandaloneMark(
  markSvg: string,
  size: number,
  fraction: number,
): Promise<Buffer> {
  const scale = (size * fraction) / MARK_BOX.width;
  const translateX = (size - MARK_BOX.width * scale) / 2 - MARK_BOX.x * scale;
  const translateY = (size - MARK_BOX.height * scale) / 2 - MARK_BOX.y * scale;
  const paths = markSvg.match(/<path[^>]*\/>/g);
  if (!paths) throw new Error(`${MARK_RELATIVE_PATH} has no self-closing <path> elements.`);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">` +
    `<g transform="translate(${translateX.toFixed(3)} ${translateY.toFixed(3)}) scale(${scale.toFixed(4)})">${paths.join("")}</g></svg>`;
  return await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
}

function renderWidgetMark(markSvg: string): string {
  const path = /<path[^>]*\/>/.exec(markSvg)?.[0];
  if (!path) throw new Error(`${MARK_RELATIVE_PATH} has no self-closing <path> element.`);
  const body = path.replace(/\bstroke="[^"]*"/, 'stroke="black"');
  return (
    `<svg width="${MARK_BOX.width}" height="${MARK_BOX.height}"` +
    ` viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}" fill="none"` +
    ` xmlns="http://www.w3.org/2000/svg">\n  ${body}\n</svg>\n`
  );
}

async function renderVariant(variant: IconVariant, markSvg: string): Promise<void> {
  const canvas = await composeVariantCanvas(variant.bundle, markSvg);
  const square = (size: number): Promise<Buffer> => applyMask(canvas, size, "square");
  const [ios, macos, appleTouch, favicon16, favicon32] = await Promise.all([
    square(CANVAS),
    applyMask(canvas, CANVAS, "macos"),
    square(180),
    square(16),
    square(32),
  ]);
  const icoRenditions = [];
  for (const size of WINDOWS_ICON_SIZES) {
    icoRenditions.push({ size, contents: await square(size) });
  }
  const ico = encodePngIco(icoRenditions);
  const outputs = variant.outputs;
  // Upstream ships identical bytes for the iOS/universal pair and for both .ico files; keep that.
  writeRepositoryFile(outputs.macos, macos);
  writeRepositoryFile(outputs.appleTouch, appleTouch);
  writeRepositoryFile(outputs.favicon16, favicon16);
  writeRepositoryFile(outputs.favicon32, favicon32);
  writeRepositoryFile(outputs.faviconIco, ico);
  writeRepositoryFile(outputs.windowsIco, ico);
  writeRepositoryFile(outputs.ios, ios);
  writeRepositoryFile(outputs.universal, ios);
  process.stdout.write(`rendered ${variant.label} icons\n`);
}

const mark = NodeFS.readFileSync(toRepositoryPath(MARK_RELATIVE_PATH), "utf8");

// Every variant's Icon Composer project carries the same mark, so the source of truth cannot drift.
for (const variant of VARIANTS) {
  writeRepositoryFile(`${variant.bundle}/Assets/text.svg`, mark);
}

for (const variant of VARIANTS) {
  await renderVariant(variant, mark);
}

// `apps/web/public` tracks the development brand; upstream's release pipeline re-applies the
// production brand when it ships.
for (const override of resolveWebIconOverrides("development", WEB_PUBLIC_DIRECTORY)) {
  writeRepositoryFile(
    override.targetRelativePath,
    NodeFS.readFileSync(toRepositoryPath(override.sourceRelativePath)),
  );
}

writeRepositoryFile(
  `${MOBILE_ASSETS_DIRECTORY}/android-icon-mark.png`,
  await renderStandaloneMark(mark, MONOCHROME_MARK_SIZE, MONOCHROME_MARK_FRACTION),
);
writeRepositoryFile(
  `${MOBILE_ASSETS_DIRECTORY}/android-notification-icon.png`,
  await renderStandaloneMark(mark, NOTIFICATION_ICON_SIZE, 1),
);
writeRepositoryFile(`${MOBILE_ASSETS_DIRECTORY}/widget/T3Mark.svg`, renderWidgetMark(mark));
