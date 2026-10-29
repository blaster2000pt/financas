import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { normalizeImportRow, parseImportFile } from './imports.ts'

test('parses Portuguese semicolon CSV with quoted delimiters and duplicated headers', async () => {
  const contents = 'Data;Descrição;Descrição;Valor\r\n29/10/2026;"Compra; supermercado";Nota;12,50\r\n'
  const file = await parseImportFile('extrato.csv', Buffer.from(`\uFEFF${contents}`, 'utf8'))
  assert.deepEqual(file.headers, ['Data', 'Descrição', 'Descrição (2)', 'Valor'])
  assert.equal(file.rows[0]['Descrição'], 'Compra; supermercado')
})

test('reads the first worksheet from an XLSX workbook', async () => {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Movimentos')
  worksheet.addRow(['Data', 'Descrição', 'Débito', 'Crédito'])
  worksheet.addRow([new Date('2026-10-29T00:00:00Z'), 'Farmácia', 12.35, null])
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  const file = await parseImportFile('extrato.xlsx', buffer)
  assert.equal(file.rows.length, 1)
  assert.equal(file.rows[0].Data, '2026-10-29')
  assert.equal(file.rows[0].Descrição, 'Farmácia')
})

test('normalizes debit and credit columns into integer EUR cents', () => {
  const expense = normalizeImportRow(
    { Data: '29/10/2026', Descrição: '  CAFÉ  ', Débito: '1.234,56', Crédito: '', Categoria: 'Alimentação', ID: 'b-1' },
    0,
    { dateColumn: 'Data', descriptionColumn: 'Descrição', debitColumn: 'Débito', creditColumn: 'Crédito', categoryColumn: 'Categoria', externalIdColumn: 'ID' },
  )
  const income = normalizeImportRow(
    { Data: '2026-10-30', Descrição: 'Reembolso', Montante: '-2,35' },
    1,
    { dateColumn: 'Data', descriptionColumn: 'Descrição', amountColumn: 'Montante' },
  )
  assert.equal(expense.amountMinor, 123_456)
  assert.equal(expense.type, 'expense')
  assert.equal(expense.externalIdentifier, 'b-1')
  assert.equal(income.amountMinor, 235)
  assert.equal(income.type, 'income')
})

test('reports invalid dates and ambiguous debit/credit rows instead of guessing', () => {
  assert.throws(() => normalizeImportRow(
    { Data: '31/02/2026', Descrição: 'Movimento', Débito: '10,00', Crédito: '' },
    0,
    { dateColumn: 'Data', descriptionColumn: 'Descrição', debitColumn: 'Débito', creditColumn: 'Crédito' },
  ), /data não é válida/)
  assert.throws(() => normalizeImportRow(
    { Data: '2026-10-01', Descrição: 'Movimento', Débito: '10,00', Crédito: '5,00' },
    0,
    { dateColumn: 'Data', descriptionColumn: 'Descrição', debitColumn: 'Débito', creditColumn: 'Crédito' },
  ), /simultâneos/)
})
