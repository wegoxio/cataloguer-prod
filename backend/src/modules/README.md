# Backend module layout

Each directory under `modules` owns one business or platform capability. Production code and tests must remain visually separate.

## Convention

```text
module-name/
├── module-name.module.ts
├── module-name.controller.ts
├── module-name.service.ts
├── dto/
├── entities/
├── feature-area/
│   ├── implementation.ts
│   └── __tests__/
│       └── implementation.spec.ts
└── __tests__/
    ├── module-name.service.spec.ts
    └── business-rule.pg.spec.ts
```

- Tests covering files at the module root belong in the root `__tests__` directory.
- Tests for a nested concern belong in that concern's own `__tests__` directory.
- Keep focused test files; do not combine an entire module into one large suite.
- `.spec.ts` is the standard suffix.
- `.pg.spec.ts` identifies tests requiring disposable PostgreSQL and `ALLOW_PG_DISPOSABLE_TESTS=1`.
- Fixtures remain beside the concern they exercise, normally in `__fixtures__`.
- Production files must not be placed inside `__tests__`.

Jest discovers these files through the existing `.*\.spec\.ts$` pattern; moving a test into `__tests__` does not require a separate test configuration.

## Current coverage shape

All 230 tests previously mixed into `src/modules` production directories now follow this convention. Modules without direct tests are currently:

- `discounts`
- `product-images`

The `tenancy` directory currently contains only cross-module tests and no production implementation. This is intentional as a test boundary for tenant invariants, but it should not receive production code unless it becomes a real Nest module.
