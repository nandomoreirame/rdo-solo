# Build the Next app, then run the custom server (Next + WebSocket) in a slim
# image. This container drives the HOST firewall, so it must run with
# network_mode: host + privileged and the host binary/state mounted in
# (see docker-compose.yml). iptables/iproute2/procps are the tools rdo-solo-tui
# shells out to.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables iproute2 procps tcpdump curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src ./src
EXPOSE 3737
CMD ["npm", "run", "start"]
