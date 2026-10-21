import * as fs from 'fs';
import * as path from 'path';
import {
  ArchiveRejected,
  JOB_ARCHIVE_BUDGET,
  PREVIEW_ARCHIVE_BUDGET,
  censusArchive,
  inflateEntry,
  isSafeEntryName,
  openArchive,
} from '../archive-gate';

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '..', '__fixtures__', n));

/**
 * These fixtures are hand-built (deterministic, no vendor writer) precisely so
 * the hostile cases are exact. The zip bomb is the one that matters most: the
 * accepted value reader inflates it to ~579 MiB unbounded, which is fatal on a
 * 512 MiB container, so the gate must refuse it from the directory alone.
 */
describe('archive gate', () => {
  describe('entry name safety', () => {
    it('accepts ordinary package paths', () => {
      for (const n of ['xl/workbook.xml', '[Content_Types].xml', 'xl/worksheets/sheet1.xml', 'xl/media/image1.png']) {
        expect(isSafeEntryName(n)).toBe(true);
      }
    });

    it('refuses traversal, absolute paths, drive letters, backslashes and NULs', () => {
      for (const n of [
        '../../etc/passwd',
        'xl/../../escape.txt',
        '/etc/passwd',
        'C:/Windows/system32',
        'xl\\worksheets\\sheet1.xml',
        'xl/sheet\0.xml',
        '',
      ]) {
        expect(isSafeEntryName(n)).toBe(false);
      }
    });
  });

  describe('census of a clean workbook', () => {
    it('reports sheets, shared strings and ratio without inflating content', () => {
      const c = censusArchive(fixture('clean-multisheet.xlsx'), JOB_ARCHIVE_BUDGET);
      expect(c.worksheetEntries).toEqual(['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
      expect(c.sharedStringsEntry).toBe('xl/sharedStrings.xml');
      expect(c.activeContent).toEqual([]);
      expect(c.overallRatio).toBeGreaterThan(0);
    });

    it('censuses embedded media instead of ignoring it', () => {
      const c = censusArchive(fixture('with-image.xlsx'), JOB_ARCHIVE_BUDGET);
      expect(c.mediaEntries).toEqual(['xl/media/image1.png']);
    });
  });

  describe('refusals', () => {
    it('refuses a zip bomb from the directory, before inflating anything', () => {
      const before = process.memoryUsage().rss;
      let rejected: ArchiveRejected | null = null;
      try {
        openArchive(fixture('zip-bomb.xlsx'), JOB_ARCHIVE_BUDGET);
      } catch (e) {
        rejected = e as ArchiveRejected;
      }
      expect(rejected).toBeInstanceOf(ArchiveRejected);
      expect(rejected!.code).toBe('ENTRY_TOO_LARGE');
      // The whole point: refusing costs essentially nothing. The value reader
      // spends ~579 MiB on this same file.
      const grewMiB = (process.memoryUsage().rss - before) / 1048576;
      expect(grewMiB).toBeLessThan(64);
    });

    it('refuses a macro-bearing workbook with guidance, not a generic error', () => {
      expect(() => openArchive(fixture('macro.xlsm'), JOB_ARCHIVE_BUDGET)).toThrow(/macros/i);
      try {
        openArchive(fixture('macro.xlsm'), JOB_ARCHIVE_BUDGET);
      } catch (e) {
        expect((e as ArchiveRejected).code).toBe('ACTIVE_CONTENT');
        expect((e as Error).message).toMatch(/\.csv|\.xlsx/);
      }
    });

    it('refuses a workbook that links to another workbook', () => {
      expect(() => openArchive(fixture('external-link.xlsx'), JOB_ARCHIVE_BUDGET)).toThrow(/links to other files/i);
    });

    it('refuses a damaged package', () => {
      try {
        openArchive(fixture('truncated.xlsx'), JOB_ARCHIVE_BUDGET);
        fail('expected refusal');
      } catch (e) {
        expect(e).toBeInstanceOf(ArchiveRejected);
        expect(['MALFORMED', 'NOT_AN_ARCHIVE']).toContain((e as ArchiveRejected).code);
      }
    });

    it('refuses an entry whose path would escape the package', () => {
      try {
        censusArchive(fixture('traversal.xlsx'), JOB_ARCHIVE_BUDGET);
        fail('expected refusal');
      } catch (e) {
        expect((e as ArchiveRejected).code).toBe('UNSAFE_ENTRY_NAME');
      }
      expect(fs.existsSync('/tmp/p9-escape.txt')).toBe(false);
    });

    it('refuses a file that is not an archive at all', () => {
      expect(() => censusArchive(Buffer.from('name,price\n1,2'), JOB_ARCHIVE_BUDGET)).toThrow(ArchiveRejected);
    });
  });

  describe('the ratio control is an anomaly signal, not the gate', () => {
    it('ACCEPTS a legitimate workbook that compresses better than 10:1', () => {
      // Measured 10.2:1 on a real 40,000-row sheet. A flat 10:1 cap — the
      // obvious-looking control — would reject this genuine file.
      const c = openArchive(fixture('legit-high-compression.xlsx'), JOB_ARCHIVE_BUDGET);
      expect(c.overallRatio).toBeGreaterThan(9);
      expect(c.ratioAnomalies).toEqual([]);
      expect(c.worksheetEntries.length).toBeGreaterThan(0);
    });

    it('flags the bomb ratio far above any legitimate one', () => {
      const c = censusArchive(fixture('zip-bomb.xlsx'), {
        ...JOB_ARCHIVE_BUDGET,
        maxEntryInflatedBytes: 1024 * 1024 * 1024,
        maxTotalInflatedBytes: 1024 * 1024 * 1024,
      });
      expect(c.ratioAnomalies).toContain('xl/bomb.xml');
      expect(c.overallRatio).toBeGreaterThan(500);
    });
  });

  describe('budgeted inflation', () => {
    it('expands a small part normally', () => {
      const c = censusArchive(fixture('clean-multisheet.xlsx'), JOB_ARCHIVE_BUDGET);
      const sheet = c.entries.find((e) => e.name === 'xl/worksheets/sheet1.xml')!;
      const xml = inflateEntry(fixture('clean-multisheet.xlsx'), sheet, 1024 * 1024).toString('utf8');
      expect(xml).toContain('<worksheet');
      expect(xml).toContain('B2*2');
    });

    it('aborts when real output exceeds the budget, even if the header lied', () => {
      const buf = fixture('zip-bomb.xlsx');
      const c = censusArchive(buf, {
        ...JOB_ARCHIVE_BUDGET,
        maxEntryInflatedBytes: 1024 * 1024 * 1024,
        maxTotalInflatedBytes: 1024 * 1024 * 1024,
      });
      const bomb = c.entries.find((e) => e.name === 'xl/bomb.xml')!;
      expect(() => inflateEntry(buf, bomb, 4 * 1024 * 1024)).toThrow(ArchiveRejected);
    });
  });

  describe('preview budget is tighter than the job budget', () => {
    it('refuses in preview what the job would accept', () => {
      expect(PREVIEW_ARCHIVE_BUDGET.maxTotalInflatedBytes).toBeLessThan(JOB_ARCHIVE_BUDGET.maxTotalInflatedBytes);
      expect(() =>
        openArchive(fixture('legit-high-compression.xlsx'), {
          ...PREVIEW_ARCHIVE_BUDGET,
          maxEntryInflatedBytes: 1024,
        }),
      ).toThrow(ArchiveRejected);
    });
  });
});
