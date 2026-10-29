import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { parseEuroAmount, type TransactionType } from '../shared/domain.ts'

export interface ParsedImportFile {
  headers: string[]
  rows: Record<string, string>[]
}

export interface ImportMapping {
  dateColumn: string
  descriptionColumn: string
  amountColumn?: string
  debitColumn?: string
  creditColumn?: string
  categoryColumn?: string
  externalIdColumn?: string
  positiveAmountIs?: 'income' | 'expense'
}

export function suggestImportMapping(headers: string[]): Partial<ImportMapping> {
  const normalized = (header: string) => header.toLocaleLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ')
  const find = (pattern: RegExp) => headers.find((header) => pattern.test(normalized(header)))
  const dateColumn = find(/\b(data|date|booking|transaction)\b/)
  const descriptionColumn = find(/\b(descricao|description|merchant|memo|detail|historico)\b/)
  const debitColumn = find(/\b(debito|debit|levantamento|outflow)\b/)
  const creditColumn = find(/\b(credito|credit|deposito|inflow)\b/)
  const amountColumn = debitColumn || creditColumn ? undefined : find(/\b(valor|montante|amount|value)\b/)
  const categoryColumn = find(/\b(categoria|category)\b/)
  const externalIdColumn = find(/\b(id|referencia|reference|transaction id)\b/)
  return {
    ...(dateColumn ? { dateColumn } : {}),
    ...(descriptionColumn ? { descriptionColumn } : {}),
    ...(amountColumn ? { amountColumn } : {}),
    ...(debitColumn ? { debitColumn } : {}),
    ...(creditColumn ? { creditColumn } : {}),
    ...(categoryColumn ? { categoryColumn } : {}),
    ...(externalIdColumn ? { externalIdColumn } : {}),
    positiveAmountIs: 'expense',
  }
}

export interface NormalizedImportRow {
  rowIndex: number
  date: string
  description: string
  amountMinor: number
  type: 'income' | 'expense'
  externalIdentifier: string | null
  importedCategory: string
  fingerprint: string
}

function chooseDelimiter(line: string): string {
  const counts = new Map<string, number>([[';', 0], [',', 0], ['\t', 0]])
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') index += 1
      else quoted = !quoted
    } else if (!quoted && counts.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1)
    }
  }
  return [...counts].sort((first, second) => second[1] - first[1])[0][0]
}

function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  const delimiter = chooseDelimiter(firstLine)
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === delimiter) {
      record.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      record.push(field)
      if (record.some((value) => value.trim().length > 0)) records.push(record)
      record = []
      field = ''
    } else {
      field += character
    }
  }

  if (quoted) throw new Error('O ficheiro CSV contém uma aspa sem correspondência.')
  record.push(field)
  if (record.some((value) => value.trim().length > 0)) records.push(record)
  return records
}

function uniqueHeaders(values: string[]): string[] {
  const used = new Set<string>()
  return values.map((value, index) => {
    const base = value.trim() || `Coluna ${index + 1}`
    let name = base
    let suffix = 2
    while (used.has(name.toLocaleLowerCase())) {
      name = `${base} (${suffix})`
      suffix += 1
    }
    used.add(name.toLocaleLowerCase())
    return name
  })
}

function rowsToObjects(records: string[][]): ParsedImportFile {
  if (records.length < 2) throw new Error('O ficheiro precisa de cabeçalhos e pelo menos uma linha de dados.')
  const headers = uniqueHeaders(records[0])
  if (headers.length > 100) throw new Error('O ficheiro excede o limite de 100 colunas.')
  const dataRows = records.slice(1).filter((row) => row.some((value) => value.trim().length > 0))
  if (dataRows.length > 5000) throw new Error('O ficheiro excede o limite de 5 000 movimentos por importação.')
  if (dataRows.length === 0) throw new Error('O ficheiro não contém movimentos.')
  if (dataRows.some((row) => row.length > headers.length && row.slice(headers.length).some((value) => value.trim().length > 0))) {
    throw new Error('Existem linhas com mais colunas do que o cabeçalho.')
  }
  return {
    headers,
    rows: dataRows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))),
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result)
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => typeof item === 'object' && item !== null && 'text' in item ? String(item.text) : '').join('')
    }
    return ''
  }
  return String(value)
}

export async function parseImportFile(filename: string, bytes: Buffer): Promise<ParsedImportFile> {
  const extension = filename.toLocaleLowerCase().split('.').pop()
  if (extension === 'csv') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    return rowsToObjects(parseCsv(text))
  }
  if (extension !== 'xlsx') throw new Error('Formato não suportado. Selecione um ficheiro CSV ou XLSX.')

  const workbook = new ExcelJS.Workbook()
  try {
    const xlsxData = Uint8Array.from(bytes).buffer
    await workbook.xlsx.load(xlsxData)
  } catch {
    throw new Error('Não foi possível ler o livro XLSX. Verifique se o ficheiro não está danificado.')
  }
  const worksheet = workbook.worksheets[0]
  if (!worksheet || worksheet.rowCount < 2) throw new Error('O livro XLSX precisa de cabeçalhos e pelo menos uma linha de dados.')
  if (worksheet.rowCount > 5001 || worksheet.columnCount > 100) {
    throw new Error('O livro excede o limite de 5 000 movimentos ou 100 colunas.')
  }
  const headerRow = worksheet.getRow(1)
  const headers = uniqueHeaders(Array.from({ length: worksheet.columnCount }, (_, index) => cellText(headerRow.getCell(index + 1).value)))
  const rows: Record<string, string>[] = []
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const values = headers.map((_, index) => cellText(worksheet.getRow(rowNumber).getCell(index + 1).value))
    if (values.every((value) => value.trim().length === 0)) continue
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])))
  }
  if (rows.length === 0) throw new Error('O livro XLSX não contém movimentos.')
  return { headers, rows }
}

function parseImportMoney(value: string): number {
  let text = value.trim().replace(/[€\s\u00a0]/g, '')
  if (!text) return 0
  const parenthesesNegative = text.startsWith('(') && text.endsWith(')')
  if (parenthesesNegative) text = text.slice(1, -1)
  const negativePrefix = text.startsWith('-') || text.startsWith('−')
  text = text.replace(/[−+-]/g, '')
  const comma = text.lastIndexOf(',')
  const dot = text.lastIndexOf('.')
  const decimalIndex = Math.max(comma, dot)
  let normalized: string
  if (decimalIndex >= 0 && text.length - decimalIndex - 1 <= 2 && text.length - decimalIndex - 1 > 0) {
    const whole = text.slice(0, decimalIndex).replace(/[,.]/g, '')
    const fraction = text.slice(decimalIndex + 1)
    normalized = `${whole || '0'}.${fraction}`
  } else {
    normalized = text.replace(/[,.]/g, '')
  }
  const sign = parenthesesNegative || negativePrefix ? '-' : ''
  return parseEuroAmount(`${sign}${normalized}`, { allowNegative: true, allowZero: true })
}

function parseImportDate(value: string): string {
  const text = value.trim()
  let year: number
  let month: number
  let day: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  const european = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text)
  if (iso) {
    year = Number(iso[1])
    month = Number(iso[2])
    day = Number(iso[3])
  } else if (european) {
    day = Number(european[1])
    month = Number(european[2])
    year = Number(european[3])
  } else {
    throw new Error('Data não reconhecida; use AAAA-MM-DD ou DD/MM/AAAA.')
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('A data não é válida.')
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function requireMappedValue(row: Record<string, string>, column: string, name: string): string {
  const value = row[column]?.trim()
  if (!column || !value) throw new Error(`Falta ${name}.`)
  return value
}

export function normalizeImportRow(
  row: Record<string, string>,
  rowIndex: number,
  mapping: ImportMapping,
): NormalizedImportRow {
  if (!mapping.dateColumn || !mapping.descriptionColumn) throw new Error('Mapeie a data e a descrição.')
  if (Boolean(mapping.amountColumn) === Boolean(mapping.debitColumn || mapping.creditColumn)) {
    throw new Error('Mapeie um montante único ou uma coluna de débito/crédito.')
  }
  const date = parseImportDate(requireMappedValue(row, mapping.dateColumn, 'uma data'))
  const description = requireMappedValue(row, mapping.descriptionColumn, 'uma descrição').slice(0, 240)
  let amountMinor: number
  let type: 'income' | 'expense'

  if (mapping.amountColumn) {
    const signedAmount = parseImportMoney(requireMappedValue(row, mapping.amountColumn, 'um montante'))
    if (signedAmount === 0) throw new Error('O montante tem de ser diferente de zero.')
    const positiveType = mapping.positiveAmountIs ?? 'expense'
    type = signedAmount < 0 ? (positiveType === 'expense' ? 'income' : 'expense') : positiveType
    amountMinor = Math.abs(signedAmount)
  } else {
    const debit = mapping.debitColumn ? parseImportMoney(row[mapping.debitColumn] ?? '') : 0
    const credit = mapping.creditColumn ? parseImportMoney(row[mapping.creditColumn] ?? '') : 0
    if (debit !== 0 && credit !== 0) throw new Error('A linha tem valores simultâneos em débito e crédito.')
    if (debit === 0 && credit === 0) throw new Error('Falta um valor de débito ou crédito.')
    type = debit !== 0 ? 'expense' : 'income'
    amountMinor = Math.abs(debit !== 0 ? debit : credit)
  }

  const externalIdentifier = mapping.externalIdColumn ? row[mapping.externalIdColumn]?.trim() || null : null
  const importedCategory = mapping.categoryColumn ? row[mapping.categoryColumn]?.trim().slice(0, 80) ?? '' : ''
  const normalizedDescription = description.toLocaleLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const fingerprint = createHash('sha256')
    .update(`${date}|${type}|${amountMinor}|${normalizedDescription}`)
    .digest('hex')

  return { rowIndex, date, description, amountMinor, type, externalIdentifier, importedCategory, fingerprint }
}
