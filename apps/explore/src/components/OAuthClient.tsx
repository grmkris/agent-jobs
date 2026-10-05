export interface OAuthClientIdentity {
  clientId: string;
  clientName: string;
  redirectUri: string;
}

/** Public client names are self-declared; the bound callback identifies the recipient. */
export function OAuthClient({ client }: { client: OAuthClientIdentity }) {
  return (
    <div className="rounded-lg border border-sep p-3 text-sm">
      <p className="font-semibold">Requesting client</p>
      <p>{client.clientName} <span className="text-label-2">(unverified name)</span></p>
      <p className="break-all text-label-2">Client ID: {client.clientId}</p>
      <p className="break-all text-label-2">Callback: {client.redirectUri}</p>
    </div>
  );
}
