import type { ComponentProps } from "react";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { useT } from "../../hooks/useT";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  const t = useT();
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? t("Continue with ChatGPT")}
    </Button>
  );
}
