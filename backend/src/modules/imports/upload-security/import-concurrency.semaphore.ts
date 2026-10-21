/**
 * A tiny counting semaphore bounding simultaneous imports on ONE backend
 * container (#172). Non-blocking by design: `tryAcquire` fails fast so excess
 * imports are rejected immediately rather than queued while holding a buffered
 * file. Provided once by ImportUploadSecurityModule and shared by both import
 * routes, so they compete for the same pool.
 */
export class ImportConcurrencySemaphore {
  private available: number;

  constructor(private readonly permits: number) {
    this.available = permits;
  }

  /** Take a permit if one is free. Returns false immediately when exhausted. */
  tryAcquire(): boolean {
    if (this.available <= 0) return false;
    this.available -= 1;
    return true;
  }

  /** Return a permit, never exceeding the configured ceiling. */
  release(): void {
    if (this.available < this.permits) this.available += 1;
  }

  /** For tests/observability. */
  get free(): number {
    return this.available;
  }
}
