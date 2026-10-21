import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The whole component-test harness (P5-W5).
 *
 * Deliberately about forty lines instead of a testing library. What the Phase 5
 * evidence has to show is narrow and specific — that a control is ABSENT for an
 * actor the server would refuse, and that the HANDLER refuses too when the
 * control is reached anyway — and React 18's own `createRoot` plus `act`,
 * driving real DOM events, shows exactly that. React attaches its listeners at
 * the container root, so `element.click()` produces a genuine bubbling event
 * that reaches the component's handler the same way a person's click would.
 *
 * Queries are by `data-testid` on purpose: a test that finds a button by its
 * Spanish label breaks when the copy is reworded, and rewording copy is not a
 * behaviour change. Where the label IS the behaviour — the truthful
 * "Coming soon" notice — the test reads text, and says so.
 */

// React 18 refuses to run `act` outside an environment that declares itself.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Production batches query notifications on a timer. Component tests flush
// promises deliberately, so schedule notifications in that same microtask
// queue instead of requiring every query test to sleep for an arbitrary time.
notifyManager.setScheduler(queueMicrotask);

export interface RenderResult {
  container: HTMLElement;
  unmount: () => void;
  /** Re-renders the same root with new element, inside `act`. */
  rerender: (next: React.ReactElement) => Promise<void>;
  /** The element carrying this test id, or null. */
  find: (testId: string) => HTMLElement | null;
  /** The element carrying this test id; throws when absent. */
  get: (testId: string) => HTMLElement;
  /** Every element carrying a test id starting with this prefix. */
  all: (prefix: string) => HTMLElement[];
  /** The container's visible text, whitespace-collapsed. */
  text: () => string;
}

const roots: { root: Root; container: HTMLElement }[] = [];

export async function renderComponent(element: React.ReactElement): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const withProviders = (node: React.ReactElement) => (
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
  roots.push({ root, container });

  await act(async () => {
    root.render(withProviders(element));
  });

  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(withProviders(next));
      });
    },
    find: (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    get: (testId: string) => {
      const found = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!found) throw new Error(`No element with data-testid="${testId}"`);
      return found;
    },
    all: (prefix: string) =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-testid]')).filter((node) =>
        (node.dataset.testid ?? '').startsWith(prefix),
      ),
    text: () => (container.textContent ?? '').replace(/\s+/g, ' ').trim(),
  };
}

/** A real DOM click, flushed through React's effects. */
export async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('click() received no element');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Types into a controlled input by dispatching the event React listens for. */
export async function type(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error('type() received no element');
  const input = element as HTMLInputElement;
  await act(async () => {
    // React tracks the value on the DOM node, so assigning `.value` directly
    // is ignored on the next change. Setting through the prototype descriptor
    // is what makes React see a genuine change.
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Picks an option in a controlled <select>. */
export async function select(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error('select() received no element');
  const node = element as HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(node, value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Lets pending promises and effects settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Waits out a REAL timer — a debounce, most often — and then lets the effects
 * it triggered settle. `flush()` only drains the microtask queue, so a
 * debounced search never fires under it.
 */
export async function settle(ms = 400): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

export function cleanupAll(): void {
  while (roots.length) {
    const entry = roots.pop();
    if (!entry) continue;
    try {
      act(() => entry.root.unmount());
    } catch {
      /* already unmounted */
    }
    entry.container.remove();
  }
}
