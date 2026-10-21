import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogueRevalidationTarget, parseRevalidationTargets } from './revalidation-targets';

const WEBHOOK_TIMEOUT_MS = 3_000;
const BURST_WINDOW_MS = 75;

@Injectable()
export class CatalogueRevalidationService {
  private readonly logger = new Logger(CatalogueRevalidationService.name);
  private readonly targets: CatalogueRevalidationTarget[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private dirty = false;

  constructor(config: ConfigService) {
    this.targets = parseRevalidationTargets(
      config.get<string>('CATALOGUE_REVALIDATION_TARGETS'),
      config.get<string>('NODE_ENV') === 'production',
    );
  }

  /**
   * Collapse a short mutation burst, then fan out without delaying the API
   * response. A mutation arriving during delivery marks the catalogue dirty
   * and guarantees a second pass, so no committed update can be swallowed.
   */
  request(): void {
    if (this.targets.length === 0) return;
    this.dirty = true;
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, BURST_WINDOW_MS);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        await Promise.all(this.targets.map((target) => this.send(target)));
      }
    } finally {
      this.running = false;
      // Defensive scheduling for a future refactor that introduces an await
      // between the loop condition and this finally block.
      if (this.dirty) this.request();
    }
  }

  private async send(target: CatalogueRevalidationTarget): Promise<void> {
    const timestamp = Date.now().toString();
    const body = JSON.stringify({ tag: 'cataloguer', timestamp });
    const signature = createHmac('sha256', target.secret).update(`${timestamp}.${body}`).digest('hex');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cataloguer-timestamp': timestamp,
          'x-cataloguer-signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Catalogue cache revalidation target=${target.name} returned HTTP ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(
        `Catalogue cache revalidation target=${target.name} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
