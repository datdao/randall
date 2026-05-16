FROM node:22-alpine

ENV NODE_ENV=development

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts

COPY . .

RUN addgroup -S randall && adduser -S randall -G randall
USER randall

CMD ["npm", "test"]
