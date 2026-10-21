import { BadRequestException } from '@nestjs/common';
import { Product } from '../entities/product.entity';

/**
 * What a product must be before it can become someone's child.
 *
 * ONE definition for both entry points — `POST /products/families` (creation)
 * and `POST /products/:id/family/members` (attachment) — because they were
 * checking DIFFERENT things and each was missing what the other had:
 *
 *   - creation refused a product with no store, attachment did not;
 *   - attachment refused a product that is itself a parent, creation did not,
 *     which let two parents be grouped under a third and produced a
 *     THREE-LEVEL hierarchy the model does not have and no surface renders.
 *
 * Every refusal here happens before any write, in both paths, with the same
 * sentence — so the two endpoints cannot disagree about what is legal, and a
 * caller cannot reach through one what the other denies.
 *
 * Callers keep their own additional rules: identity, tenancy and label
 * uniqueness are not membership eligibility and stay where they are.
 */
export function assertEligibleAsChild(product: Product): void {
  if (product.parent) {
    throw new BadRequestException(`"${product.name}" is already a child of another parent`);
  }
  // `children` must be loaded; an unloaded collection would silently report
  // zero and let a parent through. Callers populate it.
  if (product.children && product.children.isInitialized() && product.children.count() > 0) {
    throw new BadRequestException(`"${product.name}" is a parent with children of its own`);
  }
  // A child is the sellable item, so it must already carry its own store
  // state. A child in no store produces a family nobody can buy from.
  if (product.stores.getItems().length === 0) {
    throw new BadRequestException(`"${product.name}" belongs to no store, so it cannot become a child product`);
  }
}

/**
 * A label a shopper can actually use to choose.
 *
 * The selector shows one option per child, so a blank label leaves an option
 * nobody can read, and two labels differing only in case or surrounding space
 * leave two a shopper cannot tell apart. Comparison is trimmed and
 * case-insensitive for exactly that reason.
 *
 * ONE definition, used by every path that writes a label: attaching a child,
 * renaming one, and creating a whole family at once. `createFamily` did not
 * validate labels at all — it assigned whatever arrived — so the interface was
 * the only thing standing between a person and an unreadable selector.
 */
export function assertLabelFree(
  siblings: { id?: string; name?: string; optionLabel?: string | null }[],
  label: string,
  exceptId?: string,
): void {
  const wanted = (label ?? '').trim().toLowerCase();
  if (!wanted) throw new BadRequestException('The label cannot be empty');
  const clash = siblings.find(
    (child) => child.id !== exceptId && (child.optionLabel ?? '').trim().toLowerCase() === wanted,
  );
  if (clash) {
    throw new BadRequestException(
      `"${clash.name}" already shows as "${label.trim()}" — the selector could not tell them apart`,
    );
  }
}

/**
 * A refusal that knows WHICH product caused it.
 *
 * The message stays a plain string, so `rejects.toThrow(/…/)` and the HTTP
 * body are unchanged; the id rides alongside it for the advisory preflight,
 * which reports a `productId` so an interface can point at the offending row
 * instead of making the reader hunt for it.
 */
export class FamilyMemberRefusal extends BadRequestException {
  constructor(
    message: string,
    readonly productId: string,
  ) {
    super(message);
  }
}

/** "PUBLISHED" reads as "Published" to somebody who did not write the enum. */
function readableStatus(status: string): string {
  const s = (status ?? '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : 'unknown';
}

/**
 * Every member of a new family must share ONE publication status.
 *
 * A card takes its status from its members, so a mixed selection has no
 * answer: whichever status the card ends up with, half the selection now sits
 * under a card that contradicts it — a Draft card hiding published children,
 * or a Published card advertising drafts. Deterministic ordering made that
 * arbitrary result REPEATABLE; it did not make it right, and the interface
 * refusing to offer the button never bound a direct API request.
 *
 * The disagreement is reported from the id-ordered members, so the SAME two
 * products are named whatever order the caller sent them in.
 */
export function assertUniformPublicationStatus(members: { id: string; name: string; status: string }[]): void {
  if (members.length < 2) return;
  const ordered = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reference = ordered[0];
  const differing = ordered.find((member) => member.status !== reference.status);
  if (!differing) return;
  throw new FamilyMemberRefusal(
    `These items are not all published or all draft: "${reference.name}" is ${readableStatus(reference.status)} ` +
      `and "${differing.name}" is ${readableStatus(differing.status)}. ` +
      'Align their status first, then group them.',
    differing.id,
  );
}

/**
 * The two things a grouping request must say before anything is looked up.
 *
 * Separate from the rest of the prelude only because it needs no database:
 * `createFamily` asks it before opening a transaction, so a malformed request
 * never reaches one, and the prelude asks it again from inside so the rule
 * has one definition rather than a fast copy and a real one.
 */
export function assertFamilyRequestShape(name: string, members: { id: string; label: string }[] | undefined): void {
  if (!name?.trim()) throw new BadRequestException('The parent product needs a name');
  if (!members || members.length < 2) throw new BadRequestException('A parent needs at least two child products');
}

/**
 * What a family CARD may never be asked to do.
 *
 * A card is not a sellable unit: it holds no stock, is refused at checkout,
 * and its store presence is derived from its children. Several writers can
 * reach the fields that contradict that — the product editor, the two
 * single-store endpoints, three bulk operations, supplier receiving and both
 * importers — and the DTOs cannot stop them, because most of those writers do
 * not go through a DTO at all. One assertion, called from each.
 *
 * `what` names the operation in the refusal, so a reader learns which control
 * to stop using rather than only that something was refused.
 */
export function assertNotAFamilyCard(product: { id?: string; name?: string; childCount: number }, what: string): void {
  if (product.childCount > 0) {
    throw new BadRequestException(
      `"${product.name ?? 'This item'}" is a parent card, so ${what}. Its child products carry that.`,
    );
  }
}

/**
 * A card's SKU and manufacturer code, under the one rule that lets a card
 * created before this existed be cleaned up without letting a new one be
 * stamped.
 *
 *   - omitted                    → allowed, nothing happens
 *   - the value it already has   → accepted as a no-op
 *   - null, empty or whitespace  → CLEARS it, allowed
 *   - any other non-empty value  → refused, before anything is written
 *
 * Both fields are compared in their NORMALIZED form, so "  A-1 " submitted
 * against a stored "A-1" is the no-op it looks like rather than a change.
 */
export function assertIdentityFieldUnchanged(
  field: 'SKU' | 'manufacturer code',
  stored: string | null | undefined,
  submitted: string | null | undefined,
  normalize: (raw: unknown) => string | null,
): void {
  if (submitted === undefined) return;
  const next = normalize(submitted);
  if (next === null) return; // clearing a legacy value is always allowed
  if (next === normalize(stored)) return; // a no-op restatement
  throw new BadRequestException(
    `A parent card cannot be given a ${field}. It is never ordered or received, and the ${field} belongs to the child products. Send an empty value to clear the one it has.`,
  );
}

/**
 * ATTACHING MUST NOT TAKE A LIVE ITEM OFF THE WEBSITE.
 *
 * A child never lists on its own: the public query pins `parent: null`, so a
 * version reaches a shopper only through its parent's card. Attaching
 * therefore hands the child's entire visibility to the parent, and if the
 * parent is not visible the item simply vanishes from the site it was on a
 * moment earlier — with both products still marked Published, which is what
 * makes it so quiet.
 *
 * Two independent ways for the parent to be invisible, so two rules:
 *
 *   - the CARD is not live at all — Draft, or archived;
 *   - the card is live but hidden IN A BRANCH the child is published in.
 *
 * Neither rule fires for a child that is not live itself. A Draft or archived
 * item shows nowhere already, so attaching it removes nothing, and refusing
 * would block the ordinary way families are assembled: build the versions as
 * drafts, then publish.
 */
export function assertParentCanHostLiveChild(
  parent: { name: string; status: string; archivedAt?: Date | null },
  member: { id: string; name: string; status: string; archivedAt?: Date | null },
): void {
  const memberIsLive = member.status === 'PUBLISHED' && !member.archivedAt;
  if (!memberIsLive) return;
  const parentIsLive = parent.status === 'PUBLISHED' && !parent.archivedAt;
  if (parentIsLive) return;
  const why = parent.archivedAt ? 'archived' : readableStatus(parent.status).toLowerCase();
  throw new FamilyMemberRefusal(
    `"${parent.name}" is ${why}, so attaching the published item "${member.name}" would remove it from the website. ` +
      'Publish the parent first, or set this item to draft.',
    member.id,
  );
}

/**
 * The branch half of the same rule.
 *
 * A card is shown in a branch only through a pivot published THERE, and
 * `reconcileStoresOfParent` does not republish one: a store the parent
 * already holds keeps whatever publication it had, and only a store the
 * parent does not hold yet gets a pivot born published. So a parent that is
 * ATTACHED BUT HIDDEN in a branch stays hidden there after the attach, and a
 * child published in that branch loses the only surface it had.
 *
 * `hiddenIn` is therefore exactly: the branches where the CHILD is published
 * and the parent already holds an UNPUBLISHED pivot. A branch the parent does
 * not hold at all is not a problem — that pivot is about to be created
 * published — and a branch where the child is not published was never
 * showing it.
 *
 * Every offending branch is named. Reporting only the first would send the
 * reader round the loop once per branch.
 */
export function assertBranchesKeepLiveChildVisible(
  parent: { name: string },
  member: { id: string; name: string; status: string; archivedAt?: Date | null },
  hiddenIn: { id: string; name: string }[],
): void {
  const memberIsLive = member.status === 'PUBLISHED' && !member.archivedAt;
  if (!memberIsLive || hiddenIn.length === 0) return;
  const ordered = [...hiddenIn].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const names = ordered.map((branch) => `"${branch.name}"`).join(', ');
  const isOne = ordered.length === 1;
  throw new FamilyMemberRefusal(
    `"${parent.name}" is hidden in ${names}, where the published item "${member.name}" is visible. ` +
      `Attaching it would remove the item from ${isOne ? 'that branch' : 'those branches'}. ` +
      `Publish the parent ${isOne ? 'there' : 'in each of them'} first, or hide the item there.`,
    member.id,
  );
}
