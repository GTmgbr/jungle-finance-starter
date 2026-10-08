FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY tsconfig*.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.2
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["sh", "-c", "bun dist/database/migrate.js && exec bun dist/main.js"]
