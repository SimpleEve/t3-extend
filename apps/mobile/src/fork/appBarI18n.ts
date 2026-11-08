// fork: i18n. AppBar draws the labels, menus and actions that screens hand it; translating them
// here, once, keeps upstream's screens free of t() for copy that only the bar renders.
import type { Translator } from "@t3tools/client-runtime/i18n";

import type {
  AppBarAction,
  AppBarMenu,
  AppBarMenuItem,
  AppBarProps,
} from "../components/ui/AppBar.types";

function localizeAction<A extends Pick<AppBarAction, "accessibilityLabel" | "subtitle">>(
  action: A,
  t: Translator,
): A {
  return {
    ...action,
    accessibilityLabel: t(action.accessibilityLabel),
    ...(action.subtitle === undefined ? undefined : { subtitle: t(action.subtitle) }),
  };
}

function localizeItem(item: AppBarMenuItem, t: Translator): AppBarMenuItem {
  if ("items" in item) {
    return {
      ...item,
      ...(item.title === undefined ? undefined : { title: t(item.title) }),
      items: item.items.map((child) => localizeItem(child, t)),
    };
  }
  return {
    ...item,
    title: t(item.title),
    ...(item.subtitle === undefined ? undefined : { subtitle: t(item.subtitle) }),
  };
}

function localizeMenu(menu: AppBarMenu, t: Translator): AppBarMenu {
  return {
    ...menu,
    title: t(menu.title),
    ...(menu.status === undefined ? undefined : { status: t(menu.status) }),
    items: menu.items.map((item) => localizeItem(item, t)),
  };
}

export function localizeAppBarProps<P extends AppBarProps>(props: P, t: Translator): P {
  const { actions, refresh, menus, search, confirm, closeAccessibilityLabel, backInSplitView } =
    props;
  return {
    ...props,
    ...(actions && { actions: actions.map((action) => localizeAction(action, t)) }),
    ...(refresh && { refresh: localizeAction(refresh, t) }),
    ...(menus && { menus: menus.map((menu) => localizeMenu(menu, t)) }),
    ...(search && {
      search: {
        ...search,
        placeholder: t(search.placeholder),
        ...(search.accessibilityLabel && { accessibilityLabel: t(search.accessibilityLabel) }),
        ...(search.compactPlaceholder && { compactPlaceholder: t(search.compactPlaceholder) }),
        ...(search.closeAccessibilityLabel && {
          closeAccessibilityLabel: t(search.closeAccessibilityLabel),
        }),
        ...(search.clearAccessibilityLabel && {
          clearAccessibilityLabel: t(search.clearAccessibilityLabel),
        }),
      },
    }),
    ...(confirm && { confirm: { ...confirm, label: t(confirm.label) } }),
    ...(closeAccessibilityLabel && { closeAccessibilityLabel: t(closeAccessibilityLabel) }),
    ...(backInSplitView && {
      backInSplitView: {
        ...backInSplitView,
        accessibilityLabel: t(backInSplitView.accessibilityLabel),
      },
    }),
  };
}
