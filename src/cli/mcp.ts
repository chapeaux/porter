export async function cmdMcp(_args: string[]): Promise<void> {
  const { runStdioMcpServer } = await import("../mcp/mcp_server.ts");

  console.error("[porter] Starting MCP server (stdio mode)...");
  console.error("[porter] Editors can connect via stdio transport.");

  await runStdioMcpServer();
}
