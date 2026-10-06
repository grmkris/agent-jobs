export interface OAuthClientIdentity {
  clientId: string
  clientName: string
  redirectUri: string
}

/** Public client names are self-declared; the bound callback identifies the recipient. */
export function OAuthClient({ client }: { client: OAuthClientIdentity }) {
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <p className="font-semibold">Requesting client</p>
      <p>
        {client.clientName} <span className="text-muted-foreground">(unverified name)</span>
      </p>
      <p className="break-all text-muted-foreground">Client ID: {client.clientId}</p>
      <p className="break-all text-muted-foreground">Callback: {client.redirectUri}</p>
    </div>
  )
}
