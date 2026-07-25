FROM node:20-alpine

WORKDIR /app

# No npm install needed — proxy uses only Node.js built-in modules
COPY package.json ./
COPY server.js    ./

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
