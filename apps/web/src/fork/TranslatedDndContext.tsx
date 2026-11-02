import { DndContext, type Announcements, type DndContextProps } from "@dnd-kit/core";
import type { Translator } from "@t3tools/client-runtime/i18n";

import { useT } from "~/hooks/useT";

type Accessibility = NonNullable<DndContextProps["accessibility"]>;

// `useT` returns one translator per locale, so this builds the default text once per language.
// Sidebar rows share one context, and a drag must not rebuild these on every render.
const translatedByTranslator = new WeakMap<Translator, Accessibility>();

function translatedAccessibility(t: Translator): Accessibility {
  const cached = translatedByTranslator.get(t);
  if (cached) return cached;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("Picked up draggable item {id}.", { id: String(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? t("Draggable item {id} was moved over droppable area {over}.", {
            id: String(active.id),
            over: String(over.id),
          })
        : t("Draggable item {id} is no longer over a droppable area.", {
            id: String(active.id),
          }),
    onDragEnd: ({ active, over }) =>
      over
        ? t("Draggable item {id} was dropped over droppable area {over}.", {
            id: String(active.id),
            over: String(over.id),
          })
        : t("Draggable item {id} was dropped.", { id: String(active.id) }),
    onDragCancel: ({ active }) =>
      t("Dragging was cancelled. Draggable item {id} was dropped.", { id: String(active.id) }),
  };
  const built: Accessibility = {
    announcements,
    screenReaderInstructions: {
      draggable: t(
        "To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.",
      ),
    },
  };
  translatedByTranslator.set(t, built);
  return built;
}

const definedEntries = <T extends object>(value: T | undefined): Partial<T> =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(([, field]) => field !== undefined),
  ) as Partial<T>;

const mergedByCaller = new WeakMap<Accessibility, WeakMap<Accessibility, Accessibility>>();

/** The translated defaults, with a caller's own `accessibility` winning only where it sets a field. */
export function resolveDndAccessibility(
  t: Translator,
  caller: DndContextProps["accessibility"],
): Accessibility {
  const translated = translatedAccessibility(t);
  if (caller === undefined) return translated;
  let byTranslated = mergedByCaller.get(caller);
  if (!byTranslated) {
    byTranslated = new WeakMap();
    mergedByCaller.set(caller, byTranslated);
  }
  const cached = byTranslated.get(translated);
  if (cached) return cached;
  const merged: Accessibility = {
    ...translated,
    ...definedEntries(caller),
    // dnd-kit types these as complete, but a caller can still leave a field unset at runtime.
    announcements: {
      ...translated.announcements,
      ...definedEntries(caller.announcements),
    } as Announcements,
    screenReaderInstructions: {
      ...translated.screenReaderInstructions,
      ...definedEntries(caller.screenReaderInstructions),
    } as NonNullable<Accessibility["screenReaderInstructions"]>,
  };
  byTranslated.set(translated, merged);
  return merged;
}

/** `DndContext` whose screen reader instructions and announcements follow the interface language. */
export function TranslatedDndContext(props: DndContextProps) {
  const t = useT();
  return <DndContext {...props} accessibility={resolveDndAccessibility(t, props.accessibility)} />;
}
