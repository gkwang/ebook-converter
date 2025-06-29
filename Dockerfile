FROM cgr.dev/chainguard/node:latest AS build

#RUN apk add --no-cache unzip

#RUN mkdir /app
WORKDIR /app
COPY --chown=node:node package.json .
COPY --chown=node:node package-lock.json .
RUN npm ci 
COPY --chown=node:node src src
COPY --chown=node:node server server
COPY --chown=node:node bin bin

RUN chown -R node:node server/uploads
USER node
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["server/index.js"]
