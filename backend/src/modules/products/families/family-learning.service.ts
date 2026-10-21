import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { FamilyVocabulary } from '../entities/family-vocabulary.entity';
import { DismissedSuggestion } from '../entities/dismissed-suggestion.entity';
import { normalizeGroupName } from '../../imports/preview/family-grouping';

/**
 * What this company has taught the variant detector (phase 2).
 *
 * Accepting a group teaches its labels: "Terra" and "Vintage" join the
 * company's own vocabulary and future imports propose groups wearing them
 * confidently. Dismissing a suggestion sticks: its model name is never
 * proposed again. Both are per-organization — one client's fabric names
 * must not leak into another's suggestions.
 *
 * Learning is bookkeeping: it never throws into the flow that triggered it.
 *
 * THE COMPANY COMES FROM THE REQUEST'S RESOLVED SCOPE, never from the caller's
 * own user row. Those are not the same company: a platform owner working
 * inside a client has no organization of their own, so deriving it from the
 * user put their dismissals and their vocabulary in a null bucket the client
 * never reads — the owner watched a suggestion disappear while the client
 * still saw it. Every method here takes the effective organization and refuses
 * to guess one.
 */
@Injectable()
export class FamilyLearningService {
  private readonly logger = new Logger(FamilyLearningService.name);

  constructor(
    @InjectRepository(FamilyVocabulary)
    private readonly vocabularyRepository: EntityRepository<FamilyVocabulary>,
    @InjectRepository(DismissedSuggestion)
    private readonly dismissedRepository: EntityRepository<DismissedSuggestion>,
  ) {}

  /** The company's learned version words, ready for the detector. */
  async learnedWordsFor(organizationId: string | null): Promise<string[]> {
    const rows = await this.vocabularyRepository.find({ organization: organizationId });
    return rows.map((row) => row.word);
  }

  /** Signatures of every suggestion the company said No to. */
  async dismissedSignaturesFor(organizationId: string | null): Promise<string[]> {
    const rows = await this.dismissedRepository.find({ organization: organizationId });
    return rows.map((row) => row.signature);
  }

  /** Has this company already said No to this signature? */
  async isDismissed(organizationId: string | null, signature: string): Promise<boolean> {
    const row = await this.dismissedRepository.findOne({ organization: organizationId, signature });
    return row !== null;
  }

  /**
   * An accepted group teaches every word of its labels. Tokens are stored
   * normalized; duplicates are skipped, so re-accepting costs nothing.
   *
   * TWO MODES, because the caller decides what a failed lesson means.
   *
   * Standalone (no `opts.em`): learning is bookkeeping and never throws into
   * the flow that triggered it — the group already exists and a failed lesson
   * must not undo it.
   *
   * Joined to a caller's transaction (`opts.em`): the lesson lives or dies with
   * the group it came from, so a rolled-back group leaves no vocabulary behind.
   * Errors PROPAGATE here rather than being swallowed: once a statement has
   * failed, the surrounding transaction is already aborted, and pretending
   * otherwise would have the caller commit in a state it cannot reason about.
   */
  async learnFromAcceptedGroup(
    labels: string[],
    organizationId: string | null,
    opts?: { em?: EntityManager },
  ): Promise<void> {
    const joined = !!opts?.em;
    try {
      const em = opts?.em ?? this.vocabularyRepository.getEntityManager();
      const tokens = new Set(
        labels
          .flatMap((label) => label.split(/\s+/))
          .map((word) => word.toLowerCase().replace(/[.,;:()/-]/g, ''))
          .filter((word) => word.length >= 2 && !/^\d+$/.test(word)),
      );
      if (tokens.size === 0) return;

      const existing = await em.find(FamilyVocabulary, {
        organization: organizationId,
        word: { $in: Array.from(tokens) },
      });
      const known = new Set(existing.map((row) => row.word));

      for (const word of tokens) {
        if (known.has(word)) continue;
        em.persist(
          em.create(FamilyVocabulary, {
            organization: organizationId as any,
            word,
            createdAt: new Date(),
          } as any),
        );
      }
      await em.flush();
    } catch (err: any) {
      if (joined) throw err;
      this.logger.warn(`Vocabulary not learned: ${err?.message ?? err}`);
    }
  }

  /**
   * "No" is remembered: this model name is never suggested again.
   *
   * A PERSISTENT, ORGANIZATION-WIDE WRITE, so it refuses to run without an
   * organization rather than writing into a null bucket nobody reads. Whether
   * the caller MAY dismiss this particular signature is decided before this
   * point, by the scope that produced it.
   */
  async dismissSuggestion(name: string, organizationId: string | null): Promise<{ signature: string }> {
    if (!organizationId) {
      throw new ForbiddenException(
        'This operation requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    const signature = normalizeGroupName(name);
    const already = await this.dismissedRepository.findOne({ organization: organizationId, signature });
    if (!already) {
      const em = this.dismissedRepository.getEntityManager();
      em.persist(
        this.dismissedRepository.create({
          organization: organizationId as any,
          signature,
          name: name.trim(),
          createdAt: new Date(),
        }),
      );
      await em.flush();
    }
    return { signature };
  }
}
