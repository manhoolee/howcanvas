FROM docker.m.daocloud.io/library/node:22-bookworm-slim

WORKDIR /app
RUN sed -i \
        -e 's|http://deb.debian.org/debian|http://mirrors.cloud.tencent.com/debian|g' \
        -e 's|http://security.debian.org/debian-security|http://mirrors.cloud.tencent.com/debian-security|g' \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server/requirements-grok.txt ./
RUN pip3 install --no-cache-dir --break-system-packages \
    --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    -r requirements-grok.txt
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/*.mjs ./
COPY server/*.py ./

ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.mjs"]
