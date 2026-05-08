FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/ui ./ui
COPY --from=builder /app/personas ./personas
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/bin/cli.js"]
