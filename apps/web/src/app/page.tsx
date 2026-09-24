import { redirect } from 'next/navigation';

export default function RootPage() {
  // The session cookie decides where this lands; the API is the authority.
  redirect('/incidents');
}
