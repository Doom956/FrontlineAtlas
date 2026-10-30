# Frontline Atlas: client + multiplayer server in one image.
#   docker build -t frontline-atlas .
#   docker run -p 8080:8080 frontline-atlas -> http://localhost:8080
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Builds dist/ (the client, one HTML file) and server-dist/index.js (the server).
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
USER node
EXPOSE 8080
CMD ["node", "server-dist/index.js"]
