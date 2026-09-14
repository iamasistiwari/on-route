import { memo, useRef, type ReactNode } from 'react';
import type { AuthConfig } from '../../shared/model';
import type { VariableInfo } from '../../shared/protocol';
import { authLabel } from '../lib/format';
import { SecretInput } from './ui';
import { VarInput } from './VarInput';

function TextInput({
  value,
  onChange,
  placeholder,
  variables,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  variables?: readonly VariableInfo[];
}) {
  if (variables) {
    return (
      <VarInput
        className="ctl p-0"
        fieldClassName="px-[6px] py-[3px] font-mono outline-none"
        value={value}
        placeholder={placeholder}
        variables={variables}
        onChange={onChange}
      />
    );
  }
  return <input className="ctl font-mono" value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />;
}

type AuthType = AuthConfig['type'];

const TYPE_LABELS: Record<AuthType, string> = {
  inherit: 'Inherit from parent',
  none: 'No auth',
  bearer: 'Bearer token',
  basic: 'Basic auth',
  apikey: 'API key',
};

function defaultFor(type: AuthType): AuthConfig {
  switch (type) {
    case 'inherit':
      return { type };
    case 'none':
      return { type };
    case 'bearer':
      return { type, token: '' };
    case 'basic':
      return { type, username: '', password: '' };
    case 'apikey':
      return { type, key: '', value: '', in: 'header' };
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="contents">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

function mask(s: string): string {
  if (!s) return '(empty)';
  if (/^\{\{.*\}\}$/.test(s.trim())) return s;
  return '•'.repeat(Math.min(12, Math.max(6, s.length)));
}

export function authSummary(auth: AuthConfig): string {
  switch (auth.type) {
    case 'bearer':
      return `Token ${mask(auth.token)}`;
    case 'basic':
      return `User ${auth.username || '(empty)'}`;
    case 'apikey':
      return `${auth.key || '(no key)'} in ${auth.in}`;
    default:
      return '';
  }
}

export interface AuthEditorProps {
  value: AuthConfig;
  onChange: (auth: AuthConfig) => void;
  allowInherit?: boolean;
  /** Effective auth of the parent chain (request editor). */
  inherited?: { auth: AuthConfig; source: string };
  /** Text shown for inherit when `inherited` is unknown. */
  inheritHint?: string;
  /** Enables {{variable}} highlighting and autocomplete. */
  variables?: readonly VariableInfo[];
}

function AuthEditorInner({ value, onChange, allowInherit = true, inherited, inheritHint, variables }: AuthEditorProps) {
  // Remember values per type so toggling type does not lose what was typed.
  const cache = useRef<Partial<Record<AuthType, AuthConfig>>>({});
  cache.current[value.type] = value;

  const types = (Object.keys(TYPE_LABELS) as AuthType[]).filter((t) => allowInherit || t !== 'inherit');

  return (
    <div className="grid max-w-xl grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
      <Field label="Type">
        <select
          className="ctl w-full max-w-[220px]"
          value={value.type}
          onChange={(e) => {
            const type = e.target.value as AuthType;
            onChange(cache.current[type] ?? defaultFor(type));
          }}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>

      {value.type === 'inherit' && (
        <div className="col-span-2 rounded-xl border border-[var(--or-line)] bg-code px-3 py-2 text-muted">
          {inherited ? (
            <>
              Inherited from <span className="text-fg">{inherited.source}</span>: <span className="text-fg">{authLabel(inherited.auth)}</span>
              {authSummary(inherited.auth) && <span className="ml-2 font-mono text-[12px]">{authSummary(inherited.auth)}</span>}
            </>
          ) : (
            (inheritHint ?? 'Uses the auth of the parent folder, or the project.')
          )}
        </div>
      )}

      {value.type === 'none' && <div className="col-span-2 text-muted">No authorization is sent.</div>}

      {value.type === 'bearer' && (
        <Field label="Token">
          <SecretInput value={value.token} onChange={(token) => onChange({ ...value, token })} placeholder="{{token}}" variables={variables} />
        </Field>
      )}

      {value.type === 'basic' && (
        <>
          <Field label="Username">
            <TextInput value={value.username} variables={variables} onChange={(username) => onChange({ ...value, username })} />
          </Field>
          <Field label="Password">
            <SecretInput value={value.password} onChange={(password) => onChange({ ...value, password })} variables={variables} />
          </Field>
        </>
      )}

      {value.type === 'apikey' && (
        <>
          <Field label="Key">
            <TextInput value={value.key} placeholder="X-API-Key" variables={variables} onChange={(key) => onChange({ ...value, key })} />
          </Field>
          <Field label="Value">
            <SecretInput value={value.value} onChange={(v) => onChange({ ...value, value: v })} placeholder="{{apiKey}}" variables={variables} />
          </Field>
          <Field label="Add to">
            <select
              className="ctl w-full max-w-[220px]"
              value={value.in}
              onChange={(e) => onChange({ ...value, in: e.target.value as 'header' | 'query' })}
            >
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </select>
          </Field>
        </>
      )}
    </div>
  );
}

export const AuthEditor = memo(AuthEditorInner);
