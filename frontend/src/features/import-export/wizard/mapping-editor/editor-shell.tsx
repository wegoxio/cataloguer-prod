'use client';

import React from 'react';
import { cn } from '../../../../lib/cn';
import type { EditorRegion } from '../mapping/mapping-state';

/**
 * The four regions of the mapping editor, and how they sit together.
 *
 * The screen answers four questions that a person moves between constantly, so
 * they are four regions rather than four steps:
 *
 *   SOURCE   what is in my file?
 *   MAPPING  what should each column become?
 *   ISSUES   what is wrong, and how bad is it?
 *   RESULT   what would actually be written?
 *
 * A wizard that made these sequential would force someone to go back three
 * screens to check a column while reading a warning about it, which is exactly
 * when they stop checking.
 *
 * On a wide screen all four are visible at once. Below that they become a tab
 * set, because four panes on a phone is four unreadable panes. The tabs are
 * real buttons in a real `tablist`: arrow keys move between them, the selected
 * one is announced, and each panel is labelled by its tab. A styled `div` with
 * an onClick looks identical and is unusable without a mouse.
 */

export interface RegionDescriptor {
  id: EditorRegion;
  label: string;
  /** Shown on the tab — "3 to decide", "2 warnings". Never a bare number. */
  badge?: { text: string; tone: 'neutral' | 'warning' | 'blocking' };
  content: React.ReactNode;
}

const TONE_CLASSES: Record<'neutral' | 'warning' | 'blocking', string> = {
  neutral: 'bg-slate-100 text-slate-700',
  warning: 'bg-amber-100 text-amber-900',
  blocking: 'bg-rose-100 text-rose-900',
};

export function EditorShell({
  regions,
  active,
  onActivate,
  footer,
}: {
  regions: RegionDescriptor[];
  active: EditorRegion;
  onActivate: (region: EditorRegion) => void;
  footer?: React.ReactNode;
}) {
  const tabRefs = React.useRef(new Map<EditorRegion, HTMLButtonElement | null>());

  /**
   * Arrow keys move between tabs, as a tablist is expected to.
   *
   * Focus follows selection deliberately: each panel is a working surface
   * rather than a preview, so arriving at a tab without its panel would be a
   * dead end for a keyboard user.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const order = regions.map((r) => r.id);
    const current = order.indexOf(active);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    else return;

    event.preventDefault();
    onActivate(order[next]);
    tabRefs.current.get(order[next])?.focus();
  };

  return (
    <div className="space-y-4" data-testid="mapping-editor">
      {/* Tabs drive the narrow layout and stay available as a jump target on
          wide screens, where all four panels are visible at once. */}
      <div
        role="tablist"
        aria-label="Import mapping"
        className="flex gap-1 overflow-x-auto border-b border-slate-200"
        onKeyDown={onKeyDown}
      >
        {regions.map((region) => {
          const selected = region.id === active;
          return (
            <button
              key={region.id}
              ref={(node) => {
                tabRefs.current.set(region.id, node);
              }}
              role="tab"
              type="button"
              id={`tab-${region.id}`}
              aria-selected={selected}
              aria-controls={`panel-${region.id}`}
              // Only the selected tab is in the tab order; arrow keys move
              // within the set, which is how a tablist is meant to behave.
              tabIndex={selected ? 0 : -1}
              onClick={() => onActivate(region.id)}
              className={cn(
                'flex items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-semibold transition-colors',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600',
                selected
                  ? 'border-b-2 border-sky-600 text-sky-700'
                  : 'border-b-2 border-transparent text-slate-500 hover:text-slate-700',
              )}
            >
              {region.label}
              {region.badge ? (
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', TONE_CLASSES[region.badge.tone])}>
                  {region.badge.text}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {regions.map((region) => {
          const selected = region.id === active;
          return (
            <section
              key={region.id}
              role="tabpanel"
              id={`panel-${region.id}`}
              aria-labelledby={`tab-${region.id}`}
              // `hidden` rather than unmounting: a panel that unmounts loses
              // its scroll position and any half-typed value every time
              // someone glances at another region.
              hidden={!selected}
              // On a wide screen every panel shows regardless of selection.
              className={cn('card bg-white p-4 xl:!block', !selected && 'hidden')}
              data-region={region.id}
            >
              <h2 className="mb-3 text-sm font-bold text-slate-800">{region.label}</h2>
              {region.content}
            </section>
          );
        })}
      </div>

      {footer ? (
          // In normal flow, NOT sticky.
          //
          // It stuck once, so that "can I run this yet?" did not require
          // scrolling past four panels. The cost showed up in manual
          // acceptance: a sticky footer inside a scrolling card sits OVER the
          // content, and a forty-five column mapping form had inputs behind it
          // at nearly every scroll position. An unobstructed editor is worth
          // more than an answer that is always on screen — and the same answer
          // is carried by the stage header above, which cannot cover anything.
          <div className="border-t border-slate-200 bg-white p-3">{footer}</div>
      ) : null}
    </div>
  );
}
