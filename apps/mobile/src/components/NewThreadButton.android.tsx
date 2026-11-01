import type { ComponentProps } from "react";
import { FloatingActionButton } from "./ui/FloatingActionButton.android";
import { ScrollComposeButton } from "./ScrollComposeButton.android";
import type { NewThreadButton as SharedNewThreadButton } from "./NewThreadButton.shared";
import { useT } from "../hooks/useT"; // fork: i18n

export function NewThreadButton(props: ComponentProps<typeof SharedNewThreadButton>) {
  const t = useT(); // fork: i18n
  if (props.extended && props.expanded !== undefined) {
    return <ScrollComposeButton {...props} expanded={props.expanded} />;
  }
  return (
    <FloatingActionButton
      {...props}
      icon="square.and.pencil"
      label={t("New thread")}
      tone="primary"
      variant={props.extended ? "extended" : "large"}
    />
  );
}
