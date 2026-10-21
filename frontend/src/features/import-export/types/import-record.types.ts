/** One past import run, as /import/history returns it. */
export interface ImportRecord {
  id: string;
  type: 'products' | 'categories';
  fileName?: string | null;
  totalRows?: number | null;
  created: number;
  updated: number;
  skipped: number;
  images: number;
  groups: number;
  errors?: { row: number; message: string }[] | null;
  /** RUNNING means the final chunk never arrived — the run died midway. */
  status: 'RUNNING' | 'COMPLETED';
  actorEmail?: string | null;
  createdAt: string;
}
