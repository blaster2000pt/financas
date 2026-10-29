# Finanças

Aplicação local-first para gerir finanças pessoais e conjuntas. O projecto está a ser construído por fases; a base actual inclui um frontend React/TypeScript, uma API Node.js local e persistência SQLite.

## Requisitos

- Node.js 22.18 ou superior (usa `node:sqlite` e suporte nativo para executar TypeScript; a versão recomendada é Node.js 24 LTS).
- npm.

## Arranque local

Na primeira utilização, instala as dependências da API e do frontend:

```powershell
# Na raiz do repositório
npm install
Set-Location frontend
npm install
Set-Location ..
```

Inicia a API e o frontend em dois terminais PowerShell, na raiz do repositório:

```powershell
npm run dev
```

```powershell
npm run dev:web
```

Abre o endereço local apresentado pelo Vite. A API escuta apenas em `127.0.0.1:4174`; o Vite também faz bind a `127.0.0.1`. A base de dados é criada em `data/financas.sqlite` e não é versionada.

Na primeira execução, cria-se uma palavra-passe única da aplicação e definem-se os nomes dos dois perfis financeiros. A palavra-passe é armazenada com scrypt; **a base de dados SQLite não é cifrada**. Protege o acesso à conta do sistema operativo e aos ficheiros de backup.

## Comandos

```powershell
npm test
npm run typecheck:api
npm run build
npm --prefix frontend run lint
```

## Estado da implementação

A aplicação inclui setup/login local, dois perfis, contas com um ou dois titulares, movimentos categorizados, transferências ligadas, reconciliação não destrutiva e importação CSV/XLSX com pré-visualização, análise de duplicados, perfis reutilizáveis, batches e undo conservador. A importação não aceita contas classificadas como investimento: compras e vendas de ativos são registadas pela área de investimentos, para não as classificar incorretamente como despesas ou rendimentos. Inclui também ativos e operações de investimento com atualização de caixa, cotações manuais, orçamentos mensais por categoria, objetivos de poupança, pesquisa de movimentos, análise mensal e estimativa simples baseada em meses anteriores.

As cópias SQLite podem ser descarregadas e restauradas. O restauro valida a integridade antes de substituir a base e guarda uma cópia de segurança prévia na pasta `data`. Os ficheiros não são cifrados; proteja também as cópias. A aplicação não liga a bancos, serviços de cotações ou à cloud.

O forecast é apenas uma média histórica explicável, não uma previsão financeira. O progresso dos objetivos é indicado manualmente e não movimenta dinheiro nem altera saldos. As posições sem cotação manual não entram no património valorizado.
