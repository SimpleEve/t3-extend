import type { ReactElement } from "react";
import { Sheet } from "../../components/ui/Sheet";
import { useT } from "../../hooks/useT"; // fork: i18n

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose }: WorktreeSetupSheetProps) {
  const t = useT();
  return (
    <Sheet title={t("Worktree setup")} onClose={onClose}>
      {children}
    </Sheet>
  );
}
