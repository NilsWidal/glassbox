import { login } from '../auth/session';

interface Props {
  message?: string;
  onDone: (token: string) => void;
}

export const LoginForm = ({ message, onDone }: Props) => {
  const submit = async (email: string, password: string) => {
    const session = await login(email, password);
    if (session) onDone(session.token);
  };
  return (
    <form onSubmit={() => submit('', '')}>
      {/* Risky: renders a server-provided message as raw HTML. */}
      <div dangerouslySetInnerHTML={{ __html: message ?? '' }} />
      <input name="email" />
      <input name="password" type="password" />
    </form>
  );
};
