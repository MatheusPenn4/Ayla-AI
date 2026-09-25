# Pontos de integração para o backend

Nesta fase o Setor IA é só frontend. Nada executa demandas, acessa o GitHub, envia arquivos ou delega tarefas. Este documento lista onde a próxima etapa se encaixa.

## Dados locais

- `lib/office/types.ts`: tipos `Agent`, `Demand`, `FolderSummary` e `RepoRef`.
- `lib/office/storage.ts`: persistência em `localStorage`.
  - A chave atual é `setor-ia-office-v2`.
  - A chave antiga `setor-ia-game-v1` é lida uma única vez, migrada para a v2 e **mantida** como cópia de segurança.
  - A migração preserva as edições dos cinco funcionários padrão e os funcionários criados. Converte os encaminhamentos em texto livre em ids, cria aparência e estação para quem não tinha e extrai `owner/repo` de URLs do GitHub.
- `hooks/use-office.ts`: ações (`saveAgent`, `addAgent`, `removeAgent`, `addDemand`, `removeDemand`) e validações de capacidade por área.

Na etapa seguinte, `loadOffice` e `saveOffice` podem ser trocados por chamadas a uma API sem mudar a UI. O formato exportado em "Exportar dados locais" é o mesmo da v2.

## Contrato da demanda

`lib/integration/contracts.ts`:

- `buildDemandPayload(demand, agents)` monta o `DemandPayload` (`schema: "setor-ia.demand/v1"`). Ele contém a demanda com os critérios de aceite, o perfil completo do responsável, a equipe inteira (para resolver encaminhamentos) e a fonte:
  - `github`: `url`, `owner`, `repo` e `branch`.
  - `folder`: resumo com nome, quantidade de arquivos, bytes, extensões e se há `package.json` ou `.git`, sempre com `note: "files-not-uploaded"`.
  - `none`.
- O botão **Payload** na fila mostra exatamente esse JSON.
- `OrchestratorAdapter` e `orchestrator` definem a interface do motor. A implementação atual tem `status: "not_connected"` e `submit()` lança `NotConnectedError`. A UI nunca chama `submit()`, então nenhuma demanda aparece como executada.

## O que falta implementar no backend

1. **Motor de agentes**: um endpoint no servidor (ex.: `POST /api/demands`) que recebe o `DemandPayload`, cria uma execução e devolve o `runId`. Depois, trocar `orchestrator` por uma implementação que chame esse endpoint. As credenciais dos provedores (Claude, OpenAI, etc.) ficam só no servidor.
2. **Estados de execução**: acrescentar ao tipo `Demand` os estados `running`, `needs_review`, `done` e `failed`, com eventos por funcionário. A cena já tem ganchos para refletir isso: `typing` por personagem, painéis de parede alimentados por `setDashboard` e a bandeja do Diretor com a contagem da fila.
3. **GitHub**: OAuth ou GitHub App no servidor, validação de acesso ao repositório e clone ou leitura sob demanda. Hoje só a URL é guardada.
4. **Pasta local**: upload real (ou File System Access API com permissão persistida), com filtros de `node_modules` e `.git` e limite de tamanho. Hoje só o resumo é guardado; o conteúdo dos arquivos nunca é lido.
5. **Delegação**: usar `handoffTo`, `tools` e `budget` de cada funcionário como regras do orquestrador.
6. **Persistência multiusuário**: mover agentes e demandas para o D1 (já previsto no starter, em `db/`) e usar o id estável do usuário (`oai-authenticated-user-id`).

## Ganchos de QA

- `?webgl=0` força a planta 2D interativa, para testar o fallback.
- `window.__setorOffice` (o motor da cena) expõe `project(id)`, `projectStation(id)` e `stats()` (draw calls, triângulos, nível de qualidade), usados nos testes de clique na cena e de desempenho.
