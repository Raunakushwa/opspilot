# Python AI service. uv installs from the lockfile into a project venv, which is
# then copied into a slim runtime image.
ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim-bookworm AS builder
# uv from PyPI rather than its own image: one base image for both stages and
# one fewer registry to depend on.
RUN pip install --no-cache-dir uv==0.11.27
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
# Dependencies before source: application edits do not re-resolve the venv.
COPY apps/ai-service/pyproject.toml apps/ai-service/uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev
COPY apps/ai-service/src ./src
RUN uv sync --frozen --no-dev

FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH=/app/.venv/bin:$PATH
RUN useradd --create-home --uid 10001 opspilot
# The model cache is a mounted volume; Docker copies this directory's ownership
# to the volume on first use, so it must exist and belong to the app user.
RUN mkdir -p /home/opspilot/.cache && chown -R opspilot:opspilot /home/opspilot
ENV HF_HOME=/home/opspilot/.cache/huggingface \
    FASTEMBED_CACHE_PATH=/home/opspilot/.cache/fastembed
WORKDIR /app
COPY --from=builder --chown=opspilot:opspilot /app /app
USER opspilot
CMD ["uvicorn", "opspilot_ai.main:app", "--host", "0.0.0.0", "--port", "8000"]
