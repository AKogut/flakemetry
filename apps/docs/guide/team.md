# Your team

A workspace is shared. Everyone in it can see every project it holds — the runs, the error
messages, the artifacts. Adding someone is therefore a real grant, and this page is about
what that grant is and how to take it back.

## Inviting

**Members → Invite**, in any project's settings. You get a link, shown once.

```
https://flakemetry.example.com/invite/fmk_…
```

Send it however you normally send a secret. Opening it, signing in with GitHub and pressing
**Join the workspace** is the whole flow.

## What the link is

A capability. Whoever opens it joins — the address you typed labels the invitation, it does
not gate it.

That is deliberate. Requiring the signed-in address to match would lock out everyone whose
GitHub email is private or absent, which is common, and it would buy little: someone holding
the link has it whichever address they arrive with. The controls that actually matter are
the ones on the link itself:

- **High entropy**, and stored only as a SHA-256 hash — a database dump does not hand it over
- **Single use** — the second person to open it is refused, not admitted alongside the first
- **Seven days**, then it is dead
- **Cancellable** at any time from the same page

Treat it like a password, because it is one.

## Roles

| Role | Can |
| --- | --- |
| **member** | Read everything in the workspace |
| **admin** | …and manage projects, tokens, policy, notifications, quarantine |
| **owner** | …and manage people, and delete the workspace |

Two rules are enforced on the server rather than in the form:

**An admin can invite a member, but not another admin or an owner.** Otherwise an admin could
grant away control of the workspace, which is an escalation dressed up as an invitation.
Changing anyone's role is an owner's call.

**The last owner cannot be removed or demoted.** A workspace with no owner has nobody who can
invite, delete or hand it over, and no way back short of the database.

## Removing someone

**Members → Remove.** Their membership goes; the workspace's data does not. Anything they
created — policy changes, RCA feedback, identity merges — stays attributed to them, because
an audit trail that forgets who did what is not one.

Removing a person does not delete their account: they may belong to other workspaces, and
leaving one is not consent to be erased from all of them. See
[Data governance](/reference/data-governance) for what deletion does cover.
