import type { MenuAction } from "@react-native-menu/menu";
import type { AppBarMenuItem } from "./AppBar.types";

/** Adapts a `MenuAction` tree and its selection handler to `AppBar` menu items. */
export function appBarMenuItemsFromActions(
  actions: ReadonlyArray<MenuAction>,
  onSelect: (id: string) => void,
): AppBarMenuItem[] {
  return actions.map((action, index) => {
    const id = action.id ?? String(index);
    return action.subactions?.length
      ? {
          id,
          title: action.title,
          icon: action.image,
          verbatim: true, // fork: i18n, a MenuAction is localized by whoever built it
          items: appBarMenuItemsFromActions(action.subactions, onSelect),
        }
      : {
          id,
          title: action.title,
          subtitle: action.subtitle,
          verbatim: true, // fork: i18n
          icon: action.image,
          iconColor: action.imageColor,
          selected: action.state === "on",
          disabled: action.attributes?.disabled,
          onPress: () => onSelect(id),
        };
  });
}
