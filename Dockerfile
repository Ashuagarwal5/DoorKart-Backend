FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Generate explicitly after the schema is copied; do not run postinstall yet.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run prisma:generate -- --config prisma7.config.ts && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=4000 UPLOAD_DIR=/app/uploads
# Keep Prisma/tsx tooling for migrations, seeding, and admin creation.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package*.json /app/prisma7.config.ts /app/tsconfig.json ./
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
