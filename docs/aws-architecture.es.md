# Cataloguer — arquitectura AWS desplegada

> Documento canónico de infraestructura y operación. Estado al 21 de octubre de 2026.

## 1. Topología

```text
Vercel: admin.cataloguer.wegox.io     Vercel: designhof.com + clientes
                   \                   /
                    HTTPS / X-Api-Key
                             |
 api.cataloguer.wegox.io -> 13.61.76.35 (AWS Lightsail, eu-north-1)
                             |
          Caddy :80/:443 -> NestJS :3001 -> PostgreSQL 16
                             |
        S3 imágenes públicas / S3 backups privados
```

Los frontends viven en Vercel. AWS aloja API, base de datos y almacenamiento para un piloto de aproximadamente tres clientes.

## 2. Recursos

| Recurso | Valor/estado |
|---|---|
| Cuenta/región | `420151437743` / `eu-north-1` |
| Lightsail | `cataloguer-pilot-prod`, Ubuntu 24.04 |
| Capacidad/coste | 4 GB RAM, 2 vCPU, 80 GB; ~USD 24/mes |
| IP/DNS | `13.61.76.35` / `api.cataloguer.wegox.io` |
| Runtime | Docker 29, Compose 5, Node 22 |
| Proxy | Caddy 2; Let’s Encrypt y renovación automática |
| Base de datos | PostgreSQL 16 en volumen Docker privado |
| Imágenes | `cataloguer-products-bucket` |
| Backups | `cataloguer-private-prod-420151437743` |
| Perfil CLI | `cataloguer-deployer` |
| Presupuesto | `Cataloguer-Pilot-Monthly`, USD 40 |

## 3. Red y contenedores

Puertos públicos 80/443. SSH 22 está restringido en Lightsail a la IP administrativa. PostgreSQL y NestJS no se exponen; Caddy redirige HTTP, termina TLS y reenvía al backend.

`ops/aws-pilot-hybrid/compose.yaml` define `postgres`, `backend`, `caddy` e `import-runner` (perfil manual `tools`). PostgreSQL/backend tienen health checks; backend limita memoria a 1200 MB; logs rotan a 3 × 10 MB. Salud pública: `GET https://api.cataloguer.wegox.io/api/v1/health`.

## 4. Persistencia y S3

El bucket de productos permite únicamente lectura pública de objetos; listar/escribir/eliminar requiere IAM. Las URLs S3 se guardan en `ProductImage`.

El bucket privado bloquea todo acceso público, usa SSE-S3 y versionado. `backups/` conserva objetos 35 días y versiones anteriores 7 días. El timer `cataloguer-backup.timer` ejecuta dumps comprimidos cada seis horas. El restore drill fue probado exitosamente.

Contrato CORS del bucket privado cuando se habiliten cargas empresariales directas:

| Regla | Valor |
|---|---|
| Allowed headers | `Content-Type`, `Content-Length`, `If-None-Match` |
| Allowed methods | `PUT` |
| Allowed origins | dominios administrativos explícitos; nunca `*` |

## 5. Secretos y dominios

Los secretos están en `/opt/cataloguer/.env.backend` y `.env.infrastructure` con modo `0600`, nunca en Git.

Ya están configurados:

```env
CORS_ALLOWED_ORIGINS=https://admin.cataloguer.wegox.io
FRONTEND_URL=https://admin.cataloguer.wegox.io
```

El admin no requerirá reconfiguración si conserva ese dominio. DesignHof llama la API pública desde servidor y no requiere CORS. Después de desplegarlo debe configurarse la revalidación:

```env
CATALOGUE_REVALIDATION_TARGETS=[{"name":"designhof","url":"https://designhof.com/api/cataloguer/revalidate","secret":"<secreto compartido con Vercel>"}]
```

Usar `www.designhof.com` si ese resulta ser el canónico. Cada storefront tiene secreto propio. Después del cambio:

```bash
cd /opt/cataloguer
docker compose --env-file .env.infrastructure up -d --force-recreate backend
docker compose --env-file .env.infrastructure ps
```

## 6. Operación

```bash
cd /opt/cataloguer
docker compose --env-file .env.infrastructure ps
docker compose --env-file .env.infrastructure logs --tail=100 backend
systemctl status cataloguer-backup.timer
./backup-postgres.sh
./restore-drill.sh
```

Un release manual valida código, construye imagen inmutable, ejecuta migraciones una sola vez, recrea backend, espera health check, prueba API/S3/autenticación y conserva la imagen anterior para rollback. Los scripts reproducibles están en `ops/aws-pilot-hybrid`.

## 7. Deuda técnica de infraestructura

### P0

- **CI/CD para backend y recursos operativos:** lint, typecheck, pruebas críticas, imagen inmutable, migración controlada, despliegue, health check y rollback. Autenticación efímera/OIDC; no access keys en CI.
- Separar IAM de imágenes e IAM de backups; hoy ambas capacidades usan temporalmente `cataloguer-user` por restricciones/SCP de la organización.
- Configurar/probar la revalidación de DesignHof.
- Automatizar restore drills y alertar fallos.

### P1

Alertas de disponibilidad, 5xx, disco, memoria y backup; Sentry con scrubbing; rotación de secretos; política de parches; vigilar memoria (no hay swap).

### P2

RDS, Redis, workers, WAF/CDN, IaC completa, staging y alta disponibilidad únicamente cuando carga, ingresos o SLA lo justifiquen.

## 8. Coste y control

El coste dominante es Lightsail (~USD 24/mes); S3 será pequeño durante el piloto. El presupuesto de USD 40 alerta a `develop@wegox.io` al 50, 75, 90 y 100 % real y 100 % previsto. No escalar preventivamente.

## 9. Checklist

- Health público 200 y base de datos `ok`.
- PostgreSQL/backend saludables y Caddy activo.
- TLS válido y autorrenovable.
- Backup reciente en S3 y restauración ensayada.
- Disco/memoria con margen.
- API key independiente por cliente y solo en secretos Vercel.
- CORS limitado a dominios administrativos.
- URL/secreto independiente por storefront para revalidación.
- Superadmin con contraseña cambiada y MFA.
