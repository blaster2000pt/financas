import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isConfigured, openDatabase } from './database.ts'

test('database starts unconfigured and enforces the two-profile model', () => {
  const db = openDatabase(':memory:')
  try {
    assert.equal(isConfigured(db), false)
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM categories').get() as { count: number }).count, 21)
    for (const table of ['investment_assets', 'investment_trades', 'investment_prices', 'budgets', 'savings_goals']) {
      assert.equal((db.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('table', table) !== undefined), true)
    }
    const insertProfile = db.prepare('INSERT INTO financial_profiles (id, name) VALUES (?, ?)')
    insertProfile.run('user1', 'Pessoa Um')
    insertProfile.run('user2', 'Pessoa Dois')
    assert.throws(() => insertProfile.run('user3', 'Terceira Pessoa'))

    db.prepare("INSERT INTO app_settings (key, value) VALUES ('password_hash', 'test-hash')").run()
    assert.equal(isConfigured(db), true)
  } finally {
    db.close()
  }
})

test('database constraints protect account ownership and transaction amounts', () => {
  const db = openDatabase(':memory:')
  try {
    db.prepare('INSERT INTO financial_profiles (id, name) VALUES (?, ?)').run('user1', 'Pessoa Um')
    db.prepare('INSERT INTO financial_profiles (id, name) VALUES (?, ?)').run('user2', 'Pessoa Dois')
    db.prepare(`
      INSERT INTO accounts (id, name, institution, classification, opening_balance_minor)
      VALUES ('joint', 'Conta conjunta', 'Banco', 'available', 25000)
    `).run()
    db.prepare("INSERT INTO account_owners (account_id, profile_id) VALUES ('joint', 'user1')").run()
    db.prepare("INSERT INTO account_owners (account_id, profile_id) VALUES ('joint', 'user2')").run()

    assert.throws(() => db.prepare(`
      INSERT INTO transactions (id, account_id, context, type, amount_minor, description, date)
      VALUES ('invalid', 'joint', 'joint', 'expense', 0, 'Inválido', '2026-10-01')
    `).run())
    assert.throws(() => db.prepare(`
      INSERT INTO account_owners (account_id, profile_id) VALUES ('missing', 'user1')
    `).run())
    assert.throws(() => db.prepare(`
      INSERT INTO transactions (id, account_id, context, type, amount_minor, description, date, category_id)
      VALUES ('bad-category', 'joint', 'joint', 'expense', 100, 'Inválido', '2026-10-01', 'missing-category')
    `).run())
    assert.throws(() => db.prepare(`
      INSERT INTO budgets (id, context, category_id, period, amount_minor)
      VALUES ('bad-period', 'user1', 'food', '2026-13', 1000)
    `).run())
    db.prepare(`
      INSERT INTO accounts (id, name, institution, classification, opening_balance_minor)
      VALUES ('broker', 'Carteira', 'Teste', 'investment', 10000)
    `).run()
    db.prepare("INSERT INTO account_owners (account_id, profile_id) VALUES ('broker', 'user1')").run()
    db.prepare("INSERT INTO investment_assets (id, name, symbol) VALUES ('fund', 'Fundo', 'FND')").run()
    db.prepare(`
      INSERT INTO transactions (id, account_id, context, type, amount_minor, description, date)
      VALUES ('investment-buy', 'broker', 'user1', 'investment_buy', 1000, 'Compra', '2026-10-01')
    `).run()
    db.prepare(`
      INSERT INTO investment_trades (
        id, transaction_id, asset_id, account_id, side, quantity_milli,
        unit_price_minor, amount_minor, date
      ) VALUES ('trade', 'investment-buy', 'fund', 'broker', 'buy', 1000, 1000, 1000, '2026-10-01')
    `).run()
    assert.throws(() => db.prepare(`
      INSERT INTO investment_trades (
        id, transaction_id, asset_id, account_id, side, quantity_milli,
        unit_price_minor, amount_minor, date
      ) VALUES ('mismatched-trade', 'investment-buy', 'fund', 'broker', 'sell', 1000, 1000, 1000, '2026-10-01')
    `).run())
  } finally {
    db.close()
  }
})

test('version 3 databases migrate to the current schema without losing transactions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-migration-'))
  const filename = join(directory, 'finance.sqlite')
  const db = openDatabase(filename)
  try {
    db.prepare('INSERT INTO financial_profiles (id, name) VALUES (?, ?)').run('user1', 'Pessoa Um')
    db.prepare(`
      INSERT INTO accounts (id, name, institution, classification, opening_balance_minor)
      VALUES ('current', 'Conta', 'Banco', 'available', 1000)
    `).run()
    db.prepare("INSERT INTO account_owners (account_id, profile_id) VALUES ('current', 'user1')").run()
    db.prepare(`
      INSERT INTO transactions (id, account_id, context, type, amount_minor, description, date)
      VALUES ('kept', 'current', 'user1', 'income', 500, 'Receita existente', '2026-10-01')
    `).run()
    db.exec(`
      DROP TABLE investment_prices;
      DROP TABLE investment_trades;
      DROP TABLE investment_assets;
      DROP TABLE budgets;
      DROP TABLE savings_goals;
      PRAGMA user_version = 3;
    `)
  } finally {
    db.close()
  }

  const migrated = openDatabase(filename)
  try {
    assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4)
    assert.equal((migrated.prepare('SELECT amount_minor FROM transactions WHERE id = ?').get('kept') as { amount_minor: number }).amount_minor, 500)
    assert.equal(migrated.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'investment_trades'").get() !== undefined, true)
  } finally {
    migrated.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
