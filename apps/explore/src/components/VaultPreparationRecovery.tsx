import { useState } from "react";
import { type InterruptedVaultPreparation, discardVaultPreparation, withVaultIntentLock } from "../vault-lock.ts";
import { friendlyError } from "../txErrors.ts";
import { Button } from "./ui.tsx";

export function VaultPreparationRecovery({ preparation, intentKey, onCleared, onError }: {
  preparation: InterruptedVaultPreparation | null;
  intentKey: string;
  onCleared: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (preparation === null) return null;
  return <Button variant="plain" busy={busy} onClick={() => {
    setBusy(true);
    void withVaultIntentLock(navigator.locks, intentKey, async () => {
      if (!(await discardVaultPreparation(localStorage, intentKey, preparation.id)))
        throw new Error("The saved position action changed. Reload to reconcile it; nothing was discarded.");
      onCleared();
    }).catch(failure => onError(friendlyError(failure))).finally(() => setBusy(false));
  }}>Discard interrupted preparation</Button>;
}
