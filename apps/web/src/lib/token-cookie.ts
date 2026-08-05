export const NEW_TOKEN_COOKIE = 'flakemetry_new_token'

/**
 * The invitation link comes back through a short-lived httpOnly cookie rather than a query
 * parameter, for the same reason the token does: a credential in a URL survives in browser
 * history, in proxy logs, and in anything the page gets shared into.
 */
export const NEW_INVITE_COOKIE = 'flakemetry_new_invite'
