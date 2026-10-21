import { describe, expect, it } from 'vitest';
import { createSingleFlight } from './checkout-flight';

describe('checkout single-flight (D-9)', () => {
  it('a second call while one is in flight joins it: one request, one shared result', async () => {
    let runs = 0;
    let release!: (value: string) => void;
    const flight = createSingleFlight<string>();
    const run = () => {
      runs++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const first = flight(run);
    const second = flight(run);
    expect(runs).toBe(1);
    release('https://checkout.example/one');
    expect(await first).toBe('https://checkout.example/one');
    expect(await second).toBe('https://checkout.example/one');
  });

  it('after the flight settles, the next call starts a fresh request', async () => {
    let runs = 0;
    const flight = createSingleFlight<number>();
    await flight(async () => ++runs);
    await flight(async () => ++runs);
    expect(runs).toBe(2);
  });

  it('a rejected flight is cleared too, so a failure never wedges the button', async () => {
    let runs = 0;
    const flight = createSingleFlight<number>();
    await expect(
      flight(async () => {
        runs++;
        throw new Error('Checkout is temporarily unavailable');
      }),
    ).rejects.toThrow('temporarily unavailable');
    await flight(async () => ++runs);
    expect(runs).toBe(2);
  });
});
