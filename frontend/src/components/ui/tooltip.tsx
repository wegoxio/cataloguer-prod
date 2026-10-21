'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

interface TooltipProps {
  /** Short description of what the wrapped control does. */
  content: string;
  children: React.ReactNode;
  /** Where the bubble appears relative to the control. */
  side?: 'top' | 'bottom';
  className?: string;
}

// Minimum gap between the bubble and the viewport edge
const EDGE = 8;

/**
 * Hover tooltip rendered in a portal and clamped to the viewport, so it
 * never runs off-screen for controls near the edge and can't be clipped
 * by scrollable/overflow containers (tables, cards). Keeps the 300ms
 * show delay and stays off on touch-only devices, where it would stick.
 */
export default function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    // Touch-only devices: a tap would leave the bubble stuck open
    if (window.matchMedia('(hover: none)').matches) return;
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
    setPos(null);
  };

  // Position after the bubble has rendered (off-screen) so we can measure
  // it: centered on the control, then clamped inside the viewport
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapRef.current?.getBoundingClientRect();
    const bubble = bubbleRef.current?.getBoundingClientRect();
    if (!trigger || !bubble) return;
    let left = trigger.left + trigger.width / 2 - bubble.width / 2;
    left = Math.min(Math.max(left, EDGE), window.innerWidth - bubble.width - EDGE);
    const top = side === 'top' ? trigger.top - bubble.height - 6 : trigger.bottom + 6;
    setPos({ top, left });
  }, [open, side, content]);

  // Fixed positioning goes stale the moment anything scrolls — just hide
  useLayoutEffect(() => {
    if (!open) return;
    const onScroll = () => hide();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className={cn(
              'pointer-events-none z-[80] w-max max-w-[min(320px,calc(100vw-16px))] text-center',
              'rounded-md bg-slate-800 px-2 py-1 text-[11px] font-medium text-white shadow-md',
              // invisible until the keyframe fires: recreates the 300ms delay
              'opacity-0 animate-[tooltip-in_150ms_ease-out_300ms_forwards]',
            )}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
