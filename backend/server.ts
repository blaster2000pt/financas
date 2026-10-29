import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { accountContext, calculateContextTotals, type Account, type AccountClassification, type FinanceContext, type FinancialCategory, type FinancialReconciliation, type FinancialTransaction, type InvestmentPosition, type ProfileId, type TransactionType } from '../shared/domain.ts'
import { normalizeImportRow, parseImportFile, suggestImportMapping, type ImportMapping, type NormalizedImportRow, type ParsedImportFile } from './imports.ts'
import { isConfigured, openDatabase } from './database.ts'

const databasePath = process.env.FINANCAS_DB_PATH ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'financas.sqlite')
let db = openDatabase(databasePath)
const sessions = new Map<string, number>()
const sessionLifetimeMs = 30 * 60 * 1000
const profileIds: ProfileId[] = ['user1', 'user2']
const transactionTypes: TransactionType[] = [
  'income', 'expense', 'dividend', 'interest',
]
const classifications: AccountClassification[] = ['available', 'reserved', 'investment', 'other']

class RequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function respond(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > maxBytes) throw new RequestError('O pedido excede o limite permitido.')
    chunks.push(chunk)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError('O conteúdo do pedido não é JSON válido.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError('O conteúdo do pedido é inválido.')
  }
  return parsed as Record<string, unknown>
}

async function readRequestBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > maxBytes) throw new RequestError('O ficheiro excede o limite de 250 MB.')
    chunks.push(chunk)
  }
  if (length === 0) throw new RequestError('Selecione um ficheiro de cópia de segurança válido.')
  return Buffer.concat(chunks)
}

function requiredText(value: unknown, field: string, maximum = 240): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) {
    throw new RequestError(`O campo ${field} é obrigatório e tem um limite de ${maximum} caracteres.`)
  }
  return value.trim()
}

function validDate(value: unknown): string {
  const date = requiredText(value, 'data', 10)
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : undefined
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new RequestError('Indique uma data válida no formato AAAA-MM-DD.')
  }
  return date
}

function validAmount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new RequestError('O montante tem de ser um número inteiro de cêntimos superior a zero.')
  return Number(value)
}

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [, cost, blockSize, parallelism, saltHex, hashHex] = stored.split('$')
  if (cost !== '16384' || blockSize !== '8' || parallelism !== '1' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(cost), r: Number(blockSize), p: Number(parallelism), maxmem: 64 * 1024 * 1024,
  })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function sessionCookie(token: string, maxAge: number): string {
  return `financas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

function sessionToken(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('financas_session='))
  return cookie?.slice('financas_session='.length)
}

function isAuthenticated(request: IncomingMessage): boolean {
  const token = sessionToken(request)
  const expiry = token ? sessions.get(token) : undefined
  if (!token || expiry === undefined) return false
  if (expiry <= Date.now()) {
    sessions.delete(token)
    return false
  }
  sessions.set(token, Date.now() + sessionLifetimeMs)
  return true
}

function validateImportMapping(value: unknown, headers: string[]): ImportMapping {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError('O mapeamento do ficheiro é inválido.')
  }
  const raw = value as Record<string, unknown>
  const requiredColumn = (key: string) => {
    const column = requiredText(raw[key], key, 100)
    if (!headers.includes(column)) throw new RequestError(`A coluna ${column} não existe no ficheiro.`)
    return column
  }
  const optionalColumn = (key: string): string | undefined => {
    if (raw[key] === null || raw[key] === undefined || raw[key] === '') return undefined
    return requiredColumn(key)
  }
  const mapping: ImportMapping = {
    dateColumn: requiredColumn('dateColumn'),
    descriptionColumn: requiredColumn('descriptionColumn'),
    ...(optionalColumn('amountColumn') ? { amountColumn: optionalColumn('amountColumn') } : {}),
    ...(optionalColumn('debitColumn') ? { debitColumn: optionalColumn('debitColumn') } : {}),
    ...(optionalColumn('creditColumn') ? { creditColumn: optionalColumn('creditColumn') } : {}),
    ...(optionalColumn('categoryColumn') ? { categoryColumn: optionalColumn('categoryColumn') } : {}),
    ...(optionalColumn('externalIdColumn') ? { externalIdColumn: optionalColumn('externalIdColumn') } : {}),
  }
  if (raw.positiveAmountIs !== undefined) {
    if (raw.positiveAmountIs !== 'expense' && raw.positiveAmountIs !== 'income') {
      throw new RequestError('A convenção de sinal do montante é inválida.')
    }
    mapping.positiveAmountIs = raw.positiveAmountIs
  }
  if (Boolean(mapping.amountColumn) === Boolean(mapping.debitColumn || mapping.creditColumn)) {
    throw new RequestError('Mapeie um montante único ou uma coluna de débito/crédito.')
  }
  return mapping
}

interface ImportRowAnalysis {
  rowIndex: number
  status: 'new' | 'probable_duplicate' | 'confirmed_duplicate' | 'invalid'
  normalized?: NormalizedImportRow
  error?: string
}

function analyzeImportRows(
  accountId: string,
  parsedFile: ParsedImportFile,
  mapping: ImportMapping,
): ImportRowAnalysis[] {
  const externalIdsSeen = new Set<string>()
  const fingerprintsSeen = new Set<string>()
  const hasExternalIdentifier = db.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND external_identifier = ? LIMIT 1')
  const hasFingerprint = db.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND fingerprint = ? LIMIT 1')

  return parsedFile.rows.map((row, rowIndex) => {
    let normalized: NormalizedImportRow
    try {
      normalized = normalizeImportRow(row, rowIndex, mapping)
    } catch (error) {
      return { rowIndex, status: 'invalid', error: error instanceof Error ? error.message : 'Linha inválida.' }
    }

    const duplicateByExternalId = normalized.externalIdentifier !== null
      && (hasExternalIdentifier.get(accountId, normalized.externalIdentifier) !== undefined
        || externalIdsSeen.has(normalized.externalIdentifier))
    const duplicateByFingerprint = hasFingerprint.get(accountId, normalized.fingerprint) !== undefined
      || fingerprintsSeen.has(normalized.fingerprint)
    if (normalized.externalIdentifier) externalIdsSeen.add(normalized.externalIdentifier)
    fingerprintsSeen.add(normalized.fingerprint)

    if (duplicateByExternalId) return { rowIndex, status: 'confirmed_duplicate', normalized }
    if (duplicateByFingerprint) return { rowIndex, status: 'probable_duplicate', normalized }
    return { rowIndex, status: 'new', normalized }
  })
}

function investmentAmountMinor(quantityMilli: number, unitPriceMinor: number): number {
  const amount = (BigInt(quantityMilli) * BigInt(unitPriceMinor) + 500n) / 1000n
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RequestError('O valor calculado da operação excede o intervalo monetário suportado.')
  }
  return Number(amount)
}

function validInvestmentQuantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RequestError('A quantidade tem de ser um número inteiro de milésimas superior a zero.')
  }
  return Number(value)
}

function validBudgetPeriod(value: unknown): string {
  const period = requiredText(value, 'mês', 7)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new RequestError('Indique um mês válido no formato AAAA-MM.')
  return period
}

function allFinancialData(database: ReturnType<typeof openDatabase> = db) {
  const profiles = database.prepare('SELECT id, name FROM financial_profiles ORDER BY id').all() as { id: ProfileId; name: string }[]
  const accountRows = database.prepare(`
    SELECT a.id, a.name, a.institution, a.classification, a.opening_balance_minor, a.archived,
      GROUP_CONCAT(o.profile_id, ',') AS owners
    FROM accounts a JOIN account_owners o ON o.account_id = a.id
    GROUP BY a.id ORDER BY a.created_at DESC
  `).all() as { id: string; name: string; institution: string; classification: AccountClassification; opening_balance_minor: number; archived: number; owners: string }[]
  const accounts: Account[] = accountRows.map((row) => ({
    id: row.id,
    name: row.name,
    institution: row.institution,
    classification: row.classification,
    openingBalanceMinor: row.opening_balance_minor,
    archived: row.archived === 1,
    owners: row.owners.split(',') as ProfileId[],
  }))
  const categoryRows = database.prepare(`
    SELECT id, name, kind, parent_id AS parentId FROM categories
    WHERE archived = 0 ORDER BY kind, name
  `).all() as { id: string; name: string; kind: 'income' | 'expense'; parentId: string | null }[]
  const categories: FinancialCategory[] = categoryRows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
  }))
  const transactions = database.prepare(`
    SELECT t.id, t.account_id, t.context, t.type, t.amount_minor, t.description, t.date,
      t.category_id, c.name AS category_name, t.source, t.import_batch_id
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    ORDER BY t.date DESC, t.created_at DESC
  `).all() as { id: string; account_id: string; context: FinanceContext; type: TransactionType; amount_minor: number; description: string; date: string; category_id: string | null; category_name: string | null; source: 'manual' | 'import'; import_batch_id: string | null }[]
  const normalizedTransactions: FinancialTransaction[] = transactions.map((item) => ({
    id: item.id,
    accountId: item.account_id,
    context: item.context,
    type: item.type,
    amountMinor: item.amount_minor,
    description: item.description,
    categoryId: item.category_id ?? undefined,
    categoryName: item.category_name ?? undefined,
    source: item.source,
    importBatchId: item.import_batch_id ?? undefined,
    date: item.date,
  }))
  const reconciliationRows = database.prepare(`
    SELECT id, account_id AS accountId, reported_balance_minor AS reportedBalanceMinor,
      calculated_balance_minor AS calculatedBalanceMinor, difference_minor AS differenceMinor,
      reported_at AS reportedAt
    FROM reconciliations ORDER BY reported_at DESC, created_at DESC
  `).all() as { id: string; accountId: string; reportedBalanceMinor: number; calculatedBalanceMinor: number; differenceMinor: number; reportedAt: string }[]
  const reconciliations: FinancialReconciliation[] = reconciliationRows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    reportedBalanceMinor: row.reportedBalanceMinor,
    calculatedBalanceMinor: row.calculatedBalanceMinor,
    differenceMinor: row.differenceMinor,
    reportedAt: row.reportedAt,
  }))
  const importBatches = database.prepare(`
    SELECT id, institution, account_id AS accountId, filename, total_count AS totalCount,
      imported_count AS importedCount, ignored_count AS ignoredCount,
      duplicate_count AS duplicateCount, failed_count AS failedCount, state,
      created_at AS createdAt, undone_at AS undoneAt
    FROM import_batches ORDER BY created_at DESC
  `).all()
  const importProfiles = database.prepare(`
    SELECT id, name, institution, account_id AS accountId, mapping_json AS mappingJson
    FROM import_profiles ORDER BY name
  `).all()
  const investmentRows = database.prepare(`
    SELECT t.account_id AS accountId, t.asset_id AS assetId, a.name AS assetName, a.symbol,
      SUM(CASE WHEN t.side = 'buy' THEN t.quantity_milli ELSE -t.quantity_milli END) AS quantityMilli
    FROM investment_trades t JOIN investment_assets a ON a.id = t.asset_id
    GROUP BY t.account_id, t.asset_id, a.name, a.symbol
    HAVING quantityMilli > 0
    ORDER BY a.name, t.account_id
  `).all() as { accountId: string; assetId: string; assetName: string; symbol: string; quantityMilli: number }[]
  const latestPrices = database.prepare(`
    SELECT p.asset_id AS assetId, p.price_minor AS unitPriceMinor, p.quoted_at AS quotedAt
    FROM investment_prices p
    JOIN (SELECT asset_id, MAX(quoted_at) AS quoted_at FROM investment_prices GROUP BY asset_id) latest
      ON latest.asset_id = p.asset_id AND latest.quoted_at = p.quoted_at
  `).all() as { assetId: string; unitPriceMinor: number; quotedAt: string }[]
  const investmentAssets = database.prepare('SELECT id, name, symbol FROM investment_assets ORDER BY name')
    .all() as { id: string; name: string; symbol: string }[]
  const priceByAsset = new Map(latestPrices.map((price) => [price.assetId, price]))
  const investmentPositions: InvestmentPosition[] = investmentRows.map((position) => {
    const price = priceByAsset.get(position.assetId)
    const marketValue = price
      ? (BigInt(position.quantityMilli) * BigInt(price.unitPriceMinor) + 500n) / 1000n
      : null
    if (marketValue !== null && marketValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('O valor da carteira excede o intervalo monetário suportado.')
    }
    return {
      ...position,
      unitPriceMinor: price?.unitPriceMinor ?? null,
      quotedAt: price?.quotedAt ?? null,
      marketValueMinor: marketValue === null ? null : Number(marketValue),
    }
  })
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const investmentValues = investmentPositions.flatMap((position) => {
    const account = accountById.get(position.accountId)
    if (!account || position.marketValueMinor === null) return []
    return [{ context: accountContext(account.owners), amountMinor: position.marketValueMinor }]
  })
  const budgetRows = database.prepare(`
    SELECT b.id, b.context, b.category_id AS categoryId, c.name AS categoryName,
      b.period, b.amount_minor AS amountMinor, COALESCE(SUM(t.amount_minor), 0) AS spentMinor
    FROM budgets b JOIN categories c ON c.id = b.category_id
    LEFT JOIN transactions t ON t.category_id = b.category_id AND t.context = b.context
      AND t.type = 'expense' AND substr(t.date, 1, 7) = b.period
    GROUP BY b.id, b.context, b.category_id, c.name, b.period, b.amount_minor
    ORDER BY b.period DESC, c.name
  `).all() as {
    id: string
    context: FinanceContext
    categoryId: string
    categoryName: string
    period: string
    amountMinor: number
    spentMinor: number
  }[]
  const savingsGoals = database.prepare(`
    SELECT id, name, context, target_minor AS targetMinor, saved_minor AS savedMinor,
      target_date AS targetDate
    FROM savings_goals ORDER BY created_at DESC
  `).all() as {
    id: string
    name: string
    context: FinanceContext
    targetMinor: number
    savedMinor: number
    targetDate: string | null
  }[]
  return {
    profiles,
    accounts,
    categories,
    transactions: normalizedTransactions,
    reconciliations,
    importBatches,
    importProfiles,
    investmentPositions,
    investmentAssets,
    investmentPrices: latestPrices,
    budgets: budgetRows,
    savingsGoals,
    totals: calculateContextTotals(accounts, normalizedTransactions, investmentValues),
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  try {
    if (request.method === 'GET' && url.pathname === '/api/status') {
      respond(response, 200, { configured: isConfigured(db) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/setup') {
      if (isConfigured(db)) {
        respond(response, 409, { error: 'A configuração inicial já foi concluída.' })
        return
      }
      const body = await readJson(request)
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 200) {
        throw new RequestError('A palavra-passe deve ter entre 12 e 200 caracteres.')
      }
      const password = body.password
      const names = [requiredText(body.user1Name, 'nome do primeiro perfil', 60), requiredText(body.user2Name, 'nome do segundo perfil', 60)]
      db.exec('BEGIN IMMEDIATE')
      try {
        const insert = db.prepare('INSERT INTO financial_profiles (id, name) VALUES (?, ?)')
        insert.run('user1', names[0])
        insert.run('user2', names[1])
        db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('password_hash', hashPassword(password))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      const token = randomBytes(32).toString('hex')
      sessions.set(token, Date.now() + sessionLifetimeMs)
      respond(response, 201, { ok: true }, { 'set-cookie': sessionCookie(token, sessionLifetimeMs / 1000) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      if (!isConfigured(db)) {
        respond(response, 409, { error: 'A configuração inicial ainda não foi concluída.' })
        return
      }
      const body = await readJson(request)
      if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 200) {
        throw new RequestError('A palavra-passe é inválida.')
      }
      const password = body.password
      const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'password_hash'").get() as { value: string }
      if (!verifyPassword(password, stored.value)) {
        respond(response, 401, { error: 'Palavra-passe incorreta.' })
        return
      }
      const token = randomBytes(32).toString('hex')
      sessions.set(token, Date.now() + sessionLifetimeMs)
      respond(response, 200, { ok: true }, { 'set-cookie': sessionCookie(token, sessionLifetimeMs / 1000) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const token = sessionToken(request)
      if (token) sessions.delete(token)
      respond(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) })
      return
    }

    if (!isAuthenticated(request)) {
      respond(response, 401, { error: 'É necessário iniciar sessão.' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/backup') {
      if (databasePath === ':memory:') throw new RequestError('A cópia de segurança não está disponível para uma base de dados temporária.', 409)
      const backupPath = join(dirname(databasePath), `.${basename(databasePath)}.${randomBytes(8).toString('hex')}.backup`)
      try {
        db.prepare('VACUUM INTO ?').run(backupPath)
        const bytes = readFileSync(backupPath)
        response.writeHead(200, {
          'content-type': 'application/vnd.sqlite3',
          'content-disposition': `attachment; filename="financas-${new Date().toISOString().slice(0, 10)}.sqlite"`,
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
        })
        response.end(bytes)
      } finally {
        if (existsSync(backupPath)) unlinkSync(backupPath)
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/restore') {
      if (databasePath === ':memory:') throw new RequestError('O restauro não está disponível para uma base de dados temporária.', 409)
      if (!request.headers['content-type']?.toLocaleLowerCase().startsWith('application/octet-stream')) {
        throw new RequestError('Envie uma cópia SQLite como ficheiro binário.')
      }
      const bytes = await readRequestBytes(request, 250 * 1024 * 1024)
      const directory = dirname(databasePath)
      mkdirSync(directory, { recursive: true })
      const token = randomBytes(12).toString('hex')
      const stagingPath = join(directory, `.${basename(databasePath)}.${token}.restore`)
      const rollbackPath = join(directory, `.${basename(databasePath)}.${token}.rollback`)
      const safetyPath = join(directory, `financas-pre-restauro-${new Date().toISOString().replace(/[:.]/g, '-')}-${token.slice(0, 6)}.sqlite`)
      writeFileSync(stagingPath, bytes, { flag: 'wx' })
      let validationDb: ReturnType<typeof openDatabase> | undefined
      let liveDbClosed = false
      let oldDatabaseMoved = false
      try {
        try {
          validationDb = openDatabase(stagingPath)
          const integrity = validationDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
          const foreignKeyErrors = validationDb.prepare('PRAGMA foreign_key_check').all()
          const version = validationDb.prepare('PRAGMA user_version').get() as { user_version: number }
          const profileCount = validationDb.prepare('SELECT COUNT(*) AS count FROM financial_profiles').get() as { count: number }
          const requiredTables = [
            'app_settings', 'financial_profiles', 'accounts', 'account_owners', 'transactions', 'transfers',
            'categories', 'reconciliations', 'import_profiles', 'import_batches', 'import_staging',
            'investment_assets', 'investment_trades', 'investment_prices', 'budgets', 'savings_goals',
          ]
          const tableRows = validationDb.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
          const tableNames = new Set(tableRows.map((table) => table.name))
          const domainData = allFinancialData(validationDb)
          const accountCount = (validationDb.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count
          const unownedAccounts = (validationDb.prepare(`
            SELECT COUNT(*) AS count FROM accounts a
            WHERE (SELECT COUNT(*) FROM account_owners o WHERE o.account_id = a.id) NOT BETWEEN 1 AND 2
          `).get() as { count: number }).count
          const invalidTransfers = (validationDb.prepare(`
            SELECT COUNT(*) AS count FROM transfers t
            WHERE (SELECT COUNT(*) FROM transactions x WHERE x.transfer_id = t.id) <> 2
              OR (SELECT SUM(CASE x.type WHEN 'transfer_in' THEN x.amount_minor
                  WHEN 'transfer_out' THEN -x.amount_minor ELSE 0 END)
                  FROM transactions x WHERE x.transfer_id = t.id) <> 0
          `).get() as { count: number }).count
          const unlinkedInvestmentTransactions = (validationDb.prepare(`
            SELECT COUNT(*) AS count FROM transactions t
            WHERE t.type IN ('investment_buy', 'investment_sell')
              AND NOT EXISTS (SELECT 1 FROM investment_trades i WHERE i.transaction_id = t.id)
          `).get() as { count: number }).count
          const invalidInvestmentTrades = (validationDb.prepare(`
            SELECT COUNT(*) AS count FROM investment_trades i
            JOIN transactions t ON t.id = i.transaction_id
            JOIN accounts a ON a.id = i.account_id
            WHERE t.account_id <> i.account_id OR a.classification <> 'investment'
              OR t.amount_minor <> i.amount_minor
              OR t.type <> CASE i.side WHEN 'buy' THEN 'investment_buy' ELSE 'investment_sell' END
              OR i.amount_minor <> (i.quantity_milli * i.unit_price_minor + 500) / 1000
          `).get() as { count: number }).count
          const negativeHoldings = (validationDb.prepare(`
            SELECT COUNT(*) AS count FROM (
              SELECT account_id, asset_id,
                SUM(CASE WHEN side = 'buy' THEN quantity_milli ELSE -quantity_milli END) AS quantity_milli
              FROM investment_trades GROUP BY account_id, asset_id
              HAVING quantity_milli < 0
            )
          `).get() as { count: number }).count
          if (integrity.integrity_check !== 'ok' || foreignKeyErrors.length > 0
            || version.user_version !== 4 || profileCount.count !== 2 || !isConfigured(validationDb)
            || requiredTables.some((table) => !tableNames.has(table))
            || domainData.profiles.map((profile) => profile.id).sort().join(',') !== 'user1,user2'
            || domainData.accounts.length !== accountCount || unownedAccounts > 0
            || invalidTransfers > 0 || unlinkedInvestmentTransactions > 0
            || invalidInvestmentTrades > 0 || negativeHoldings > 0) {
            throw new RequestError('A cópia não passou na validação de integridade, versão ou configuração.')
          }
          const checkpoint = validationDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
          if (checkpoint.busy !== 0) throw new RequestError('Não foi possível preparar a cópia para restauro.')
          validationDb.close()
          validationDb = undefined
        } catch (error) {
          validationDb?.close()
          validationDb = undefined
          if (error instanceof RequestError) throw error
          throw new RequestError('O ficheiro não é uma cópia financeira SQLite válida.')
        }

        db.prepare('VACUUM INTO ?').run(safetyPath)
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
        if (checkpoint.busy !== 0) throw new RequestError('A base de dados está ocupada; não foi possível iniciar o restauro.', 409)
        db.close()
        liveDbClosed = true
        renameSync(databasePath, rollbackPath)
        oldDatabaseMoved = true
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${databasePath}${suffix}`
          if (existsSync(sidecar)) unlinkSync(sidecar)
        }
        renameSync(stagingPath, databasePath)
        db = openDatabase(databasePath)
        liveDbClosed = false
        sessions.clear()
        if (existsSync(rollbackPath)) {
          try {
            unlinkSync(rollbackPath)
          } catch (error) {
            console.error('Não foi possível remover a cópia temporária de recuperação após o restauro.', error)
          }
        }
        respond(response, 200, {
          ok: true,
          safetyCopy: basename(safetyPath),
          message: 'Restauro concluído. A cópia anterior foi preservada; inicie sessão com a palavra-passe da cópia restaurada.',
        })
      } catch (error) {
        if (liveDbClosed) {
          if (oldDatabaseMoved) {
            if (existsSync(databasePath)) unlinkSync(databasePath)
            for (const suffix of ['-wal', '-shm']) {
              const sidecar = `${databasePath}${suffix}`
              if (existsSync(sidecar)) unlinkSync(sidecar)
            }
            if (existsSync(rollbackPath)) renameSync(rollbackPath, databasePath)
          }
          db = openDatabase(databasePath)
        }
        throw error
      } finally {
        validationDb?.close()
        if (existsSync(stagingPath)) unlinkSync(stagingPath)
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${stagingPath}${suffix}`
          if (existsSync(sidecar)) unlinkSync(sidecar)
        }
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/data') {
      respond(response, 200, allFinancialData())
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/accounts') {
      const body = await readJson(request)
      const name = requiredText(body.name, 'nome da conta', 80)
      const institution = typeof body.institution === 'string' ? body.institution.trim().slice(0, 80) : ''
      const classification = body.classification as AccountClassification
      if (!classifications.includes(classification)) throw new RequestError('Classificação de conta inválida.')
      if (!Array.isArray(body.owners) || body.owners.some((owner) => !profileIds.includes(owner as ProfileId))) {
        throw new RequestError('Selecione um ou ambos os titulares.')
      }
      const owners = [...new Set(body.owners as ProfileId[])]
      if (owners.length < 1 || owners.length > 2) throw new RequestError('Selecione um ou ambos os titulares.')
      const context = accountContext(owners)
      if (typeof body.openingBalanceMinor !== 'number' || !Number.isSafeInteger(body.openingBalanceMinor)) {
        throw new RequestError('Saldo inicial inválido.')
      }
      const openingBalanceMinor = body.openingBalanceMinor
      const id = randomBytes(16).toString('hex')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('INSERT INTO accounts (id, name, institution, classification, opening_balance_minor) VALUES (?, ?, ?, ?, ?)')
          .run(id, name, institution, classification, openingBalanceMinor)
        const insertOwner = db.prepare('INSERT INTO account_owners (account_id, profile_id) VALUES (?, ?)')
        for (const owner of owners) insertOwner.run(id, owner)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      respond(response, 201, { id, context })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/investment-assets') {
      const body = await readJson(request)
      const name = requiredText(body.name, 'nome do ativo', 100)
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toLocaleUpperCase().slice(0, 20) : ''
      const id = randomBytes(16).toString('hex')
      db.prepare('INSERT INTO investment_assets (id, name, symbol) VALUES (?, ?, ?)').run(id, name, symbol)
      respond(response, 201, { id })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/investment-prices') {
      const body = await readJson(request)
      const assetId = requiredText(body.assetId, 'ativo', 100)
      const unitPriceMinor = validAmount(body.unitPriceMinor)
      const quotedAt = validDate(body.quotedAt)
      if (!db.prepare('SELECT 1 FROM investment_assets WHERE id = ?').get(assetId)) {
        throw new RequestError('O ativo selecionado não existe.')
      }
      const id = randomBytes(16).toString('hex')
      try {
        db.prepare('INSERT INTO investment_prices (id, asset_id, price_minor, quoted_at) VALUES (?, ?, ?, ?)')
          .run(id, assetId, unitPriceMinor, quotedAt)
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new RequestError('Já existe uma cotação manual para este ativo nessa data.')
        }
        throw error
      }
      respond(response, 201, { id })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/investment-trades') {
      const body = await readJson(request)
      const accountId = requiredText(body.accountId, 'conta de investimento', 100)
      const assetId = requiredText(body.assetId, 'ativo', 100)
      const side = body.side
      if (side !== 'buy' && side !== 'sell') throw new RequestError('Indique se a operação é uma compra ou venda.')
      const quantityMilli = validInvestmentQuantity(body.quantityMilli)
      const unitPriceMinor = validAmount(body.unitPriceMinor)
      const date = validDate(body.date)
      const amountMinor = investmentAmountMinor(quantityMilli, unitPriceMinor)
      const account = db.prepare(`
        SELECT a.classification, a.opening_balance_minor AS openingBalanceMinor,
          GROUP_CONCAT(o.profile_id, ',') AS owners
        FROM accounts a JOIN account_owners o ON o.account_id = a.id
        WHERE a.id = ? AND a.archived = 0 GROUP BY a.id
      `).get(accountId) as { classification: AccountClassification; openingBalanceMinor: number; owners: string } | undefined
      if (!account || account.classification !== 'investment') {
        throw new RequestError('Selecione uma conta activa classificada como investimento.')
      }
      const asset = db.prepare('SELECT name FROM investment_assets WHERE id = ?').get(assetId) as { name: string } | undefined
      if (!asset) throw new RequestError('O ativo selecionado não existe.')
      if (side === 'buy') {
        const accountTransactions = db.prepare('SELECT type, amount_minor AS amountMinor FROM transactions WHERE account_id = ?')
          .all(accountId) as { type: TransactionType; amountMinor: number }[]
        const cashBalance = accountTransactions.reduce((balance, transaction) => {
          const direction = ['income', 'dividend', 'interest', 'transfer_in', 'investment_sell'].includes(transaction.type) ? 1n : -1n
          return balance + direction * BigInt(transaction.amountMinor)
        }, BigInt(account.openingBalanceMinor))
        if (cashBalance < BigInt(amountMinor)) {
          throw new RequestError('A conta não tem saldo calculado suficiente para esta compra.')
        }
      }
      if (side === 'sell') {
        const holdings = db.prepare(`
          SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN quantity_milli ELSE -quantity_milli END), 0) AS quantityMilli
          FROM investment_trades WHERE account_id = ? AND asset_id = ? AND date <= ?
        `).get(accountId, assetId, date) as { quantityMilli: number }
        if (holdings.quantityMilli < quantityMilli) {
          throw new RequestError('A venda excede a quantidade deste ativo detida na conta.')
        }
      }
      const context = accountContext(account.owners.split(',') as ProfileId[])
      const transactionId = randomBytes(16).toString('hex')
      const tradeId = randomBytes(16).toString('hex')
      const type = side === 'buy' ? 'investment_buy' : 'investment_sell'
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`
          INSERT INTO transactions (id, account_id, context, type, amount_minor, description, date)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          transactionId, accountId, context, type, amountMinor,
          `${side === 'buy' ? 'Compra' : 'Venda'} de ${asset.name}`, date,
        )
        db.prepare(`
          INSERT INTO investment_trades (
            id, transaction_id, asset_id, account_id, side, quantity_milli,
            unit_price_minor, amount_minor, date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(tradeId, transactionId, assetId, accountId, side, quantityMilli, unitPriceMinor, amountMinor, date)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      respond(response, 201, { id: tradeId, amountMinor })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/budgets') {
      const body = await readJson(request)
      const context = body.context
      if (context !== 'user1' && context !== 'user2' && context !== 'joint') {
        throw new RequestError('Contexto financeiro inválido.')
      }
      const categoryId = requiredText(body.categoryId, 'categoria', 100)
      const period = validBudgetPeriod(body.period)
      const amountMinor = validAmount(body.amountMinor)
      const category = db.prepare('SELECT kind FROM categories WHERE id = ? AND archived = 0')
        .get(categoryId) as { kind: string } | undefined
      if (!category || category.kind !== 'expense') throw new RequestError('Selecione uma categoria de despesa ativa.')
      const id = randomBytes(16).toString('hex')
      db.prepare(`
        INSERT INTO budgets (id, context, category_id, period, amount_minor)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (context, category_id, period) DO UPDATE SET amount_minor = excluded.amount_minor
      `).run(id, context, categoryId, period, amountMinor)
      const budget = db.prepare('SELECT id FROM budgets WHERE context = ? AND category_id = ? AND period = ?')
        .get(context, categoryId, period) as { id: string }
      respond(response, 201, { id: budget.id })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/savings-goals') {
      const body = await readJson(request)
      const name = requiredText(body.name, 'nome do objetivo', 100)
      const context = body.context
      if (context !== 'user1' && context !== 'user2' && context !== 'joint') {
        throw new RequestError('Contexto financeiro inválido.')
      }
      const targetMinor = validAmount(body.targetMinor)
      const savedMinor = body.savedMinor === undefined ? 0 : typeof body.savedMinor === 'number' ? body.savedMinor : Number.NaN
      if (!Number.isSafeInteger(savedMinor) || savedMinor < 0) {
        throw new RequestError('O progresso inicial tem de ser zero ou um número positivo de cêntimos.')
      }
      const targetDate = body.targetDate === null || body.targetDate === '' || body.targetDate === undefined
        ? null
        : validDate(body.targetDate)
      const id = randomBytes(16).toString('hex')
      db.prepare(`
        INSERT INTO savings_goals (id, name, context, target_minor, saved_minor, target_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, name, context, targetMinor, savedMinor, targetDate)
      respond(response, 201, { id })
      return
    }

    const goalMatch = /^\/api\/savings-goals\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'PUT' && goalMatch) {
      const goalId = requiredText(decodeURIComponent(goalMatch[1]), 'objetivo', 100)
      const body = await readJson(request)
      const savedMinor = typeof body.savedMinor === 'number' ? body.savedMinor : Number.NaN
      if (!Number.isSafeInteger(savedMinor) || savedMinor < 0) {
        throw new RequestError('O progresso tem de ser zero ou um número positivo de cêntimos.')
      }
      const result = db.prepare('UPDATE savings_goals SET saved_minor = ? WHERE id = ?').run(savedMinor, goalId)
      if (result.changes === 0) throw new RequestError('O objetivo não foi encontrado.', 404)
      respond(response, 200, { id: goalId })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/categories') {
      const body = await readJson(request)
      const name = requiredText(body.name, 'nome da categoria', 80)
      const kind = body.kind
      if (kind !== 'income' && kind !== 'expense') throw new RequestError('Tipo de categoria inválido.')
      const parentId = body.parentId === null || body.parentId === undefined || body.parentId === ''
        ? null
        : requiredText(body.parentId, 'categoria superior', 100)
      if (parentId) {
        const parent = db.prepare('SELECT kind FROM categories WHERE id = ? AND archived = 0').get(parentId) as { kind: string } | undefined
        if (!parent || parent.kind !== kind) throw new RequestError('A categoria superior selecionada não é válida para este tipo.')
      }
      const id = randomBytes(16).toString('hex')
      try {
        db.prepare('INSERT INTO categories (id, name, kind, parent_id) VALUES (?, ?, ?, ?)').run(id, name, kind, parentId)
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new RequestError('Já existe uma categoria com esse nome e tipo.')
        }
        throw error
      }
      respond(response, 201, { id })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/transactions') {
      const body = await readJson(request)
      const accountId = requiredText(body.accountId, 'conta', 100)
      const accountRow = db.prepare('SELECT account_id, GROUP_CONCAT(profile_id, \',\') AS owners FROM account_owners WHERE account_id = ?')
        .get(accountId) as { account_id: string; owners: string } | undefined
      if (!accountRow) throw new RequestError('A conta selecionada não existe.')
      const context = body.context as FinanceContext
      if (!['user1', 'user2', 'joint'].includes(context)) throw new RequestError('Contexto financeiro inválido.')
      const type = body.type as TransactionType
      if (!transactionTypes.includes(type)) throw new RequestError('Tipo de movimento inválido.')
      const amountMinor = validAmount(body.amountMinor)
      const description = requiredText(body.description, 'descrição')
      const date = validDate(body.date)
      const category = typeof body.category === 'string' ? body.category.trim().slice(0, 80) : ''
      const categoryId = body.categoryId ? requiredText(body.categoryId, 'categoria', 100) : null
      if (categoryId) {
        const expectedKind = type === 'expense' ? 'expense' : 'income'
        const selectedCategory = db.prepare('SELECT kind FROM categories WHERE id = ? AND archived = 0').get(categoryId) as { kind: string } | undefined
        if (!selectedCategory || selectedCategory.kind !== expectedKind) {
          throw new RequestError('A categoria selecionada não corresponde ao tipo do movimento.')
        }
      }
      const id = randomBytes(16).toString('hex')
      db.prepare(`
        INSERT INTO transactions (id, account_id, context, type, amount_minor, description, category, date, category_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, accountId, context, type, amountMinor, description, category, date, categoryId)
      respond(response, 201, { id })
      return
    }

    const transactionMatch = /^\/api\/transactions\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'PUT' && transactionMatch) {
      const transactionId = requiredText(decodeURIComponent(transactionMatch[1]), 'movimento', 100)
      const existing = db.prepare(`
        SELECT type, transfer_id, source,
          EXISTS (SELECT 1 FROM investment_trades WHERE transaction_id = transactions.id) AS is_investment_trade
        FROM transactions WHERE id = ?
      `).get(transactionId) as { type: TransactionType; transfer_id: string | null; source: 'manual' | 'import'; is_investment_trade: number } | undefined
      if (!existing) throw new RequestError('O movimento não foi encontrado.', 404)
      if (existing.transfer_id) throw new RequestError('Edite uma transferência como um conjunto, não uma das suas pernas.')
      if (existing.is_investment_trade) throw new RequestError('As operações de investimento não podem ser editadas como movimentos comuns.')
      const body = await readJson(request)
      const description = requiredText(body.description, 'descrição')
      const amountMinor = validAmount(body.amountMinor)
      const date = validDate(body.date)
      const context = body.context
      if (context !== 'user1' && context !== 'user2' && context !== 'joint') {
        throw new RequestError('Contexto financeiro inválido.')
      }
      const categoryId = body.categoryId ? requiredText(body.categoryId, 'categoria', 100) : null
      if (categoryId) {
        const expectedKind = existing.type === 'expense' ? 'expense' : 'income'
        const selectedCategory = db.prepare('SELECT kind FROM categories WHERE id = ? AND archived = 0')
          .get(categoryId) as { kind: string } | undefined
        if (!selectedCategory || selectedCategory.kind !== expectedKind) {
          throw new RequestError('A categoria selecionada não corresponde ao tipo do movimento.')
        }
      }
      db.prepare(`
        UPDATE transactions
        SET description = ?, amount_minor = ?, date = ?, context = ?, category_id = ?,
          category = '', manual_override = CASE WHEN source = 'import' THEN 1 ELSE manual_override END,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(description, amountMinor, date, context, categoryId, transactionId)
      respond(response, 200, { id: transactionId, manualOverride: existing.source === 'import' })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/reconciliations') {
      const body = await readJson(request)
      const accountId = requiredText(body.accountId, 'conta', 100)
      const reportedAt = validDate(body.reportedAt)
      if (typeof body.reportedBalanceMinor !== 'number' || !Number.isSafeInteger(body.reportedBalanceMinor)) {
        throw new RequestError('O saldo reportado tem de ser um número inteiro de cêntimos.')
      }
      const accountRow = db.prepare(`
        SELECT a.id, a.name, a.institution, a.classification, a.opening_balance_minor, a.archived,
          GROUP_CONCAT(o.profile_id, ',') AS owners
        FROM accounts a JOIN account_owners o ON o.account_id = a.id
        WHERE a.id = ? GROUP BY a.id
      `).get(accountId) as { id: string; name: string; institution: string; classification: AccountClassification; opening_balance_minor: number; archived: number; owners: string } | undefined
      if (!accountRow || accountRow.archived === 1) throw new RequestError('A conta selecionada não existe ou está arquivada.')
      const account: Account = {
        id: accountRow.id,
        name: accountRow.name,
        institution: accountRow.institution,
        classification: accountRow.classification,
        openingBalanceMinor: accountRow.opening_balance_minor,
        archived: false,
        owners: accountRow.owners.split(',') as ProfileId[],
      }
      const rows = db.prepare(`
        SELECT id, account_id, context, type, amount_minor, description, date
        FROM transactions WHERE account_id = ? AND date <= ?
      `).all(accountId, reportedAt) as { id: string; account_id: string; context: FinanceContext; type: TransactionType; amount_minor: number; description: string; date: string }[]
      const movements: FinancialTransaction[] = rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        context: row.context,
        type: row.type,
        amountMinor: row.amount_minor,
        description: row.description,
        date: row.date,
      }))
      const accountTotals = calculateContextTotals([account], movements)
      const calculatedBalanceMinor = accountTotals[accountContext(account.owners)].balanceMinor
      const differenceMinor = body.reportedBalanceMinor - calculatedBalanceMinor
      if (!Number.isSafeInteger(differenceMinor)) throw new RequestError('A diferença entre os saldos excede o intervalo suportado.')
      const id = randomBytes(16).toString('hex')
      db.prepare(`
        INSERT INTO reconciliations (
          id, account_id, reported_balance_minor, calculated_balance_minor,
          difference_minor, reported_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, accountId, body.reportedBalanceMinor, calculatedBalanceMinor, differenceMinor, reportedAt)
      respond(response, 201, { id, calculatedBalanceMinor, differenceMinor })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/transfers') {
      const body = await readJson(request)
      const fromAccountId = requiredText(body.fromAccountId, 'conta de origem', 100)
      const toAccountId = requiredText(body.toAccountId, 'conta de destino', 100)
      if (fromAccountId === toAccountId) throw new RequestError('A origem e o destino têm de ser contas diferentes.')
      const fromAccount = db.prepare(`
        SELECT a.name, GROUP_CONCAT(o.profile_id, ',') AS owners
        FROM accounts a JOIN account_owners o ON o.account_id = a.id
        WHERE a.id = ? AND a.archived = 0 GROUP BY a.id
      `).get(fromAccountId) as { name: string; owners: string } | undefined
      const toAccount = db.prepare(`
        SELECT a.name, GROUP_CONCAT(o.profile_id, ',') AS owners
        FROM accounts a JOIN account_owners o ON o.account_id = a.id
        WHERE a.id = ? AND a.archived = 0 GROUP BY a.id
      `).get(toAccountId) as { name: string; owners: string } | undefined
      if (!fromAccount || !toAccount) throw new RequestError('Selecione duas contas activas.')
      const kind = body.kind
      if (kind !== 'transfer' && kind !== 'contribution' && kind !== 'reimbursement' && kind !== 'other') {
        throw new RequestError('Classificação da transferência inválida.')
      }
      const amountMinor = validAmount(body.amountMinor)
      const date = validDate(body.date)
      const transferId = randomBytes(16).toString('hex')
      const fromContext = accountContext(fromAccount.owners.split(',') as ProfileId[])
      const toContext = accountContext(toAccount.owners.split(',') as ProfileId[])
      const insertTransaction = db.prepare(`
        INSERT INTO transactions (id, account_id, context, type, amount_minor, description, date, transfer_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`
          INSERT INTO transfers (id, from_account_id, to_account_id, kind, amount_minor, date)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(transferId, fromAccountId, toAccountId, kind, amountMinor, date)
        insertTransaction.run(
          randomBytes(16).toString('hex'), fromAccountId, fromContext, 'transfer_out',
          amountMinor, `Transferência para ${toAccount.name}`, date, transferId,
        )
        insertTransaction.run(
          randomBytes(16).toString('hex'), toAccountId, toContext, 'transfer_in',
          amountMinor, `Transferência de ${fromAccount.name}`, date, transferId,
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      respond(response, 201, { id: transferId })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/imports/preview') {
      const body = await readJson(request, 14 * 1024 * 1024)
      const filename = requiredText(body.filename, 'nome do ficheiro', 200)
      const accountId = requiredText(body.accountId, 'conta', 100)
      const institution = typeof body.institution === 'string' ? body.institution.trim().slice(0, 80) : ''
      if (typeof body.contentBase64 !== 'string' || body.contentBase64.length > 14 * 1024 * 1024
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)) {
        throw new RequestError('O ficheiro enviado não está codificado correctamente.')
      }
      const account = db.prepare('SELECT classification FROM accounts WHERE id = ? AND archived = 0')
        .get(accountId) as { classification: AccountClassification } | undefined
      if (!account) throw new RequestError('Selecione uma conta activa.')
      if (account.classification === 'investment') {
        throw new RequestError('A importação de movimentos não está disponível para contas de investimento. Registe compras e vendas pela área de investimentos.')
      }
      const bytes = Buffer.from(body.contentBase64, 'base64')
      if (bytes.length > 10 * 1024 * 1024) throw new RequestError('O ficheiro não pode exceder 10 MB.')
      let parsedFile: ParsedImportFile
      try {
        parsedFile = await parseImportFile(filename, bytes)
      } catch (error) {
        throw new RequestError(error instanceof Error ? error.message : 'Não foi possível ler o ficheiro.')
      }
      db.prepare("DELETE FROM import_staging WHERE created_at < datetime('now', '-1 day')").run()
      const importId = randomBytes(16).toString('hex')
      db.prepare(`
        INSERT INTO import_staging (id, account_id, institution, filename, headers_json, rows_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(importId, accountId, institution, filename, JSON.stringify(parsedFile.headers), JSON.stringify(parsedFile.rows))
      respond(response, 201, {
        importId,
        headers: parsedFile.headers,
        sampleRows: parsedFile.rows.slice(0, 8),
        rowCount: parsedFile.rows.length,
        suggestedMapping: suggestImportMapping(parsedFile.headers),
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/imports/analyze') {
      const body = await readJson(request)
      const importId = requiredText(body.importId, 'importação', 100)
      const staging = db.prepare('SELECT account_id, headers_json, rows_json FROM import_staging WHERE id = ?')
        .get(importId) as { account_id: string; headers_json: string; rows_json: string } | undefined
      if (!staging) throw new RequestError('A pré-visualização expirou. Seleccione novamente o ficheiro.', 409)
      const headers = JSON.parse(staging.headers_json) as string[]
      const parsedFile: ParsedImportFile = { headers, rows: JSON.parse(staging.rows_json) as Record<string, string>[] }
      const mapping = validateImportMapping(body.mapping, headers)
      const rows = analyzeImportRows(staging.account_id, parsedFile, mapping)
      db.prepare('UPDATE import_staging SET mapping_json = ? WHERE id = ?').run(JSON.stringify(mapping), importId)
      respond(response, 200, {
        rows,
        summary: {
          newCount: rows.filter((row) => row.status === 'new').length,
          probableDuplicateCount: rows.filter((row) => row.status === 'probable_duplicate').length,
          confirmedDuplicateCount: rows.filter((row) => row.status === 'confirmed_duplicate').length,
          failedCount: rows.filter((row) => row.status === 'invalid').length,
        },
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/imports/commit') {
      const body = await readJson(request)
      const importId = requiredText(body.importId, 'importação', 100)
      const staging = db.prepare(`
        SELECT account_id, institution, filename, headers_json, rows_json, mapping_json
        FROM import_staging WHERE id = ?
      `).get(importId) as { account_id: string; institution: string; filename: string; headers_json: string; rows_json: string; mapping_json: string | null } | undefined
      if (!staging) throw new RequestError('A pré-visualização expirou. Seleccione novamente o ficheiro.', 409)
      if (!staging.mapping_json) throw new RequestError('Analise o mapeamento antes de confirmar.')
      const decisions: Record<string, 'import' | 'skip'> = {}
      if (body.decisions !== undefined) {
        if (body.decisions === null || typeof body.decisions !== 'object' || Array.isArray(body.decisions)) {
          throw new RequestError('As decisões de duplicados são inválidas.')
        }
        for (const [rowIndex, action] of Object.entries(body.decisions)) {
          if (!/^\d+$/.test(rowIndex) || (action !== 'import' && action !== 'skip')) {
            throw new RequestError('As decisões de duplicados são inválidas.')
          }
          decisions[rowIndex] = action
        }
      }
      const parsedFile: ParsedImportFile = {
        headers: JSON.parse(staging.headers_json) as string[],
        rows: JSON.parse(staging.rows_json) as Record<string, string>[],
      }
      const mapping = JSON.parse(staging.mapping_json) as ImportMapping
      if (Object.keys(decisions).some((rowIndex) => Number(rowIndex) >= parsedFile.rows.length)) {
        throw new RequestError('Uma decisão refere-se a uma linha inexistente.')
      }
      const batchId = randomBytes(16).toString('hex')
      let importedCount = 0
      let ignoredCount = 0
      let duplicateCount = 0
      let failedCount = 0
      const insertTransaction = db.prepare(`
        INSERT INTO transactions (
          id, account_id, context, type, amount_minor, description, category,
          date, category_id, source, external_identifier, fingerprint,
          import_batch_id, raw_data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)
      `)
      db.exec('BEGIN IMMEDIATE')
      try {
        const analysis = analyzeImportRows(staging.account_id, parsedFile, mapping)
        for (const row of analysis) {
          if (row.status === 'probable_duplicate' && decisions[String(row.rowIndex)] === undefined) {
            throw new RequestError('Surgiu um possível duplicado. Analise novamente antes de confirmar.', 409)
          }
        }
        const owners = db.prepare('SELECT profile_id FROM account_owners WHERE account_id = ?')
          .all(staging.account_id) as { profile_id: ProfileId }[]
        const transactionContext = accountContext(owners.map((owner) => owner.profile_id))
        db.prepare(`
          INSERT INTO import_batches (
            id, institution, account_id, filename, total_count, imported_count,
            ignored_count, duplicate_count, failed_count, state
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 'completed')
        `).run(batchId, staging.institution, staging.account_id, staging.filename, parsedFile.rows.length)

        for (const analysisRow of analysis) {
          if (analysisRow.status === 'invalid' || !analysisRow.normalized) {
            failedCount += 1
            continue
          }
          const action = decisions[String(analysisRow.rowIndex)]
          if (analysisRow.status === 'confirmed_duplicate') {
            duplicateCount += 1
            ignoredCount += 1
            continue
          }
          if (analysisRow.status === 'probable_duplicate' && action === 'skip') {
            duplicateCount += 1
            ignoredCount += 1
            continue
          }
          if (action === 'skip') {
            ignoredCount += 1
            continue
          }
          const normalized = analysisRow.normalized
          const matchingCategory = normalized.importedCategory
            ? db.prepare('SELECT id FROM categories WHERE kind = ? AND lower(name) = lower(?) AND archived = 0')
              .get(normalized.type, normalized.importedCategory) as { id: string } | undefined
            : undefined
          const sourceRow = parsedFile.rows[normalized.rowIndex]
          insertTransaction.run(
            randomBytes(16).toString('hex'),
            staging.account_id,
            transactionContext,
            normalized.type,
            normalized.amountMinor,
            normalized.description,
            normalized.importedCategory,
            normalized.date,
            matchingCategory?.id ?? null,
            normalized.externalIdentifier,
            normalized.fingerprint,
            batchId,
            JSON.stringify(sourceRow),
          )
          importedCount += 1
        }

        db.prepare(`
          UPDATE import_batches SET imported_count = ?, ignored_count = ?, duplicate_count = ?, failed_count = ?
          WHERE id = ?
        `).run(importedCount, ignoredCount, duplicateCount, failedCount, batchId)
        db.prepare('DELETE FROM import_staging WHERE id = ?').run(importId)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      respond(response, 201, { batchId, importedCount, ignoredCount, duplicateCount, failedCount })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/import-profiles') {
      const body = await readJson(request)
      const name = requiredText(body.name, 'nome do perfil de importação', 80)
      const institution = typeof body.institution === 'string' ? body.institution.trim().slice(0, 80) : ''
      const accountId = body.accountId ? requiredText(body.accountId, 'conta', 100) : null
      if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id = ? AND archived = 0').get(accountId)) {
        throw new RequestError('A conta predefinida não existe.')
      }
      const mapping = body.mapping
      if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
        throw new RequestError('O mapeamento do perfil é inválido.')
      }
      const id = randomBytes(16).toString('hex')
      db.prepare(`
        INSERT INTO import_profiles (id, name, institution, account_id, mapping_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, institution, accountId, JSON.stringify(mapping))
      respond(response, 201, { id })
      return
    }

    const undoImportMatch = /^\/api\/imports\/batches\/([^/]+)\/undo$/.exec(url.pathname)
    if (request.method === 'POST' && undoImportMatch) {
      const batchId = requiredText(decodeURIComponent(undoImportMatch[1]), 'batch', 100)
      const batch = db.prepare('SELECT state FROM import_batches WHERE id = ?').get(batchId) as { state: string } | undefined
      if (!batch) throw new RequestError('A importação não foi encontrada.', 404)
      if (batch.state === 'undone') throw new RequestError('Esta importação já foi desfeita.', 409)
      db.exec('BEGIN IMMEDIATE')
      try {
        const preserved = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE import_batch_id = ? AND manual_override = 1')
          .get(batchId) as { count: number }
        const removed = db.prepare('DELETE FROM transactions WHERE import_batch_id = ? AND manual_override = 0')
          .run(batchId).changes
        db.prepare("UPDATE import_batches SET state = 'undone', undone_at = datetime('now') WHERE id = ?").run(batchId)
        db.exec('COMMIT')
        respond(response, 200, { removedCount: removed, preservedCount: preserved.count })
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return
    }

    respond(response, 404, { error: 'Endpoint não encontrado.' })
  } catch (error) {
    if (error instanceof RequestError) {
      respond(response, error.status, { error: error.message })
      return
    }
    console.error('Falha inesperada ao processar pedido da API.', error)
    respond(response, 500, { error: 'Ocorreu um erro interno. Tente novamente.' })
  }
}

const port = Number(process.env.PORT ?? 4174)
const server = createServer((request, response) => void handle(request, response))

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`Aplicação financeira disponível em http://127.0.0.1:${port}`)
  })
}
