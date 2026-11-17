// fork: the one action a forwarding card leads with (today: allowing a port), its note and its
// error, drawn under the card's description by `PreviewUnreachable`.
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

export interface GatewayAction {
  readonly label: string;
  readonly onAction: () => void;
  readonly pending: boolean;
  readonly note: string;
  /** One line shown when the last attempt failed. */
  readonly error: string | null;
}

export function GatewayActionBlock({ action }: { readonly action: GatewayAction }) {
  return (
    <div className="mt-6 flex flex-col items-start gap-2">
      <Button type="button" size="sm" disabled={action.pending} onClick={action.onAction}>
        {action.pending ? <Spinner size="sm" /> : null}
        {action.label}
      </Button>
      <p className="text-xs text-muted-foreground">{action.note}</p>
      {action.error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {action.error}
        </p>
      )}
    </div>
  );
}
