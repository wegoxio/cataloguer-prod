# Build stage
FROM node:22-slim AS build
WORKDIR /app
# Pinned global install instead of corepack: corepack's signature-key
# rotations have broken builds before, and this stays reproducible.
RUN npm install -g pnpm@11.17.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && pnpm prune --prod

# Runtime stage (the container runtime supplies PORT; main.ts reads it)
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# --chown=node:node: the runtime user must be able to read EVERYTHING it
# serves. COPY preserves source modes, and a build context whose files lost
# group/other read bits (a umask-masked tar extract did exactly that on
# 2026-08-10) otherwise produces root-owned 600 assets — compiled JS is
# regenerated inside the builder and stays readable, but nest's copied
# template assets kept the stripped modes and invite emails failed with
# EACCES on welcome-email.html at runtime.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
# Build-time probe AS THE RUNTIME USER: the image is unbuildable unless the
# mail template is readable, so the EACCES class can never reach a deploy.
RUN node -e "require('fs').readFileSync('/app/dist/modules/mail/templates/welcome-email.html'); console.log('mail template readable by runtime user')"
CMD ["node", "dist/main.js"]
