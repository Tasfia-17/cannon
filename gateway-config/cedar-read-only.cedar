# Cannon — Cedar policy for TrueFoundry MCP Gateway
# Enforces read-only tool access at the gateway layer.
# Only the 4 approved read tools are permitted. Everything else is denied by default.

// Permit only Cannon's approved read-only tools
permit(
  principal,
  action == Action::"mcp:invoke-tool",
  resource
) when {
  context.tool_name in [
    "search_logs",
    "query_metrics",
    "query_traces",
    "read_runbook"
  ]
};

// Explicitly forbid anything that looks like a write — belt and suspenders
forbid(
  principal,
  action == Action::"mcp:invoke-tool",
  resource
) when {
  context.tool_name.contains("write") ||
  context.tool_name.contains("delete") ||
  context.tool_name.contains("update") ||
  context.tool_name.contains("insert") ||
  context.tool_name.contains("exec")
};
