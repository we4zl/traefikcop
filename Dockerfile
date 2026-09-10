FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
ENV NODE_ENV=production TRAEFIKCOP_DATA_DIR=/data LISTEN_ADDRESS=0.0.0.0 PORT=3001
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "server.mjs"]
