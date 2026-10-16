import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync } from 'node:fs';

/**
 * Whether this platform can say where an open file descriptor points. Linux exposes it
 * at /proc/self/fd/<n>. Node offers no equivalent elsewhere (macOS F_GETPATH and Windows
 * GetFinalPathNameByHandle are not exposed), and checking the path again by name cannot
 * be tied to the descriptor: a directory swapped for a symlink between the open and the
 * re-check goes unnoticed. So context files are read only where the location is known.
 */
export const DESCRIPTOR_LOCATION_SUPPORTED = process.platform === 'linux';

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

/** Refuses, before the path is touched at all, where an opened file's location cannot be known. */
export function requireDescriptorLocation(displayPath: string): void {
  if (!DESCRIPTOR_LOCATION_SUPPORTED) {
    throw new Error(`Context files can be read only where the opened file's location can be verified (Linux); on ${process.platform} a directory swapped for a symlink during the read could not be detected: ${displayPath}`);
  }
}

/** The kernel's path for an open descriptor, as raw bytes, or undefined if unknown. */
function descriptorLocation(descriptor: number): Buffer | undefined {
  if (!DESCRIPTOR_LOCATION_SUPPORTED) return undefined;
  try { return readlinkSync(`/proc/self/fd/${descriptor}`, { encoding: 'buffer' }); } catch { return undefined; }
}

/**
 * Read the file at `canonical`, a path the caller has already resolved and checked
 * against policy (allowed roots, sensitive names). Everything is checked on the one
 * open descriptor, so what is read is what was checked:
 *
 * - the final component is opened without following a symlink, without blocking on a
 *   FIFO and without taking a controlling terminal;
 * - the kernel's path for the descriptor must be exactly `canonical`, so an intermediate
 *   directory swapped for a symlink, or a file renamed or deleted, is refused;
 * - it must be a regular file with a single link (a hard link can make a file from
 *   outside the workspace appear inside it), within `maxBytes`, and must not grow while
 *   it is read.
 *
 * Where the descriptor's location cannot be known, nothing is opened.
 */
export function readCheckedFile(canonical: string, displayPath: string, maxBytes: number): string {
  requireDescriptorLocation(displayPath);
  let descriptor: number;
  try { descriptor = openSync(canonical, OPEN_FLAGS); }
  catch (error) { throw new Error(`Context file cannot be opened: ${displayPath} (${(error as NodeJS.ErrnoException).code ?? 'error'})`); }
  try {
    const location = descriptorLocation(descriptor);
    if (!location || !location.equals(Buffer.from(canonical))) throw new Error(`Context file changed while it was being opened: ${displayPath}`);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`Context path is not a regular file: ${displayPath}`);
    if (opened.nlink > 1) throw new Error(`Context file has more than one hard link, so its location cannot be verified: ${displayPath}`);
    if (opened.size > maxBytes) throw new Error(`Context file exceeds the ${maxBytes} byte limit: ${displayPath}`);
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read) read = readSync(descriptor, buffer, length, buffer.length - length, null);
    if (length > opened.size) throw new Error(`Context file changed while it was being read: ${displayPath}`);
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(descriptor); }
}
