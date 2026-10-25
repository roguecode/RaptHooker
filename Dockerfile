# RaptHooker in Docker. Bluetooth comes from the host's BlueZ through its D-Bus socket (see docs/docker.md).
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY src/shared/package.json src/shared/
COPY src/server/package.json src/server/
COPY src/web/package.json src/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /src/src/server/dist/*.cjs server/
COPY --from=build /src/src/web/dist web/dist
COPY deploy/docker/rapthooker.config.json /app/rapthooker.config.json
ENV NODE_ENV=production \
    RAPTHOOKER_CONFIG=/app/rapthooker.config.json
VOLUME /data
EXPOSE 8080
CMD ["node", "server/rapthooker.cjs"]
