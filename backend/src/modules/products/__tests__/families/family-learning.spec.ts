import { FamilyLearningService } from '../../families/family-learning.service';

/* The RESOLVED company of the request, which is what this service now takes.
   It used to look the caller's own organization up from their user row — and
   those are different companies whenever a platform owner works inside a
   client, which is how a dismissal ended up somewhere the client never read. */
const ORG = 'org-1';

describe('FamilyLearningService (phase 2)', () => {
  let service: FamilyLearningService;
  let vocabulary: any;
  let dismissed: any;
  let em: any;

  beforeEach(() => {
    // learnFromAcceptedGroup routes its reads and writes through the
    // EntityManager rather than the repository, so it can be handed a caller's
    // transactional manager and have the lesson live or die with that group.
    em = {
      persist: jest.fn(),
      flush: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_entity: any, data: any) => data),
      findOne: jest.fn().mockResolvedValue({ id: 'u1', organization: { id: 'org-1' } }),
    };
    vocabulary = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: any) => data),
      getEntityManager: () => em,
    };
    dismissed = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: any) => data),
      getEntityManager: () => em,
    };
    service = new FamilyLearningService(vocabulary, dismissed);
  });

  describe('learnFromAcceptedGroup', () => {
    it('stores each label token normalized, under the resolved organization', async () => {
      await service.learnFromAcceptedGroup(['Terra', 'Vintage Brown'], ORG);

      // em.create(Entity, data) — the payload is the SECOND argument.
      const words = em.create.mock.calls.map((c: any) => c[1].word).sort();
      expect(words).toEqual(['brown', 'terra', 'vintage']);
      em.create.mock.calls.forEach((c: any) => expect(c[1].organization).toBe('org-1'));
      expect(em.flush).toHaveBeenCalled();
    });

    it('skips words the company already learned', async () => {
      em.find.mockResolvedValue([{ word: 'terra' }]);

      await service.learnFromAcceptedGroup(['Terra', 'Vintage'], ORG);

      const words = em.create.mock.calls.map((c: any) => c[1].word);
      expect(words).toEqual(['vintage']);
    });

    it('ignores bare numbers and one-letter fragments', async () => {
      await service.learnFromAcceptedGroup(['160', 'L'], ORG);

      expect(em.create).not.toHaveBeenCalled();
      expect(em.flush).not.toHaveBeenCalled();
    });

    it('never lets a failed lesson break the grouping that triggered it', async () => {
      em.find.mockRejectedValue(new Error('db down'));

      await expect(service.learnFromAcceptedGroup(['Terra'], ORG)).resolves.toBeUndefined();
    });

    it('rethrows instead of swallowing when joined to a caller transaction', async () => {
      const tem = {
        find: jest.fn().mockRejectedValue(new Error('db down')),
        create: jest.fn(),
        persist: jest.fn(),
        flush: jest.fn(),
      };

      // Joined mode: the caller's transaction is already poisoned, so hiding
      // the failure would have it commit in a state it cannot reason about.
      await expect(service.learnFromAcceptedGroup(['Terra'], ORG, { em: tem as any })).rejects.toThrow('db down');
    });
  });

  describe('dismissSuggestion', () => {
    it('stores the normalized signature once, keeping the shown name', async () => {
      const result = await service.dismissSuggestion('Sofa  Marta', ORG);

      expect(result.signature).toBe('sofa marta');
      expect(dismissed.create).toHaveBeenCalledWith(
        expect.objectContaining({ signature: 'sofa marta', name: 'Sofa  Marta', organization: 'org-1' }),
      );
    });

    it('is idempotent: dismissing twice writes nothing new', async () => {
      dismissed.findOne.mockResolvedValue({ signature: 'sofa marta' });

      await service.dismissSuggestion('Sofa Marta', ORG);

      expect(dismissed.create).not.toHaveBeenCalled();
    });
  });

  describe('the company comes from the request, not the caller', () => {
    it('reads under exactly the organization it was given', async () => {
      await service.learnedWordsFor(ORG);
      expect(vocabulary.find).toHaveBeenCalledWith({ organization: ORG });

      await service.dismissedSignaturesFor('org-2');
      expect(dismissed.find).toHaveBeenCalledWith({ organization: 'org-2' });
    });

    it('never looks a company up from the caller', async () => {
      await service.learnedWordsFor(ORG);
      await service.dismissSuggestion('Sofa Marta', ORG);
      // The old implementation loaded the User row to find an organization.
      // Nothing here may do that any more: the request already decided.
      expect(em.findOne).not.toHaveBeenCalled();
    });

    /**
     * A persistent organization-wide write with no organization used to land
     * in a null bucket, where it silenced the suggestion for the platform
     * owner's own view and for nobody else. It is refused instead.
     */
    it('REFUSES to dismiss without a company rather than writing into a null bucket', async () => {
      await expect(service.dismissSuggestion('Sofa Marta', null)).rejects.toThrow(/requires an organization context/i);
      expect(dismissed.create).not.toHaveBeenCalled();
      expect(em.flush).not.toHaveBeenCalled();
    });

    it('answers whether a signature is already dismissed, under that company', async () => {
      dismissed.findOne.mockResolvedValue(null);
      expect(await service.isDismissed(ORG, 'sofa marta')).toBe(false);
      expect(dismissed.findOne).toHaveBeenCalledWith({ organization: ORG, signature: 'sofa marta' });

      dismissed.findOne.mockResolvedValue({ signature: 'sofa marta' });
      expect(await service.isDismissed(ORG, 'sofa marta')).toBe(true);
    });
  });
});
