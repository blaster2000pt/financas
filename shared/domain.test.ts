import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountContext,
  calculateContextTotals,
  parseEuroAmount,
  type Account,
  type FinancialTransaction,
} from './domain.ts'

const accounts: Account[] = [
  { id: 'personal-1', name: 'Pessoal 1', institution: 'Banco', classification: 'available', owners: ['user1'], openingBalanceMinor: 100_00, archived: false },
  { id: 'personal-2', name: 'Pessoal 2', institution: 'Banco', classification: 'available', owners: ['user2'], openingBalanceMinor: 200_00, archived: false },
  { id: 'joint', name: 'Conjunta', institution: 'Banco', classification: 'available', owners: ['user1', 'user2'], openingBalanceMinor: 300_00, archived: false },
]

test('parses EUR values exactly into integer cents', () => {
  assert.equal(parseEuroAmount('1234,56'), 123_456)
  assert.equal(parseEuroAmount('0.4'), 40)
  assert.equal(parseEuroAmount('0,00', { allowZero: true }), 0)
  assert.equal(parseEuroAmount('-2,35', { allowNegative: true }), -235)
  assert.throws(() => parseEuroAmount('1.234,56'))
  assert.throws(() => parseEuroAmount('0'))
  assert.throws(() => parseEuroAmount('-2,35'))
})

test('classifies a jointly owned account once', () => {
  assert.equal(accountContext(['user1', 'user2']), 'joint')
  assert.throws(() => accountContext([]))
})

test('global account balances equal personal and joint balances without duplication', () => {
  const totals = calculateContextTotals(accounts, [])
  assert.equal(totals.user1.balanceMinor, 10_000)
  assert.equal(totals.user2.balanceMinor, 20_000)
  assert.equal(totals.joint.balanceMinor, 30_000)
  assert.equal(totals.global.balanceMinor, totals.user1.balanceMinor + totals.user2.balanceMinor + totals.joint.balanceMinor)
  assert.equal(totals.global.balanceMinor, 60_000)
})

test('transfers change account balances but never appear as income or expense', () => {
  const transactions: FinancialTransaction[] = [
    { id: 'out', accountId: 'personal-1', context: 'user1', type: 'transfer_out', amountMinor: 2_500, description: 'Para conjunta', date: '2026-10-01' },
    { id: 'in', accountId: 'joint', context: 'joint', type: 'transfer_in', amountMinor: 2_500, description: 'De pessoal', date: '2026-10-01' },
  ]
  const totals = calculateContextTotals(accounts, transactions)
  assert.equal(totals.user1.balanceMinor, 7_500)
  assert.equal(totals.joint.balanceMinor, 32_500)
  assert.equal(totals.global.balanceMinor, 60_000)
  assert.equal(totals.global.incomeMinor, 0)
  assert.equal(totals.global.expensesMinor, 0)
})

test('investment trades change account cash but not income or spending totals', () => {
  const transactions: FinancialTransaction[] = [
    { id: 'buy', accountId: 'personal-1', context: 'user1', type: 'investment_buy', amountMinor: 5_000, description: 'Compra de ETF', date: '2026-10-01' },
    { id: 'sell', accountId: 'personal-1', context: 'user1', type: 'investment_sell', amountMinor: 5_500, description: 'Venda de ETF', date: '2026-10-02' },
  ]
  const totals = calculateContextTotals(accounts, transactions)
  assert.equal(totals.user1.balanceMinor, 10_500)
  assert.equal(totals.global.incomeMinor, 0)
  assert.equal(totals.global.expensesMinor, 0)
})

test('manual investment valuations add to net worth exactly once by account ownership', () => {
  const totals = calculateContextTotals(accounts, [], [
    { context: 'user1', amountMinor: 12_345 },
    { context: 'joint', amountMinor: 5_000 },
  ])
  assert.equal(totals.user1.netWorthMinor, totals.user1.balanceMinor + 12_345)
  assert.equal(totals.joint.investmentValueMinor, 5_000)
  assert.equal(totals.global.investmentValueMinor, 17_345)
  assert.equal(totals.global.netWorthMinor, totals.global.balanceMinor + 17_345)
})

test('personal context overrides affect flows, not account ownership', () => {
  const transactions: FinancialTransaction[] = [
    { id: 'expense', accountId: 'joint', context: 'user1', type: 'expense', amountMinor: 1_000, description: 'Despesa pessoal', date: '2026-10-02' },
  ]
  const totals = calculateContextTotals(accounts, transactions)
  assert.equal(totals.user1.expensesMinor, 1_000)
  assert.equal(totals.joint.balanceMinor, 29_000)
  assert.equal(totals.global.balanceMinor, 59_000)
  assert.equal(totals.global.expensesMinor, totals.user1.expensesMinor + totals.user2.expensesMinor + totals.joint.expensesMinor)
})

test('rejects totals outside JavaScript safe integer range', () => {
  const account: Account = {
    id: 'large',
    name: 'Saldo elevado',
    institution: '',
    classification: 'available',
    owners: ['user1'],
    openingBalanceMinor: Number.MAX_SAFE_INTEGER,
    archived: false,
  }
  const transaction: FinancialTransaction = {
    id: 'overflow',
    accountId: 'large',
    context: 'user1',
    type: 'income',
    amountMinor: 1,
    description: 'Receita',
    date: '2026-10-01',
  }
  assert.throws(() => calculateContextTotals([account], [transaction]), /intervalo monetário suportado/)
})
