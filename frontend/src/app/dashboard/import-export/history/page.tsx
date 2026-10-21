import { redirect } from 'next/navigation';

/**
 * The old history bookmark, pointed at the one history there is.
 *
 * This route rendered `ImportHistory`, which read `GET /import/history` — a
 * table whose only writer was retired with the direct-commit path. Nothing has
 * been able to write a row since, so the page promised "every import that ran"
 * and showed "No imports recorded yet" while Package A and Package B had both
 * completed. Import activity is built on the lifecycle tables the runner
 * actually writes, and now carries the terminal status, the finish time and the
 * row summary this page was meant to give.
 *
 * A redirect rather than a second component rendering the same list: two URLs
 * for one surface is how the previous copies came to drift apart, and every
 * defect on this screen has been a drift between two things that should have
 * been one.
 */
export default function ImportHistoryPage() {
  redirect('/dashboard/import-export');
}
