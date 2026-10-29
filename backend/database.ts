import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const defaultDatabasePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'financas.sqlite')

export function openDatabase(filename = process.env.FINANCAS_DB_PATH ?? defaultDatabasePath): DatabaseSync {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  let { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (version > 4) {
    db.close()
    throw new Error(`A base de dados está na versão ${version}, mais recente do que a versão suportada.`)
  }
  if (version === 0) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS financial_profiles (
      id TEXT PRIMARY KEY CHECK (id IN ('user1', 'user2')),
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
      institution TEXT NOT NULL DEFAULT '',
      classification TEXT NOT NULL CHECK (classification IN ('available', 'reserved', 'investment', 'other')),
      opening_balance_minor INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS account_owners (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      profile_id TEXT NOT NULL REFERENCES financial_profiles(id) ON DELETE RESTRICT,
      PRIMARY KEY (account_id, profile_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      from_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      to_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('transfer', 'contribution', 'reimbursement', 'other')),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      date TEXT NOT NULL,
      CHECK (from_account_id <> to_account_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      context TEXT NOT NULL CHECK (context IN ('user1', 'user2', 'joint')),
      type TEXT NOT NULL CHECK (type IN (
        'income', 'expense', 'dividend', 'interest', 'transfer_in', 'transfer_out'
      )),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 240),
      category TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      transfer_id TEXT REFERENCES transfers(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS transactions_account_date
      ON transactions(account_id, date);
    CREATE INDEX IF NOT EXISTS transactions_context_date
      ON transactions(context, date);
      `)
      db.exec('PRAGMA user_version = 1')
      db.exec('COMMIT')
      version = 1
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }
  if (version === 1) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE TABLE categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
          kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
          parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
          archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
          UNIQUE (name, kind)
        ) STRICT;

        ALTER TABLE transactions ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT;

        CREATE TABLE reconciliations (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
          reported_balance_minor INTEGER NOT NULL,
          calculated_balance_minor INTEGER NOT NULL,
          difference_minor INTEGER NOT NULL,
          reported_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (difference_minor = reported_balance_minor - calculated_balance_minor)
        ) STRICT;

        CREATE INDEX reconciliations_account_date
          ON reconciliations(account_id, reported_at DESC);
      `)
      const insertCategory = db.prepare('INSERT INTO categories (id, name, kind) VALUES (?, ?, ?)')
      const categories = [
        ['housing', 'Habitação', 'expense'],
        ['food', 'Alimentação', 'expense'],
        ['restaurants', 'Restaurantes', 'expense'],
        ['transport', 'Transportes', 'expense'],
        ['car', 'Automóvel', 'expense'],
        ['health', 'Saúde', 'expense'],
        ['leisure', 'Lazer', 'expense'],
        ['shopping', 'Compras', 'expense'],
        ['subscriptions', 'Subscrições', 'expense'],
        ['education', 'Educação', 'expense'],
        ['travel', 'Viagens', 'expense'],
        ['taxes', 'Impostos', 'expense'],
        ['insurance', 'Seguros', 'expense'],
        ['gifts', 'Presentes', 'expense'],
        ['other-expense', 'Outras despesas', 'expense'],
        ['salary', 'Salário', 'income'],
        ['extra-income', 'Rendimentos extra', 'income'],
        ['dividends', 'Dividendos', 'income'],
        ['interest', 'Juros', 'income'],
        ['refunds', 'Reembolsos', 'income'],
        ['other-income', 'Outras receitas', 'income'],
      ] as const
      for (const category of categories) insertCategory.run(...category)
      db.exec('PRAGMA user_version = 2')
      db.exec('COMMIT')
      version = 2
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }
  if (version === 2) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE TABLE import_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
          institution TEXT NOT NULL DEFAULT '',
          account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
          mapping_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        ) STRICT;

        CREATE TABLE import_batches (
          id TEXT PRIMARY KEY,
          institution TEXT NOT NULL DEFAULT '',
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
          filename TEXT NOT NULL,
          total_count INTEGER NOT NULL CHECK (total_count >= 0),
          imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
          ignored_count INTEGER NOT NULL CHECK (ignored_count >= 0),
          duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
          failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
          state TEXT NOT NULL CHECK (state IN ('completed', 'undone')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          undone_at TEXT
        ) STRICT;

        CREATE TABLE import_staging (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          institution TEXT NOT NULL DEFAULT '',
          filename TEXT NOT NULL,
          headers_json TEXT NOT NULL,
          rows_json TEXT NOT NULL,
          mapping_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        ) STRICT;

        ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
          CHECK (source IN ('manual', 'import'));
        ALTER TABLE transactions ADD COLUMN external_identifier TEXT;
        ALTER TABLE transactions ADD COLUMN fingerprint TEXT;
        ALTER TABLE transactions ADD COLUMN import_batch_id TEXT REFERENCES import_batches(id) ON DELETE RESTRICT;
        ALTER TABLE transactions ADD COLUMN raw_data_json TEXT;
        ALTER TABLE transactions ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0
          CHECK (manual_override IN (0, 1));
        ALTER TABLE transactions ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

        CREATE UNIQUE INDEX transactions_account_external_id
          ON transactions(account_id, external_identifier)
          WHERE external_identifier IS NOT NULL;
        CREATE INDEX transactions_import_batch
          ON transactions(import_batch_id);
        CREATE INDEX transactions_fingerprint
          ON transactions(account_id, fingerprint)
          WHERE fingerprint IS NOT NULL;
        CREATE INDEX import_batches_created
          ON import_batches(created_at DESC);
      `)
      db.exec('PRAGMA user_version = 3')
      db.exec('COMMIT')
      version = 3
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }
  if (version === 3) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE TABLE transactions_v4 (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
          context TEXT NOT NULL CHECK (context IN ('user1', 'user2', 'joint')),
          type TEXT NOT NULL CHECK (type IN (
            'income', 'expense', 'dividend', 'interest', 'transfer_in', 'transfer_out',
            'investment_buy', 'investment_sell'
          )),
          amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
          description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 240),
          category TEXT NOT NULL DEFAULT '',
          date TEXT NOT NULL,
          transfer_id TEXT REFERENCES transfers(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
          source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
          external_identifier TEXT,
          fingerprint TEXT,
          import_batch_id TEXT REFERENCES import_batches(id) ON DELETE RESTRICT,
          raw_data_json TEXT,
          manual_override INTEGER NOT NULL DEFAULT 0 CHECK (manual_override IN (0, 1)),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        ) STRICT;

        INSERT INTO transactions_v4 (
          id, account_id, context, type, amount_minor, description, category, date,
          transfer_id, created_at, category_id, source, external_identifier,
          fingerprint, import_batch_id, raw_data_json, manual_override, updated_at
        )
        SELECT id, account_id, context, type, amount_minor, description, category, date,
          transfer_id, created_at, category_id, source, external_identifier,
          fingerprint, import_batch_id, raw_data_json, manual_override, updated_at
        FROM transactions;

        DROP TABLE transactions;
        ALTER TABLE transactions_v4 RENAME TO transactions;

        CREATE INDEX transactions_account_date ON transactions(account_id, date);
        CREATE INDEX transactions_context_date ON transactions(context, date);
        CREATE UNIQUE INDEX transactions_account_external_id
          ON transactions(account_id, external_identifier)
          WHERE external_identifier IS NOT NULL;
        CREATE INDEX transactions_import_batch ON transactions(import_batch_id);
        CREATE INDEX transactions_fingerprint
          ON transactions(account_id, fingerprint)
          WHERE fingerprint IS NOT NULL;

        CREATE TABLE investment_assets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
          symbol TEXT NOT NULL DEFAULT '' CHECK (length(symbol) <= 20),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        ) STRICT;

        CREATE TABLE investment_trades (
          id TEXT PRIMARY KEY,
          transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
          asset_id TEXT NOT NULL REFERENCES investment_assets(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
          side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
          quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
          unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0),
          amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
          date TEXT NOT NULL
        ) STRICT;
        CREATE INDEX investment_trades_asset_account_date
          ON investment_trades(asset_id, account_id, date);
        CREATE TRIGGER investment_trade_consistent_insert
          BEFORE INSERT ON investment_trades
          WHEN NOT EXISTS (
            SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
            WHERE t.id = NEW.transaction_id AND t.account_id = NEW.account_id
              AND t.type = CASE NEW.side WHEN 'buy' THEN 'investment_buy' ELSE 'investment_sell' END
              AND t.amount_minor = NEW.amount_minor AND a.classification = 'investment'
          )
          BEGIN
            SELECT RAISE(ABORT, 'Investment trade does not match its cash transaction');
          END;
        CREATE TRIGGER investment_trade_consistent_update
          BEFORE UPDATE ON investment_trades
          WHEN NOT EXISTS (
            SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
            WHERE t.id = NEW.transaction_id AND t.account_id = NEW.account_id
              AND t.type = CASE NEW.side WHEN 'buy' THEN 'investment_buy' ELSE 'investment_sell' END
              AND t.amount_minor = NEW.amount_minor AND a.classification = 'investment'
          )
          BEGIN
            SELECT RAISE(ABORT, 'Investment trade does not match its cash transaction');
          END;

        CREATE TABLE investment_prices (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL REFERENCES investment_assets(id) ON DELETE RESTRICT,
          price_minor INTEGER NOT NULL CHECK (price_minor > 0),
          quoted_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (asset_id, quoted_at)
        ) STRICT;
        CREATE INDEX investment_prices_latest ON investment_prices(asset_id, quoted_at DESC);

        CREATE TABLE budgets (
          id TEXT PRIMARY KEY,
          context TEXT NOT NULL CHECK (context IN ('user1', 'user2', 'joint')),
          category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
          period TEXT NOT NULL CHECK (
            length(period) = 7 AND period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
            AND substr(period, 6, 2) BETWEEN '01' AND '12'
          ),
          amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (context, category_id, period)
        ) STRICT;

        CREATE TABLE savings_goals (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
          context TEXT NOT NULL CHECK (context IN ('user1', 'user2', 'joint')),
          target_minor INTEGER NOT NULL CHECK (target_minor > 0),
          saved_minor INTEGER NOT NULL DEFAULT 0 CHECK (saved_minor >= 0),
          target_date TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        ) STRICT;

        PRAGMA user_version = 4;
      `)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }
  return db
}

export function isConfigured(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM app_settings WHERE key = 'password_hash'").get() !== undefined
}
