// Small UI primitives styled with VS Code theme tokens.
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import type { VariableInfo } from '../../shared/protocol';
import { Icon, type IconName } from './Icon';
import { VarInput } from './VarInput';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export function Button({
  variant = 'secondary',
  className,
  icon,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: IconName }) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
    secondary: 'bg-[var(--or-soft-strong)] text-fg hover:bg-[var(--or-line-strong)]',
    ghost: 'bg-transparent text-fg hover:bg-[var(--or-soft-strong)]',
  };
  return (
    <button
      type="button"
      disabled={disabled}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1 font-medium leading-[18px]',
        'border border-[var(--vscode-button-border,transparent)] transition-[opacity,background-color,transform] duration-100 active:scale-[0.97]',
        // Disabled buttons always look dim + neutral (no bright primary), but still show their tooltip.
        disabled ? (variant === 'ghost' ? 'cursor-default text-fg opacity-50' : 'cursor-default bg-[var(--or-soft-strong)] text-fg opacity-50') : styles[variant],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  title,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; title: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cx(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-fg transition-colors hover:bg-[var(--or-soft-strong)] disabled:opacity-40',
        active && 'bg-[var(--or-soft-strong)]',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

const COPIED_MS = 1500;

/** Copy button that morphs its icon into a check mark (with a short pop animation) after copying. */
export function CopyButton({
  text,
  onCopy,
  title = 'Copy',
  label,
  variant,
  className,
  disabled,
}: {
  /** Text to copy, or a getter evaluated on click. */
  text: string | (() => string);
  onCopy: (text: string) => void;
  title?: string;
  /** Show a text label next to the icon (rendered as a Button). */
  label?: string;
  variant?: ButtonVariant;
  className?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    onCopy(typeof text === 'function' ? text() : text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [text, onCopy]);

  // Keyed so the icon remounts and replays the pop animation on each state change.
  const icon = (
    <span key={copied ? 'check' : 'copy'} className={cx('copy-icon inline-flex', copied && 'is-copied')}>
      <Icon name={copied ? 'check' : 'copy'} />
    </span>
  );
  const shownTitle = copied ? 'Copied' : title;

  if (label !== undefined) {
    return (
      <Button variant={variant} className={className} disabled={disabled} onClick={copy} title={shownTitle} aria-live="polite">
        {icon}
        {copied ? 'Copied' : label}
      </Button>
    );
  }
  return (
    <button
      type="button"
      title={shownTitle}
      aria-label={shownTitle}
      aria-live="polite"
      disabled={disabled}
      onClick={copy}
      className={cx(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-fg transition-colors hover:bg-[var(--or-soft-strong)] disabled:opacity-40',
        copied && 'bg-success/15',
        'transition-colors duration-200',
        className,
      )}
    >
      {icon}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cx('inline-flex flex-wrap gap-0.5 rounded-full bg-[var(--or-soft)] p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-full px-3 py-0.5 text-[12px] transition-colors',
            o.value === value ? 'bg-primary text-primary-fg shadow-sm' : 'text-muted hover:text-fg hover:bg-[var(--or-soft-strong)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On / off toggle. Put it inside a <label> with the setting text so the whole row is clickable. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-[var(--or-line-strong)]',
      )}
    >
      <span
        className={cx(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none',
          checked ? 'translate-x-[19px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

export function SecretInput({
  value,
  onChange,
  className,
  variables,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (v: string) => void;
  /** Enables {{variable}} highlighting (when shown) and autocomplete. */
  variables?: readonly VariableInfo[];
}) {
  const [show, setShow] = useState(false);
  return (
    <div className={cx('ctl flex items-center gap-1 p-0 pr-1', className)}>
      {variables ? (
        <VarInput
          {...rest}
          className="flex-1"
          fieldClassName="px-1.5 py-[3px] font-mono outline-none"
          value={value}
          onChange={onChange}
          variables={variables}
          masked={!show}
        />
      ) : (
      <input
        {...rest}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent px-1.5 py-[3px] font-mono outline-none"
      />
      )}
      <IconButton icon={show ? 'eyeOff' : 'eye'} title={show ? 'Hide' : 'Show'} onClick={() => setShow((s) => !s)} className="h-5 w-5" />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('spinner inline-block', className)} role="status" aria-label="Loading" />;
}

export function DirtyDot({ show, title = 'Unsaved changes' }: { show: boolean; title?: string }) {
  if (!show) return null;
  return <span title={title} aria-label={title} className="inline-block h-2 w-2 shrink-0 rounded-full bg-fg/80" />;
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-[16px] items-center justify-center rounded-full bg-badge px-1.5 text-[10px] leading-4 text-badge-fg', className)}>
      {children}
    </span>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="px-1 py-3 text-muted">{children}</div>;
}
