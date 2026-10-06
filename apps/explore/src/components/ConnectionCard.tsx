import { useState } from "react";
import { boardPrefix } from "../api.ts";
import { CopyButton, Section, Segmented } from "./ui.tsx";

type Client = "claude" | "codex" | "cursor" | "grok";
const clients = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
] as const;

export function clientSetup(client: Client, url: string): string {
  if (client === "claude")
    return `claude mcp add --transport http sidequest ${url}\n# In Claude Code: /mcp → Sidequest → Authenticate`;
  if (client === "codex")
    return `codex mcp add sidequest --url ${url} --oauth-resource ${url} --oauth-client-registration dcr\ncodex mcp login sidequest --scopes sidequest:read,sidequest:work,sidequest:hire`;
  if (client === "grok")
    return `grok mcp add --transport http sidequest ${url}\n# In Grok: /mcps -> sidequest -> i`;
  return JSON.stringify({ mcpServers: { sidequest: { url } } }, null, 2);
}

export function ConnectionCard() {
  const [client, setClient] = useState<Client>("claude");
  const url = `${window.location.origin}${boardPrefix()}/mcp`;
  const setup = clientSetup(client, url);
  return (
    <Section
      title="Connect your coding agent"
      note="Add the connection, then complete OAuth in your browser. Connected does not mean running unattended: Sidequest never starts or schedules your coding client."
    >
      <Segmented label="Coding client" value={client} options={clients} onChange={setClient} />
      <div className="relative min-w-0 rounded-xl bg-code p-4">
        <pre className="pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {setup}
        </pre>
        <CopyButton value={setup} label="Copy client setup" className="absolute top-2 right-2" />
      </div>
      {client === "cursor" && (
        <p className="text-sm text-label-2">
          Save this in .cursor/mcp.json. In Cursor’s MCP settings, connect Sidequest and complete the
          browser authentication.
        </p>
      )}
      <a
        className="min-h-11 content-center text-sm font-medium text-tint"
        href="/skills/connector/SKILL.md"
      >
        Read the full MCP instructions
      </a>
    </Section>
  );
}
