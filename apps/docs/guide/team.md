# Your team

A workspace is shared. By default everyone in it can see every project it holds: the runs,
the error messages, the artifacts. Adding someone is therefore a real grant, and this page is
about what that grant is, how to narrow it, and how to take it back.

## Inviting

**Members → Invite**, in any project's settings. You get a link, shown once.

```
https://flakemetry.example.com/invite/fmk_…
```

Send it however you normally send a secret. Opening it, signing in and pressing
**Join the workspace** is the whole flow.

## What the link is

A capability. Whoever opens it joins. The address you typed labels the invitation; it does
not gate it.

That is deliberate. Requiring the signed-in address to match would lock out everyone whose
GitHub email is private or absent, which is common, and it would buy little: someone holding
the link has it whichever address they arrive with. The controls that actually matter are
the ones on the link itself:

- **High entropy**, and stored only as a SHA-256 hash, so a database dump does not hand it over
- **Single use**: the second person to open it is refused, not admitted alongside the first
- **Seven days**, then it is dead
- **Cancellable** at any time from the same page

Treat it like a password, because it is one.

## Roles

| Role | Can |
| --- | --- |
| **viewer** | Read every project they can open. No writes of any kind, not even RCA feedback |
| **member** | …and leave feedback on root-cause analyses |
| **admin** | …and manage projects, tokens, policy, notifications, quarantine, project access, and read the audit log |
| **owner** | …and change anyone's role, and delete the workspace |

These rules are enforced on the server, not in the form:

- **An admin can invite a member or a viewer, but not another admin or an owner.** Otherwise an
  admin could grant away control of the workspace, which is an escalation dressed up as an
  invitation. Changing anyone's role is an owner's call.
- **The last owner cannot be removed or demoted.** A workspace with no owner has nobody who can
  invite, delete or hand it over, and no way back short of the database.

## Restricted projects

A project that not everyone should see can be **restricted**: **Members → Access to this
project**. A restricted project is visible only to owners, admins and the members or viewers
granted access to it, directly or through a [team](#teams), each as a member or as a viewer of
that project. Everyone else stops
seeing it: it disappears from their project list, and its pages send them away. A grant can
never make someone more than a member, and owners and admins need no grant. They can already
open everything.

Removing someone from the workspace removes their grants with them.

## Teams

A team is a named group of people in the workspace: **Teams**, in any project's settings.
Owners and admins create teams, add and remove people, and delete them; everyone else can see
who is in which team.

Grant a team access to a restricted project on the same **Access to this project** card as a
person. From then on, joining the team gives access and leaving it takes access away, with no
change to the project. When several grants reach one person (their own and one or more
teams'), the strongest applies: member beats viewer. The access table shows people who get in
through a team as **through QA (member)**.

A team can carry the handle it goes by in CODEOWNERS, such as `@acme/qa` or GitLab's
`@group/subgroup`. Handles are case-insensitive, as they are on GitHub. Owners on a test page
then read `@acme/qa (QA)`, naming the Flakemetry team behind the CODEOWNERS entry. A handle maps
to one team per workspace.

The database holds these rules too, not only the forms: a team member must be a member of the
team's workspace, and a grant names exactly one person or one team. Leaving the workspace
drops someone from all its teams, and deleting a team drops its grants.

Syncing teams from an identity provider (SCIM) is not supported yet.

## Audit log

**Audit log** (owners and admins) lists every change to access, teams, tokens, policy,
notifications, quarantine, identities and data in the workspace: who did it, when, to what. Entries have no
foreign keys, so they outlive the people and projects they mention. Erasing a project keeps
the workspace's record that it happened. Erasing the whole workspace removes its audit log
with it, and the erasure request itself stays on record as described in
[Data governance](/reference/data-governance).

## Single sign-on

Besides GitHub, the dashboard can sign people in through any OpenID Connect provider (Okta,
Entra ID, Google Workspace, Keycloak, Auth0), or through a SAML identity provider behind an
OIDC bridge such as Keycloak or BoxyHQ. Set on the **web** service:

| Variable | Value |
| --- | --- |
| `AUTH_OIDC_ISSUER` | The provider's issuer URL, `https://` (plain `http` only for `localhost`) |
| `AUTH_OIDC_ID` / `AUTH_OIDC_SECRET` | The client registered with the provider |
| `AUTH_OIDC_NAME` | Button label, such as `Okta` (default `SSO`) |

Register `https://<dashboard>/api/auth/callback/oidc` as the redirect URI. The sign-in page
then offers **Continue with Okta** next to GitHub. Without all three variables the button is
not shown and nothing changes.

Signing in through SSO creates an account, not a membership: people still join a workspace
through an invitation. Someone who already signed in with GitHub under the same email is
refused at the SSO button with an "account not linked" error rather than merged
automatically. Linking accounts by email alone would let whoever controls that address at
either provider take over the other account. They keep using the provider they started with.

## Removing someone

**Members → Remove.** Their membership, team memberships and project grants go; the
workspace's data does not. Anything they created (policy changes, RCA feedback, identity merges) stays attributed to
them, because an audit trail that forgets who did what is not one.

Removing a person does not delete their account: they may belong to other workspaces, and
leaving one is not consent to be erased from all of them. See
[Data governance](/reference/data-governance) for what deletion does cover.
