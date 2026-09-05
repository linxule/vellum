import { CONTRACT, SERVER_VERSION } from '../worker/src/contract'
import { renderAgents } from '../worker/src/discovery'

await Bun.write(new URL('../AGENTS.md', import.meta.url), renderAgents())
await Bun.write(new URL('../worker/server.json', import.meta.url), JSON.stringify({
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'io.github.linxule/vellum', description: CONTRACT.description, version: SERVER_VERSION,
  websiteUrl: CONTRACT.origin, remotes: [{ type: 'streamable-http', url: `${CONTRACT.origin}/mcp` }],
}, null, 2) + '\n')
