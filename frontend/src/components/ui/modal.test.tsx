import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, cleanupAll } from '../../test/render';
import Modal from './modal';

/**
 * Dialog keyboard behaviour (Phase 8 accessibility).
 *
 * A dialog that opens without moving focus, or closes without giving it back,
 * strands a keyboard user: they tab through the page BEHIND the dialog, and on
 * close they restart at the top of the document instead of the row they were
 * working on. Both are asserted here because both were true before.
 */
describe('Modal focus behaviour', () => {
  afterEach(() => cleanupAll());

  const dialog = (open: boolean, onClose = vi.fn()) => (
    <Modal open={open} title="Confirm something" onClose={onClose}>
      <button data-testid="inner-first">First</button>
      <button data-testid="inner-last">Last</button>
    </Modal>
  );

  it('moves focus into the dialog when it opens', async () => {
    const view = await renderComponent(dialog(true));
    expect(document.activeElement).not.toBe(document.body);
    expect(view.container.contains(document.activeElement)).toBe(true);
  });

  it('announces itself as a modal dialog with its title', async () => {
    const view = await renderComponent(dialog(true));
    const node = view.container.querySelector('[role="dialog"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute('aria-modal')).toBe('true');
    expect(node?.getAttribute('aria-label')).toBe('Confirm something');
  });

  it('restores focus to the control that opened it', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const view = await renderComponent(dialog(true));
    expect(document.activeElement).not.toBe(opener);

    await view.rerender(dialog(false));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    await renderComponent(dialog(true, onClose));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes from its own close control', async () => {
    const onClose = vi.fn();
    const view = await renderComponent(dialog(true, onClose));
    await click(view.container.querySelector('button[aria-label="Close"]'));
    expect(onClose).toHaveBeenCalled();
  });

  describe('keyboard containment', () => {
    // jsdom computes no layout, so `offsetParent` — which the trap uses to
    // skip hidden controls — is null for every element. Give it the real
    // browser meaning for these tests so the trap sees the buttons.
    let offsetParentSpy: PropertyDescriptor | undefined;
    beforeAll(() => {
      offsetParentSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() {
          return this.parentNode;
        },
      });
    });
    afterAll(() => {
      if (offsetParentSpy) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentSpy);
      else delete (HTMLElement.prototype as any).offsetParent;
    });

    it('Tab on the last control wraps to the first — focus cannot leave', async () => {
      const view = await renderComponent(dialog(true));
      const last = view.get('inner-last');
      last.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      expect(view.container.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(last);
    });

    it('Shift+Tab on the first control wraps to the last', async () => {
      const view = await renderComponent(dialog(true));
      const focusable = view.container.querySelectorAll<HTMLElement>('button');
      const first = focusable[0];
      first.focus();
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
      );
      expect(view.container.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(view.get('inner-last'));
    });
  });
});
