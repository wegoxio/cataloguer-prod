# Products module

This module owns the product catalogue and the rules that connect a product to
its family, configurable fields, stores and publication state.

## Structure

- `catalogue/`: product CRUD, listing, filtering and status.
- `families/`: parent/child product families, labels and suggestions.
- `fields/`: field definitions, store requirements and product field values.
- `publication/`: sellability and publication invariants.
- `relations/`: explicit relations between products.
- `shared/`: small product-specific helpers used by more than one capability.
- `compatibility/`: temporary aliases kept only for the legacy model/variant API.
- `dto/` and `entities/`: transport and persistence contracts shared by those capabilities.
- `__tests__/`: tests grouped by the same capability boundaries.

`products.module.ts` is the composition root. Production services and
controllers should not be added beside it.

## Remaining decomposition work

The physical layout is now explicit, but three services are still too broad:

1. `catalogue/products.service.ts` combines queries, family suggestions, family
   creation, store assignment and CRUD. Extract query/suggestion and store
   assignment collaborators before adding more behaviour.
2. `publication/publication-guard.service.ts` combines lock coordination,
   family/store reconciliation and validation of publication requirements.
   Split by those three responsibilities while preserving transaction and lock
   ordering.
3. `fields/product-fields.service.ts` combines definition administration,
   per-store settings, values, inheritance and import coercion. Separate the
   definition/settings API from value resolution and import writing.

These extractions should be behavioural refactors backed by the existing tests;
they should not introduce new database entities or public endpoints.
