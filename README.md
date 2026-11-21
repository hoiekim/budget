# Budget

Budget is a web app for tracking financial accounts and transactions. It helps users understand their money flow and establish long-term plans, integrating with [Plaid](https://plaid.com/) and [SimpleFin](https://www.simplefin.org).

See the [live demo](https://budget.hoie.kim) (username: `demo`, password: `budget`).

## Documentation

- [Getting Started](docs/GETTING_STARTED.md) — setup, installation, environment variables
- [Architecture](docs/ARCHITECTURE.md) — tech stack, project structure, data models, integrations
- [Development](docs/DEVELOPMENT.md) — dev server, build, common tasks
- [Testing](docs/TESTING.md) — running and writing tests
- [API](docs/API.md) — route patterns, response format, authentication, input validation
- [Code Style](docs/CODE_STYLE.md) — imports, TypeScript, logging, accessibility
- [Database](docs/DATABASE.md) — connection, table methods, repository pattern, transactions
- [Security](docs/SECURITY.md) — auth middleware, data sharing, session fixation, anti-enumeration, ownership verification
- [Design Patterns](docs/DESIGN_PATTERNS.md) — sync patterns, concurrency, performance
- [Deployment](docs/DEPLOYMENT.md) — production, Docker, CI/CD

## Sharing data with another user

Two or more users can share their data: every account, transaction, budget and chart of each shows up for all of them as if it were one user's, and each can edit all of it.

- On the Configuration page, enter the other user's username under **Share Data** and send the invitation. It appears on their Configuration page, where they accept or decline it.
- Once they accept, both of you see and edit everything. Only the Configuration page tells whose a connection is: each one under **Connections** carries its owner's username.
- Transfers between two people's accounts are suggested like transfers between one person's.
- Inviting someone while you already share brings them into the same group, so everyone in it shares with everyone. A user is in one group at a time.
- **Stop Sharing** on the Configuration page ends it. Everyone keeps what they own: a connection and its accounts and transactions stay with whoever made the connection, and a budget with whoever created it, whoever edited them since. Labels that point at the other person's budgets are kept, and work again if you share again.
- API keys and sign-in stay personal. An API key acts as its owner, so it reaches the shared data too.
- The `demo` account can neither invite nor be invited.

## Single sign-on (optional)

Budget can let people sign in through an OpenID Connect identity provider, such as the auth identity service, instead of (or next to) its own passwords. It is off unless `AUTH_ISSUER` is set; with it unset, budget signs in with its own passwords exactly as before, and nothing here applies.

### Settings

| Variable | Required | Meaning |
|---|---|---|
| `AUTH_ISSUER` | — | Issuer URL of the identity provider, e.g. `https://auth.example.com`. Unset or empty turns single sign-on off. |
| `AUTH_CLIENT_ID` | with `AUTH_ISSUER` | The OAuth client id registered for budget. |
| `AUTH_CLIENT_SECRET` | with `AUTH_ISSUER` | That client's secret. Tokens stay on the server. |
| `AUTH_REDIRECT_URI` | when `HOST_NAME` is unset | The callback URL registered for the client. Default: `https://$HOST_NAME/api/auth/callback`. |
| `AUTH_BACKCHANNEL_URL` | no | A private-network URL of the same issuer, for budget's server-to-server calls. |
| `AUTH_AUDIENCE` | no | The service name in tokens' `aud`, when it differs from the client id. |
| `AUTH_LOCAL_LOGIN` | no (`false`) | `true` keeps budget's own password sign-in next to single sign-on, e.g. during a migration. |
| `AUTH_LINK_USERS` | no | Comma-separated `<local username>=<SSO username>` pairs, e.g. `admin=alice,bob=bob`: existing accounts to link on their first SSO sign-in. |

Budget checks these at start and refuses to start, listing every problem, when one is wrong. It never contacts the identity provider at start, so it starts whether or not the provider is up. The sign-in cookie is `Secure`, so serve budget over HTTPS (browsers make an exception for `localhost`).

### Registering budget with the identity provider

With the auth identity service, register budget on its admin page (the **Services** tab), or in its services file if the deployment keeps one. Once the client's secret is made, the admin page lists the `AUTH_*` lines to paste into budget's environment. Budget has no roles of its own: any role on the service lets the person in, so one role is enough. The API key scope is the one budget's routes accept (`transactions:suggest`). The definition, as the services file takes it:

```json
{
  "name": "budget",
  "roles": ["user"],
  "mfa_roles": [],
  "signup": "invite",
  "api_key_scopes": ["transactions:suggest"],
  "clients": [{
    "id": "budget",
    "type": "confidential",
    "redirect_uris": ["https://budget.example.com/api/auth/callback"],
    "post_logout_redirect_uris": ["https://budget.example.com/"]
  }],
  "events_url": "https://budget.example.com/api/auth/events"
}
```

The post-logout redirect is always the origin of `AUTH_REDIRECT_URI` followed by `/`. `events_url` may be a private-network URL of budget instead.

### Accounts

The first time someone signs in, budget finds their account in this order:

1. the account already linked to their SSO account;
2. the account `AUTH_LINK_USERS` names for their SSO username, if it is not linked to anyone yet: it is linked now and keeps its data. From then on it signs in only with SSO, even while `AUTH_LOCAL_LOGIN=true`;
3. the account whose email is the email in their SSO ID token, in any letter case, if it is not linked to anyone yet: it is linked the same way;
4. otherwise a new account named after their SSO username, with no password, and with their email unless another account already has it.

So before turning single sign-on on, give each existing account the email its owner has at the identity provider, for example:

```sql
UPDATE users SET email = 'alice@example.com' WHERE username = 'admin';
```

Leave the shared `demo` account without one. Emails must be unique, ignoring letter case; budget refuses to start while two accounts share one, and names the shared addresses.

Budget matches the email whether or not the provider marked it verified. The operator filled in these addresses, and the auth identity service sets an address a person chose only after they confirm it (an unverified address there was entered by its administrator), so a match is as trustworthy as `AUTH_LINK_USERS`. A provider that lets people claim addresses they have not confirmed must not be used this way: with such a provider, leave the accounts' emails empty and use `AUTH_LINK_USERS`.

If the SSO username is already taken by an account that isn't linked and none of the above found theirs, the `admin` and `demo` accounts included, the sign-in is refused (the sign-in page says the account exists) rather than guessing: link it with its email or `AUTH_LINK_USERS`. `admin` and `demo` are still created at every start; without `AUTH_LOCAL_LOGIN` their passwords no longer sign in. Note that `demo` is pinned to Plaid's sandbox, so whoever is linked to it is too.

### What changes while it is on

- The sign-in page offers **Sign in with SSO**. Password sign-in is hidden, and `POST /api/login` answers `403`, unless `AUTH_LOCAL_LOGIN` is `true`.
- Every ten minutes, a session started by single sign-on checks with the identity provider that the person still has access. If the provider can't be reached, the session keeps working and checks again on the next request, for up to an hour.
- The provider's events end sessions right away: signing out of the provider, losing access to budget, and being disabled or deleted. Losing access, being disabled or being deleted also revokes the API keys budget itself issued to that account (access given back later doesn't restore them). Open real-time connections close within a minute, on every copy of budget. A deleted person's data stays in budget; removing it is up to the operator.
- Signing out of budget also signs out of the provider.
- API keys the provider issued for budget work on the routes that accept API keys, when their scopes include the route's and their owner has signed in to budget at least once. Budget's own API keys keep working as before.
- Sessions that were signed in with a password end at their next request, unless `AUTH_LOCAL_LOGIN=true`.

### Turning it off

Unset `AUTH_ISSUER` and restart. Sessions started by single sign-on end at their next request, and password sign-in works again for every account that has a password (including linked ones). Accounts that single sign-on created have no password, and budget has no password reset, so they can't sign in until single sign-on is back on; their data is kept.

## Contributing

Open an [issue](https://github.com/hoiekim/budget/issues/new) or send a pull request. For questions, reach out at budget@hoie.kim.
