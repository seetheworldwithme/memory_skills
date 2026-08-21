# memory-skills 可发布运行形态（Task 18）：
# - 多阶段构建：deps（lockfile 缓存）→ build（tsc + vite）→ runtime（仅 3 个运行时依赖 + 构建产物）
# - 运行层非 root（官方镜像内置 node 用户，uid 1000），数据目录 /app/data 显式挂载
# - 同一镜像两种角色：默认 CMD 为 api 服务（dist/server.js），
#   远程 MCP 角色由 compose 覆盖 command 为 dist/adapters/mcp/http-server.js
# - 基础镜像必须 >= 22.16（node:sqlite 与 --env-file-if-exists 的 engines 要求）

# ---- 依赖层：只拷 lockfile，最大化构建缓存命中 ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm ci && npm --prefix web ci

# ---- 构建层：编译服务端（tsc）与 Web 控制台（vite） ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web/index.html web/tsconfig.json web/vite.config.ts ./web/
COPY web/src ./web/src
RUN npm run build

# ---- 运行层：最小产物 + 非 root ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# 容器内必须监听 0.0.0.0 才能被端口映射命中；宿主侧的暴露面由 compose 端口绑定决定
ENV NODE_ENV=production \
    MEMORY_SKILLS_HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
# backup.mjs 纯 node 可跑；restore.mjs 依赖 tsx，恢复操作在宿主机源码环境执行（见 docs/operations.md）
COPY scripts/backup.mjs ./scripts/backup.mjs
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8421 8422
VOLUME /app/data
# slim 镜像无 curl/wget，用 node 内置 fetch 探测 /health（无认证、不泄漏配置）；
# 端口取 MEMORY_SKILLS_PORT（api 角色默认 8421，MCP 角色容器把该变量设为其端口）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MEMORY_SKILLS_PORT||'8421')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
