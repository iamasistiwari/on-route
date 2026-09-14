import { useCallback, useState } from 'react';
import { deepEqual } from '../../lib/equal';

/**
 * Local editable copy of host state. When the source changes, a clean draft follows it;
 * a dirty draft is kept (and stays dirty against the new baseline).
 */
export function useDraft<T>(source: T) {
  const [state, setState] = useState({ baseline: source, draft: source });
  let current = state;
  if (!deepEqual(state.baseline, source)) {
    const wasDirty = !deepEqual(state.draft, state.baseline);
    current = { baseline: source, draft: wasDirty ? state.draft : source };
    setState(current);
  }
  const setDraft = useCallback((next: T | ((prev: T) => T)) => {
    setState((s) => ({ ...s, draft: typeof next === 'function' ? (next as (p: T) => T)(s.draft) : next }));
  }, []);
  const reset = useCallback(() => setState((s) => ({ ...s, draft: s.baseline })), []);
  return { draft: current.draft, setDraft, dirty: !deepEqual(current.draft, current.baseline), reset };
}
