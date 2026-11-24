FROM node:22-slim
WORKDIR /app
COPY package.json server.js db.js mail.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node","server.js"]
