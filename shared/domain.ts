export type FinanceContext = 'user1' | 'user2' | 'joint'
export type ProfileId = 'user1' | 'user2'
export type AccountClassification = 'available' | 'reserved' | 'investment' | 'other'
export type TransactionType =
  | 'income'
  | 'expense'
  | 'dividend'
  | 'interest'
  | 'transfer_in'
  | 'transfer_out'
  | 'investment_buy'
  | 'investment_sell'

export interface Account {
  id: string
  name: string
  institution: string
  classification: AccountClassification
  owners: ProfileId[]
  openingBalanceMinor: number
  archived: boolean
}

export interface FinancialTransaction {
  id: string
  accountId: string
  context: FinanceContext
  type: TransactionType
  amountMinor: number
  description: string
  categoryId?: string
  categoryName?: string
  source?: 'manual' | 'import'
  importBatchId?: string
  date: string
}

export interface FinancialCategory {
  id: string
  name: string
  kind: 'income' | 'expense'
  parentId: string | null
}

export interface FinancialReconciliation {
  id: string
  accountId: string
  reportedBalanceMinor: number
  calculatedBalanceMinor: number
  differenceMinor: number
  reportedAt: string
}

export interface InvestmentPosition {
  accountId: string
  assetId: string
  assetName: string
  symbol: string
  quantityMilli: number
  unitPriceMinor: number | null
  quotedAt: string | null
  marketValueMinor: number | null
}

export interface InvestmentAsset {
  id: string
  name: string
  symbol: string
}

export interface FinancialBudget {
  id: string
  context: FinanceContext
  categoryId: string
  categoryName: string
  period: string
  amountMinor: number
  spentMinor: number
}

export interface SavingsGoal {
  id: string
  name: string
  context: FinanceContext
  targetMinor: number
  savedMinor: number
  targetDate: string | null
}

export interface InvestmentValue {
  context: FinanceContext
  amountMinor: number
}

export interface ContextTotals {
  balanceMinor: number
  investmentValueMinor: number
  netWorthMinor: number
  incomeMinor: number
  expensesMinor: number
}

export type ContextTotalsMap = Record<FinanceContext | 'global', ContextTotals>

const profiles: ProfileId[] = ['user1', 'user2']

function addSafeInteger(current: number, delta: number): number {
  const result = current + delta
  if (!Number.isSafeInteger(result)) throw new Error('O total excede o intervalo monetário suportado.')
  return result
}

export function parseEuroAmount(input: string, options: { allowZero?: boolean; allowNegative?: boolean } = {}): number {
  const normalized = input.trim().replace(',', '.')
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!match) throw new Error('Introduza um valor em euros com até duas casas decimais.')

  const whole = Number(match[2])
  const fraction = Number((match[3] ?? '').padEnd(2, '0'))
  const unsignedAmount = whole * 100 + fraction
  const amount = match[1] === '-' ? -unsignedAmount : unsignedAmount
  if (!Number.isSafeInteger(amount) || (!options.allowNegative && amount < 0) || (!options.allowZero && amount === 0)) {
    const requirement = options.allowNegative ? 'um valor válido' : options.allowZero ? 'zero ou positivo' : 'superior a zero'
    throw new Error(`O valor tem de ser ${requirement} e estar dentro do limite suportado.`)
  }
  return amount
}

export function formatEur(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('Valor monetário inválido.')
  return new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'EUR',
  }).format(amountMinor / 100)
}

export function accountContext(owners: ProfileId[]): FinanceContext {
  const uniqueOwners = [...new Set(owners)]
  if (uniqueOwners.length === 2 && profiles.every((profile) => uniqueOwners.includes(profile))) return 'joint'
  if (uniqueOwners.length === 1 && profiles.includes(uniqueOwners[0])) return uniqueOwners[0]
  throw new Error('Uma conta tem de pertencer a um perfil ou aos dois perfis.')
}

export function transactionDelta(transaction: FinancialTransaction): number {
  switch (transaction.type) {
    case 'income':
    case 'dividend':
    case 'interest':
    case 'transfer_in':
    case 'investment_sell':
      return transaction.amountMinor
    case 'expense':
    case 'transfer_out':
    case 'investment_buy':
      return -transaction.amountMinor
  }
}

export function calculateContextTotals(
  accounts: Account[],
  transactions: FinancialTransaction[],
  investments: InvestmentValue[] = [],
): ContextTotalsMap {
  const totals: ContextTotalsMap = {
    user1: { balanceMinor: 0, investmentValueMinor: 0, netWorthMinor: 0, incomeMinor: 0, expensesMinor: 0 },
    user2: { balanceMinor: 0, investmentValueMinor: 0, netWorthMinor: 0, incomeMinor: 0, expensesMinor: 0 },
    joint: { balanceMinor: 0, investmentValueMinor: 0, netWorthMinor: 0, incomeMinor: 0, expensesMinor: 0 },
    global: { balanceMinor: 0, investmentValueMinor: 0, netWorthMinor: 0, incomeMinor: 0, expensesMinor: 0 },
  }
  const accountContexts = new Map<string, FinanceContext>()
  const accountBalances = new Map<string, number>()

  for (const account of accounts.filter((item) => !item.archived)) {
    if (!Number.isSafeInteger(account.openingBalanceMinor)) throw new Error('Saldo inicial inválido.')
    if (accountContexts.has(account.id)) throw new Error(`Conta duplicada: ${account.id}`)
    accountContexts.set(account.id, accountContext(account.owners))
    accountBalances.set(account.id, account.openingBalanceMinor)
  }

  for (const transaction of transactions) {
    if (!Number.isSafeInteger(transaction.amountMinor) || transaction.amountMinor <= 0) {
      throw new Error(`Montante inválido no movimento ${transaction.id}.`)
    }
    const balance = accountBalances.get(transaction.accountId)
    if (balance === undefined) throw new Error(`Conta inexistente no movimento ${transaction.id}.`)
    accountBalances.set(transaction.accountId, addSafeInteger(balance, transactionDelta(transaction)))

    if (transaction.type === 'income' || transaction.type === 'dividend' || transaction.type === 'interest') {
      totals[transaction.context].incomeMinor = addSafeInteger(totals[transaction.context].incomeMinor, transaction.amountMinor)
      totals.global.incomeMinor = addSafeInteger(totals.global.incomeMinor, transaction.amountMinor)
    } else if (transaction.type === 'expense') {
      totals[transaction.context].expensesMinor = addSafeInteger(totals[transaction.context].expensesMinor, transaction.amountMinor)
      totals.global.expensesMinor = addSafeInteger(totals.global.expensesMinor, transaction.amountMinor)
    }
  }

  for (const [accountId, balance] of accountBalances) {
    const context = accountContexts.get(accountId)
    if (!context) throw new Error(`Contexto inexistente para a conta ${accountId}.`)
    totals[context].balanceMinor = addSafeInteger(totals[context].balanceMinor, balance)
    totals.global.balanceMinor = addSafeInteger(totals.global.balanceMinor, balance)
  }

  for (const investment of investments) {
    if (!Number.isSafeInteger(investment.amountMinor) || investment.amountMinor < 0) {
      throw new Error('Valor de investimento inválido.')
    }
    totals[investment.context].investmentValueMinor = addSafeInteger(
      totals[investment.context].investmentValueMinor,
      investment.amountMinor,
    )
    totals.global.investmentValueMinor = addSafeInteger(totals.global.investmentValueMinor, investment.amountMinor)
  }
  for (const total of Object.values(totals)) {
    total.netWorthMinor = addSafeInteger(total.balanceMinor, total.investmentValueMinor)
  }

  return totals
}
