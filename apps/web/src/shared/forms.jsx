// Small pieces the sign-in pages share: a labelled password or text field, and the page frame for people who are not signed in.
import { useId } from 'react';

/**
 * @param {{ label: string, type?: string, value: string, onChange: (v: string) => void, autoComplete?: string, hint?: string, error?: string | null, required?: boolean }} props
 */
export function Field({ label, type = 'text', value, onChange, autoComplete, hint, error, required = true }) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} autoComplete={autoComplete} required={required} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The frame of a page shown before anyone is signed in. @param {{ title: string, children: import('react').ReactNode }} props */
export function AuthFrame({ title, children }) {
  return (
    <main id="main" tabIndex={-1} className="page auth-page">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export const PASSWORD_HINT = 'At least 10 characters, and not your user name.';
