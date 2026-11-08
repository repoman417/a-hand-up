# A Hand Up — anonymous giving app
FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .
RUN bun run build

# On Render the persistent disk is mounted at /var/data; locally the app
# defaults to ./data/app.db. Override with DATABASE_PATH.
ENV DATABASE_PATH=/var/data/app.db
EXPOSE 3000
CMD ["bun", "run", "start"]
