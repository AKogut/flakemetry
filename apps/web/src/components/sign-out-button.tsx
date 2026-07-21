import { signOut } from '@/lib/auth'

export const SignOutButton = () => (
  <form
    action={async () => {
      'use server'
      await signOut({ redirectTo: '/sign-in' })
    }}
  >
    <button
      type="submit"
      className="muted"
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '0.8rem',
        textDecoration: 'underline',
      }}
    >
      Sign out
    </button>
  </form>
)
