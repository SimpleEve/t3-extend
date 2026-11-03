// fork: the route for the phone's "Your server" page, kept here so Stack.tsx carries one line.
import { createNativeStackScreen } from "@react-navigation/native-stack";
import { getUiLocale, translate } from "@t3tools/client-runtime/i18n";

import { ServerDevicesScreen } from "./ServerDevicesScreen";

export const serverDevicesScreen = (options: object) =>
  createNativeStackScreen({
    screen: ServerDevicesScreen,
    linking: "settings/server",
    options: {
      ...options,
      get title() {
        return translate(getUiLocale(), "Your server");
      },
    },
  });
