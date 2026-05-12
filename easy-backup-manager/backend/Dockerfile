FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl sqlite
COPY package*.json ./
RUN npm install

FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm install
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
EXPOSE 4100
CMD ["sh", "-c", "npm run prisma:migrate && node dist/server.js"]
