# Mock service cluster: api / worker / db_proxy / auth + gateway. All five
# uvicorn procs share localhost inside the container; only the gateway port
# (7100) needs to be exposed to the orchestrator.
FROM python:3.13-slim AS base

# uv handles install fast and respects uv.lock for reproducible builds.
RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src

# --system installs into the container's Python directly (no venv layer to
# activate from CMD). Optional `dev` extras aren't pulled in unless requested.
RUN uv pip install --system --no-cache .

EXPOSE 7100 7101 7102 7103 7104
CMD ["cluster"]
