# Aftercare application VM (Vultr instance 1).
# The server runs TypeScript through tsx, so devDependencies are needed at runtime.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

# SQLite lives on a mounted volume so a container rebuild never loses demo history.
ENV DATABASE_PATH=/data/aftercare.sqlite
VOLUME ["/data"]

# Bind to every interface inside the container; the reverse proxy is the public edge.
ENV HOST=0.0.0.0
ENV PORT=4317
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4317/api/health || exit 1

CMD ["npm", "start"]
