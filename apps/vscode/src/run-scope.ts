import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Missing/relative/removed repositories are unassociated, never guessed from text. */
export function sameRepository(repository: unknown, root: string | undefined): boolean {
  if (typeof repository !== 'string' || !root || !isAbsolute(repository)) return false;
  try { return realpathSync.native(repository) === realpathSync.native(root); }
  catch { return false; }
}
