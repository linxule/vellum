function mcpHeaders(sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
  }
  if (sessionId) h['Mcp-Session-Id'] = sessionId
  return h
}

export function jsonrpcResponse(id: string | number | null | undefined, result: unknown, sessionId?: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), {
    headers: mcpHeaders(sessionId),
  })
}

export function jsonrpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  httpStatus = 200,
  extraHeaders: Record<string, string> = {},
  data?: unknown,
): Response {
  // JSON-RPC 2.0 over HTTP: errors are returned as HTTP 200 with the error
  // inside the envelope. HTTP 400 caused Claude Desktop to treat the response
  // as a transport failure rather than a structured error.
  // Exception: session-related errors use HTTP 404 per MCP Streamable HTTP
  // spec, which signals the client to re-initialize the session.
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }), {
    status: httpStatus,
    headers: { ...mcpHeaders(), ...extraHeaders },
  })
}
