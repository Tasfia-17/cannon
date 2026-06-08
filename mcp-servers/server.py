"""
Cannon MCP Tool Server
Exposes 4 read-only tools to TrueFoundry MCP Gateway:
  - search_logs
  - query_metrics
  - query_traces
  - read_runbook

Runs as a FastMCP HTTP server. Register with TFY MCP Gateway
at: AI Gateway > MCP > Deploy from Code.
"""
import os
import httpx
from pathlib import Path
from fastmcp import FastMCP

CLUSTER_URL = os.getenv("MOCK_CLUSTER_URL", "http://127.0.0.1:7100").rstrip("/")
RUNBOOKS_DIR = Path(os.getenv("RUNBOOKS_DIR", "./runbooks"))

mcp = FastMCP("cannon-tools")


@mcp.tool()
async def search_logs(service: str = "", q: str = "", limit: int = 50) -> str:
    """Search structured logs from the mock cluster."""
    params: dict = {"limit": limit}
    if service:
        params["service"] = service
    if q:
        params["q"] = q
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{CLUSTER_URL}/logs", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def query_metrics(service: str = "") -> str:
    """Get Prometheus-format metrics from the mock cluster."""
    params = {"service": service} if service else {}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{CLUSTER_URL}/metrics", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def query_traces(service: str = "") -> str:
    """Get recent spans/traces from the mock cluster."""
    params = {"service": service} if service else {}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{CLUSTER_URL}/traces", params=params)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def read_runbook(service: str) -> str:
    """Read the runbook for a given service (api, worker, db_proxy, auth)."""
    safe = service.replace("/", "").replace("..", "")
    path = RUNBOOKS_DIR / f"{safe}.md"
    if not path.exists():
        return f"No runbook found for service '{service}'."
    return path.read_text()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8100"))
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
