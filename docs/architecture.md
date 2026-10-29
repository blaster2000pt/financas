# Architecture decision: local-first finance app

## Executive summary

Build a private household-finance web app that runs on one computer, binds only to loopback, and stores its operational data in SQLite. The first implementation uses React and TypeScript in the browser, a small Node.js/TypeScript HTTP API, and SQLite through Node's built-in `node:sqlite` module. This keeps the initial system small and avoids a cloud service, bank connection, native database dependency, or second application language.

The application has one shared password gate and exactly two financial profiles. An account is stored once and linked to one or both profiles. Account ownership determines where balances belong; each transaction's financial context independently determines where income and expenses are reported.

## Requirements and boundaries

### Functional foundation

- One application password; two named financial profiles; no individual logins.
- Personal and jointly owned accounts, stored once.
- EUR-only records, integer cents for money, manual transactions and linked transfers.
- Calculated account balances derived from opening balance and movements.
- Personal, joint, and global views without counting joint accounts twice.
- Local setup and operation without cloud, telemetry, bank APIs, automatic quotes, or AI.

### Non-functional requirements

- SQLite referential integrity, constraints, transactions, indexes, and versioned schema.
- Bind the API and development server to `127.0.0.1`.
- Validate inputs and use parameterized SQL.
- Hash the application password; do not log it.
- Keep financial calculations testable without UI or database dependencies.
- Use fictitious data in tests.

### Explicitly out of scope for the foundation

Automatic prices, bank connections, cloud sync, and investment tax-lot or realized-gain accounting are out of scope. The implemented investment model is deliberately basic: manual assets, manual quotes, and buy/sell operations that reconcile cash and asset quantities.

## Technology options

| Option | Benefits | Trade-offs |
|---|---|---|
| React + TypeScript/Vite, Node.js + TypeScript, built-in SQLite | One application language; type-safe UI and API; local HTTP boundary; SQLite without a native package; direct fit for a browser UI and local operation. | Node's built-in SQLite and native TypeScript execution are tied to supported Node versions; CSV/XLSX libraries still need a later focused choice. |
| React + TypeScript/Vite, Python/FastAPI, SQLite | Strong Python data/CSV ecosystem; familiar SQLite support; clear API framework. | Adds a second language and toolchain, plus separately maintained API contracts and packaging. |

**Decision:** use the first option for the MVP. Keep the server thin and the financial rules in dependency-light domain functions. Reassess the built-in SQLite driver if its maturity or packaging becomes a practical issue; do not add an ORM or framework without a concrete need.

## Data model

The SQLite schema is versioned and currently includes:

- `financial_profiles`: fixed identifiers `user1` and `user2`, with user-provided display names.
- `accounts`: one record per bank, digital, cash, or other account; opening balance in integer cents; classification and archive state.
- `account_owners`: one or two profile links per account. A jointly owned account is one account with both links, never two account rows.
- `transactions`: one account posting, positive integer amount, date, category, type, and an explicit financial context.
- `transfers`: one transfer record with source, destination, kind, amount, and date; two related transaction legs are created atomically.
- `app_settings`: application password hash and future single-instance settings.
- `categories` and `reconciliations`: categorized flows and dated reported-balance observations.
- `import_staging`, `import_batches`, and `import_profiles`: temporary file previews, committed import history, and reusable column mappings.
- Import provenance on `transactions`, including source, external identifier, fingerprint, source-row data, and batch association.
- `investment_assets`, `investment_trades`, and `investment_prices`: manual instruments, cash-linked operations with milli-unit quantities, and dated manual quotes.
- `budgets`: monthly category limits by financial context.
- `savings_goals`: target amounts, dates, and a manually tracked progress amount.

Categorization rules and more advanced investment accounting remain future work.

### Ownership and context

Account ownership uses the profiles attached through `account_owners`. One owner maps to that person's context; both owners map to `joint`. Transaction context is independent and can be overridden: for example, a personal expense paid from a joint account remains owned by the joint account but is reported as personal spending. The global stock balance sums each account once; flow totals group by each transaction's context.

## Financial invariants

1. `Global balance = User 1 balance + User 2 balance + Joint balance`; each account contributes to exactly one stock context.
2. Joint ownership is represented by two owner links to one account, not duplicated balances.
3. Transfers have equal and opposite account postings and are not income or expenses.
4. Investment purchases reduce cash and add asset quantity; sales increase cash and reduce units held. They are neither income nor consumption.
5. Investment quantities use thousandths of a unit; trade and manual quote prices and totals are stored in EUR cents.
6. Net worth is cash balances plus asset positions with a recorded manual quote. An unquoted position is disclosed and omitted from the valued total.
7. Account balance is opening balance plus signed postings; a reported institution balance is a separate dated observation.
8. EUR is the only supported currency for the current household; no FX conversion is applied.
9. Monetary input is converted to integer cents before storage. Zero is valid for an opening balance; transaction amounts must be positive.
10. A transaction context override changes flow attribution, never account ownership.
11. Budget actuals sum only expense movements in the selected month and context.
12. Savings-goal progress is planning metadata, not a balance, account, or cash movement.

The tests cover exact EUR parsing, joint account classification, context overrides, global balance/flow invariants, investment cash flows and valuations, database constraints, and CSV/XLSX normalization. Import preview/analyze/commit keeps probable duplicates reviewable, treats external identifiers as confirmed matches, and writes each batch atomically. Transfers and investment operations write their cash and domain records atomically.

## Transaction model versus double-entry ledger

The MVP uses explicit domain transactions rather than a generic ledger. Ordinary income and expenses post to one account; transfers have a first-class record and two linked postings; each investment trade is paired with an investment-specific cash transaction and a quantity record. This is less abstract than a reusable double-entry engine and easier to explain in a household UI. Constraints, atomic writes, and invariant tests provide the required correctness for the current scope. Revisit a general ledger only if later features cannot be expressed safely with these explicit records.

## Import architecture

The implemented flow is file selection → preview → column mapping → normalization → duplicate analysis → user confirmation → one atomic batch commit. Keep the source details and import batch on each imported record. External identifiers are preferred for matching; deterministic fingerprints are review signals, not proof. Probable matches require user review rather than silent deletion. Imported category text is retained, but it is linked to a category only when a matching active category of the correct kind exists; unrecognized names are not silently mapped.

Undo is limited to the selected batch. Movements edited after import should be preserved and reported as not undone; independent manual edits must never be removed as a side effect. Reapplying mappings or rules must not silently overwrite a manual category decision.

## Security and privacy decisions

- Password hashes use scrypt; the application password is a local access gate, not encryption.
- **Decision confirmed:** SQLite data is not encrypted at rest in the MVP. Protect the operating-system account and any copies/backups.
- API and Vite development server bind to `127.0.0.1`; there are no external services or financial-data telemetry.
- SQL uses parameters; backend input is validated; session cookies are HTTP-only and same-site.
- No Open Banking, direct bank APIs, cloud sync, automatic prices, external AI, MFA, individual credentials, or roles.

## Roadmap

1. **Foundation:** complete — local startup, schema/migrations, shared-password setup, profiles and account ownership.
2. **Core finance:** complete — manual movements, categories, transfers, calculated/reported balances and reconciliation.
3. **Imports:** implemented — CSV/XLSX preview and mapping, import profiles, duplicate review, batches and conservative undo. Categorization rules remain future work.
4. **Planning and investments:** implemented — budgets, savings goals, basic manual assets/prices, and cash-linked buy/sell operations.
5. **Analysis UX:** implemented — context-aware totals, monthly category summaries, transaction search, and an explicitly limited three-month historical average.
6. **Resilience and polish:** implemented — SQLite backup and staged integrity-checked restore with a pre-restore safety copy. Encryption, automated scheduling, and broader browser-level regression coverage remain future work.

## Risks to guard against

- Double-counting a joint account in a dashboard, report, or forecast.
- Treating a transfer as income/expense, or investment principal as consumption.
- Losing context attribution when a joint account pays a personal expense.
- False-positive duplicate matching or undo removing a subsequently edited movement.
- Reconciling by silently changing a movement instead of surfacing the discrepancy.
- Restore replacing data before the backup is validated and a safety copy is made.
- Users mistaking a password gate for disk encryption.
- Manual prices becoming stale; valuation dates must remain visible and unquoted positions excluded from the valued net worth.
- Goal progress being mistaken for cash; the UI labels it as manually tracked planning data.

## Open decisions

No product decision blocks the foundation. The household uses EUR only; database-at-rest encryption is not part of the MVP. Future decisions should be deferred until their feature is planned, particularly exact import formats, backup encryption, investment valuation conventions, and forecast assumptions.
