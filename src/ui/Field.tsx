import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (props: { id: string; describedBy: string | undefined }) => ReactNode;
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // 错误优先播报，两者都存在时把 hint 一起关联，避免用户漏掉说明
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-700">
        {label}
      </label>
      {children({ id, describedBy: describedBy || undefined })}
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-ink-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-seal">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASS =
  'w-full rounded-xl border border-ink-100 bg-paper-raised px-3 py-2.5 text-ink-900 ' +
  'placeholder:text-ink-300 focus:border-ink-500 focus:outline-none focus:ring-2 focus:ring-ink-100';

export function TextField({
  label,
  hint,
  error,
  ...rest
}: { label: string; hint?: ReactNode; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={CONTROL_CLASS}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  rows = 3,
  ...rest
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          rows={rows}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`${CONTROL_CLASS} resize-none`}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  options,
  ...rest
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  options: { value: string; label: string }[];
} & InputHTMLAttributes<HTMLSelectElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          className={CONTROL_CLASS}
          {...(rest as object)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
