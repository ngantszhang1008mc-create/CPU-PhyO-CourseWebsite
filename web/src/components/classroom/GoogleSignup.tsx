import { useEffect, useRef, useState } from 'react';

interface IdentityServices {
  initialize(options: {
    client_id: string;
    nonce: string;
    hd: string;
    login_hint: string;
    callback: (response: { credential?: string }) => void;
  }): void;
  renderButton(
    container: HTMLElement,
    options: { theme: string; text: string; size: string },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: IdentityServices } };
  }
}

let loading: Promise<IdentityServices> | undefined;
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (loading) return loading;
  loading = new Promise<IdentityServices>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    function failed() {
      script.remove();
      loading = undefined;
      reject(new Error('Google sign-in could not load. Check your connection and try again.'));
    }
    script.onload = () =>
      window.google?.accounts?.id ? resolve(window.google.accounts.id) : failed();
    script.onerror = failed;
    document.head.append(script);
  });
  return loading;
}

export interface GoogleChallenge {
  required: true;
  clientId: string;
  email: string;
  nonce: string;
}

export function GoogleSignup({
  challenge,
  selected,
}: {
  challenge: GoogleChallenge;
  selected: (credential: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('Loading Google sign-in…');
  const [retry, setRetry] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadGoogle()
      .then((id) => {
        if (!active || !container.current) return;
        id.initialize({
          client_id: challenge.clientId,
          nonce: challenge.nonce,
          hd: 'cpu.edu.hk',
          login_hint: challenge.email,
          callback: (response) => {
            if (active && response.credential) selected(response.credential);
          },
        });
        id.renderButton(container.current, {
          theme: 'outline',
          text: 'continue_with',
          size: 'large',
        });
        setMessage('');
      })
      .catch((err) => {
        if (active) {
          setMessage(err.message);
          setRetry(true);
        }
      });
    return () => {
      active = false;
    };
  }, [challenge, selected, attempt]);
  return (
    <section>
      <p>
        Continue with your school Google account, <strong>{challenge.email}</strong>.
      </p>
      <div ref={container} />
      <span role="status">{message}</span>
      {retry && (
        <button
          type="button"
          onClick={() => {
            setRetry(false);
            setAttempt(attempt + 1);
          }}
        >
          Retry Google sign-in
        </button>
      )}
    </section>
  );
}
