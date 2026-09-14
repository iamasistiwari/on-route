// Minimal git helpers (the `git` CLI, run in the workspace). Failures (no git, not a repository) are soft.
import { execFile } from 'node:child_process';

/** Which of `paths` (relative to `cwd`) are tracked by git. Empty when git is unavailable. */
export function gitTrackedFiles(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '--', ...paths], { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? new Set() : new Set(stdout.split(/\r?\n/).filter(Boolean)));
    });
  });
}

/** `git rm --cached`: stop tracking a file but keep it on disk. */
export function gitUntrack(cwd: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['rm', '--cached', '--quiet', '--', path], { cwd, timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
}
