# StoryForge container image (M08-J01). Build from the repository root:   docker build -f deploy/Dockerfile -t storyforge .
# (deploy/compose.yaml does that for you.) Nothing the author wrote lives in the image: the library, the per-user config and the shared-mode accounts
# are three volumes (see VOLUME below).
#
# Base image: node:24-bookworm-slim. To pin it by digest for a release, look the digest up once and put it in both FROM lines:
#   docker buildx imagetools inspect node:24-bookworm-slim      then      FROM node:24-bookworm-slim@sha256:<digest shown>
# The tag stays in the line so that a human can read what the digest is.

# ---- build stage: install everything, build the web app, then drop the development dependencies
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

# ---- runtime stage: the built tree with production node_modules only
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    STORYFORGE_MODE=shared \
    STORYFORGE_PORT=4317 \
    STORYFORGE_LIBRARY=/library \
    STORYFORGE_SHARED_DATA=/shared-data \
    XDG_CONFIG_HOME=/config
WORKDIR /app
# the app directory belongs to root and is only read by the server user (read-only application code)
COPY --from=build /app /app
RUN groupadd --gid 10001 storyforge \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin storyforge \
 && mkdir -p /library /config /shared-data \
 && chown 10001:10001 /library /config /shared-data
VOLUME ["/library", "/config", "/shared-data"]
USER 10001:10001
EXPOSE 4317
# curl is not in the slim image. The shared-mode gate checks the Host header, so the check sends the one the server expects (the public URL's, else the bind address).
# In shared mode /api/health answers 401 until someone is signed in: any answer that is not a refusal of the Host (403) or an error counts as alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const e=process.env,p=e.STORYFORGE_PORT||'4317',m=e.STORYFORGE_MODE||'shared',h=e.STORYFORGE_HOST||(m==='personal'?'127.0.0.1':'0.0.0.0'),H=m==='shared'&&e.STORYFORGE_PUBLIC_URL?new URL(e.STORYFORGE_PUBLIC_URL).host:h+':'+p;require('node:http').get({host:'127.0.0.1',port:p,path:'/api/health',headers:{host:H},timeout:4000},r=>process.exit(r.statusCode===200||r.statusCode===401?0:1)).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy()})"
ENTRYPOINT ["node", "deploy/entrypoint.mjs"]
