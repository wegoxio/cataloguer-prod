# Wegox Catalog

> Commercial name: **Wegox Catalog** (wegoxcatalog.com) · internal repo codename: `cataloguer`

A standalone product catalogue platform: the **single source of truth** behind a client's consumer
website (catalog-only — no checkout). Admins manage categories, products,
variants and images here; the website reads everything through a rate-limited, read-only
**Catalogue API** secured with revocable API keys (ADR 005). Built to be sold to multiple clients
as one deployment per client.

## Features

- **Catalog management**: hierarchical categories, products with pricing/sale price/stock,
  variants with free-form attributes, soft archive/restore everywhere.
- **Images**: drag & drop upload with automatic browser-side optimization (resize + WebP,
  hard 500 KB cap) direct to Supabase Storage via signed URLs.
- **SEO fields**: `metaTitle` / `metaDescription` on products and categories, exposed to the
  website through the Public API.
- **Bulk operations**: archive/restore/publish/draft/category/stores/pricing/inventory over any
  selection, with per-product failure reporting; plus **website publication** — publish or hide
  the selection on one website without touching membership, branch prices or stock (ADR 029).
- **Import / Export**: native CSV round-trip plus a **legacy-store importer** (standard legacy
  export: simple/variable products, variations, category trees, image URLs — idempotent).
- **Users & security**: role hierarchy (SUPER_ADMIN > ADMIN > EDITOR > VIEWER), argon2 passwords,
  short-lived JWTs with rotating httpOnly refresh tokens (reuse detection), rate limiting,
  self-service password change, full audit log of every write.
- **Website module**: configurable site URL + URL patterns power "View on site" links and a
  live-visibility overview.

## Stack

**Frontend**: Next.js (App Router), TypeScript, Tailwind CSS (shared UI kit in `components/ui`),
React Hook Form + Zod. **Backend**: NestJS, MikroORM, PostgreSQL. **Infra** (ADR 006): Vercel
(frontend and backend), PostgreSQL and Redis on AWS Lightsail, S3 storage, and Resend.
There is no CI/CD yet; releases are manual and the gap is tracked in the canonical architecture document.

```
cataloguer/
├── backend/    # NestJS API (modular: auth, users, categories, products, imports, storage, ...)
├── frontend/   # Next.js admin (features/<domain>, components/ui kit)
├── docs/       # Product context and deployed AWS architecture
└── Dev_Manual/ # Company engineering manual (conventions this repo follows)
```

## Quick Start

Prerequisites: Node 18+, npm 9+, local PostgreSQL.

```bash
# Configure (fill DATABASE_URL, JWT secrets; Supabase vars optional for image upload)
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# Backend — http://localhost:3001/api/v1
cd backend && pnpm install && pnpm run migration:up && pnpm run seed && pnpm run start:dev

# Frontend — http://localhost:3000 (second terminal)
cd frontend && pnpm install && pnpm run dev
```

> The project uses **pnpm** (pinned via `packageManager` in each `package.json`).
> No pnpm yet? `corepack enable` (bundled with Node) or `npm install -g pnpm`.

Log in with the seeded dev admin (`DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD` from `backend/.env`).

> [!WARNING]
> `DEV_ADMIN_*` credentials are for local development/staging only. The seeder refuses to create
> them in production; production admins are created through the Users screen.

## Development

| Command (both apps) | Purpose |
|---|---|
| `pnpm run typecheck` / `pnpm run lint` | Static checks (backend also has `lint:check` for CI) |
| `pnpm run build` | Production build |
| `pnpm test` *(backend)* | Unit tests |
| `pnpm run migration:create` / `migration:up` *(backend)* | MikroORM migrations |

**Branch flow** (per the manual): `feature/*` → PR to `develop` (staging) → controlled release to
`main` (production). CI (lint + typecheck + tests + build) must pass before merge.

## Documentation

- [Product context](docs/product-context.es.md) — scope, entities, relations, flows and technical debt.
- [AWS architecture](docs/aws-architecture.es.md) — deployed infrastructure and operations.
