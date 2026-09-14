// Undo / redo history for the request editor. Pure.
import type { RequestDef } from '../../shared/model';
import { deepEqual } from './equal';

interface Entry<T> {
  value: T;
  key: string;
  at: number;
}

export class UndoStack<T> {
  private past: Entry<T>[] = [];
  private future: T[] = [];

  constructor(
    private readonly limit = 200,
    private readonly groupMs = 700,
  ) {}

  /** `prev` is the value before an edit of kind `key`. Edits of the same kind in quick succession form one step. */
  record(prev: T, key: string, now = Date.now()): void {
    const top = this.past[this.past.length - 1];
    if (top && top.key === key && now - top.at <= this.groupMs) {
      top.at = now;
    } else {
      this.past.push({ value: prev, key, at: now });
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future = [];
  }

  /** The value to go back to, or undefined when there is nothing to undo. */
  undo(current: T): T | undefined {
    const top = this.past.pop();
    if (!top) return undefined;
    this.future.push(current);
    return top.value;
  }

  redo(current: T): T | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push({ value: current, key: '', at: 0 });
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  /** Plain-data copy, so the history can outlive the webview (kept by the host until VS Code reloads). */
  snapshot(): UndoSnapshot<T> {
    return { past: this.past.map((e) => ({ ...e })), future: [...this.future] };
  }

  /** Replaces the history with a snapshot. Steps grouped before the restore never merge with new edits. */
  restore(snapshot: UndoSnapshot<T>): void {
    this.past = snapshot.past.slice(-this.limit).map((e) => ({ ...e, at: 0 }));
    this.future = [...snapshot.future];
  }
}

export interface UndoSnapshot<T> {
  past: { value: T; key: string; at: number }[];
  future: T[];
}

const EDITABLE = ['method', 'url', 'params', 'headers', 'auth', 'body', 'docs'] as const satisfies readonly (keyof RequestDef)[];

/**
 * Kind of edit between two request states, for grouping undo steps. "" when only id, name or order differ:
 * those change the file on disk right away and undo leaves them alone. The URL and its query params are one field.
 */
export function requestEditKey(prev: RequestDef, next: RequestDef): string {
  const changed: string[] = EDITABLE.filter((k) => !deepEqual(prev[k], next[k]));
  return (changed.includes('url') ? changed.filter((k) => k !== 'params') : changed).join(',');
}
