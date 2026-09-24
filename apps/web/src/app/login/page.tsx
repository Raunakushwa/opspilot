'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Window } from '@/components/window';
import { ApiError, apiFetch } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void signIn();
  };

  const signIn = async () => {
    setPending(true);
    setError(null);
    try {
      await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      router.replace('/incidents');
    } catch (err) {
      // The API deliberately does not say which half was wrong.
      setError(err instanceof ApiError ? err.problem.title : 'Unable to sign in');
      setPending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <p className="label-mono mb-3 text-ink-muted">OpsPilot · incident operations</p>
      <h1 className="mb-6 text-5xl">Sign in.</h1>

      <Window title="Authentication">
        <form onSubmit={submit} className="grid gap-3">
          <label className="grid gap-1">
            <span className="label-mono text-ink-muted">Email</span>
            <input
              type="email"
              value={email}
              autoComplete="username"
              required
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              className="border border-ink bg-paper p-2"
            />
          </label>
          <label className="grid gap-1">
            <span className="label-mono text-ink-muted">Password</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className="border border-ink bg-paper p-2"
            />
          </label>

          {error ? <p className="label-mono text-sev1">{error}</p> : null}

          <button
            type="submit"
            disabled={pending}
            className="border border-ink bg-ink px-3 py-2 text-paper disabled:opacity-40"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </Window>

      <p className="label-mono mt-4 text-ink-muted">
        Demo: ada@acme.test (owner) · grace@acme.test (engineer) · password demo-password-1234
      </p>
    </main>
  );
}
