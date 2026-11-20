import { THEME_LOOK_LIMITS, type ChatWidth } from "@t3tools/contracts";
import { isThemeLookFontStack } from "@t3tools/shared/forkThemeLook";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MousePointer2Icon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import { useT } from "../../hooks/useT";
import { cn } from "../../lib/utils";
import {
  type ThemeColorRole,
  type ThemeDefinition,
  updateThemeColorFamily,
} from "../../themePalette";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { ThemeColorPicker } from "../../components/settings/ThemeColorPicker";
import { ThemeCssEditor } from "../../components/settings/ThemeCssEditor";
import {
  getThemeCardDefinition,
  previewColorsOf,
  STANDARD_THEME_CARDS,
} from "../../components/settings/ThemePreviewCircles";
import { ThemeWireframe } from "../../components/settings/ThemeWireframe";
import { TypographySection } from "../../components/settings/TypographySettings";
import { isThemeColor, themeColorToHex } from "../../themePalette";
import { COLOR_GROUPS, colorFamilyOfRole, locateColorRole } from "./colorFamilies";
import { HalvesNotice } from "./HalvesNotice";
import { MySchemes } from "./MySchemes";
import { CODE_FONT_OPTIONS, THEME_PRESET_SEEDS, UI_FONT_OPTIONS } from "./presets";
import { overriddenSettings, schemeColors, studioThemeKind } from "./studio.logic";
import { PickHint } from "./PickHint";
import { useColorInspector } from "./useColorInspector";
import { useThemeStudio } from "./useThemeStudio";

type Studio = ReturnType<typeof useThemeStudio>;

const CUSTOM_FONT = "__custom__";
const NO_FONT = "__setting__";

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
};

function sliderStyle(ratio: number): CSSProperties {
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

function LookSlider({
  id,
  title,
  description,
  unit,
  limit,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  title: string;
  description: string;
  unit: string;
  limit: {
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly default: number;
  };
  /** Absent means the theme leaves this alone. */
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const shown = value ?? limit.default;
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      resetAction={
        value !== undefined ? (
          <SettingResetButton label={title} onClick={() => onChange(undefined)} />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-56">
          <output
            className="min-w-14 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor={`${id}-range`}
          >
            {shown}
            {unit}
          </output>
          <input
            aria-label={t(title)}
            className={cn("settings-slider min-w-0 flex-1", value === undefined && "opacity-60")}
            disabled={disabled}
            id={`${id}-range`}
            max={limit.max}
            min={limit.min}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isInteger(next)) onChange(next);
            }}
            step={limit.step}
            style={sliderStyle((shown - limit.min) / (limit.max - limit.min))}
            type="range"
            value={shown}
          />
        </div>
      }
    />
  );
}

function FontStackRow({
  id,
  title,
  description,
  options,
  value,
  overridesSetting,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  options: ReadonlyArray<{ id: string; label: string; stack: string }>;
  value: string | undefined;
  overridesSetting: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const t = useT();
  const known = options.find((option) => option.stack === value);
  const selected = value === undefined ? NO_FONT : (known?.id ?? CUSTOM_FONT);
  const [custom, setCustom] = useState(known === undefined ? (value ?? "") : "");
  const [customOpen, setCustomOpen] = useState(selected === CUSTOM_FONT);
  const customValid = custom.trim() === "" || isThemeLookFontStack(custom.trim());
  const selectedLabel =
    selected === NO_FONT
      ? t("Your setting")
      : selected === CUSTOM_FONT
        ? t("Custom")
        : t(known?.label ?? "");

  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      status={
        overridesSetting ? (
          <Badge size="sm" variant="info">
            {t("Overrides your font setting")}
          </Badge>
        ) : null
      }
      resetAction={
        value !== undefined ? (
          <SettingResetButton
            label={title}
            onClick={() => {
              setCustom("");
              setCustomOpen(false);
              onChange(undefined);
            }}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-64">
          <Select
            value={customOpen ? CUSTOM_FONT : selected}
            onValueChange={(next) => {
              if (next === NO_FONT) {
                setCustomOpen(false);
                onChange(undefined);
              } else if (next === CUSTOM_FONT) {
                setCustomOpen(true);
              } else {
                setCustomOpen(false);
                onChange(options.find((option) => option.id === next)?.stack);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={t(title)}>
              <SelectValue>{customOpen ? t("Custom") : selectedLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NO_FONT}>{t("Your setting")}</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {t(option.label)}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_FONT}>{t("Custom")}</SelectItem>
            </SelectPopup>
          </Select>
          {customOpen ? (
            <Input
              size="sm"
              aria-invalid={!customValid}
              aria-label={t("{title} font names", { title: t(title) })}
              autoCapitalize="off"
              autoComplete="off"
              font="mono"
              onChange={(event) => {
                const next = event.currentTarget.value;
                setCustom(next);
                if (isThemeLookFontStack(next.trim())) onChange(next.trim());
                else if (next.trim() === "") onChange(undefined);
              }}
              placeholder={t("Georgia, serif")}
              value={custom}
            />
          ) : null}
        </div>
      }
    />
  );
}

function ColorRow({
  studio,
  role,
  label,
  selected,
}: {
  studio: Studio;
  role: ThemeColorRole;
  label: string;
  /** The row found by picking a color from the app. */
  selected: boolean;
}) {
  const t = useT();
  const colors = schemeColors(studio.working, studio.editAppearance) ?? studio.working.colors;
  const value = colors[role];
  const valid = isThemeColor(value);
  const hex = value.trim().toLowerCase().startsWith("oklch(")
    ? (themeColorToHex(value) ?? value)
    : value;
  const change = (next: string) =>
    studio.setColors((current) =>
      isThemeColor(next)
        ? updateThemeColorFamily(studio.editAppearance, current, role, next)
        : { ...current, [role]: next },
    );
  return (
    <div
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-2 px-3 py-1.5 sm:px-4",
        selected && "bg-accent/30 ring-2 ring-inset ring-ring",
      )}
      data-theme-color-role={role}
    >
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
      <ThemeColorPicker
        label={label}
        onChange={change}
        onEditCancel={studio.cancelColorEdit}
        onEditStart={studio.startColorEdit}
        value={valid ? value : "#000000"}
      />
      <div className="w-28 shrink-0">
        <Input
          aria-invalid={!valid}
          aria-label={t("{label} hex value", { label })}
          font="mono"
          nativeInput
          onChange={(event) => change(event.currentTarget.value)}
          size="compact"
          value={hex}
        />
      </div>
    </div>
  );
}

function ColorsSection({ studio }: { studio: Studio }) {
  const t = useT();
  const [allOpenByHand, setAllOpenByHand] = useState(false);
  const inspector = useColorInspector();
  const { selection } = inspector;
  const selectedRole = selection?.role ?? null;
  const allOpen =
    allOpenByHand || (selectedRole !== null && locateColorRole(selectedRole).needsAllColors);
  const family = selectedRole === null ? null : colorFamilyOfRole(selectedRole);
  const selectedLabel =
    selectedRole === null
      ? ""
      : selectedRole === "canvas"
        ? t("Background")
        : selectedRole === "accent"
          ? t("Accent")
          : t(family?.label ?? selectedRole, undefined, "theme color");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the page to the row a color picked from the app belongs to, once it has rendered
  useEffect(() => {
    // While picking the page is hidden; it is scrolled once it is back.
    if (selection === null || inspector.inspecting) return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`#theme-studio-colors [data-theme-color-role="${selection.role}"]`)
        ?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "center",
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [selection, inspector.inspecting]);

  return (
    <SettingsSection
      data-theme-editor-panel
      id="theme-studio-colors"
      title="Colors"
      headerAction={
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {studio.editAppearance === "dark"
              ? t("Editing the dark palette")
              : t("Editing the light palette")}
          </p>
          <Button
            aria-pressed={inspector.inspecting}
            size="xs"
            variant={inspector.inspecting ? "secondary" : "outline"}
            onClick={inspector.inspecting ? inspector.clear : inspector.start}
          >
            <MousePointer2Icon />
            {inspector.inspecting ? t("Cancel") : t("Pick from the app")}
          </Button>
        </div>
      }
    >
      {inspector.inspecting ? <PickHint /> : null}
      {!inspector.inspecting && selectedRole !== null ? (
        <div className="flex items-center gap-2 px-3 pt-3 sm:px-4">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t("Highlighting where “{label}” is used.", { label: selectedLabel })}
          </p>
          <Button size="xs" variant="ghost" onClick={inspector.clear}>
            {t("Clear")}
          </Button>
        </div>
      ) : null}
      <ColorRow
        studio={studio}
        role="canvas"
        label={t("Background")}
        selected={selectedRole === "canvas"}
      />
      <ColorRow
        studio={studio}
        role="accent"
        label={t("Accent")}
        selected={selectedRole === "accent"}
      />
      <div className="px-3 py-2 sm:px-4">
        <Button
          aria-expanded={allOpen}
          size="xs"
          variant="ghost"
          onClick={() => {
            if (allOpen) inspector.clear();
            setAllOpenByHand(!allOpen);
          }}
        >
          {allOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
          {t("All colors")}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "Every role the app paints, grouped. Changing one also updates the roles that follow it.",
          )}
        </p>
      </div>
      {allOpen ? (
        <div className="space-y-4 py-3">
          {COLOR_GROUPS.map((group) => (
            <div className="space-y-1" key={group.id}>
              <h4 className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:px-4">
                {t(group.title)}
              </h4>
              {group.families.map((family) => (
                <ColorRow
                  key={family.id}
                  studio={studio}
                  role={family.role}
                  label={t(family.label, undefined, "theme color")}
                  selected={selectedRole === family.role}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function PresetCard({
  definition,
  active,
  modified,
  note,
  onUse,
  onHover,
}: {
  definition: ThemeDefinition;
  active: boolean;
  modified: boolean;
  note: string | null;
  onUse: () => void;
  onHover: (hovered: boolean) => void;
}) {
  const t = useT();
  const card = getThemeCardDefinition(definition);
  const panes = card.previews.flatMap((preview, index) =>
    preview.colors
      ? [
          {
            colors: preview.colors,
            ...(card.previews.length > 1
              ? { clip: index === 0 ? ("left" as const) : ("right" as const) }
              : {}),
          },
        ]
      : [],
  );
  return (
    <button
      aria-pressed={active}
      className={cn(
        "group flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border border-border/70 bg-card/40 p-2 text-left outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active && "border-ring bg-accent/20",
      )}
      data-theme-preset={definition.id}
      onBlur={() => onHover(false)}
      onClick={onUse}
      onFocus={() => onHover(true)}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      type="button"
    >
      <ThemeWireframe className="aspect-[16/10]" panes={panes} />
      <span className="flex min-w-0 items-center gap-1.5 px-0.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t(definition.label)}</span>
        {modified ? (
          <Badge size="sm" variant="warning">
            {t("Edited")}
          </Badge>
        ) : null}
        {active ? <CheckIcon aria-hidden className="size-3.5 shrink-0 text-foreground" /> : null}
      </span>
      {note ? <span className="px-0.5 text-xs text-muted-foreground">{note}</span> : null}
    </button>
  );
}

function PresetsSection({ studio }: { studio: Studio }) {
  const t = useT();
  const activeId = studio.working.basedOn ?? studio.working.id;
  const stock = STANDARD_THEME_CARDS[0]!;
  const stockActive = studio.applied === null && studio.draft === null;
  const needsBackground = new Set(
    THEME_PRESET_SEEDS.filter((seed) => seed.needsBackground).map((seed) => seed.id),
  );
  return (
    <SettingsSection id="theme-studio-presets" title="Presets">
      <div className="space-y-3 p-3 sm:p-4">
        <p className="text-xs text-muted-foreground">
          {t(
            "Hover to preview, click to use. Changing a preset afterwards saves your version as a scheme and leaves the preset as it is.",
          )}
        </p>
        <HalvesNotice studio={studio} />
        <div
          className="grid gap-2.5"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))" }}
        >
          <button
            aria-pressed={stockActive}
            className={cn(
              "flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border border-border/70 bg-card/40 p-2 text-left outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              stockActive && "border-ring bg-accent/20",
            )}
            data-theme-preset="default"
            onClick={() => studio.select(null)}
            type="button"
          >
            <ThemeWireframe
              className="aspect-[16/10]"
              panes={(["light", "dark"] as const).flatMap((mode) => {
                const colors = previewColorsOf(stock, mode);
                return colors
                  ? [{ colors, clip: mode === "light" ? ("left" as const) : ("right" as const) }]
                  : [];
              })}
            />
            <span className="flex items-center gap-1.5 px-0.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{stock.label}</span>
              {stockActive ? <CheckIcon aria-hidden className="size-3.5" /> : null}
            </span>
          </button>
          {[...studio.presets, ...BUILT_IN_THEMES].map((definition) => (
            <PresetCard
              active={activeId === definition.id}
              definition={definition}
              key={definition.id}
              modified={activeId === definition.id && studio.draft !== null}
              note={needsBackground.has(definition.id) ? t("Needs a background image") : null}
              onHover={(hovered) => studio.setHovered(hovered ? definition : null)}
              onUse={() => studio.select(definition.id)}
            />
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}

function FontsSection({ studio }: { studio: Studio }) {
  const t = useT();
  const look = studio.working.look;
  const overridden = overriddenSettings(look);
  const [ownOpen, setOwnOpen] = useState(false);
  return (
    <>
      <SettingsSection id="theme-studio-fonts" title="Fonts">
        <FontStackRow
          description={t(
            "The font for the interface and messages. Fonts must be installed on this device.",
          )}
          id="theme-studio-font-ui"
          onChange={(value) => studio.setLook("fontUi", value)}
          options={UI_FONT_OPTIONS}
          overridesSetting={overridden.includes("fontUi")}
          title={t("Interface font")}
          value={look?.fontUi}
        />
        <FontStackRow
          description={t("The font for code blocks and diffs.")}
          id="theme-studio-font-code"
          onChange={(value) => studio.setLook("fontCode", value)}
          options={CODE_FONT_OPTIONS}
          overridesSetting={overridden.includes("fontCode")}
          title={t("Code font")}
          value={look?.fontCode}
        />
        <div className="px-3 py-2 sm:px-4">
          <Button
            aria-expanded={ownOpen}
            size="xs"
            variant="ghost"
            onClick={() => setOwnOpen(!ownOpen)}
          >
            {ownOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            {t("Font sizes and your own fonts")}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Your own settings apply wherever the theme above leaves a font alone.")}
          </p>
        </div>
      </SettingsSection>
      {ownOpen ? <TypographySection /> : null}
    </>
  );
}

function LayoutSection({ studio }: { studio: Studio }) {
  const t = useT();
  const look = studio.working.look;
  const chatWidth = look?.chatWidth;
  return (
    <SettingsSection id="theme-studio-layout" title="Layout">
      <LookSlider
        description={t("How round corners are. 0 is square.")}
        id="theme-studio-radius"
        limit={THEME_LOOK_LIMITS.radius}
        onChange={(value) => studio.setLook("radius", value)}
        title={t("Corner radius")}
        unit=" px"
        value={look?.radius}
      />
      <LookSlider
        description={t("How much room there is between things. Lower is tighter.")}
        id="theme-studio-density"
        limit={THEME_LOOK_LIMITS.density}
        onChange={(value) => studio.setLook("density", value)}
        title={t("Density")}
        unit="%"
        value={look?.density}
      />
      <LookSlider
        description={t("How strong shadows are. 0 is flat.")}
        id="theme-studio-shadow"
        limit={THEME_LOOK_LIMITS.shadow}
        onChange={(value) => studio.setLook("shadow", value)}
        title={t("Shadow")}
        unit="%"
        value={look?.shadow}
      />
      <SettingsRow
        id="theme-studio-chat-width"
        title="Chat width"
        description={t("How wide messages and the composer can grow.")}
        status={
          chatWidth !== undefined ? (
            <Badge size="sm" variant="info">
              {t("Overrides your chat width setting")}
            </Badge>
          ) : null
        }
        resetAction={
          chatWidth !== undefined ? (
            <SettingResetButton
              label="Chat width"
              onClick={() => studio.setLook("chatWidth", undefined)}
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-40">
            <Select
              value={chatWidth ?? NO_FONT}
              onValueChange={(value) => {
                if (value === "comfortable" || value === "wide" || value === "full") {
                  studio.setLook("chatWidth", value);
                } else {
                  studio.setLook("chatWidth", undefined);
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={t("Chat width")}>
                <SelectValue>
                  {chatWidth === undefined ? t("Your setting") : t(CHAT_WIDTH_LABELS[chatWidth])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={NO_FONT}>{t("Your setting")}</SelectItem>
                <SelectItem value="comfortable">{t("Comfortable")}</SelectItem>
                <SelectItem value="wide">{t("Wide")}</SelectItem>
                <SelectItem value="full">{t("Full")}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />
    </SettingsSection>
  );
}

function BackgroundSection({ studio }: { studio: Studio }) {
  const t = useT();
  return (
    <SettingsSection id="theme-studio-background" title="Background">
      <SettingsRow
        id="theme-studio-background-image"
        title="Background image"
        description={
          studio.background
            ? t("This theme has a background image.")
            : t(
                "This theme has no background image. Ask an agent to set one with t3_theme_set, or copy a JPEG, PNG or WebP file of up to 16 MB next to the published theme file.",
              )
        }
        status={
          <Badge size="sm" variant={studio.background ? "success" : "outline"}>
            {studio.background ? t("In use") : t("None")}
          </Badge>
        }
      />
      <LookSlider
        description={t(
          "Makes the sidebar, header and composer see-through and blurs what is behind them. Only with a background image.",
        )}
        disabled={!studio.background}
        id="theme-studio-glass"
        limit={THEME_LOOK_LIMITS.glass}
        onChange={(value) => studio.setLook("glass", value)}
        title={t("Panel glass")}
        unit="%"
        value={studio.working.look?.glass}
      />
    </SettingsSection>
  );
}

function CssSection({ studio }: { studio: Studio }) {
  const t = useT();
  const css = studio.working.css ?? "";
  const [open, setOpen] = useState(css !== "");
  return (
    <SettingsSection id="theme-studio-css" title="Custom CSS">
      <div className="space-y-2 p-3 sm:p-4">
        <Button aria-expanded={open} size="xs" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          {open ? t("Hide CSS") : css ? t("Show CSS") : t("Add CSS")}
        </Button>
        {open ? (
          <>
            <p className="text-xs text-muted-foreground">
              {t(
                "Saved with this scheme and included when you export it. Web and desktop only. Rules that load remote files are ignored.",
              )}
            </p>
            <ThemeCssEditor onChange={studio.setCss} value={css} />
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function StudioHeader({ studio }: { studio: Studio }) {
  const t = useT();
  const { working } = studio;
  const kind = studioThemeKind({
    id: working.id,
    stock: studio.applied === null,
    presetIds: new Set(studio.presets.map((preset) => preset.id)),
    builtInIds: new Set(BUILT_IN_THEMES.map((theme) => theme.id)),
    savedIds: new Set(studio.customThemes.map((saved) => saved.id)),
  });
  const isPreset = kind === "preset";
  const customLook = working.look !== undefined;
  return (
    <div
      className="sticky top-0 z-10 -mx-1 rounded-xl border border-border/60 bg-background px-3 py-2.5 sm:px-4"
      data-theme-studio-header
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-48 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="min-w-0 truncate text-sm font-semibold">{studio.labelOf(working)}</h2>
            {studio.dirty ? (
              <Badge size="sm" variant="warning">
                {t("Unsaved changes")}
              </Badge>
            ) : (
              <Badge size="sm" variant="outline">
                {kind === "preset"
                  ? t("Preset")
                  : kind === "builtIn"
                    ? t("Built-in")
                    : kind === "default"
                      ? t("Default")
                      : kind === "scheme"
                        ? t("Scheme")
                        : t("Published")}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {studio.isFork
              ? studio.preset
                ? t("Saves as a new scheme based on {name}", {
                    name: studio.labelOf(studio.preset),
                  })
                : t("Saves as a new scheme")
              : studio.preset
                ? t("Based on {name}", { name: studio.labelOf(studio.preset) })
                : customLook
                  ? t("Fonts and layout come from this theme.")
                  : t("Fonts and layout come from your own settings.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {studio.preset && !isPreset ? (
            <Button size="xs" variant="outline" onClick={studio.restoreToPreset}>
              <Undo2Icon />
              {t("Restore to preset")}
            </Button>
          ) : null}
          <Button disabled={!studio.dirty} size="xs" variant="outline" onClick={studio.revert}>
            {t("Revert unsaved changes")}
          </Button>
          <Button
            disabled={studio.applied === null && studio.draft === null}
            size="xs"
            variant="outline"
            onClick={() => studio.select(null)}
          >
            <RotateCcwIcon />
            {t("Reset theme to default")}
          </Button>
          <Button disabled={!studio.dirty} size="xs" onClick={studio.apply}>
            {t("Apply")}
          </Button>
        </div>
      </div>
      {studio.saveFailed ? (
        <p aria-live="polite" className="mt-2 text-xs text-destructive">
          {t("Could not save the scheme. Browser storage may be unavailable or full.")}
        </p>
      ) : null}
    </div>
  );
}

export function ThemeStudioPanel() {
  const studio = useThemeStudio();
  return (
    <SettingsPageContainer>
      <StudioHeader studio={studio} />
      <PresetsSection studio={studio} />
      <ColorsSection studio={studio} />
      <FontsSection studio={studio} />
      <LayoutSection studio={studio} />
      <BackgroundSection studio={studio} />
      <CssSection studio={studio} />
      <MySchemes studio={studio} />
    </SettingsPageContainer>
  );
}
