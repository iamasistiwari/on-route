import type { RequestMethod } from '../../shared/model';
import { cx } from './ui';

/** Text color class per method (colors are theme-aware CSS vars, see index.css). */
export const METHOD_TEXT: Record<RequestMethod, string> = {
  GET: 'text-m-get',
  POST: 'text-m-post',
  PUT: 'text-m-put',
  PATCH: 'text-m-patch',
  DELETE: 'text-m-delete',
  HEAD: 'text-m-other',
  OPTIONS: 'text-m-other',
  WS: 'text-m-ws',
};

export const METHOD_SHORT: Record<RequestMethod, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DEL',
  HEAD: 'HEAD',
  OPTIONS: 'OPT',
  WS: 'WS',
};

/** Fixed-width, left-aligned method label, sized to its longest short label. `sm` is the dense sidebar variant. */
export function MethodBadge({ method, size = 'md', className }: { method: RequestMethod; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      className={cx(
        'inline-block shrink-0 text-left font-mono font-bold uppercase leading-none tracking-tight',
        size === 'sm' ? 'mr-1.5 w-[31px] text-[10px]' : 'w-[38px] text-[11px]',
        METHOD_TEXT[method],
        className,
      )}
      title={method}
    >
      {METHOD_SHORT[method]}
    </span>
  );
}
