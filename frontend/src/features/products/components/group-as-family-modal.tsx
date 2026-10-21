'use client';

import React from 'react';
import Button from '../../../components/ui/button';
import Modal from '../../../components/ui/modal';
import { useT } from '../../../lib/i18n';
import { familyRoleOf } from '../family-role';
import type { Product } from '../types/product.types';

/**
 * Group the selected items under ONE new parent card.
 *
 * Nothing selected is consumed: a NEW card is created and every selected item
 * becomes a child of it, keeping its own price, stock, stores and publication.
 * Promoting one of the selection to be the card was considered and rejected —
 * a parent is not purchasable, so promoting "Small" would have removed Small
 * from sale, turning a reorganisation into a loss.
 *
 * Eligibility is NOT re-implemented here. The one shape the interface decides
 * is which items may be offered at all; every deeper rule — already grouped,
 * store-less, specification conflicts, tenancy — is answered by the backend,
 * advisory through the preflight and authoritatively by the creation itself.
 */

/**
 * One child as the modal is about to send it: always its id and its selector
 * label, and a `name` only when the reader actually changed it. The absence
 * of `name` is the instruction to leave that item's name alone.
 */
export interface FamilyMemberDraft {
  id: string;
  label: string;
  name?: string;
}

export interface GroupCandidate extends Pick<Product, 'id' | 'name' | 'price' | 'status'> {
  parent?: Product['parent'];
  children?: Product['children'];
}

/**
 * A first suggestion for each child's option label: what its name adds to the
 * card's name. "Silla Nordic Verde" under "Silla Nordic" proposes "Verde".
 * Always editable — this is a starting point, not a decision.
 */
export function proposeLabel(productName: string, parentName: string): string {
  const name = (productName ?? '').trim();
  const parent = (parentName ?? '').trim();
  if (!parent) return name;
  const lowerName = name.toLowerCase();
  const lowerParent = parent.toLowerCase();
  if (lowerName.startsWith(lowerParent)) {
    const rest = name.slice(parent.length).trim();
    if (rest) return rest;
  }
  const words = parent.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  const remainder = name
    .split(/\s+/)
    .filter((w) => !words.includes(w.toLowerCase()))
    .join(' ')
    .trim();
  return remainder || name;
}

/** Why this selection cannot be grouped, or null when it can be offered. */
export function groupBlockedReason(selected: GroupCandidate[], t: (k: string) => string): string | null {
  if (selected.length < 2) return t('Select at least two items to group.');
  if (selected.some((p) => familyRoleOf(p as Product) !== 'STANDALONE')) {
    return t('Only standalone items can be grouped. Remove parents and children from the selection.');
  }
  const statuses = new Set(selected.map((p) => p.status));
  if (statuses.size > 1) {
    return t('These items are not all published or all draft. Align their status first, then group them.');
  }
  return null;
}

export interface GroupAsFamilyModalProps {
  selected: GroupCandidate[];
  onCancel: () => void;
  /** Advisory backend check. Returns null when it raises no problem. */
  onValidate: (name: string, members: FamilyMemberDraft[]) => Promise<string | null>;
  /** The authoritative, atomic creation. Resolves with the new parent's id. */
  onConfirm: (name: string, members: FamilyMemberDraft[]) => Promise<string>;
  /**
   * A name to start from, when the modal was opened from a SUGGESTION rather
   * than from a selection the reader made. Always editable: a proposal is a
   * starting point, not a decision.
   */
  initialName?: string;
  /** Preselected labels, likewise a starting point. */
  initialLabels?: Record<string, string>;
}

export default function GroupAsFamilyModal({
  selected,
  onCancel,
  onValidate,
  onConfirm,
  initialName,
  initialLabels,
}: GroupAsFamilyModalProps) {
  const t = useT();
  const [name, setName] = React.useState(initialName ?? '');
  const [labels, setLabels] = React.useState<Record<string, string>>(initialLabels ?? {});
  /*
   * EACH CHILD'S OWN NAME, starting from what it is called today.
   *
   * Reviewing the items is the moment a person notices that one is called
   * "Silla Nordic Verde 2" and should simply be "Verde". The field is seeded
   * with the current name so leaving it alone is the default and costs
   * nothing; only a name that actually differs is sent.
   */
  const [names, setNames] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(selected.map((item) => [item.id, item.name])),
  );
  /*
   * WHICH NAME FIELDS THE READER ACTUALLY TOUCHED.
   *
   * Without this, comparing the trimmed field against the stored value
   * rewrites a name nobody edited: an item stored as " Silla Roja " would be
   * silently saved as "Silla Roja" merely because the modal was opened. A
   * rename is something a person does, so only a field they typed in can
   * produce one.
   */
  const [editedNames, setEditedNames] = React.useState<Record<string, boolean>>({});
  const [problem, setProblem] = React.useState<string | null>(null);
  /*
   * The advisory check and the real creation get SEPARATE flags. Sharing one
   * made the preflight disable the confirm button: leaving the name field runs
   * the check on blur, and a click that arrives while it is in flight was
   * swallowed — the reader pressed "Group them" and nothing happened. An
   * advisory answer must never gate the authoritative action.
   */
  const [checking, setChecking] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Labels follow the card's name until the reader edits one.
  const [touched, setTouched] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.keys(initialLabels ?? {}).map((id) => [id, true])),
  );
  React.useEffect(() => {
    setLabels((current) => {
      const next = { ...current };
      for (const item of selected) if (!touched[item.id]) next[item.id] = proposeLabel(item.name, name);
      return next;
    });
  }, [name, selected, touched]);

  const members = selected.map((item) => {
    const typed = (names[item.id] ?? item.name).trim();
    // Absent unless the reader edited this field AND the result differs from
    // what is stored. The server reads a missing name as "leave it alone".
    const renamed = editedNames[item.id] && typed && typed !== item.name;
    return {
      id: item.id,
      label: (labels[item.id] ?? '').trim(),
      ...(renamed ? { name: typed } : {}),
    };
  });
  /*
   * WHICH INPUT the standing backend answer was about.
   *
   * The advisory answer belongs to the exact name and labels it was asked
   * with. Once either changes, the refusal on screen is about text nobody is
   * proposing any more — "already shows as Verde" left standing while the
   * reader is halfway through typing something else. Comparing the signature
   * rather than clearing on every keystroke keeps a verdict that is still
   * true visible while the reader looks at it.
   */
  const signature = JSON.stringify([name.trim(), members]);
  const [answeredFor, setAnsweredFor] = React.useState<string | null>(null);
  // BEFORE paint: a verdict about superseded input must never be shown, not
  // even for the frame between a late answer arriving and an effect tidying it
  // away. That is also why the in-flight check needs no separate guard of its
  // own — an answer stamped with input that is no longer on screen is cleared
  // by the same comparison, in the same commit.
  React.useLayoutEffect(() => {
    if (answeredFor !== null && answeredFor !== signature) {
      setProblem(null);
      setAnsweredFor(null);
    }
  }, [signature, answeredFor]);
  const blank = members.some((m) => !m.label);
  const seen = new Set<string>();
  const duplicate = members.some((m) => {
    const key = m.label.toLowerCase();
    if (!m.label) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });

  // The card copies the LOWEST selected base price for sorting, and takes the
  // status the selection shares. Both are stated so the preview matches what
  // the backend will deterministically do.
  const lowest = [...selected].sort((a, b) => Number(a.price ?? 0) - Number(b.price ?? 0))[0];
  const cardStatus = selected[0]?.status ?? 'DRAFT';

  /*
   * A CHILD NAME IS JUDGED BY THE RULES ANY ITEM NAME IS JUDGED BY: present,
   * and within the column's 255. Held per item so the message can sit under
   * the field it is about rather than as one sentence at the bottom that does
   * not say which of six items is wrong.
   */
  const nameProblems: Record<string, string> = {};
  for (const item of selected) {
    const typed = (names[item.id] ?? '').trim();
    if (!typed) nameProblems[item.id] = t('An item needs a name.');
    // Code points, not `String.length`: one emoji is a single character to
    // the column and to the endpoint, and counting it as two would refuse a
    // name the server would have accepted.
    else if (Array.from(typed).length > 255) nameProblems[item.id] = t('A name can be at most 255 characters.');
  }
  const hasNameProblem = selected.some((i) => nameProblems[i.id]);
  /*
   * Two children ending up with the same name is legal — ordinary items may
   * share a name — but it is almost never meant, so it is said out loud
   * without blocking the save.
   */
  const duplicateNames = (() => {
    const seen = new Map<string, number>();
    for (const item of selected) {
      const typed = (names[item.id] ?? '').trim().toLowerCase();
      if (typed) seen.set(typed, (seen.get(typed) ?? 0) + 1);
    }
    return Array.from(seen.values()).some((n) => n > 1);
  })();

  /*
   * A name problem is shown UNDER ITS OWN FIELD and nowhere else. Repeating it
   * in the panel at the bottom put the same sentence on screen twice and, with
   * both marked `role="alert"`, announced it twice. It still blocks the save.
   */
  const localProblem = !name.trim()
    ? t('The parent needs a name.')
    : blank
      ? t('Every child needs a label.')
      : duplicate
        ? t('Two children cannot show the same label.')
        : null;

  const check = async () => {
    if (localProblem) return;
    setChecking(true);
    try {
      setProblem(await onValidate(name.trim(), members));
      // Stamped with the input it judged — `signature` here is the one this
      // call was made with, not whatever is on screen when it returns. If the
      // reader has typed on since, the layout effect drops it before paint.
      setAnsweredFor(signature);
    } finally {
      setChecking(false);
    }
  };

  const confirm = async () => {
    if (localProblem || submitting) return;
    setSubmitting(true);
    setProblem(null);
    try {
      await onConfirm(name.trim(), members);
    } catch (err: any) {
      setProblem(err?.message || t('This grouping could not be made.'));
      setAnsweredFor(signature);
    } finally {
      setSubmitting(false);
    }
  };

  /*
   * The SHARED dialog, not a card in the page flow. The bulk actions bar is
   * `fixed bottom-4 z-40` and stays on screen while a bulk modal is open, so an
   * in-flow panel has that bar sitting over its buttons — at every width, not
   * just narrow ones. The shared Modal is `z-50` over a full-screen overlay,
   * and it also brings the focus trap, Escape and focus restore that every
   * other bulk modal already has.
   */
  return (
    <Modal open title={t('Group as parent and children')} onClose={onCancel}>
    <div className="space-y-4" data-testid="group-modal">
      <div className="space-y-1">
        <label className="text-xs font-semibold text-slate-700" htmlFor="group-parent-name">
          {t('Name for the new parent')}
        </label>
        <input
          id="group-parent-name"
          data-testid="group-parent-name"
          className="w-full border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={check}
        />
      </div>

      {/*
         TWO DIFFERENT QUESTIONS ABOUT THE SAME ITEM, so they are asked as two
         labelled fields rather than one field beside a piece of grey text.
         The NAME is what the item is called, everywhere in the catalogue and
         on the website. The LABEL is the single word the selector shows for
         this option under the card. People routinely assume editing one edits
         the other, so each says which it is, and each is tied to its own item
         by id for a screen reader.
       */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-slate-700">{t('Each child: its name, and what the selector shows')}</p>
        {selected.map((item) => (
          <div key={item.id} className="space-y-1 rounded border border-slate-100 p-2" data-testid={`group-child-${item.id}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1">
                {/*
                   The accessible name is the VISIBLE label plus which item it
                   belongs to. "Name for Camiseta Small" alone left a screen
                   reader unable to tell this field from the one beside it,
                   which is also "for Camiseta Small"; the visible word is what
                   distinguishes them, so it is part of the name.
                 */}
                <label
                  id={`group-name-label-${item.id}`}
                  className="text-[10px] font-semibold uppercase tracking-wide text-slate-500"
                  htmlFor={`group-name-${item.id}`}
                >
                  {t('Item name')}
                </label>
                <span id={`group-name-owner-${item.id}`} className="sr-only">
                  {item.name}
                </span>
                <input
                  id={`group-name-${item.id}`}
                  data-testid={`group-name-${item.id}`}
                  aria-labelledby={`group-name-label-${item.id} group-name-owner-${item.id}`}
                  aria-invalid={nameProblems[item.id] ? true : undefined}
                  aria-describedby={nameProblems[item.id] ? `group-name-problem-${item.id}` : undefined}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  value={names[item.id] ?? ''}
                  onChange={(e) => {
                    setEditedNames((s) => ({ ...s, [item.id]: true }));
                    setNames((s) => ({ ...s, [item.id]: e.target.value }));
                  }}
                  onBlur={(e) => {
                    // What you see is what will be saved: the field settles on
                    // the trimmed value the request would carry.
                    if (editedNames[item.id]) setNames((s) => ({ ...s, [item.id]: e.target.value.trim() }));
                    check();
                  }}
                />
              </div>
              <div className="space-y-1 w-full sm:w-auto">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500" htmlFor={`group-label-${item.id}`}>
                  {t('Selector label')}
                </label>
                <input
                  id={`group-label-${item.id}`}
                  aria-label={t('Label for {name}', { name: item.name } as never)}
                  data-testid={`group-label-${item.id}`}
                  className="w-full sm:w-32 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  value={labels[item.id] ?? ''}
                  onChange={(e) => {
                    setTouched((s) => ({ ...s, [item.id]: true }));
                    setLabels((s) => ({ ...s, [item.id]: e.target.value }));
                  }}
                  onBlur={check}
                />
              </div>
            </div>
            {nameProblems[item.id] && (
              <p
                id={`group-name-problem-${item.id}`}
                role="alert"
                data-testid={`group-name-problem-${item.id}`}
                className="text-[10px] text-danger"
              >
                {nameProblems[item.id]}
              </p>
            )}
          </div>
        ))}
        {duplicateNames && (
          <p className="text-[10px] text-amber-700" data-testid="group-duplicate-names">
            {t('Two children would end up with the same name. That is allowed, but check it is what you meant.')}
          </p>
        )}
      </div>

      {/* THE PREVIEW. Three facts, because all three surprise people. */}
      <div className="rounded bg-slate-50 p-3 space-y-1" data-testid="group-preview">
        <p className="text-xs text-slate-700">
          {t('A new parent card will be created. It is never sold, so it carries no stock of its own.')}
        </p>
        <p className="text-xs text-slate-700" data-testid="group-preview-status">
          {cardStatus === 'PUBLISHED'
            ? t('The new parent will be Published.')
            : t('The new parent will be Draft.')}
        </p>
        <p className="text-xs text-slate-700">
          {t('Every selected item stays purchasable and keeps its own price and stock.')}
        </p>
        <p className="text-xs text-slate-700">
          {t("The parent appears in the stores its children are in — its own store presence is derived from them.")}
        </p>
        {lowest && (
          <p className="text-[10px] text-slate-500" data-testid="group-preview-price">
            {t('The card copies the lowest selected price for sorting only; customers pay each child’s own price.')}
          </p>
        )}
      </div>

      {(localProblem || problem) && (
        <p className="text-xs text-danger" role="alert" data-testid="group-problem">
          {localProblem ?? problem}
        </p>
      )}

      <div className="flex gap-2 justify-end items-center">
        {checking && (
          <span className="text-[10px] text-slate-500" data-testid="group-checking">
            {t('Checking…')}
          </span>
        )}
        <Button variant="secondary" onClick={onCancel} data-testid="group-cancel">
          {t('Cancel')}
        </Button>
        <Button
          onClick={confirm}
          isLoading={submitting}
          disabled={localProblem !== null || hasNameProblem}
          data-testid="group-confirm"
          aria-describedby={localProblem ? 'group-problem-desc' : undefined}
        >
          {t('Group them')}
        </Button>
      </div>
      {localProblem && (
        <span id="group-problem-desc" className="sr-only">
          {localProblem}
        </span>
      )}
    </div>
    </Modal>
  );
}
