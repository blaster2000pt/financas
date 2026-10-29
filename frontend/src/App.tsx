import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  accountContext,
  calculateContextTotals,
  formatEur,
  parseEuroAmount,
  type Account,
  type FinanceContext,
  type FinancialCategory,
  type FinancialBudget,
  type FinancialReconciliation,
  type FinancialTransaction,
  type InvestmentAsset,
  type InvestmentPosition,
  type ProfileId,
  type ContextTotalsMap,
  type SavingsGoal,
  type TransactionType,
} from '../../shared/domain'
import './App.css'

interface FinancialData {
  profiles: { id: ProfileId; name: string }[]
  accounts: Account[]
  categories: FinancialCategory[]
  transactions: FinancialTransaction[]
  reconciliations: FinancialReconciliation[]
  importBatches: ImportBatch[]
  importProfiles: ImportProfile[]
  investmentAssets: InvestmentAsset[]
  investmentPositions: InvestmentPosition[]
  budgets: FinancialBudget[]
  savingsGoals: SavingsGoal[]
  totals: ContextTotalsMap
}

interface ImportBatch {
  id: string
  institution: string
  accountId: string
  filename: string
  totalCount: number
  importedCount: number
  ignoredCount: number
  duplicateCount: number
  failedCount: number
  state: 'completed' | 'undone'
  createdAt: string
  undoneAt: string | null
}

interface ImportProfile {
  id: string
  name: string
  institution: string
  accountId: string | null
  mappingJson: string
}

interface ImportMappingForm {
  dateColumn: string
  descriptionColumn: string
  amountColumn: string
  debitColumn: string
  creditColumn: string
  categoryColumn: string
  externalIdColumn: string
  positiveAmountIs: 'income' | 'expense'
}

interface ImportAnalysisRow {
  rowIndex: number
  status: 'new' | 'probable_duplicate' | 'confirmed_duplicate' | 'invalid'
  normalized?: {
    date: string
    description: string
    amountMinor: number
    type: 'income' | 'expense'
    importedCategory: string
  }
  error?: string
}

type Screen = 'loading' | 'setup' | 'login' | 'dashboard'

const contextNames: Record<FinanceContext | 'global', string> = {
  user1: 'Pessoal',
  user2: 'Pessoal',
  joint: 'Conjunto',
  global: 'Global',
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? 'Não foi possível concluir o pedido.')
  return result
}

function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [data, setData] = useState<FinancialData | null>(null)
  const [context, setContext] = useState<FinanceContext | 'global'>('global')
  const [error, setError] = useState('')
  const [accessNotice, setAccessNotice] = useState('')

  async function loadData() {
    const financialData = await request<FinancialData>('/api/data')
    setData(financialData)
    setScreen('dashboard')
    setError('')
  }

  useEffect(() => {
    void request<{ configured: boolean }>('/api/status')
      .then(async ({ configured }) => {
        if (!configured) {
          setScreen('setup')
          return
        }
        try {
          await loadData()
        } catch {
          setScreen('login')
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Não foi possível contactar a aplicação local.')
        setScreen('login')
      })
  }, [])

  async function submitAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setAccessNotice('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    try {
      if (screen === 'setup') {
        await request('/api/setup', 'POST', {
          password,
          user1Name: form.get('user1Name'),
          user2Name: form.get('user2Name'),
        })
      } else {
        await request('/api/login', 'POST', { password })
      }
      await loadData()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível autenticar.')
    }
  }

  async function logout() {
    await request('/api/logout', 'POST')
    setData(null)
    setScreen('login')
  }

  async function refresh() {
    try {
      await loadData()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar os dados.')
    }
  }

  if (screen === 'loading') {
    return <main className="loading-screen"><span className="brand-mark">f</span><p>A preparar as suas finanças…</p></main>
  }

  if (screen === 'setup' || screen === 'login') {
    return (
      <main className="access-layout">
        <section className="access-intro">
          <a className="brand" href="/"> <span className="brand-mark">f</span> finanças</a>
          <div className="intro-copy">
            <p className="eyebrow">FINANÇAS, COM CLAREZA</p>
            <h1>Uma visão tranquila do que é seu.</h1>
            <p>As suas contas, movimentos e objetivos num só lugar — guardados localmente neste computador.</p>
          </div>
          <div className="privacy-note"><span className="privacy-dot" /> Os seus dados financeiros ficam neste dispositivo.</div>
        </section>
        <section className="access-panel">
          <form className="access-card" onSubmit={(event) => void submitAccess(event)}>
            <p className="eyebrow">{screen === 'setup' ? 'PRIMEIRA UTILIZAÇÃO' : 'BEM-VINDO DE VOLTA'}</p>
            <h2>{screen === 'setup' ? 'Vamos preparar a sua casa financeira.' : 'Desbloquear aplicação'}</h2>
            <p className="muted">{screen === 'setup' ? 'Defina uma palavra-passe e os nomes dos dois perfis.' : 'Introduza a palavra-passe da aplicação para continuar.'}</p>
            {screen === 'setup' && (
              <>
                <label>Nome do primeiro perfil<input name="user1Name" autoComplete="name" required maxLength={60} placeholder="Por exemplo, Alex" /></label>
                <label>Nome do segundo perfil<input name="user2Name" required maxLength={60} placeholder="Por exemplo, Sam" /></label>
              </>
            )}
            <label>Palavra-passe<input name="password" type="password" autoComplete={screen === 'setup' ? 'new-password' : 'current-password'} required minLength={screen === 'setup' ? 12 : undefined} /></label>
            {screen === 'setup' && <p className="field-note">Pelo menos 12 caracteres. A palavra-passe é guardada através de hash; a base de dados local não é cifrada.</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            {accessNotice && <p className="success-note" role="status">{accessNotice}</p>}
            <button className="button button-primary button-wide" type="submit">{screen === 'setup' ? 'Criar espaço financeiro' : 'Desbloquear'}</button>
          </form>
        </section>
      </main>
    )
  }

  if (!data) return null
  const currentTotals = data.totals[context]
  const visibleAccounts = data.accounts.filter((account) => context === 'global' || accountContext(account.owners) === context)
  const visibleTransactions = data.transactions.filter((transaction) => context === 'global' || transaction.context === context)
  const accountNames = new Map(data.accounts.map((account) => [account.id, account.name]))
  const visibleAccountIds = new Set(visibleAccounts.map((account) => account.id))
  const visibleInvestmentPositions = data.investmentPositions.filter((position) => visibleAccountIds.has(position.accountId))
  const portfolioValueMinor = currentTotals.netWorthMinor
  const currentPeriod = localMonth()
  const visibleBudgets = data.budgets.filter((budget) => context === 'global' || budget.context === context)
  const visibleGoals = data.savingsGoals.filter((goal) => context === 'global' || goal.context === context)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">f</span> finanças</a>
        <div className="side-label">ESPAÇO FINANCEIRO</div>
        <nav className="side-nav" aria-label="Navegação principal">
          <a className="nav-item active" href="#dashboard"><span className="nav-icon">◫</span> Visão geral</a>
          <a className="nav-item" href="#accounts"><span className="nav-icon">▤</span> Contas</a>
          <a className="nav-item" href="#transactions"><span className="nav-icon">↕</span> Movimentos</a>
          <a className="nav-item" href="#analysis"><span className="nav-icon">⌕</span> Análise</a>
          <a className="nav-item" href="#investments"><span className="nav-icon">◈</span> Investimentos</a>
          <a className="nav-item" href="#planning"><span className="nav-icon">◎</span> Planeamento</a>
          <a className="nav-item" href="#data-safety"><span className="nav-icon">⬇</span> Cópias</a>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge"><span className="privacy-dot" /><span><strong>Modo local</strong><small>Os dados ficam neste dispositivo</small></span></div>
          <button className="nav-item logout-button" onClick={() => void logout()}><span className="nav-icon">↪</span> Bloquear aplicação</button>
        </div>
      </aside>

      <main className="main-content" id="dashboard">
        <header className="topbar">
          <div><span className="topbar-kicker">O SEU ESPAÇO</span><div className="topbar-title">Finanças pessoais</div></div>
          <div className="topbar-actions"><span className="local-status"><span className="privacy-dot" /> Apenas neste dispositivo</span><button className="avatar-button" aria-label="Bloquear aplicação" onClick={() => void logout()}>⌑</button></div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div><p className="eyebrow">VISÃO FINANCEIRA</p><h1>Olá, {data.profiles.map((profile) => profile.name).join(' e ')}</h1><p className="muted">Uma visão simples e partilhada da vossa vida financeira.</p></div>
            <button className="button button-secondary" onClick={() => void refresh()}>↻ <span>Atualizar</span></button>
          </section>

          <section className="context-section" aria-label="Contexto financeiro">
            <div className="context-tabs" role="tablist">
              {(['user1', 'user2', 'joint', 'global'] as const).map((value) => {
                const profileName = value === 'user1' ? data.profiles.find((profile) => profile.id === value)?.name : value === 'user2' ? data.profiles.find((profile) => profile.id === value)?.name : contextNames[value]
                return <button key={value} role="tab" aria-selected={context === value} className={context === value ? 'context-tab selected' : 'context-tab'} onClick={() => setContext(value)}>{profileName}</button>
              })}
            </div>
            <span className="context-caption">A consultar: <strong>{context === 'global' ? 'Visão global' : context === 'joint' ? 'Finanças conjuntas' : data.profiles.find((profile) => profile.id === context)?.name}</strong></span>
          </section>

          {error && <p className="form-error" role="alert">{error}</p>}

          <section className="summary-grid" aria-label="Posição financeira">
            <article className="summary-card balance-card">
              <div className="card-label">PATRIMÓNIO VALORIZADO <span className="card-icon green-icon">€</span></div>
              <div className="summary-value">{formatEur(portfolioValueMinor)}</div>
              <p className="card-footnote">Contas + ativos com cotação manual</p>
            </article>
            <article className="summary-card">
              <div className="card-label">SALDO NAS CONTAS <span className="card-icon">▤</span></div>
              <div className="summary-value">{formatEur(currentTotals.balanceMinor)}</div>
              <p className="card-footnote">Saldo inicial + movimentos registados</p>
            </article>
            <article className="summary-card">
              <div className="card-label">RECEITAS REGISTADAS <span className="card-icon">↗</span></div>
              <div className="summary-value">{formatEur(currentTotals.incomeMinor)}</div>
              <p className="card-footnote">Inclui juros e dividendos</p>
            </article>
            <article className="summary-card">
              <div className="card-label">DESPESAS REGISTADAS <span className="card-icon coral-icon">↘</span></div>
              <div className="summary-value">{formatEur(currentTotals.expensesMinor)}</div>
              <p className="card-footnote">Transferências não são despesas</p>
            </article>
          </section>
          {visibleInvestmentPositions.some((position) => position.marketValueMinor === null) && <p className="field-note valuation-note">O património valorizado não inclui posições sem cotação manual.</p>}

          <div className="content-grid">
            <section className="surface accounts-surface" id="accounts">
              <div className="section-heading"><div><p className="eyebrow">PATRIMÓNIO LÍQUIDO</p><h2>As suas contas</h2></div><span className="count-pill">{visibleAccounts.length} {visibleAccounts.length === 1 ? 'conta' : 'contas'}</span></div>
              {visibleAccounts.length === 0 ? <div className="empty-state"><span className="empty-icon">＋</span><strong>Comece por adicionar uma conta</strong><p>Registe uma conta pessoal ou conjunta. Pode começar com saldo zero.</p></div> : (
                <div className="account-list">{visibleAccounts.map((account) => <AccountRow key={account.id} account={account} transactions={data.transactions} reconciliation={data.reconciliations.find((item) => item.accountId === account.id)} />)}</div>
              )}
              <AccountForm profiles={data.profiles} onCreated={() => void refresh()} />
              <ReconcileForm accounts={visibleAccounts} onCreated={() => void refresh()} />
            </section>

            <section className="surface activity-surface" id="transactions">
              <div className="section-heading"><div><p className="eyebrow">ATIVIDADE FINANCEIRA</p><h2>Movimentos recentes</h2></div><button className="text-button" onClick={() => void refresh()}>Ver atualizados ↗</button></div>
              {visibleTransactions.length === 0 ? <div className="empty-state compact-empty"><span className="empty-icon">↕</span><strong>Ainda sem movimentos</strong><p>Os movimentos registados aparecerão aqui.</p></div> : (
                <div className="transaction-list">{visibleTransactions.slice(0, 7).map((transaction) => {
                  const positive = ['income', 'dividend', 'interest', 'investment_sell', 'transfer_in'].includes(transaction.type)
                  return <div className="transaction-row" key={transaction.id}><span className={positive ? 'transaction-icon income-icon' : 'transaction-icon expense-icon'}>{positive ? '↗' : '↙'}</span><div className="transaction-description"><strong>{transaction.description}</strong><small>{accountNames.get(transaction.accountId) ?? 'Conta'}{transaction.categoryName ? ` · ${transaction.categoryName}` : ''} · {new Date(`${transaction.date}T12:00:00`).toLocaleDateString('pt-PT')}</small></div><span className={positive ? 'transaction-amount positive' : 'transaction-amount'}>{positive ? '+' : '−'}{formatEur(transaction.amountMinor)}</span></div>
                })}</div>
              )}
              <TransactionForm accounts={visibleAccounts} profiles={data.profiles} categories={data.categories} context={context} onCreated={() => void refresh()} />
              <TransferForm accounts={data.accounts.filter((account) => !account.archived)} onCreated={() => void refresh()} />
              <CategoryForm categories={data.categories} onCreated={() => void refresh()} />
            </section>
          </div>

          <ImportWizard accounts={data.accounts.filter((account) => !account.archived && account.classification !== 'investment')} batches={data.importBatches} profiles={data.importProfiles} onChanged={() => void refresh()} />
          <AnalyticsPanel
            transactions={visibleTransactions}
            accounts={data.accounts}
            categories={data.categories}
            profiles={data.profiles}
            context={context}
            currentPeriod={currentPeriod}
          />
          <InvestmentsPanel
            accounts={visibleAccounts.filter((account) => account.classification === 'investment' && !account.archived)}
            assets={data.investmentAssets}
            positions={visibleInvestmentPositions}
            onChanged={() => void refresh()}
          />
          <PlanningPanel
            budgets={visibleBudgets}
            goals={visibleGoals}
            categories={data.categories}
            profiles={data.profiles}
            context={context}
            currentPeriod={currentPeriod}
            onChanged={() => void refresh()}
          />
          <DataSafetyPanel onRestored={(message) => {
            setData(null)
            setScreen('login')
            setError('')
            setAccessNotice(message)
          }} />
          <footer className="page-footer"><span>Dados guardados localmente neste computador.</span><span>Moeda base: EUR</span></footer>
        </div>
      </main>
    </div>
  )
}

function AccountRow({ account, transactions, reconciliation }: { account: Account; transactions: FinancialTransaction[]; reconciliation?: FinancialReconciliation }) {
  const balance = useMemo(() => {
    const totals = calculateContextTotals([account], transactions.filter((item) => item.accountId === account.id))
    return totals[accountContext(account.owners)].balanceMinor
  }, [account, transactions])
  const contextLabel = account.owners.length === 2 ? 'Conjunta' : 'Pessoal'
  return <div className="account-row"><span className={`account-type-icon ${account.classification}`}>{account.classification === 'investment' ? '◈' : account.classification === 'reserved' ? '◌' : '▤'}</span><div className="account-details"><strong>{account.name}</strong><small>{account.institution || 'Instituição não indicada'} · {contextLabel}</small>{reconciliation && <><small>Reportado {formatEur(reconciliation.reportedBalanceMinor)} · calculado {formatEur(reconciliation.calculatedBalanceMinor)}</small><small className={reconciliation.differenceMinor === 0 ? 'reconciliation-ok' : 'reconciliation-difference'}>Diferença {formatEur(reconciliation.differenceMinor)} em {new Date(`${reconciliation.reportedAt}T12:00:00`).toLocaleDateString('pt-PT')}</small></>}</div><div className="account-balance"><strong>{formatEur(balance)}</strong><small>{account.classification === 'available' ? 'Disponível' : account.classification === 'investment' ? 'Caixa da conta' : account.classification === 'reserved' ? 'Reservado' : 'Outro'}</small></div></div>
}

function AccountForm({ profiles, onCreated }: { profiles: { id: ProfileId; name: string }[]; onCreated: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const openingBalance = String(form.get('openingBalance') ?? '').trim()
      await request('/api/accounts', 'POST', {
        name: form.get('name'),
        institution: form.get('institution'),
        classification: form.get('classification'),
        owners: form.getAll('owners'),
        openingBalanceMinor: openingBalance ? parseEuroAmount(openingBalance, { allowZero: true }) : 0,
      })
      setError('')
      formElement.reset()
      setExpanded(false)
      onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar a conta.')
    }
  }

  return <div className="form-expander"><button type="button" className="add-link" onClick={() => setExpanded(!expanded)}>{expanded ? '− Fechar' : '+ Adicionar conta'}</button>
    {expanded && <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <label>Nome da conta<input name="name" required maxLength={80} placeholder="Ex.: Conta à ordem" /></label>
      <label>Instituição<input name="institution" maxLength={80} placeholder="Ex.: BPI, Revolut, dinheiro físico" /></label>
      <label>Classificação<select name="classification"><option value="available">Disponível</option><option value="reserved">Reservado</option><option value="investment">Investimento</option><option value="other">Outro</option></select></label>
      <label>Saldo inicial (€)<input name="openingBalance" inputMode="decimal" placeholder="0,00" /></label>
      <fieldset><legend>Titulares</legend>{profiles.map((profile) => <label className="checkbox-label" key={profile.id}><input type="checkbox" name="owners" value={profile.id} />{profile.name}</label>)}</fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary" type="submit">Guardar conta</button>
    </form>}
  </div>
}

function ReconcileForm({ accounts, onCreated }: { accounts: Account[]; onCreated: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      await request('/api/reconciliations', 'POST', {
        accountId: form.get('accountId'),
        reportedBalanceMinor: parseEuroAmount(String(form.get('reportedBalance') ?? ''), { allowZero: true, allowNegative: true }),
        reportedAt: form.get('reportedAt'),
      })
      setError('')
      formElement.reset()
      setExpanded(false)
      onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível guardar a conferência.')
    }
  }

  return <div className="form-expander"><button type="button" className="add-link" disabled={accounts.length === 0} onClick={() => setExpanded(!expanded)}>{expanded ? '− Fechar' : '✓ Conferir saldo reportado'}</button>
    {expanded && <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <label>Conta<select name="accountId" required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label>Saldo de caixa indicado (€)<input name="reportedBalance" inputMode="decimal" required placeholder="0,00" /></label>
      <label>Data do saldo<input name="reportedAt" type="date" required /></label>
      <p className="field-note">Compara apenas o saldo de caixa da conta; posições de investimento são avaliadas em separado. A conferência não altera movimentos nem saldos calculados.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary" type="submit">Guardar conferência</button>
    </form>}
  </div>
}

function TransactionForm({ accounts, profiles, categories, context, onCreated }: { accounts: Account[]; profiles: { id: ProfileId; name: string }[]; categories: FinancialCategory[]; context: FinanceContext | 'global'; onCreated: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [selectedType, setSelectedType] = useState<TransactionType>('expense')
  const defaultContext: FinanceContext = context === 'global' ? 'user1' : context

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const type = String(form.get('type')) as TransactionType
      await request('/api/transactions', 'POST', {
        accountId: form.get('accountId'),
        type,
        context: form.get('context'),
        amountMinor: parseEuroAmount(String(form.get('amount') ?? '')),
        description: form.get('description'),
        date: form.get('date'),
        categoryId: form.get('categoryId') || undefined,
      })
      setError('')
      formElement.reset()
      setExpanded(false)
      onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível guardar o movimento.')
    }
  }

  return <div className="form-expander transaction-expander"><button type="button" className="add-link" disabled={accounts.length === 0} onClick={() => setExpanded(!expanded)}>{expanded ? '− Fechar' : '+ Registar movimento'}</button>
    {expanded && <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <label>Descrição<input name="description" required maxLength={240} placeholder="Ex.: Compra no supermercado" /></label>
      <label>Conta<select name="accountId" required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label>Tipo<select name="type" value={selectedType} onChange={(event) => setSelectedType(event.target.value as TransactionType)}><option value="expense">Despesa</option><option value="income">Receita</option><option value="dividend">Dividendos</option><option value="interest">Juros</option></select></label>
      <label>Contexto financeiro<select name="context" defaultValue={defaultContext}><option value="user1">{profiles.find((profile) => profile.id === 'user1')?.name ?? 'Pessoal 1'}</option><option value="user2">{profiles.find((profile) => profile.id === 'user2')?.name ?? 'Pessoal 2'}</option><option value="joint">Conjunto</option></select></label>
      <label>Categoria<select name="categoryId"><option value="">Sem categoria</option>{categories.filter((category) => category.kind === (selectedType === 'expense' ? 'expense' : 'income')).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
      <label>Montante (€)<input name="amount" inputMode="decimal" required placeholder="0,00" /></label>
      <label>Data<input name="date" type="date" required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary" type="submit">Guardar movimento</button>
    </form>}
  </div>
}

function CategoryForm({ categories, onCreated }: { categories: FinancialCategory[]; onCreated: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [kind, setKind] = useState<'income' | 'expense'>('expense')
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      await request('/api/categories', 'POST', {
        name: form.get('name'),
        kind: form.get('kind'),
        parentId: form.get('parentId') || null,
      })
      setError('')
      formElement.reset()
      setExpanded(false)
      onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar a categoria.')
    }
  }

  return <div className="form-expander"><button type="button" className="add-link" onClick={() => setExpanded(!expanded)}>{expanded ? '− Fechar' : '+ Criar categoria'}</button>
    {expanded && <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <label>Nome<input name="name" required maxLength={80} placeholder="Ex.: Animais de estimação" /></label>
      <label>Tipo<select name="kind" value={kind} onChange={(event) => setKind(event.target.value as 'income' | 'expense')}><option value="expense">Despesa</option><option value="income">Receita</option></select></label>
      <label>Categoria superior (opcional)<select name="parentId"><option value="">Categoria principal</option>{categories.filter((category) => category.kind === kind && category.parentId === null).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary" type="submit">Guardar categoria</button>
    </form>}
  </div>
}

function TransferForm({ accounts, onCreated }: { accounts: Account[]; onCreated: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      await request('/api/transfers', 'POST', {
        fromAccountId: form.get('fromAccountId'),
        toAccountId: form.get('toAccountId'),
        kind: form.get('kind'),
        amountMinor: parseEuroAmount(String(form.get('amount') ?? '')),
        date: form.get('date'),
      })
      setError('')
      formElement.reset()
      setExpanded(false)
      onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível guardar a transferência.')
    }
  }

  return <div className="form-expander transfer-expander"><button type="button" className="add-link" disabled={accounts.length < 2} onClick={() => setExpanded(!expanded)}>{expanded ? '− Fechar' : '⇄ Registar transferência'}</button>
    {expanded && <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <label>Conta de origem<select name="fromAccountId" required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label>Conta de destino<select name="toAccountId" required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label>Classificação<select name="kind"><option value="transfer">Transferência</option><option value="contribution">Contribuição</option><option value="reimbursement">Reembolso</option><option value="other">Outra</option></select></label>
      <label>Montante (€)<input name="amount" inputMode="decimal" required placeholder="0,00" /></label>
      <label>Data<input name="date" type="date" required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="field-note">As transferências alteram os saldos das contas, mas não são receitas nem despesas.</p>
      <button className="button button-primary" type="submit">Guardar transferência</button>
    </form>}
  </div>
}

function ImportWizard({ accounts, batches, profiles, onChanged }: { accounts: Account[]; batches: ImportBatch[]; profiles: ImportProfile[]; onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [importId, setImportId] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [sampleRows, setSampleRows] = useState<Record<string, string>[]>([])
  const [rowCount, setRowCount] = useState(0)
  const [accountId, setAccountId] = useState('')
  const [institution, setInstitution] = useState('')
  const [mapping, setMapping] = useState<ImportMappingForm>({
    dateColumn: '',
    descriptionColumn: '',
    amountColumn: '',
    debitColumn: '',
    creditColumn: '',
    categoryColumn: '',
    externalIdColumn: '',
    positiveAmountIs: 'expense',
  })
  const [analysis, setAnalysis] = useState<ImportAnalysisRow[] | null>(null)
  const [decisions, setDecisions] = useState<Record<string, 'import' | 'skip'>>({})
  const [error, setError] = useState('')
  const [resultMessage, setResultMessage] = useState('')
  const [profileName, setProfileName] = useState('')
  const [busy, setBusy] = useState(false)

  function updateMapping(field: keyof ImportMappingForm, value: string) {
    setMapping((current) => ({ ...current, [field]: value }))
    setAnalysis(null)
    setDecisions({})
  }

  async function previewFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) {
      setError('Seleccione primeiro um ficheiro CSV ou XLSX.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('O ficheiro não pode exceder 10 MB.')
      return
    }
    const form = new FormData(event.currentTarget)
    const selectedAccount = String(form.get('accountId') ?? '')
    const selectedInstitution = String(form.get('institution') ?? '')
    if (!selectedAccount) {
      setError('Seleccione a conta de destino.')
      return
    }
    setBusy(true)
    setError('')
    setResultMessage('')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      const contentBase64 = btoa(binary)
      const response = await request<{
        importId: string
        headers: string[]
        sampleRows: Record<string, string>[]
        rowCount: number
        suggestedMapping: Partial<ImportMappingForm>
      }>('/api/imports/preview', 'POST', {
        filename: file.name,
        accountId: selectedAccount,
        institution: form.get('institution'),
        contentBase64,
      })
      setImportId(response.importId)
      setHeaders(response.headers)
      setSampleRows(response.sampleRows)
      setRowCount(response.rowCount)
      setAccountId(selectedAccount)
      setInstitution(selectedInstitution)
      setMapping({
        dateColumn: response.suggestedMapping.dateColumn ?? '',
        descriptionColumn: response.suggestedMapping.descriptionColumn ?? '',
        amountColumn: response.suggestedMapping.amountColumn ?? '',
        debitColumn: response.suggestedMapping.debitColumn ?? '',
        creditColumn: response.suggestedMapping.creditColumn ?? '',
        categoryColumn: response.suggestedMapping.categoryColumn ?? '',
        externalIdColumn: response.suggestedMapping.externalIdColumn ?? '',
        positiveAmountIs: response.suggestedMapping.positiveAmountIs ?? 'expense',
      })
      setAnalysis(null)
      setDecisions({})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível ler o ficheiro.')
    } finally {
      setBusy(false)
    }
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await request<{ rows: ImportAnalysisRow[] }>(
        '/api/imports/analyze',
        'POST',
        { importId, mapping },
      )
      setAnalysis(response.rows)
      setDecisions({})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível analisar as linhas.')
    } finally {
      setBusy(false)
    }
  }

  async function commitImport() {
    const unresolved = (analysis ?? []).filter((row) => row.status === 'probable_duplicate' && !decisions[String(row.rowIndex)])
    if (unresolved.length > 0) {
      setError(`Escolha o que fazer com os ${unresolved.length} duplicados prováveis antes de continuar.`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const summary = await request<{ batchId: string; importedCount: number; ignoredCount: number; duplicateCount: number; failedCount: number }>(
        '/api/imports/commit',
        'POST',
        { importId, decisions },
      )
      setResultMessage(`Importados: ${summary.importedCount} · ignorados: ${summary.ignoredCount} · duplicados: ${summary.duplicateCount} · linhas inválidas: ${summary.failedCount}`)
      setImportId('')
      setAnalysis(null)
      setHeaders([])
      setSampleRows([])
      setFile(null)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar a importação.')
    } finally {
      setBusy(false)
    }
  }

  async function saveProfile() {
    if (!profileName.trim() || !mapping.dateColumn || !mapping.descriptionColumn) {
      setError('Indique um nome e complete o mapeamento antes de guardar o perfil.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await request('/api/import-profiles', 'POST', {
        name: profileName,
        institution,
        accountId: accountId || null,
        mapping,
      })
      setProfileName('')
      setResultMessage('Perfil de importação guardado.')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível guardar o perfil.')
    } finally {
      setBusy(false)
    }
  }

  function loadProfile(profileId: string) {
    const profile = profiles.find((item) => item.id === profileId)
    if (!profile) return
    try {
      const saved = JSON.parse(profile.mappingJson) as Partial<ImportMappingForm>
      setMapping((current) => ({
        ...current,
        ...saved,
        dateColumn: saved.dateColumn ?? '',
        descriptionColumn: saved.descriptionColumn ?? '',
        amountColumn: saved.amountColumn ?? '',
        debitColumn: saved.debitColumn ?? '',
        creditColumn: saved.creditColumn ?? '',
        categoryColumn: saved.categoryColumn ?? '',
        externalIdColumn: saved.externalIdColumn ?? '',
      }))
      if (profile.accountId) setAccountId(profile.accountId)
      setAnalysis(null)
      setDecisions({})
    } catch {
      setError('O perfil guardado não contém um mapeamento válido.')
    }
  }

  async function undoBatch(batchId: string) {
    setBusy(true)
    setError('')
    try {
      const result = await request<{ removedCount: number; preservedCount: number }>(`/api/imports/batches/${batchId}/undo`, 'POST')
      setResultMessage(`Importação desfeita: removidos ${result.removedCount}; preservados por terem sido alterados ${result.preservedCount}.`)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível desfazer a importação.')
    } finally {
      setBusy(false)
    }
  }

  const amountColumnOptions = [['amountColumn', 'Montante único'], ['debitColumn', 'Débito'], ['creditColumn', 'Crédito']] as const
  const reviewRows = analysis?.filter((row) => row.status !== 'new' || row.rowIndex < 12) ?? []

  return <section className="surface import-surface" aria-label="Importação de extratos">
    <div className="section-heading"><div><p className="eyebrow">IMPORTAÇÃO GUIADA</p><h2>Importar um extrato</h2></div><span className="count-pill">CSV · XLSX</span></div>
    <div className="import-content">
      <p className="import-intro">Os ficheiros são lidos localmente. Veja o mapeamento e os possíveis duplicados antes de confirmar.</p>
      {accounts.length === 0 && <p className="empty-note">Para importar movimentos, selecione uma conta ativa que não esteja classificada como investimento. As compras e vendas de ativos são registadas pela área de investimentos.</p>}
      <form className="import-start-form" onSubmit={(event) => void previewFile(event)}>
        <label>Conta de destino<select name="accountId" value={accountId} onChange={(event) => setAccountId(event.target.value)} required><option value="">Escolher conta</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
        <label>Instituição<input name="institution" value={institution} onChange={(event) => setInstitution(event.target.value)} maxLength={80} placeholder="Ex.: BPI, Revolut, Moey" /></label>
        <label>Ficheiro<input type="file" accept=".csv,.xlsx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></label>
        <button className="button button-primary" type="submit" disabled={busy || accounts.length === 0}>{busy ? 'A ler…' : 'Pré-visualizar ficheiro'}</button>
      </form>

      {headers.length > 0 && <div className="import-mapping">
        <div className="mapping-heading"><strong>{file?.name ?? 'Ficheiro seleccionado'}</strong><span>{rowCount} linhas · {headers.length} colunas</span></div>
        {profiles.length > 0 && <label>Reutilizar perfil<select defaultValue="" onChange={(event) => loadProfile(event.target.value)}><option value="">Escolher perfil de mapeamento</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>}
        <form className="mapping-grid" onSubmit={(event) => void analyze(event)}>
          <label>Data<select required value={mapping.dateColumn} onChange={(event) => updateMapping('dateColumn', event.target.value)}><ColumnOptions headers={headers} /></select></label>
          <label>Descrição<select required value={mapping.descriptionColumn} onChange={(event) => updateMapping('descriptionColumn', event.target.value)}><ColumnOptions headers={headers} /></select></label>
          {amountColumnOptions.map(([field, label]) => <label key={field}>{label}<select value={mapping[field]} onChange={(event) => updateMapping(field, event.target.value)}><ColumnOptions headers={headers} /></select></label>)}
          <label>Categoria (opcional)<select value={mapping.categoryColumn} onChange={(event) => updateMapping('categoryColumn', event.target.value)}><ColumnOptions headers={headers} /></select></label>
          <label>Identificador externo (opcional)<select value={mapping.externalIdColumn} onChange={(event) => updateMapping('externalIdColumn', event.target.value)}><ColumnOptions headers={headers} /></select></label>
          {mapping.amountColumn && <label>Sinal positivo representa<select value={mapping.positiveAmountIs} onChange={(event) => updateMapping('positiveAmountIs', event.target.value)}><option value="expense">Despesa</option><option value="income">Receita</option></select></label>}
          <div className="mapping-actions"><button type="submit" className="button button-secondary" disabled={busy}>{busy ? 'A analisar…' : 'Validar mapeamento e duplicados'}</button><input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={80} placeholder="Nome do perfil reutilizável" /><button type="button" className="text-button" onClick={() => void saveProfile()} disabled={busy}>Guardar perfil</button></div>
        </form>
        <div className="raw-preview"><strong>Pré-visualização original</strong><div className="table-scroll"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{sampleRows.map((row, index) => <tr key={index}>{headers.map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div></div>
      </div>}

      {analysis && <div className="import-review">
        <div className="mapping-heading"><strong>Revisão de movimentos</strong><span>{analysis.filter((row) => row.status === 'new').length} novos · {analysis.filter((row) => row.status.includes('duplicate')).length} possíveis duplicados · {analysis.filter((row) => row.status === 'invalid').length} inválidos</span></div>
        <div className="review-list">{reviewRows.map((row) => <div className={`review-row ${row.status}`} key={row.rowIndex}><span className="review-status">{row.status === 'new' ? 'Novo' : row.status === 'probable_duplicate' ? 'Possível duplicado' : row.status === 'confirmed_duplicate' ? 'Duplicado confirmado' : 'Inválido'}</span><div className="review-description"><strong>{row.normalized?.description ?? `Linha ${row.rowIndex + 2}`}</strong><small>{row.normalized ? `${row.normalized.date} · ${row.normalized.type === 'expense' ? 'Despesa' : 'Receita'} · ${formatEur(row.normalized.amountMinor)}${row.normalized.importedCategory ? ` · ${row.normalized.importedCategory}` : ''}` : row.error}</small></div>{row.status === 'probable_duplicate' && <select aria-label={`Decisão para a linha ${row.rowIndex + 2}`} value={decisions[String(row.rowIndex)] ?? ''} onChange={(event) => setDecisions((current) => ({ ...current, [row.rowIndex]: event.target.value as 'import' | 'skip' }))}><option value="">Escolher…</option><option value="import">Importar</option><option value="skip">Ignorar</option></select>}</div>)}</div>
        {analysis.length > reviewRows.length && <p className="field-note">A tabela mostra as linhas novas iniciais e todos os duplicados/erros; as restantes linhas novas serão importadas após confirmação.</p>}
        <button className="button button-primary" type="button" onClick={() => void commitImport()} disabled={busy}>{busy ? 'A importar…' : 'Confirmar importação'}</button>
      </div>}

      {error && <p className="form-error" role="alert">{error}</p>}
      {resultMessage && <p className="import-result" role="status">{resultMessage}</p>}
      {batches.length > 0 && <div className="batch-history"><strong>Histórico de importações</strong>{batches.slice(0, 5).map((batch) => <div className="batch-row" key={batch.id}><div><b>{batch.filename}</b><small>{batch.importedCount} importados · {batch.duplicateCount} duplicados · {batch.failedCount} inválidos</small></div>{batch.state === 'completed' ? <button className="text-button" disabled={busy} onClick={() => void undoBatch(batch.id)}>Desfazer</button> : <span className="count-pill">Desfeita</span>}</div>)}</div>}
    </div>
  </section>
}

function localMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseQuantityMilli(input: string): number {
  const match = /^(0|[1-9]\d*)(?:[,.](\d{1,3}))?$/.exec(input.trim())
  if (!match) throw new Error('Introduza uma quantidade com até três casas decimais.')
  const quantity = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'))
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('A quantidade tem de ser superior a zero e válida.')
  return quantity
}

function formatQuantityMilli(quantityMilli: number): string {
  return new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(quantityMilli / 1000)
}

function periodOffset(period: string, offset: number): string {
  const [year, month] = period.split('-').map(Number)
  const date = new Date(year, month - 1 + offset, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function transactionTypeName(type: TransactionType): string {
  const names: Record<TransactionType, string> = {
    income: 'Receita',
    expense: 'Despesa',
    dividend: 'Dividendo',
    interest: 'Juro',
    transfer_in: 'Transferência recebida',
    transfer_out: 'Transferência enviada',
    investment_buy: 'Compra de investimento',
    investment_sell: 'Venda de investimento',
  }
  return names[type]
}

function AnalyticsPanel({
  transactions,
  accounts,
  categories,
  profiles,
  context,
  currentPeriod,
}: {
  transactions: FinancialTransaction[]
  accounts: Account[]
  categories: FinancialCategory[]
  profiles: { id: ProfileId; name: string }[]
  context: FinanceContext | 'global'
  currentPeriod: string
}) {
  const [period, setPeriod] = useState(currentPeriod)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<TransactionType | 'all'>('all')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [limit, setLimit] = useState(50)
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]))
  const periodTransactions = transactions.filter((transaction) => transaction.date.startsWith(period))
  const expenses = periodTransactions.filter((transaction) => transaction.type === 'expense')
  const incomeTypes: TransactionType[] = ['income', 'dividend', 'interest']
  const incomes = periodTransactions.filter((transaction) => incomeTypes.includes(transaction.type))
  const categoryTotals = new Map<string, number>()
  for (const transaction of expenses) {
    const category = transaction.categoryName ?? 'Sem categoria'
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + transaction.amountMinor)
  }
  const highestExpense = Math.max(1, ...categoryTotals.values())

  const previousPeriods = [1, 2, 3].map((offset) => periodOffset(period, -offset)).sort()
  const firstTransactionPeriod = transactions.map((transaction) => transaction.date.slice(0, 7)).sort()[0]
  const forecastPeriods = firstTransactionPeriod
    ? previousPeriods.filter((month) => month >= firstTransactionPeriod)
    : []
  const forecastIncome = forecastPeriods.reduce((sum, month) => sum + transactions
    .filter((transaction) => transaction.date.startsWith(month) && incomeTypes.includes(transaction.type))
    .reduce((monthly, transaction) => monthly + transaction.amountMinor, 0), 0)
  const forecastExpenses = forecastPeriods.reduce((sum, month) => sum + transactions
    .filter((transaction) => transaction.date.startsWith(month) && transaction.type === 'expense')
    .reduce((monthly, transaction) => monthly + transaction.amountMinor, 0), 0)
  const averageIncome = forecastPeriods.length ? Math.round(forecastIncome / forecastPeriods.length) : 0
  const averageExpenses = forecastPeriods.length ? Math.round(forecastExpenses / forecastPeriods.length) : 0
  const netEstimate = averageIncome - averageExpenses
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredTransactions = transactions.filter((transaction) => {
    if (!transaction.date.startsWith(period)) return false
    if (typeFilter !== 'all' && transaction.type !== typeFilter) return false
    if (categoryFilter && transaction.categoryId !== categoryFilter) return false
    if (normalizedSearch) {
      const searchable = `${transaction.description} ${transaction.categoryName ?? ''} ${accountNames.get(transaction.accountId) ?? ''}`.toLocaleLowerCase()
      if (!searchable.includes(normalizedSearch)) return false
    }
    return true
  })

  const contextName = context === 'global' ? 'global' : context === 'joint'
    ? 'conjunto'
    : profiles.find((profile) => profile.id === context)?.name ?? 'pessoal'

  return <section className="surface planning-surface" id="analysis" aria-label="Análise financeira">
    <div className="section-heading"><div><p className="eyebrow">MOVIMENTOS E TENDÊNCIAS</p><h2>Pesquisa e análise</h2></div><label className="period-control">Mês<input type="month" value={period} onChange={(event) => { setPeriod(event.target.value || currentPeriod); setLimit(50) }} /></label></div>
    <div className="planning-content">
      <div className="analytics-summary">
        <div><small>Receitas do mês</small><strong>{formatEur(incomes.reduce((sum, transaction) => sum + transaction.amountMinor, 0))}</strong></div>
        <div><small>Despesas do mês</small><strong>{formatEur(expenses.reduce((sum, transaction) => sum + transaction.amountMinor, 0))}</strong></div>
        <div><small>Saldo do mês</small><strong>{formatEur(incomes.reduce((sum, transaction) => sum + transaction.amountMinor, 0) - expenses.reduce((sum, transaction) => sum + transaction.amountMinor, 0))}</strong></div>
      </div>
      <div className="analytics-grid">
        <div>
          <div className="planning-subheading"><strong>Despesas por categoria</strong></div>
          {categoryTotals.size === 0 ? <p className="empty-note">Sem despesas registadas neste mês.</p> : <div className="category-report">{[...categoryTotals].sort((a, b) => b[1] - a[1]).map(([category, amount]) => <div className="category-report-row" key={category}><div className="budget-heading"><strong>{category}</strong><span>{formatEur(amount)}</span></div><div className="category-bar"><span style={{ width: `${Math.max(3, Math.round(amount / highestExpense * 100))}%` }} /></div></div>)}</div>}
        </div>
        <div className="forecast-panel">
          <div className="planning-subheading"><strong>Estimativa mensal simples</strong></div>
          {forecastPeriods.length === 0 ? <p className="empty-note">Ainda não há histórico anterior suficiente para estimar.</p> : <>
            <p className={`forecast-value ${netEstimate < 0 ? 'negative' : ''}`}>{formatEur(netEstimate)}</p>
            <p className="field-note">Saldo mensal estimado para {contextName}, com base na média dos {forecastPeriods.length} meses completos anteriores ({forecastPeriods[0]} a {forecastPeriods[forecastPeriods.length - 1]}): receitas {formatEur(averageIncome)} menos despesas {formatEur(averageExpenses)}. Meses sem movimentos contam como zero; não considera sazonalidade nem movimentos futuros planeados.</p>
          </>}
        </div>
      </div>
      <div className="search-toolbar">
        <label>Pesquisar movimentos<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(50) }} placeholder="Descrição, conta ou categoria" /></label>
        <label>Tipo<select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value as TransactionType | 'all'); setLimit(50) }}><option value="all">Todos</option>{Object.entries({
          income: 'Receita', expense: 'Despesa', dividend: 'Dividendo', interest: 'Juro',
          transfer_in: 'Transferência recebida', transfer_out: 'Transferência enviada',
          investment_buy: 'Compra de investimento', investment_sell: 'Venda de investimento',
        }).map(([type, name]) => <option value={type} key={type}>{name}</option>)}</select></label>
        <label>Categoria<select value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); setLimit(50) }}><option value="">Todas</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
      </div>
      {filteredTransactions.length === 0 ? <p className="empty-note">Não foram encontrados movimentos com estes filtros.</p> : <>
        <div className="analysis-list">{filteredTransactions.slice(0, limit).map((transaction) => {
          const positive = ['income', 'dividend', 'interest', 'transfer_in', 'investment_sell'].includes(transaction.type)
          return <div className="analysis-row" key={transaction.id}><div><strong>{transaction.description}</strong><small>{new Date(`${transaction.date}T12:00:00`).toLocaleDateString('pt-PT')} · {accountNames.get(transaction.accountId) ?? 'Conta'} · {transactionTypeName(transaction.type)}{transaction.categoryName ? ` · ${transaction.categoryName}` : ''}</small></div><span className={positive ? 'transaction-amount positive' : 'transaction-amount'}>{positive ? '+' : '−'}{formatEur(transaction.amountMinor)}</span></div>
        })}</div>
        {filteredTransactions.length > limit && <button className="text-button load-more" type="button" onClick={() => setLimit((value) => value + 50)}>Mostrar mais movimentos</button>}
      </>}
    </div>
  </section>
}

function InvestmentsPanel({
  accounts,
  assets,
  positions,
  onChanged,
}: {
  accounts: Account[]
  assets: InvestmentAsset[]
  positions: InvestmentPosition[]
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]))
  const value = positions.reduce((sum, position) => sum + (position.marketValueMinor ?? 0), 0)

  async function submitAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError('')
    setStatus('')
    try {
      await request('/api/investment-assets', 'POST', { name: form.get('name'), symbol: form.get('symbol') })
      formElement.reset()
      setStatus('Ativo registado.')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível registar o ativo.')
    }
  }

  async function submitPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError('')
    setStatus('')
    try {
      await request('/api/investment-prices', 'POST', {
        assetId: form.get('assetId'),
        unitPriceMinor: parseEuroAmount(String(form.get('unitPrice') ?? '')),
        quotedAt: form.get('quotedAt'),
      })
      formElement.reset()
      setStatus('Cotação manual registada.')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível guardar a cotação.')
    }
  }

  async function submitTrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError('')
    setStatus('')
    try {
      await request('/api/investment-trades', 'POST', {
        accountId: form.get('accountId'),
        assetId: form.get('assetId'),
        side: form.get('side'),
        quantityMilli: parseQuantityMilli(String(form.get('quantity') ?? '')),
        unitPriceMinor: parseEuroAmount(String(form.get('unitPrice') ?? '')),
        date: form.get('date'),
      })
      formElement.reset()
      setStatus('Operação registada; o saldo de caixa da conta foi atualizado.')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível registar a operação.')
    }
  }

  return <section className="surface planning-surface" id="investments" aria-label="Investimentos">
    <div className="section-heading"><div><p className="eyebrow">POSIÇÕES E COTAÇÕES MANUAIS</p><h2>Investimentos</h2></div><span className="count-pill">{formatEur(value)} valorizados</span></div>
    <div className="planning-content">
      <p className="import-intro">Registe ativos e operações nas contas classificadas como investimento. As compras reduzem o caixa; as vendas aumentam-no. As cotações são sempre introduzidas manualmente, sem ligação a serviços externos.</p>
      {positions.length === 0
        ? <p className="empty-note">Ainda não existem posições de investimento valorizadas.</p>
        : <div className="investment-list">{positions.map((position) => <div className="investment-row" key={`${position.accountId}:${position.assetId}`}><div><strong>{position.assetName}{position.symbol ? ` (${position.symbol})` : ''}</strong><small>{accountNames.get(position.accountId) ?? 'Conta'} · {formatQuantityMilli(position.quantityMilli)} unidades{position.quotedAt ? ` · cotação de ${new Date(`${position.quotedAt}T12:00:00`).toLocaleDateString('pt-PT')}` : ' · sem cotação manual'}</small></div><strong>{position.marketValueMinor === null ? '—' : formatEur(position.marketValueMinor)}</strong></div>)}</div>}
      <div className="form-expander"><button type="button" className="add-link" onClick={() => setExpanded(!expanded)}>{expanded ? '− Fechar gestão de investimentos' : '+ Registar ativo, cotação ou operação'}</button>
        {expanded && <div className="investment-forms">
          <form className="inline-form" onSubmit={(event) => void submitAsset(event)}>
            <strong>Novo ativo</strong>
            <label>Nome<input name="name" required maxLength={100} placeholder="Ex.: Fundo global" /></label>
            <label>Símbolo (opcional)<input name="symbol" maxLength={20} placeholder="Ex.: VWCE" /></label>
            <button className="button button-secondary" type="submit">Guardar ativo</button>
          </form>
          <form className="inline-form" onSubmit={(event) => void submitPrice(event)}>
            <strong>Nova cotação manual</strong>
            <label>Ativo<select name="assetId" required disabled={assets.length === 0}><option value="">Escolher ativo</option>{assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}{asset.symbol ? ` (${asset.symbol})` : ''}</option>)}</select></label>
            <label>Preço por unidade (€)<input name="unitPrice" inputMode="decimal" required placeholder="0,00" /></label>
            <label>Data da cotação<input name="quotedAt" type="date" defaultValue={localDate()} required /></label>
            <button className="button button-secondary" type="submit" disabled={assets.length === 0}>Guardar cotação</button>
          </form>
          <form className="inline-form" onSubmit={(event) => void submitTrade(event)}>
            <strong>Compra ou venda</strong>
            <label>Conta de investimento<select name="accountId" required disabled={accounts.length === 0}><option value="">Escolher conta</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
            <label>Ativo<select name="assetId" required disabled={assets.length === 0}><option value="">Escolher ativo</option>{assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}{asset.symbol ? ` (${asset.symbol})` : ''}</option>)}</select></label>
            <label>Operação<select name="side"><option value="buy">Compra</option><option value="sell">Venda</option></select></label>
            <label>Quantidade (até 3 casas decimais)<input name="quantity" inputMode="decimal" required placeholder="1,000" /></label>
            <label>Preço por unidade (€)<input name="unitPrice" inputMode="decimal" required placeholder="0,00" /></label>
            <label>Data<input name="date" type="date" defaultValue={localDate()} required /></label>
            <p className="field-note">A compra exige saldo calculado suficiente. Não é possível vender mais unidades do que as registadas na conta.</p>
            <button className="button button-primary" type="submit" disabled={accounts.length === 0 || assets.length === 0}>Guardar operação</button>
          </form>
        </div>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {status && <p className="import-result" role="status">{status}</p>}
    </div>
  </section>
}

function PlanningPanel({
  budgets,
  goals,
  categories,
  profiles,
  context,
  currentPeriod,
  onChanged,
}: {
  budgets: FinancialBudget[]
  goals: SavingsGoal[]
  categories: FinancialCategory[]
  profiles: { id: ProfileId; name: string }[]
  context: FinanceContext | 'global'
  currentPeriod: string
  onChanged: () => void
}) {
  const [period, setPeriod] = useState(currentPeriod)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const monthBudgets = budgets.filter((budget) => budget.period === period)
  const contextLabel = (value: FinanceContext) => value === 'joint'
    ? 'Conjunto'
    : profiles.find((profile) => profile.id === value)?.name ?? 'Pessoal'
  const defaultContext: FinanceContext = context === 'global' ? 'joint' : context

  async function submitBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError('')
    setStatus('')
    try {
      await request('/api/budgets', 'POST', {
        context: form.get('context'),
        categoryId: form.get('categoryId'),
        period,
        amountMinor: parseEuroAmount(String(form.get('amount') ?? '')),
      })
      setStatus('Orçamento guardado para o mês selecionado.')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível guardar o orçamento.')
    }
  }

  async function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError('')
    setStatus('')
    try {
      await request('/api/savings-goals', 'POST', {
        name: form.get('name'),
        context: form.get('context'),
        targetMinor: parseEuroAmount(String(form.get('target') ?? '')),
        savedMinor: form.get('saved') ? parseEuroAmount(String(form.get('saved')), { allowZero: true }) : 0,
        targetDate: form.get('targetDate') || null,
      })
      formElement.reset()
      setStatus('Objetivo guardado.')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível guardar o objetivo.')
    }
  }

  async function updateGoal(goal: SavingsGoal, formElement: HTMLFormElement) {
    const form = new FormData(formElement)
    setError('')
    setStatus('')
    try {
      await request(`/api/savings-goals/${goal.id}`, 'PUT', {
        savedMinor: parseEuroAmount(String(form.get('saved') ?? ''), { allowZero: true }),
      })
      setStatus(`Progresso atualizado para «${goal.name}».`)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar o progresso.')
    }
  }

  return <section className="surface planning-surface" id="planning" aria-label="Orçamentos e objetivos">
    <div className="section-heading"><div><p className="eyebrow">PLANEAMENTO PESSOAL E CONJUNTO</p><h2>Orçamentos e objetivos</h2></div></div>
    <div className="planning-content">
      <div className="planning-grid">
        <div>
          <div className="planning-subheading"><strong>Orçamentos por categoria</strong><label>Mês<input aria-label="Mês do orçamento" type="month" value={period} onChange={(event) => setPeriod(event.target.value || currentPeriod)} /></label></div>
          {monthBudgets.length === 0 ? <p className="empty-note">Sem orçamentos para este mês. O gasto considera apenas movimentos classificados como despesa.</p> : <div className="budget-list">{monthBudgets.map((budget) => {
            const remaining = budget.amountMinor - budget.spentMinor
            const progress = Math.min(100, Math.round((budget.spentMinor / budget.amountMinor) * 100))
            return <div className="budget-row" key={budget.id}><div className="budget-heading"><strong>{budget.categoryName} · {contextLabel(budget.context)}</strong><span>{formatEur(budget.spentMinor)} / {formatEur(budget.amountMinor)}</span></div><progress max="100" value={progress} aria-label={`${budget.categoryName}: ${progress}% do orçamento utilizado`} /><small className={remaining < 0 ? 'budget-over' : ''}>{remaining < 0 ? `Excedido em ${formatEur(-remaining)}` : `Disponível ${formatEur(remaining)}`}</small></div>
          })}</div>}
          <form className="inline-form planning-form" onSubmit={(event) => void submitBudget(event)}>
            <label>Contexto<select name="context" defaultValue={defaultContext}><ContextOptions profiles={profiles} /></select></label>
            <label>Categoria de despesa<select name="categoryId" required><option value="">Escolher categoria</option>{categories.filter((category) => category.kind === 'expense').map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
            <label>Limite mensal (€)<input name="amount" inputMode="decimal" required placeholder="0,00" /></label>
            <button className="button button-primary" type="submit">Guardar orçamento</button>
          </form>
        </div>
        <div>
          <div className="planning-subheading"><strong>Objetivos de poupança</strong></div>
          {goals.length === 0 ? <p className="empty-note">Ainda não há objetivos definidos.</p> : <div className="goal-list">{goals.map((goal) => {
            const progress = Math.min(100, Math.round((goal.savedMinor / goal.targetMinor) * 100))
            return <div className="goal-row" key={goal.id}><div className="budget-heading"><strong>{goal.name} · {contextLabel(goal.context)}</strong><span>{formatEur(goal.savedMinor)} / {formatEur(goal.targetMinor)}</span></div><progress max="100" value={progress} aria-label={`${goal.name}: ${progress}% do objetivo`} />{goal.targetDate && <small>Data-alvo: {new Date(`${goal.targetDate}T12:00:00`).toLocaleDateString('pt-PT')}</small>}<form className="goal-progress-form" onSubmit={(event) => { event.preventDefault(); void updateGoal(goal, event.currentTarget) }}><label>Montante acompanhado (€)<input name="saved" inputMode="decimal" defaultValue={(goal.savedMinor / 100).toFixed(2).replace('.', ',')} /></label><button className="text-button" type="submit">Atualizar progresso</button></form></div>
          })}</div>}
          <form className="inline-form planning-form" onSubmit={(event) => void submitGoal(event)}>
            <label>Nome do objetivo<input name="name" required maxLength={100} placeholder="Ex.: Fundo de emergência" /></label>
            <label>Contexto<select name="context" defaultValue={defaultContext}><ContextOptions profiles={profiles} /></select></label>
            <label>Valor-alvo (€)<input name="target" inputMode="decimal" required placeholder="0,00" /></label>
            <label>Progresso inicial acompanhado (€)<input name="saved" inputMode="decimal" placeholder="0,00" /></label>
            <label>Data-alvo (opcional)<input name="targetDate" type="date" /></label>
            <button className="button button-primary" type="submit">Criar objetivo</button>
          </form>
          <p className="field-note goal-note">O progresso é um valor de planeamento indicado manualmente; não movimenta dinheiro nem altera saldos de contas.</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {status && <p className="import-result" role="status">{status}</p>}
    </div>
  </section>
}

function DataSafetyPanel({ onRestored }: { onRestored: (message: string) => void }) {
  const [backupBusy, setBackupBusy] = useState(false)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  async function downloadBackup() {
    setBackupBusy(true)
    setError('')
    setStatus('')
    try {
      const response = await fetch('/api/backup', { credentials: 'same-origin' })
      if (!response.ok) {
        const result = await response.json() as { error?: string }
        throw new Error(result.error ?? 'Não foi possível criar a cópia de segurança.')
      }
      const backup = await response.blob()
      const url = URL.createObjectURL(backup)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `financas-${localDate()}.sqlite`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setStatus('Cópia de segurança transferida. Guarde-a num local protegido.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar a cópia de segurança.')
    } finally {
      setBackupBusy(false)
    }
  }

  async function restoreBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const file = (new FormData(formElement).get('backup') as File | null)
    if (!file || file.size === 0) {
      setError('Selecione uma cópia SQLite válida.')
      return
    }
    if (file.size > 250 * 1024 * 1024) {
      setError('A cópia não pode exceder 250 MB.')
      return
    }
    if (!window.confirm('O restauro substituirá os dados atuais. Será criada uma cópia de segurança da base atual antes da substituição. Continuar?')) return
    setRestoreBusy(true)
    setError('')
    setStatus('')
    try {
      const response = await fetch('/api/restore', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const result = await response.json() as { error?: string; message?: string; safetyCopy?: string }
      if (!response.ok) throw new Error(result.error ?? 'Não foi possível restaurar a cópia.')
      formElement.reset()
      onRestored(`${result.message ?? 'Restauro concluído.'} Cópia anterior: ${result.safetyCopy ?? 'guardada na pasta da base de dados'}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível restaurar a cópia.')
    } finally {
      setRestoreBusy(false)
    }
  }

  return <section className="surface planning-surface" id="data-safety" aria-label="Cópias de segurança">
    <div className="section-heading"><div><p className="eyebrow">PROTEÇÃO DOS DADOS LOCAIS</p><h2>Cópias de segurança</h2></div></div>
    <div className="planning-content">
      <p className="import-intro">As cópias incluem os dados financeiros e não são cifradas. Guarde-as num local protegido. O restauro valida a integridade antes de substituir a base atual e cria uma cópia prévia de recuperação.</p>
      <div className="backup-actions"><button className="button button-secondary" type="button" disabled={backupBusy || restoreBusy} onClick={() => void downloadBackup()}>{backupBusy ? 'A preparar cópia…' : 'Descarregar cópia SQLite'}</button>
        <form className="restore-form" onSubmit={(event) => void restoreBackup(event)}><label>Ficheiro de cópia<input name="backup" type="file" accept=".sqlite,.db,application/vnd.sqlite3" required /></label><button className="button button-primary" type="submit" disabled={backupBusy || restoreBusy}>{restoreBusy ? 'A validar e restaurar…' : 'Restaurar cópia'}</button></form>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {status && <p className="import-result" role="status">{status}</p>}
    </div>
  </section>
}

function ContextOptions({ profiles }: { profiles: { id: ProfileId; name: string }[] }) {
  return <>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}<option value="joint">Conjunto</option></>
}

function ColumnOptions({ headers }: { headers: string[] }) {
  return <><option value="">Não mapear</option>{headers.map((header) => <option value={header} key={header}>{header}</option>)}</>
}

export default App
