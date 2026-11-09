FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 PORT=8000 DATA_DIR=/data
LABEL org.opencontainers.image.title="MeshWars Route Planner" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 planner \
    && useradd --uid 10001 --gid planner --no-create-home planner \
    && mkdir /data && chown planner:planner /data
COPY *.py LICENSE ./
COPY static/ ./static/
ARG APP_REVISION=development
ARG APP_CHANGES=[]
ENV APP_REVISION=${APP_REVISION} APP_CHANGES=${APP_CHANGES}
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).read()"]
CMD ["python", "hosting.py"]

FROM base AS test
COPY tests/ ./tests/
RUN python -m unittest discover -s tests
RUN python tests/smoke_hosting.py

FROM base AS production
