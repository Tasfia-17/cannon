FROM python:3.11-slim
WORKDIR /app
RUN pip install uv
COPY pyproject.toml ./
RUN uv pip install --system -r pyproject.toml 2>/dev/null || pip install fastmcp httpx
COPY server.py ./
EXPOSE 8100
CMD ["python", "server.py"]
