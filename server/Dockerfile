FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get -o Acquire::ForceIPv4=true update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server/requirements-grok.txt ./
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip3 install --no-cache-dir --break-system-packages \
    --index-url "${PIP_INDEX_URL}" \
    -r requirements-grok.txt
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/*.mjs ./
COPY server/*.py ./

ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.mjs"]
