# Cataloguer — contexto integral del producto

> Documento canónico para desarrolladores y modelos de IA. Describe el estado real, alcance, entidades, relaciones, flujos y deuda técnica. Actualizado: 21 de octubre de 2026.

## 1. Definición y límites

Cataloguer es un SaaS multiempresa y multisucursal para administrar categorías, productos, familias/variantes, imágenes, publicación e inventario. Expone el catálogo a sitios externos mediante una API headless autenticada con API keys.

No es un CMS, constructor web ni clon de WordPress. SEO, hero, páginas, footer y contenido editorial pertenecen al código de cada storefront. El piloto conecta:

- Panel: `https://admin.catalog.wegox.io`.
- API: `https://api.catalog.wegox.io/api/v1`.
- Primer storefront: `https://designhof.com`.
- Imágenes: `cataloguer-products-bucket` en S3.

## 2. Estado y alcance funcional

| Dominio | Estado | Alcance vigente |
|---|---|---|
| Autenticación | Operativo | Login, refresh rotatorio, logout, recuperación, MFA, multipestaña y revocación |
| Organizaciones | Operativo | Tenants, ciclo de vida y contexto administrado por superadmin |
| Usuarios/roles | Operativo | Autoridad global, de organización y de sucursal |
| Sucursales | Operativo | Varias sucursales por organización; publicación e inventario por sucursal |
| Categorías | Operativo | Árbol, orden, visibilidad y metadatos visuales |
| Navegación | Operativo | Canales, grupos y publicación de categorías por sucursal |
| Productos | Operativo | CRUD, estados, precios, SKU, campos y relaciones |
| Familias/variantes | Operativo con revisión humana | Padre agrupador e hijos vendibles diferenciados |
| Imágenes | Operativo | Pertenecen al producto; S3, orden e imagen principal |
| Inventario | Operativo avanzado | Ledger, balances, reservas, backorders, ubicaciones, conciliación y transferencias |
| API headless | Operativo | Catálogo público mediante `X-Api-Key` |
| Revalidación | Implementada, sin configurar para DesignHof | Fanout multicliente con URL/secreto independiente |
| Importación | Implementada | Análisis, mapeo, aprobación, ejecución y reporte por fila |
| Traducciones | Implementado | Productos/categorías con fallback |
| Dashboard/auditoría | Operativo | KPIs reales por tenant y registro de acciones |
| Ventas, descuentos y billing | Secundario | Existe código; no define el MVP del catálogo |
| CMS, website builder, popups, WhatsApp, CRM, proveedores y fiscalidad | Fuera de alcance | No reintroducir sin PRD y decisión comercial |

## 3. Tenancy y autorización

`Organization` es la frontera de aislamiento. `Store` pertenece a una organización. Todo recurso comercial debe quedar asociado directa o indirectamente al tenant, y el scope debe aplicarse antes de leer o escribir.

- `SUPER_ADMIN`: operador global; entra explícitamente en el contexto de una organización.
- `ORGANIZATION_MANAGER`: autoridad sobre toda una organización.
- `STORE_ADMIN` y `ADMIN`: autoridad de sucursal; `ADMIN` se mantiene por compatibilidad.
- `EDITOR`: edición limitada.
- `VIEWER`: lectura limitada.

Invariantes: un usuario normal pertenece a organización; un rol de sucursal tiene una sucursal de esa organización; una API key pertenece al tenant y opcionalmente a una sucursal; el scope público se deriva de la API key, nunca de un ID confiado al cliente; un tenant archivado no puede seguir operando.

## 4. Entidades y relaciones

### Identidad y tenancy

| Entidad | Relación/finalidad |
|---|---|
| `Organization` | 1:N tiendas, usuarios y API keys; raíz lógica del catálogo |
| `Store` | N:1 organización; N:M productos mediante `StoreProduct` |
| `User` | N:1 rol; organización y, según rol, sucursal |
| `Role` | 1:N usuarios |
| `RefreshToken` | N:1 usuario; rotación y revocación de sesión |
| `PasswordResetToken` | N:1 usuario; recuperación |
| `ApiKey` | N:1 organización; sucursal opcional; acceso servidor a servidor |

### Catálogo

| Entidad | Relación/finalidad |
|---|---|
| `Category` | N:1 organización; padre/hijos; taxonomía jerárquica |
| `Product` | Organización/categoría; padre/hijos; raíz de imágenes, campos y relaciones |
| `StoreProduct` | Producto + sucursal; asignación/publicación local |
| `ProductImage` | N:1 producto; URL S3, orden y principal |
| `ProductFieldDefinition` | N:1 organización; atributo configurable |
| `ProductFieldValue` | Producto + definición; valor tipado |
| `StoreFieldSetting` | Sucursal + definición; visibilidad/requisito |
| `ProductRelation` | Producto origen/destino; relacionados o complementarios |
| `FamilyVocabulary` | N:1 organización; términos de familias |
| `DismissedSuggestion` | Rechazo persistido de sugerencia |
| `ProductTranslation` / `CategoryTranslation` | Texto localizado de su entidad |

### Navegación pública

`CatalogueChannel` representa el canal; contiene `CatalogueGroup`; `CatalogueGroupCategory` ordena categorías dentro del grupo; `StoreCategoryPublication` decide qué categorías expone cada sucursal. La navegación es configurable, no específica de DesignHof. “Mobiliario H1” debe ser configuración del tenant, no lógica del SaaS.

### Inventario

| Entidad | Finalidad |
|---|---|
| `InventoryLocation` | Ubicación física |
| `InventoryTransaction` / `InventoryEntry` | Movimiento inmutable y sus partidas |
| `InventoryBalance` | Proyección de saldo para lectura rápida |
| `InventoryTransactionIntent` | Idempotencia de comandos |
| `InventoryReservation` | Cantidad apartada |
| `InventoryBackorder` / `Allocation` | Demanda sin stock y asignación posterior |
| `InventoryTransfer` / `Line` | Traslado entre ubicaciones |
| `InventoryTransitBalance` | Existencia en tránsito |
| `InventoryOpeningReconciliation` / `Allocation` | Corte inicial auditable |

El saldo no se edita directamente: entradas, salidas, ajustes, reservas y transferencias producen movimientos trazables.

### Importación y operación

`ImportSource` → `ImportAnalysis` → `ImportMappingTemplate` → `ImportPlan` → `ImportApproval` → `ImportExecution` → `ImportRowResult` conforman el flujo auditable. `ImportedHistoricalSale` conserva historia sin crear pedidos activos. `AuditLog` registra actividad; `Settings` configuración; `Payment`, `SalesOrder` y `DiscountCode` son capacidades secundarias.

## 5. Familias padre/hijo

El padre agrupa “el mismo producto comercial”; cada hijo es una versión vendible. Ejemplo: Camisa de lino → roja, azul y verde. Cada hijo conserva SKU, imágenes, precio, atributos e inventario propios.

Reglas: un hijo tiene un solo padre; ambos pertenecen a la misma organización; no hay ciclos; el inventario reside en el vendible y no se suma ciegamente al padre; publicación y asignación mantienen coherencia familiar; la API permite seleccionar variantes. Las imágenes pertenecen exclusivamente a productos, no a una biblioteca editorial independiente.

## 6. Flujos principales

### Alta de cliente

Organización → sucursales → responsable/usuarios → taxonomía/navegación/campos → API key restringida.

### Producto y publicación

Crear producto → categoría y atributos → familia si aplica → imágenes firmadas y asociadas → sucursales → estado/publicación → revalidación de storefronts.

### Importación DesignHof

El importador lee el workbook, normaliza, resuelve categorías/familias, crea o actualiza productos, descarga imágenes externas, las sube a S3 y persiste sus URLs. Genera reportes por ejecución/fila. Primero se analiza y luego se ejecuta con confirmación explícita. La fuente final es PostgreSQL + S3, no WooCommerce.

### Consumo storefront

Next.js utiliza `X-Api-Key` exclusivamente en servidor, consulta navegación/listados/detalle y renderiza. Cataloguer llama al endpoint privado de revalidación cuando cambia información publicable.

## 7. Seguridad existente

Argon2; access token corto; refresh rotatorio en cookie `HttpOnly`, `Secure`, `SameSite=None`; MFA; revocación; validación DTO estricta; rate limits; aislamiento tenant; API keys hasheadas; permisos IAM acotados; bucket de backup privado/cifrado/versionado; secretos fuera del repo; PostgreSQL privado; HTTPS/HSTS; auditoría y soft deletion.

## 8. Dominios y variables

Producción ya contiene:

```env
CORS_ALLOWED_ORIGINS=https://admin.catalog.wegox.io
FRONTEND_URL=https://admin.catalog.wegox.io
```

Desplegar el admin en ese dominio no requiere cambiar el backend. `designhof.com` no necesita CORS si consume desde el servidor Next.js. Tras desplegarlo sí debe agregarse y probarse:

```env
CATALOGUE_REVALIDATION_TARGETS=[{"name":"designhof","url":"https://designhof.com/api/cataloguer/revalidate","secret":"SECRETO_COMPARTIDO_MINIMO_32_CARACTERES"}]
```

El secreto también va en Vercel. Si el canónico es `www.designhof.com`, se usa ese hostname exacto. Cada cliente recibe URL/secreto propios. Cambiar esta variable exige recrear el contenedor backend.

## 9. MVP comercial

Incluye multiempresa, usuarios, sucursales, categorías, productos/familias, imágenes, inventario, importación, traducciones, publicación headless y auditoría. DesignHof valida el modelo, pero nada debe codificarse solo para él. No se prometen aún alta disponibilidad, SLA empresarial, checkout integral, fiscalidad, CRM, WhatsApp, proveedores ni constructor web.

## 10. Deuda técnica

### P0

1. **CI/CD de backend y recursos operativos.** Ejecutar lint, tipos, pruebas críticas, imagen inmutable, migración única/controlada, despliegue, health check y rollback. Usar credenciales efímeras/OIDC; nunca secretos en logs o artefactos.
2. **Separar credenciales IAM.** Imágenes y backups usan temporalmente `cataloguer-user` por restricciones/SCP de la organización AWS. Crear identidades independientes, mínimo privilegio y rotación.
3. **Restauración recurrente.** Hay backup automático y un restore drill exitoso; automatizar la prueba y alertar fallos.
4. **Revalidación DesignHof.** Configurar secreto/URL en AWS y Vercel y probar cambio → webhook → contenido actualizado.
5. **Importación productiva.** Analizar, revisar reporte, ejecutar y conciliar productos, categorías, imágenes, familias e inventario.

### P1

Alertas de caída/disco/memoria/5xx/backup; Sentry con scrubbing; vigilar memoria o añadir swap; reducir ruido y retener logs; contratos API compartidos y E2E críticos; ocultar módulos secundarios no usados; procedimiento de rotación de JWT, MFA, API keys e IAM.

### P2

RDS cuando SLA/carga lo justifique; Redis al escalar horizontalmente; workers separados; WAF/CDN según abuso real; IaC completa; staging permanente y despliegue blue/green cuando existan ingresos/SLA.

## 11. Reglas para evolucionar

- Toda función necesita público, flujo, entidad propietaria, frontera tenant, permisos, errores, observabilidad y aceptación.
- La personalización de storefront se resuelve por configuración, no con reglas de cliente en el núcleo.
- No reintroducir CMS/DAM/automatizaciones sin PRD.
- Cambios de entidades requieren migración y pruebas PostgreSQL.
- Cambios publicables preservan contrato headless y revalidación multicliente.
- Toda imagen persistida debe ser propia en S3 y asociarse a un producto.
