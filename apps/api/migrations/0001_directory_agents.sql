CREATE TABLE IF NOT EXISTS directory_agents (
chain_id INTEGER NOT NULL,
registry TEXT NOT NULL,
agent_key TEXT NOT NULL,
agent_id TEXT NOT NULL,
audience TEXT NOT NULL,
enrolled INTEGER NOT NULL,
revision INTEGER NOT NULL,
projection_at INTEGER NOT NULL,
json TEXT NOT NULL,
PRIMARY KEY (chain_id, registry, audience, agent_key)
  );
