# Pontos de integração para o backend

Nesta fase o Setor IA é só frontend. Nada executa demandas, acessa o GitHub, envia arquivos ou delega tarefas. Este documento lista onde a próxima etapa se encaixa.

## Dados locais

- `lib/office/types.ts`: tipos `Agent`, `Demand`, `FolderSummary` e `RepoRef`.
- `lib/office/storage.ts`: persistência em `localStorage`.
  - A chave atual é `setor-ia-office-v2`.
  - A chave antiga `setor-ia-game-v1` é lida uma única vez, migrada para a v2 e **mantida** como cópia de segurança.
  - A migração preserva as edições dos cinco funcionários padrão e os funcionários criados. Converte os encaminhamentos em texto livre em ids, cria aparência e estação para quem não tinha e extrai `owner/repo` de URLs do GitHub.
- `hooks/use-office.ts`: ações (`saveAgent`, `addAgent`, `removeAgent`, `dismissPreset`, `addDemand`, `removeDemand`), validações de capacidade por área, de orçamento e de limite de devoluções.
- Testes unitários da migração, da atualização de fichas e do payload: `npm test` (Vitest, `tests/profiles.test.ts`).

Na etapa seguinte, `loadOffice` e `saveOffice` podem ser trocados por chamadas a uma API sem mudar a UI. O formato exportado em "Exportar dados locais" é o mesmo da v2.

## Fichas dos colaboradores

- Os textos padrão das cinco fichas e dos modelos de contratação ficam em `lib/office/presets.ts` (`DEFAULT_PROFILES`, `HIRE_TEMPLATES`), versionados por `PRESET_VERSION`.
- Cada colaborador salvo guarda a própria cópia completa da ficha (`Agent`):
  - `playbook`: missão, insumos, método, qualidade, esclarecimentos e evidências;
  - `instructions`: instruções complementares;
  - `limits` e `deliverable`;
  - fluxo: `handoffTo`, `returnTo`, `maxCycles` e as regras em texto (`handoff`);
  - permissões planejadas (`tools`) e orçamento planejado (`budget`);
  - a origem da ficha (`preset`).
- **O motor deve ler a ficha salva, e não os presets.** Os presets servem só para criar fichas novas e para a comparação.
- `lib/office/profile.ts` concentra a lógica pura:
  - `comparePreset` sugere apenas os campos vazios ou nunca editados;
  - `applyPreset` aplica somente os campos escolhidos, sem tocar em nome, visual, estação, área, provedor, modelo ou demandas;
  - `dismissPreset` implementa o “manter a ficha atual”;
  - `profileForHire` monta a ficha de uma contratação.
- **Atualização para quem já tem dados salvos:**
  - Na migração, os campos novos ficam vazios e a ficha é marcada como baseada na versão 1.
  - O app avisa que existem novas instruções padrão (uma notificação e a tela de Funcionários) e oferece “Comparar”, mas não altera nada sozinho.
  - O usuário aplica os campos que quiser. O resultado vai para o rascunho da ficha e só vale depois de Salvar.
  - O usuário também pode cancelar, ou escolher “Manter a ficha atual”.
- **Decisões de produto:**
  - Os campos novos não são preenchidos com o padrão durante a migração. Assim nenhuma ficha antiga muda sem revisão.
  - O antigo texto único de instruções continua em “Instruções complementares”.
  - O orçamento inicial é proporcional ao papel: Diretor 16k, Arquiteto 24k, Desenvolvedor 48k, QA 24k e Revisor 12k tokens por tarefa. É só planejamento, e o motor ainda não aplica esse limite.
  - O Diretor pode devolver a demanda ao solicitante (`returnTo: ["user"]`).
  - Nenhum modelo ou provedor específico vem como padrão.

## Contrato da demanda

`lib/integration/contracts.ts`:

- `buildDemandPayload(demand, agents)` monta o `DemandPayload` (`schema: "setor-ia.demand/v2"`, com `status: "prepared"` e `engine: "not_connected"`). Cada perfil (`setor-ia.agent/v2`) traz:
  - `playbook`, `instructions`, `limits` e `deliverable`;
  - `routing`, com `handoffTo`, `returnTo`, `maxCycles` e `rules`;
  - `toolsPlanned` e `toolsConnected` (sempre vazio nesta fase);
  - `budget.enforced: false`;
  - `brief`, o texto montado apenas a partir desses campos por `agentBrief`. É o mesmo texto da aba Prévia da ficha.
- O restante do `DemandPayload` traz a demanda com os critérios de aceite, o perfil completo do responsável, a equipe inteira (para resolver encaminhamentos) e a fonte:
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
5. **Delegação**: usar como regras do orquestrador os campos de cada colaborador:
   - `routing.handoffTo`, `routing.returnTo` e `routing.rules`;
   - `routing.maxCycles`, que é o limite de devoluções por demanda e o que impede ciclos;
   - `toolsPlanned` e `budget`.

   Conectar ferramentas de verdade exige preencher `toolsConnected` no servidor.
6. **Persistência multiusuário**: mover agentes e demandas para o D1 (já previsto no starter, em `db/`) e usar o id estável do usuário (`oai-authenticated-user-id`).

## Ganchos de QA

- `?webgl=0` força a planta 2D interativa, para testar o fallback.
- `window.__setorOffice` (o motor da cena) expõe `project(id)`, `projectStation(id)` e `stats()` (draw calls, triângulos, nível de qualidade), usados nos testes de clique na cena e de desempenho.
