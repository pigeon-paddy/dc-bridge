FROM node:20-alpine

WORKDIR /app

COPY ./build/package*.json ./

RUN npm ci --omit=dev

COPY ./src/ ./
RUN chmod +x ./*.js