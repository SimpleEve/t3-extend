// fork: the account chip and pace labels the Usage screen and the compact account list share. A leaf
// module, so the list does not have to import the screen that renders it.
import { msg } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";

export const PACE_LABEL = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
} as const;

export function emailInitials(email: string) {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
}

function accountHue(email: string) {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

// Same hashed hue as the web account chip, so an account keeps its color across clients.
export function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <View
      className="size-5 items-center justify-center rounded-full"
      style={{ backgroundColor: `hsl(${hue}, 45%, 82%)` }}
    >
      <Text className="text-[9px] font-t3-bold" style={{ color: `hsl(${hue}, 45%, 28%)` }}>
        {emailInitials(email)}
      </Text>
    </View>
  );
}
