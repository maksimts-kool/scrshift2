FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

# The image already contains the matching browsers and Linux dependencies.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci

COPY scripts/realtime ./scripts/realtime
RUN mkdir -p /data/profile

ENV NODE_ENV=production \
    RT_MODE=hosted \
    RT_HOST=0.0.0.0 \
    RT_PROFILE=/data/profile

EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/rt/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/realtime/server.mjs"]
