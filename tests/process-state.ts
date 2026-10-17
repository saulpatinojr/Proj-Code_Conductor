import { existsSync, readFileSync } from 'node:fs';

/**
 * A process's state and group from /proc/<pid>/stat ("pid (comm) state ppid pgrp ..."), or
 * undefined once it is gone. The file is read once, never checked first: the process can
 * exit and be reaped between an existence check and the read. Without procfs (macOS), only
 * whether the process exists can be known.
 */
export function processState(pid: number): { state: string; pgrp: number } | undefined {
  let text: string;
  try { text = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (error) {
    // With procfs, only a missing entry (ENOENT, or ESRCH mid-exit) means the process is
    // gone; anything else, such as EACCES under hidepid, is an error, not "not running".
    if (existsSync('/proc/self/stat')) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
      throw error;
    }
    // Without procfs, ask the kernel.
    try { process.kill(pid, 0); return { state: 'R', pgrp: Number.NaN }; } catch { return undefined; }
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { state: fields[0]!, pgrp: Number(fields[2]) };
}

/**
 * Whether a process is still running. A killed process whose new parent does not reap it
 * (common for PID 1 in containers) stays a zombie ("Z"); neither it nor a dead one ("X") runs.
 */
export function isRunning(pid: number): boolean {
  const state = processState(pid)?.state;
  return state !== undefined && state !== 'Z' && state !== 'X';
}
