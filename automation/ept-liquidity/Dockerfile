FROM node:24-bookworm-slim
WORKDIR /app
COPY automation/ept-liquidity/server.mjs automation/ept-liquidity/test.mjs ./
RUN node --test test.mjs
ENV PORT=8080 WHP_LIQUIDITY_ENVIRONMENT=LIVE WHP_LIQUIDITY_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.mjs"]
