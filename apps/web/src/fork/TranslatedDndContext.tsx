import { DndContext, type DndContextProps, type Announcements } from "@dnd-kit/core";

import { useT } from "~/hooks/useT";

/** `DndContext` whose screen reader instructions and announcements follow the interface language. */
export function TranslatedDndContext(props: DndContextProps) {
  const t = useT();
  const accessibility = (): NonNullable<DndContextProps["accessibility"]> => {
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
    return {
      announcements,
      screenReaderInstructions: {
        draggable: t(
          "To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.",
        ),
      },
    };
  };
  return <DndContext accessibility={accessibility()} {...props} />;
}
