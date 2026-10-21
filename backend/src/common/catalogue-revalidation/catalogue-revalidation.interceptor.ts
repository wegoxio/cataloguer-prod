import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { CatalogueRevalidationService } from './catalogue-revalidation.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_CATALOGUE_MUTATIONS = [
  /\/products(?:\/|$)/,
  /\/product-fields(?:\/|$)/,
  /\/categories(?:\/|$)/,
  /\/inventory(?:\/|$)/,
  /\/bulk\/products(?:\/|$)/,
  /\/import(?:\/|$)/,
  /\/localization(?:\/|$)/,
  /\/stores\/[^/]+\/catalogue-navigation(?:\/|$)/,
  /\/public\/orders(?:\/|$)/,
];

export function changesPublicCatalogue(method: string, originalUrl: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  const path = originalUrl.split('?')[0];
  return PUBLIC_CATALOGUE_MUTATIONS.some((pattern) => pattern.test(path));
}

@Injectable()
export class CatalogueRevalidationInterceptor implements NestInterceptor {
  constructor(private readonly revalidation: CatalogueRevalidationService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ method?: string; originalUrl?: string; url?: string }>();
    const shouldRevalidate = changesPublicCatalogue(
      request.method ?? '',
      request.originalUrl ?? request.url ?? '',
    );
    return next.handle().pipe(tap({ next: () => shouldRevalidate && this.revalidation.request() }));
  }
}
