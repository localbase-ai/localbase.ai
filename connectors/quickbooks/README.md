# QuickBooks Online connector

Reads your QuickBooks Online company (customers, items, invoices, profit & loss)
into LocalBase, and exposes it to AI clients over MCP.

## You connect with your own Intuit app

LocalBase doesn't run a QuickBooks app on your behalf. You create a developer
app in your own Intuit account, and QuickBooks issues tokens to that app. Your
data goes straight between your machine and Intuit, and your app's keys live
only in your `env.local`.

You're the app owner, so Intuit's developer terms for that app apply to you.

## Setup

1. **Create an app.** Sign in at the
   [Intuit developer portal](https://developer.intuit.com/app/developer/dashboard),
   create an app, and give it the **Accounting** scope
   (`com.intuit.quickbooks.accounting`).
2. **Copy its keys.** Under *Keys & credentials*, copy the **Client ID** and
   **Client Secret**. Use the Production keys to connect a real company.
3. **Get your first tokens.** Open Intuit's
   [OAuth 2.0 Playground](https://developer.intuit.com/app/developer/playground),
   choose your app, authorize your company, and exchange the code for tokens.
   You get an access token, a refresh token and your company (realm) ID.
4. **Add everything to `env.local`** in your workspace:

   ```bash
   QUICKBOOKS_CLIENT_ID=...
   QUICKBOOKS_CLIENT_SECRET=...
   QUICKBOOKS_ACCESS_TOKEN=...
   QUICKBOOKS_REFRESH_TOKEN=...
   QUICKBOOKS_COMPANY_ID=...
   QUICKBOOKS_TOKEN_EXPIRES_AT=
   QUICKBOOKS_ENVIRONMENT=production
   ```

   Or open **Settings** in the app, configure QuickBooks, and paste them
   there; it writes the same file.

## Keeping the connection alive

Access tokens last about an hour. Refresh them with your app's keys:

```bash
node connectors/quickbooks/token-refresh.js
```

It rewrites the token lines in `env.local` (owner-only, mode 0600). QuickBooks
rotates the refresh token on every refresh, so always keep the newest one; a
refresh token that goes unused for long enough expires and you'll need to
repeat step 3.

## Syncing

```bash
node connectors/quickbooks/sync-quickbooks.js
```

## Read-only by default

The MCP tools that create or update customers are hidden and refused unless
you opt in:

```bash
QUICKBOOKS_ENABLE_WRITES=true
```

Leave this off unless you need it: AI clients read synced data that other
people can influence (lead notes, deal comments), and a write tool lets that
text change your books.
