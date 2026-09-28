# Executor local do Setor IA

O Diretor planeja de verdade, o Arquiteto analisa (só leitura) e o Desenvolvedor implementa (escrita confinada a uma cópia isolada do commit aprovado) tarefas que você aprovar, usando **as suas assinaturas** por meio dos clientes oficiais instalados e autenticados neste computador:

| Conexão na ficha | Cliente oficial | Conta usada | Como o login é feito |
|---|---|---|---|
| Claude — assinatura (via Claude Code) | Claude Code (`claude`) | login claude.ai (Pro, Max, Team, Enterprise) | `claude auth login --claudeai`, no seu terminal |
| ChatGPT Business (via Codex CLI) | Codex CLI (`codex`) | login ChatGPT (Business, Plus, Pro…) | `codex login` ou `codex login --device-auth`, no seu terminal |

Nenhuma chave de API é necessária. O executor **ignora** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` e variáveis de gateway: ele só usa o login que o próprio cliente mantém. Se um cliente estiver autenticado por chave de API, o Setor IA mostra a conexão como **Desconectado** e explica como entrar pela assinatura.

## Arquitetura

```
Navegador (interface)                 Servidor web (pnpm dev)                Executor local (pnpm executor)          Clientes oficiais
────────────────────                  ────────────────────────               ──────────────────────────────          ─────────────────
/api/engine/status  ── mesma origem ─▶ proxy + portões (localhost,       ──▶  127.0.0.1:4317, token Bearer,   ──▶  claude -p … (stdin)
/api/runs, /cancel     cabeçalho       origem, x-ayla-client)                 recusa Origin/Sec-Fetch,               codex exec - … (stdin)
/api/handoffs, /approve                 token só no servidor (.dev.vars)       Host fixo, JSON ≤ 1 MB                 (sessão do próprio cliente)
/api/engine/connections
                                                                               SQLite: .ayla/runs.sqlite
```

Camadas separadas no código:

- **Interface**: `components/office/panels/*`, `hooks/use-runs.ts`, `lib/engine/client.ts`. Não fala com modelos e não vê o token.
- **Rotas web (proxy)**: `app/api/**`, `lib/server/*`. Só funcionam no servidor local de desenvolvimento acessado por `localhost`.
- **Executor**: `executor/main.ts` (entrada), `lib/executor/service.ts` (fila, concorrência, cancelamento), `lib/executor/http.ts` (proteção HTTP), `lib/executor/planner.ts` (núcleo único de execução, usado pelo Diretor e pelo Arquiteto), `lib/executor/handoff.ts` (preparação e validação do encaminhamento ao Arquiteto), `lib/executor/store.ts` + `sqlite.ts` (registro durável), `lib/executor/github.ts` (leitura pública limitada), `lib/executor/proc.ts` (execução controlada de processos), `lib/executor/clients.ts` (detecção).
- **Adaptadores**: `lib/executor/adapters/claude.ts` e `lib/executor/adapters/codex.ts`, com a mesma interface (`AgentAdapter`). Os cinco colaboradores podem escolher qualquer um dos dois. Nesta fase o Diretor executa por conta própria e o Arquiteto só executa tarefas aprovadas por você; Desenvolvedor, QA e Revisor não executam.

## Como iniciar localmente

Pré-requisitos: Node.js 22.13 ou mais novo, `pnpm install` já feito, e pelo menos um cliente oficial instalado e com login.

1. **Login no cliente oficial** (uma vez, no seu terminal, fora do Setor IA):
   - Claude: `claude auth login --claudeai` (confira com `claude auth status`).
   - ChatGPT Business: `codex login` e escolha “Sign in with ChatGPT” (confira com `codex login status`). Sem navegador: `codex login --device-auth`. O administrador do workspace Business precisa ter liberado o Codex.
2. **Executor**, em um terminal na pasta do projeto:
   ```bash
   pnpm executor
   ```
   Na primeira vez ele cria `AYLA_EXECUTOR_URL` e `AYLA_EXECUTOR_TOKEN` em `.dev.vars` (arquivo ignorado pelo Git) e mostra o estado de cada cliente. O token nunca é impresso.
3. **Interface**, em outro terminal:
   ```bash
   pnpm dev
   ```
   Se o `pnpm dev` já estava aberto antes do passo 2, reinicie-o para ele ler o token.
4. Abra `http://localhost:5173`, escolha a **Conexão de execução** na ficha do Diretor (aba Perfil), salve, crie uma demanda e clique em **Planejar com o Diretor** na tela Demandas.

Variáveis opcionais (em `.dev.vars` ou no ambiente do executor): `AYLA_EXECUTOR_PORT` (padrão 4317), `AYLA_MAX_CONCURRENT_RUNS` (padrão 1), `AYLA_MAX_RUNS_PER_HOUR` (padrão 20), `AYLA_CALL_TIMEOUT_MS` (padrão 600000, 10 min; até 30 min), `AYLA_LOCAL_REPOS` (pastas de cópias locais autorizadas para leitura, separadas por `;`; veja abaixo), `AYLA_CLAUDE_PATH` / `AYLA_CODEX_PATH` (caminho absoluto do executável, se não estiver no PATH), `GITHUB_TOKEN` (apenas aumenta o limite de consultas da API pública do GitHub).

## Encaminhamento Diretor → Arquiteto

Fluxo: **plano do Diretor → você escolhe uma tarefa do Arquiteto → revisa o que será enviado → confirma → o Arquiteto analisa → a análise fica registrada**. Nada acontece automaticamente depois disso.

1. **Abrir o plano.** Na tela Demandas, o cartão mostra o resumo (“Arquiteto: 1 análise concluída · 1 proposta(s) para enviar”). Na aba **Tarefas** do plano, cada tarefa mostra seu estado real, lido do executor:

   | Estado | Significado |
   |---|---|
   | Proposta pelo Diretor | tarefa do Arquiteto ainda não enviada |
   | Proposta pelo Diretor · responsável ainda não executa | tarefa do Desenvolvedor, QA ou Revisor (sem botão) |
   | Aguardando sua aprovação | envio preparado e congelado; nada rodou |
   | Na fila do executor / Arquiteto trabalhando | aprovado; o cliente oficial está em execução |
   | Análise concluída | resultado validado e registrado |
   | Arquiteto aguardando esclarecimento | ele fez perguntas e não inventou uma decisão |
   | Falha / Cancelada | com motivo e caminho de recuperação; pode ser enviada de novo |

   Se o plano não tem tarefa do Arquiteto, a aba diz isso e não oferece botão. Uma tarefa que depende de outra só pode ser enviada depois que a outra tiver análise concluída do Arquiteto; se depender de alguém que não executa nesta fase, fica bloqueada com o motivo.
2. **Enviar ao Arquiteto** (preparar). O navegador manda só o ID do plano, o ID da tarefa e a ficha salva do Arquiteto. O executor confere, **no próprio registro**, que o plano existe e está pronto, que a tarefa pertence a ele, que o responsável é o Arquiteto, que a ficha é a do Arquiteto e que a tarefa não tem análise concluída nem envio em aberto. Em seguida lê as fontes, monta a entrada exata e grava tudo congelado com o estado “aguardando aprovação”. Nenhum cliente é chamado.
3. **Revisar.** A janela de revisão mostra a demanda e os critérios, o que o Diretor pediu (escopo, insumos, entregável, critérios), os arquivos que o Diretor realmente consultou (com commit), o contexto que vai para o Arquiteto (e o que não vai), a conexão, o modelo e o esforço da ficha do Arquiteto com o estado real do cliente, as ferramentas autorizadas e bloqueadas, a estimativa de texto contra o orçamento e o texto exato. Se a ficha do Arquiteto mudar depois de preparado, a confirmação é bloqueada até preparar de novo.
4. **Confirmar.** A confirmação envia o hash do conteúdo revisado; o executor só aceita se for idêntico ao preparado e muda o estado de forma atômica (cliques repetidos criam uma única execução e um único processo). “Descartar envio” registra o descarte; nada é executado.
5. **Análise.** O Arquiteto recebe o protocolo da execução + a ficha salva dele (playbook, limites, regras de encaminhamento) e a mensagem congelada. A resposta estruturada é validada: entendimento técnico e suposições; arquivos/símbolos/contratos examinados, separando **lido** (conteúdo enviado) de **inferido**; solução recomendada e justificativa; alternativas só quando há decisão real; dependências e compatibilidade; riscos e regressões; orientação ao Desenvolvedor; checagens recomendadas ao QA (não executadas); dúvidas. Uma referência marcada como “lida” que não foi enviada é rejeitada (uma correção é pedida). Se houver dúvidas bloqueantes, o estado vira “aguardando esclarecimento”; responder prepara um novo envio, que passa de novo por revisão e confirmação.

A análise fica vinculada à demanda, ao plano do Diretor (`parent_run_id`) e à tarefa (`task_id`), com o instantâneo da ficha usada, eventos, uso informado e resposta bruta. Ela fica disponível para a futura etapa do Desenvolvedor e para o Diretor consolidar; nenhum colaborador é acionado a partir dela.

### Esclarecimento e revisão de contexto

Quando o Arquiteto pede esclarecimento, a aba **Dúvidas** da execução dele permite resolver **cada pergunta de um único jeito**:

- **Eu respondo**: vira “resposta do solicitante (usuário)”, uma decisão sua;
- **Resolver lendo arquivos**: você indica `caminho` ou `caminho#Símbolo`; o executor lê esses arquivos no commit escolhido e o Arquiteto responde a partir do conteúdo (fica registrado quais foram lidos e quais não existiam).

Também é possível registrar **decisões adicionais** (pontos que o Arquiteto não perguntou) e escolher **a fonte e o commit** do novo envio. Submeter só prepara um novo envio, que passa pela mesma revisão e confirmação.

Regras aplicadas pelo executor:

- as respostas precisam corresponder, **pelo texto exato**, às perguntas da execução que as fez (`previous_run_id`); cada pergunta é resolvida uma vez; nenhuma pode ficar sem resolução;
- trocar commit ou fonte exige **motivo** e vira uma **revisão** numerada (`revisão 2`, `3`…), com commit anterior, commit novo, fonte e motivo, e o evento `context_revision`. O envio anterior **não é alterado** (nem o que ele recebeu, nem seu estado);
- a numeração conta todas as tentativas da tarefa: uma revisão que falhou ou foi descartada mantém seu número;
- o Arquiteto recebe `<esclarecimentos>` com a origem de cada resposta e não pode repetir uma pergunta já resolvida: a validação recusa (e pede uma correção) uma pergunta parecida com uma resolvida, salvo se `why_it_blocks` começar com “Contradição:”.

A revisão do envio mostra: suas respostas marcadas como suas; as dúvidas resolvidas por leitura, com arquivos e commit; o que é **reaproveitado** e o que é **novo** em relação ao envio anterior (comparação por blob do Git ou hash do conteúdo; quando o envio anterior não registrou hash, isso é dito); o commit exato; a conexão e o modelo; e o escopo (o que é pedido e o que fica fora).

### Cópia local autorizada (commits não publicados)

O leitor público só vê o que está no GitHub. Se a tarefa fala de código que existe apenas em commits locais não enviados, o executor pode ler **uma cópia local autorizada**, com estas garantias:

- só pastas listadas em `AYLA_LOCAL_REPOS` (caminho absoluto, em `.dev.vars`), autorizadas por você;
- o `origin` da cópia precisa ser o mesmo repositório da demanda;
- o commit precisa **descender** do commit que o Diretor leu (`git merge-base --is-ancestor`);
- só objetos commitados são lidos (`git ls-tree`, `git show`, `git merge-base`, `git branch -r --contains`, `git diff-tree --name-only`), com argumentos estruturados e sem shell; sem checkout, sem `status`, sem `fetch`, sem escrita, e **alterações não commitadas nunca entram**;
- o registro guarda o nome da pasta (não o caminho completo), se o commit está publicado no GitHub (segundo as referências locais `origin/*`) e a relação com o commit do Diretor.

### Caso real da task-1 (26/09/2026)

- **Execução 87768df8** (revisão 1): commit público `0f6cdf6`, que o Diretor tinha lido. O Arquiteto fez 5 perguntas: onde fica a janela de execução do Diretor, qual o tipo do plano, onde o plano fica em memória, o que `tests/profiles.test.ts` cobre, se há utilitário de download. **As cinco eram técnicas**, mas não podiam ser resolvidas em `0f6cdf6`: a janela (`run-dialog.tsx`, `DirectorPlan`, `use-runs.ts`) só existe nos commits locais `ae8e896`/`c878f7b`, **não publicados** (o GitHub continua em `0f6cdf6`).
- **Decisões que eram suas**: qual commit ler e se a cópia local poderia ser lida (você escolheu `c878f7b` local); e uma decisão de produto nova que o código de `c878f7b` criou (o `.md` deve mostrar o estado real de cada tarefa e o resumo da análise do Arquiteto).
- **Revisão 2** (d4ffb0d7): commit `c878f7b` local, as 5 perguntas resolvidas por leitura de 7 arquivos, sua decisão. **Falhou por tempo esgotado**: o executor encerrou o cliente aos 5 min. Não havia progresso registrado nem uso informado (o formato `json` só escreve no fim).
- **Revisão 3** (3678137a): mesmo conteúdo, preparada e **descartada** por você antes de executar, para investigar a falha.
- **Revisão 4** (7ddd04b5): contexto reduzido (abaixo), limite de 10 min, progresso em fluxo. **Análise concluída em 206 s**, sem novas perguntas, com recomendação, 12 referências examinadas (11 lidas, 1 inferida), riscos, orientação ao Desenvolvedor e checagens para o QA. Repositório conferido idêntico antes e depois (HEAD, `status` e hash de cada arquivo); nenhuma execução de Desenvolvedor, QA ou Revisor.

### Tarefa que depende de outra: fonte, arquivos e análise da dependência

Antes de preparar, o botão “Enviar ao Arquiteto” abre um painel (nada é gravado e nenhum modelo é chamado ao abrir):

- **Fonte e commit**, com a origem de cada opção: o commit que o Diretor leu (GitHub público), o commit de cada análise concluída da qual a tarefa depende e o HEAD da cópia local autorizada. O proposto é o commit da análise da dependência. Escolher um commit diferente do Diretor exige **motivo**, que fica na revisão (`context_revision`).
- **Comparação arquivo a arquivo** (só na cópia local, com `git ls-tree`, `git merge-base --is-ancestor` e `git diff-tree --name-only`): para cada arquivo pedido, se existe no commit do Diretor, se existe no commit escolhido e se mudou entre eles. A comparação fica gravada no envio e aparece na revisão e no texto enviado (“não existiam lá: …”).
- **Arquivos a ler**, sugeridos a partir da análise da dependência: o que ela examinou (lido ou inferido) e os caminhos que ela cita como não verificados ou na orientação. Por padrão, as sugestões são marcadas enquanto cabem no limite (10 arquivos, 12 referências); você desmarca ou acrescenta `caminho` ou `caminho#Símbolo`. Com arquivos confirmados, a heurística por nome e o manifesto não entram.
- **Novo envio após falha**: o painel começa do mesmo commit e dos mesmos arquivos do envio anterior (que não é alterado), e o número da revisão continua.

O que vai para o Arquiteto de uma dependência concluída (`<analises_das_dependencias>`, uma vez só): execução, revisão, commit e fonte da análise; entendimento (até 400 caracteres); recomendação e justificativa; até 12 referências examinadas com a base (lido/inferido); até 8 orientações ao Desenvolvedor; até 4 riscos, suposições e pontos não verificados, cada um cortado, com a contagem do que ficou de fora; e as **decisões suas** registradas naquele envio, marcadas como decisão do usuário. O protocolo (regra 13) diz que isso é insumo, não fato verificado, e se refere ao commit da análise.

**“Lido” por símbolo.** Num arquivo enviado só em trecho, `arquivo#Símbolo` só pode ser marcado como lido se o símbolo aparece no trecho enviado; a lista de declarações do topo não conta. O executor recusa e pede correção quando isso não acontece. Aplicada à análise da task-1 já registrada (sem alterá-la), a regra aponta uma referência: `hooks/use-runs.ts#useRuns` foi marcada como lida, mas só a janela de `taskRunsFor` (dentro de `useRuns`) tinha sido enviada. A prévia do Desenvolvedor mostra isso como “lido só em parte”.

**Revisão antes de confirmar** (além do que já mostrava): análises das dependências usadas e as decisões suas herdadas; arquivos confirmados e o motivo de cada um; comparação dos commits; para cada arquivo, bytes no commit, caracteres enviados, linhas e **blocos** enviados; quantos arquivos do repositório vão só pelo nome (não examinados); e o **custo possível**: o total que o cliente informou nas execuções anteriores do Arquiteto pela mesma conexão, a razão entre esse total e a estimativa do texto e a faixa que isso sugeriria para o envio atual. É referência, não medida nem limite; o consumo sai da cota da assinatura, sem cobrança por API.

**Cobertura da leitura** (aba Análise): o que foi lido (conteúdo enviado e conferido pelo executor), o que foi só inferido, o que foi enviado e não citado, e quantos arquivos não foram examinados.

### Caso real da task-2 (28/09/2026)

- O plano do Diretor (`92788815`) diz que a task-2 depende da task-1 e que a task-3 (Desenvolvedor) depende da task-2.
- **Fonte**: o commit do Diretor (`0f6cdf6`, GitHub) não tem 6 dos 8 arquivos necessários (a janela do Diretor, os tipos do plano, `handoff-state.ts`, `plan-schema.ts`, `use-runs.ts`); 73 arquivos mudaram entre ele e o commit usado. A análise da task-1 foi feita em `c878f7b`; entre ele e o commit usado mudaram 36 arquivos, 6 deles pedidos. Escolha proposta pelo Claude Code e confirmada por você: `b6bad7a` (HEAD local, não publicado, descende de ambos), com o estado atual de `taskState`, `RunRecord` e `DirectorBody`.
- **Envio**: 8 arquivos (12 referências: `DirectorBody`; `DirectorPlan`, `PlanStep`, `PlanTask`, `ArchitectAnalysis`, `RunRecord` e os tipos que eles usam; `handoff-state.ts` inteiro; `exportData`; `PlanZ`; `taskRunsFor`; `lib/utils.ts`; `package.json`), sem nenhuma linha enviada duas vezes; a análise da task-1 e a sua decisão registrada nela. 52.716 caracteres na mensagem e 5.083 nas instruções; estimativa ≈ 17.280 tokens (orçamento de referência 24.000).
- **Revisão 1 (`483de03a`)**: confirmada por você; falhou em 19 s. O Claude Code informou: “Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient”. Nenhum uso foi informado e o repositório ficou idêntico (HEAD, `status` e hash de cada arquivo versionado). O executor classificou errado como “sessão expirada” e marcou a conexão como expirada; o registro dessa falha ficou como foi gravado.
- **Correção**: essa mensagem agora é o erro `auth_busy` (recuperável). Ele não vira “sessão expirada”, mas a conexão passa a avisar que a última chamada falhou ao renovar o token, com os passos de recuperação.
- **Teste de sessão (autorizado por você)**: falhou com a mesma mensagem, sem chamada ao modelo. A trava `~/.claude/.oauth_refresh.lock` (só nome e data foram vistos) foi criada durante o próprio teste e ficou parada, vazia. O arquivo de login do cliente não é renovado desde 26/09. O único outro processo do Claude Code na máquina é a sessão do app Claude usada para desenvolver o Setor IA. Conclusão: a renovação do login do cliente está falhando. O Setor IA não abre nem mexe nesses arquivos; a recuperação é sua, pelo próprio cliente.
- **Recuperação**: você rodou `claude` no seu terminal; o cliente renovou o login (o arquivo de login foi regravado às 09:38 e a trava sumiu) e se atualizou para a 2.1.283. O “Testar sessão” passou em seguida e limpou o estado “sessão expirada”.
- **Revisão 2 (`e70e9937`)**: mesmo commit e mesmos arquivos (todos reaproveitados, mesmo blob). Confirmada por você e **concluída em 237 s**. A primeira resposta marcou “análise task-1 (7ddd04b5)” como lida; o executor recusou (não é conteúdo enviado) e pediu a única correção prevista, que a marcou como inferida. Resultado: especificação do `.md` com 6 blocos em ordem fixa e aviso de proposta não executada; módulo puro `lib/engine/plan-markdown.ts` (`directorPlanToMarkdown`, `planMarkdownFilename`, `escapeMdText`), que recebe nomes, estados e resumos já resolvidos pela interface; `downloadTextFile` novo em `lib/utils.ts`; nenhum tipo alterado; nenhuma dependência nova. 12 referências examinadas (10 lidas, 2 inferidas), 2 alternativas, 4 riscos, 11 orientações ao Desenvolvedor e 8 checagens para o QA, sem perguntas.
- **Uso informado pelo cliente** (duas chamadas: análise e correção): entrada 4, cache lido 3.680, cache gravado 57.627, saída 26.206 (raciocínio 12.210), **total 87.517** (46.319 + 41.198). Passou do orçamento de referência (24.000), o que fica só como alerta. O repositório ficou idêntico (HEAD, `status` e hash de cada arquivo versionado) e nenhuma execução de Desenvolvedor, QA ou Revisor foi criada.
- **Ponto para a revisão do Desenvolvedor**: as duas análises supõem que o resumo do Arquiteto precisa ser buscado por execução (`engineApi.get`). O tipo `RunRecord`, que a task-2 leu, já tem o campo `analysis`, e a lista de execuções o devolve. Ninguém confirmou isso numa execução: fica para o Desenvolvedor conferir.

### Prévia do envio ao Desenvolvedor (somente visualização)

Nas tarefas do Desenvolvedor, “Ver prévia do envio ao Desenvolvedor” só fica disponível quando **todas** as dependências, diretas e indiretas, são tarefas do Arquiteto com análise concluída. A prévia é montada pelo executor a partir dos registros. Ela **não cria execução, não chama modelo, não grava nada e não concede escrita**, e diz isso no topo. Mostra:

- a demanda original e a tarefa;
- as tarefas relevantes com o **estado real** (a mesma `taskState` da aba Tarefas): a própria, as dependências diretas e indiretas e as que dependem dela;
- as análises registradas dos Arquitetos (execução, revisão, commit, recomendação, orientação, riscos, decisões suas, quantidade de checagens para o QA);
- o **commit de base proposto** (o da análise da dependência mais próxima), o HEAD local e, para cada análise, quantos arquivos mudaram desde então e quais dos examinados mudaram;
- os pontos ainda não verificados (não verificado, suposições, inferidos, lidos só em parte, alterados desde a análise);
- o **escopo de edição previsto**: arquivos citados pela tarefa e pelas análises, classificados como alterar, criar ou apenas consultar (pelo verbo antes do caminho: “ler …” é consulta). É previsão, não permissão, e as demais tarefas ficam fora do escopo;
- o que uma futura execução do Desenvolvedor exigiria (não implementado).

“Baixar prévia (.md)” gera uma cópia em Markdown dos mesmos dados; os estados na tela e no arquivo vêm da mesma fonte. Isso não é a exportação do plano pedida na demanda: aquela é trabalho do Desenvolvedor (task-3 e task-4). Ao lado da prévia, quando a tarefa está apta, um botão **“Enviar ao Desenvolvedor”** prepara o encaminhamento de verdade — a próxima seção descreve esse fluxo.

### Encaminhamento Diretor → Desenvolvedor

Mesmo modelo em dois passos do Arquiteto (preparar → revisar → confirmar), mas o Desenvolvedor **escreve**: por isso o fluxo só existe para a conexão Claude — assinatura, e só depois que você confirma a revisão. Preparar **não constrói nada e não chama o cliente**; a cópia isolada só é montada dentro da execução aprovada.

1. **Preparar** (`lib/executor/developer.ts#prepareDeveloperHandoff`): reaproveita a mesma lógica de dependências e escopo da prévia (nenhuma regra duplicada). Recusa se: alguma dependência (sempre do Arquiteto, com análise concluída) ainda não terminou; a conexão da ficha não é Claude Code (`connection_not_write_restricted`, e antes disso o próprio serviço já bloqueia por `WRITE_RESTRICTED`, veja adiante); a permissão “Editar arquivos” está desligada na ficha (`no_write_permission`); não há cópia local autorizada para o repositório (`local_not_authorized`); ou nenhum caminho de edição foi identificado (`no_edit_scope`). O commit de base é o da análise mais próxima; outro commit exige descender dele (`commit_not_descendant`) e um motivo, virando uma revisão numerada — mesma mecânica do Arquiteto.
2. **Mensagem sem conteúdo de arquivo colado.** Ao contrário do Arquiteto, o Desenvolvedor tem ferramentas reais de leitura, então a mensagem não cola texto de arquivos: descreve a tarefa, as análises das dependências (uma vez, resumidas, marcadas como insumo — não fato verificado) e o **escopo de edição aprovado** (`<escopo_de_edicao>`: caminhos que podem ser criados/alterados, e os que são só para consulta), com o resto do repositório fora do alcance.
3. **Revisão** mostra: demanda e tarefa; as análises das dependências e a decisão sua registrada nelas; o commit de base (com a revisão, se houver troca); a tabela de escopo de edição (caminho, ação prevista, motivo — citado pela tarefa ou pelas análises); o que fica fora do escopo; as ferramentas desta execução com o texto exato do que cada uma permite; os limites (tempo por chamada, uma tentativa de correção, tamanho do diff exibido); conexão e modelo; e o texto exato enviado. Confirmar envia o hash do conteúdo revisado, como no Arquiteto.
4. **Execução aprovada** (`lib/executor/planner.ts#developerSpec`, `lib/executor/worktree.ts`):
   - **Cópia isolada**: `git archive` do commit aprovado (lê só objetos commitados, como o leitor local do Arquiteto — nunca alterações não commitadas) extraído por `tar` numa pasta temporária nova; sem `node_modules`, sem `.env`, sem `.dev.vars`, sem o `.git` do projeto real (`git archive` nunca inclui `.git`) — nada disso faz parte do commit, então nunca é copiado. A cópia ganha um repositório Git **próprio, novo e sem remoto** (hooks desligados por `core.hooksPath` apontando para uma pasta vazia, sem modelo de `git init`), usado só para calcular o diff depois; o Desenvolvedor não tem terminal para mexer nele.
   - **Ferramentas do Claude Code** (`--restricted`, documentado no próprio `claude --help`, verificado nesta versão do cliente): remove Bash/PowerShell/REPL e ferramentas de rede a menos que `--tools` as nomeie (não nomeia); confina Read/Edit/Write/Glob/Grep à pasta de trabalho, sem `--add-dir`; ignora configurações de usuário/projeto/local (sem hooks, sem CLAUDE.md automático); recusa `bypassPermissions`. `--disallowedTools` nega Bash/PowerShell/NotebookEdit/WebFetch/WebSearch/Task como segunda camada, e `--safe-mode` desliga skills/plugins/MCP como terceira. **Isso ainda não foi confirmado por uma chamada real de verificação** (o equivalente ao `pnpm check:readonly` do Arquiteto) nesta versão — a revisão diz isso explicitamente.
   - **Terminal continua bloqueado nesta versão**, mesmo a ficha do Desenvolvedor planejando essa permissão: rodar comandos exigiria instalar dependências (rede, não autorizada por padrão) ou copiar `node_modules` de fora do commit aprovado (proibido). Por isso `tipos, lint, testes, build` não são verificados nesta versão — fica registrado como limitação, não escondido.
   - **Diff real, não o relato do modelo**: depois da chamada, o executor roda `git add -A` + `git diff --cached` na cópia isolada e compara os arquivos tocados com o escopo aprovado. Qualquer arquivo fora do escopo vira erro de validação (mesma mecânica de correção única do Arquiteto: uma nova tentativa pode desfazer o problema; se persistir, a execução falha — nunca fica “implementação pronta”). O relatório do próprio Desenvolvedor (`changes`) é conferido contra esse diff: uma alteração relatada que não existe no diff real, ou uma alteração real não relatada, também é recusada.
   - **Resultado**: relatório estruturado (resumo, critério por critério de aceite, suposições, não verificado) mais o diff calculado (arquivos, +/-, texto do diff até 40.000 caracteres) — tudo gravado no registro; a cópia isolada é apagada ao final, sempre.
5. **Nada é aplicado ao projeto original.** A implementação existe só na cópia isolada (depois removida) e no registro. Aplicar ao checkout real, comitar, publicar ou acionar o QA a partir daí são etapas futuras, com aprovação própria.

### Caso real da task-3 (28/09/2026)

Preparado de verdade pela interface (nenhum modelo chamado): tarefa `task-3` (“Implementar serialização do plano em Markdown”), dependências `task-1` e `task-2` com análise concluída do Arquiteto. Commit de base proposto e usado: `b6bad7a` (o da análise de `task-2`), cópia local autorizada “setor-ia”, 238 arquivos na cópia isolada que seria montada. Escopo de edição resolvido contra a árvore real desse commit: criar `lib/engine/plan-markdown.ts`; alterar `lib/utils.ts` e `app/page.tsx`; consultar (sem editar) `lib/engine/types.ts` e `lib/engine/plan-schema.ts`. Estimativa do texto enviado: cerca de 7.260 tokens (orçamento de referência da ficha: 48.000). A revisão ficou **aguardando confirmação**; nenhuma cópia de trabalho foi criada e nenhuma chamada real ao Claude Code foi feita para esta tarefa nesta etapa.

### Contexto do Arquiteto e suas reduções

- **Mesmo repositório e mesmo commit** que o Diretor leu (o executor não relê a branch; o commit fica registrado).
- **O que vai com conteúdo**: arquivos e pastas citados na tarefa, o manifesto (`package.json` etc.) e arquivos cujo nome combina com termos da tarefa. Os termos em português são ligados às palavras que o código costuma usar em inglês por um dicionário pequeno e fixo (`janela → dialog`, `tipos → types`, `contrato → contract`…); o nome do arquivo pesa mais que a pasta, pastas genéricas (`components`, `lib`, `src`…) não contam e primitivas `components/ui/` perdem prioridade. É uma heurística por caminho: ela não lê conteúdo para decidir.
- **O que vai só como caminho**: a lista dos arquivos de texto do repositório (até 300) e os arquivos que o Diretor leu mas que não foram escolhidos, para o Arquiteto saber o que existe e o que não leu.
- **O que não vai**: as demais tarefas em detalhe, a resposta completa do Diretor e a conversa. Vai um resumo verificável do plano (objetivo, fluxo, etapa, riscos, suposições, não verificado) e, para tarefas dependentes, o resumo da recomendação da análise anterior.
- **Limites** (`ARCHITECT_GITHUB_LIMITS`): até 10 arquivos, 16.000 caracteres por arquivo, 56.000 no total, 20 s de leitura. Se a estimativa passar de 60% do orçamento da ficha, o executor retira primeiro os arquivos **menos relevantes** (fim da ordem de seleção) e registra cada remoção; arquivos pedidos para resolver uma pergunta **nunca** são retirados. O texto e a lista de arquivos lidos mudam sempre juntos. Limite dessa redução: um arquivo retirado não chega ao Arquiteto, e ele só sabe o caminho.
- **Trechos verificáveis** (arquivos acima de 7.000 caracteres): lista das declarações de nível superior com linhas; imports (até 1.200 caracteres); os blocos dos símbolos pedidos (`#Símbolo`) e os tipos que eles referenciam (um nível); para um símbolo que não é declaração de nível superior (por exemplo, uma função dentro de um componente), uma janela de linhas ao redor dele, com janelas sobrepostas fundidas; em arquivos de teste, os títulos de `describe`/`it` com a linha. Cada trecho diz as linhas e o commit. Sem símbolos pedidos, os termos da tarefa só casam com o **nome** das declarações.
- **Em um novo envio com arquivos pedidos**, a heurística por nome de arquivo e o manifesto não entram: só os arquivos pedidos e os citados na tarefa.
- **Resumo do plano**: até 4 itens por lista (riscos, suposições, não verificado), cada um cortado em 220 caracteres, com a contagem do que ficou de fora e o ID do plano.
- **Análise anterior**: só uma referência e o entendimento resumido; a recomendação provisória só é reenviada se o commit não mudou (feita sobre outro commit, levaria a uma conclusão desatualizada).
- **Resposta**: o protocolo pede concisão (até 12 itens em `examined`, 8 nas demais listas; referenciar em vez de copiar código).

### Somente leitura, garantido pela configuração

O Arquiteto não recebe o repositório: o executor lê os arquivos pela API pública do GitHub, em memória, e entrega apenas texto. O cliente roda numa pasta temporária vazia, sem credencial do GitHub. Além disso:

- **Claude Code**: `--tools ""` (nenhuma ferramenta), `--permission-mode dontAsk`, `--disallowedTools Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch`, `--strict-mcp-config`, `--safe-mode`, `--setting-sources ""`, `--no-session-persistence`.
- **Codex CLI**: `--sandbox read-only`, `-c approval_policy="never"`, `--disable shell_tool unified_exec apps plugins browser_use computer_use image_generation multi_agent hooks`, busca na web desligada, `--ignore-user-config`, `--ephemeral`.

Verificação real (`pnpm check:readonly`, uma chamada pequena por cliente): o prompt pede explicitamente para sobrescrever um arquivo dentro da pasta de trabalho, outro fora dela, criar um arquivo novo e rodar um comando. Resultado em 25/09/2026: **nenhum arquivo alterado ou criado nos dois clientes**. O Claude Code informou que só tinha a ferramenta de saída estruturada. O Codex informou que `apply_patch` continua visível ao modelo, mas foi **bloqueado pela sandbox somente leitura**. Esse é o limite conhecido: no Codex, a proteção contra escrita vem da sandbox, e não da ausência total de ferramentas. Se algum adaptador deixar de garantir leitura segura, `READ_ONLY` em `lib/executor/service.ts` bloqueia esse adaptador para o Arquiteto e a revisão explica o motivo.

## Segurança

- **Nenhuma credencial de conta passa pelo Setor IA.** Senha, cookie, token OAuth e arquivos de autenticação ficam com o cliente oficial (`~/.claude`, `~/.codex`). O Setor IA não abre, copia nem registra esses arquivos; usa apenas os comandos de status dos clientes (`claude auth status`, `codex login status`).
- **Sem automação de sites.** Nada acessa `claude.ai` ou `chatgpt.com` pelo navegador, nem endpoints privados.
- **Processos sem shell.** Executável + lista de argumentos; texto da demanda e da ficha vai por stdin; instruções do Claude por arquivo temporário; esquema do Codex por arquivo. Scripts `.cmd`/`.bat` não são executados (o shim do npm é resolvido para `node` + script). Modelo e esforço são validados por expressão regular antes de virar argumento.
- **Isolamento das chamadas (Arquiteto, só leitura).** Pasta de trabalho vazia e temporária por execução (apagada no fim). Claude: `--tools ""`, `--strict-mcp-config`, `--safe-mode`, `--setting-sources ""`, `--disable-slash-commands`, `--no-session-persistence`. Codex: `--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, ferramentas de shell, apps, plugins, navegador, imagens e multiagente desligadas, busca na web desligada.
- **Isolamento das chamadas (Desenvolvedor, escrita confinada, só Claude Code).** A pasta de trabalho é uma cópia isolada do commit aprovado (`git archive`, sem `.git`/`node_modules`/alterações não commitadas do projeto real), apagada no fim. `--restricted` confina Read/Edit/Write/Glob/Grep a essa pasta (sem `--add-dir`), remove Bash/PowerShell/REPL/ferramentas de rede a menos que `--tools` as nomeie, ignora configurações de usuário/projeto/local e recusa `bypassPermissions`; `--disallowedTools` nega Bash/PowerShell/NotebookEdit/WebFetch/WebSearch/Task como segunda camada e `--safe-mode` desliga skills/plugins/MCP como terceira. Depois da chamada, o executor recalcula o diff real da cópia (não confia no relato do modelo) e reprova qualquer arquivo fora do escopo aprovado. **Ainda sem verificação por chamada real** (o equivalente ao `pnpm check:readonly` do Arquiteto); a revisão avisa isso. Codex fica bloqueado para o Desenvolvedor nesta versão (política de rede do sandbox não verificada).
- **Limites.** Tempo máximo por chamada, saída máxima de 4 MB, uma execução por vez, 20 por hora, no máximo uma correção por execução.
- **Executor fechado para a internet.** Escuta só em `127.0.0.1`; exige `Authorization: Bearer <token>` (comparação em tempo constante); recusa qualquer requisição com `Origin` ou `Sec-Fetch-*` (marcas de navegador), então páginas da internet não conseguem chamá-lo, e ele nunca envia cabeçalhos CORS; recusa `Host` diferente de `127.0.0.1:<porta>`/`localhost:<porta>` (proteção contra DNS rebinding); aceita só JSON até 1 MB.
- **Rotas web.** Só respondem no servidor de desenvolvimento acessado por `localhost`, com origem local e o cabeçalho `x-ayla-client: web`. Um build de produção sempre recusa a execução.

## O que fica registrado

Arquivo `.ayla/runs.sqlite` (ignorado pelo Git), mantido pelo executor:

- execução: ID, tipo (`director_plan`, `architect_task` ou `developer_task`), demanda, colaborador, plano e tarefa de origem (no Arquiteto ou no Desenvolvedor), estado, conexão usada, modelo e esforço pedidos, datas (criação, início, fim), prazo de processamento, tentativa, hash e instantâneo congelado da ficha e da demanda, entrada exata enviada (instruções e mensagem — sem conteúdo de arquivo colado para o Desenvolvedor), contexto consultado, resultado validado (para o Desenvolvedor, o relatório **e** o diff que o executor calculou), erro com passos de recuperação, uso informado pelo cliente e resposta bruta;
- eventos com data e hora;
- resultado das chamadas reais por conexão (para detectar sessão expirada).

Execuções sobrevivem ao recarregar a página e ao reiniciar o executor. Uma execução que estava em planejamento quando o executor foi encerrado é marcada como **interrompida** no próximo início; as que estavam na fila continuam.

Cliques repetidos não duplicam: a interface bloqueia o segundo clique, cada pedido leva uma chave de idempotência, e o banco só permite um plano ativo por demanda e um encaminhamento em aberto por tarefa.

**Migração do registro.** A versão 2 do esquema acrescenta as colunas `kind`, `parent_run_id` e `task_id` com `ALTER TABLE … ADD COLUMN` (as linhas existentes não mudam; as antigas viram `director_plan`) e troca o índice “uma execução ativa por demanda” por índices que distinguem plano e tarefa. Antes de migrar, o executor grava uma cópia completa (`.ayla/runs.backup-before-v2-<data>.sqlite`, via `VACUUM INTO`). Não existe rotina que apague registros.

## Estados da conexão

| Estado | Quando |
|---|---|
| Não instalado | executável não encontrado no PATH nem em `AYLA_CLAUDE_PATH`/`AYLA_CODEX_PATH` |
| Desconectado | cliente sem login, ou autenticado por chave de API/outro provedor em vez da assinatura |
| Conectado | o cliente informa login pela assinatura (Claude: `authMethod` claude.ai; Codex: “Logged in using ChatGPT”) |
| Sessão expirada | o cliente ainda lista um login, mas a última chamada real foi recusada por autenticação |
| Conectado, com aviso | a última chamada real falhou porque o cliente não conseguiu renovar o token de acesso (`auth_busy`: “another … process is refreshing it”); o cliente diz que é passageiro, então não vira “sessão expirada” |
| Indisponível | o cliente não respondeu ao status ou respondeu algo inesperado |

“Verificar conexão” repete os comandos de status. “Testar sessão” faz uma chamada real mínima (usa um pouco da assinatura) e só roda quando você clica.

## Uso e limites

- O **orçamento de tokens da ficha** é **referência e alerta** do Setor IA, não um limite rígido: o cliente não pode ser interrompido no meio da resposta. Antes da chamada, o executor estima o texto que vai enviar (caracteres ÷ 3,5); para o Diretor, não chama se só esse texto já passar do orçamento; para o Arquiteto, mostra o alerta na revisão e você decide. Depois compara com o uso **informado pelo cliente** e marca “acima da referência” quando passar. Nas execuções reais, o uso informado passou do orçamento: 39.328 contra 16.000 no Diretor (Claude) e 65.467 contra 24.000 no Arquiteto. A maior parte é cache de entrada e raciocínio do próprio cliente. O orçamento padrão do Diretor (16.000) **não** foi alterado.
- Os **limites da assinatura** (janelas de uso do Claude, limites do ChatGPT Business compartilhados com o ChatGPT Work) são controlados por Anthropic e OpenAI. Os clientes não informam o saldo restante ao Setor IA, que por isso não mostra saldo nem promete teto. Quando o limite é atingido, o cliente avisa e a execução mostra o erro “limite de uso da assinatura”.
- **Progresso em fluxo**: o Claude Code roda com `--output-format stream-json --verbose`. O executor registra como eventos o início da sessão (modelo), cada repetição de requisição feita pelo cliente (`system/api_retry`, com erro, tentativa e espera) e as mensagens do modelo (tipos de conteúdo, no máximo um evento a cada 20 s). Se a chamada for encerrada (tempo esgotado, cancelamento, saída grande demais), o erro guarda o último evento, o fim do stderr e o **uso parcial** das mensagens recebidas, marcado como **limite inferior**: na execução real, o uso dentro das mensagens em fluxo apareceu como 3 e 5 tokens de saída, e o valor final (20.701) só veio no resultado.
- **Limites que os clientes oferecem** (verificado em `claude --help`, `codex exec --help` e na documentação do Claude Code): `--effort` (profundidade do raciocínio; não é teto); `--max-budget-usd` (teto em dólar **estimado**, só com `--print`, verificado entre turnos, não em tokens); `MAX_THINKING_TOKENS` (a documentação diz que é ignorado em modelos com raciocínio adaptativo). O Codex `exec` não expõe limite de tokens. **Nenhum desses é um teto rígido de tokens**, e o Setor IA não aplica nenhum deles. O único limite rígido aplicado é o tempo por chamada (`AYLA_CALL_TIMEOUT_MS`), que encerra o processo.
- Uso exibido (aba Tokens): entrada sem cache, cache lido, cache gravado, saída (com o raciocínio incluído) e total, por chamada, com a **fonte da medição** (Claude Code: `modelUsage` do evento `result`; Codex: `turn.completed.usage` do `--json`), turnos informados e, quando o cliente informa, o detalhe por requisição (Claude Code: `usage.iterations`). Na execução real, o Claude Code informou 3 turnos e detalhou só 1 requisição; o painel diz isso e não soma o detalhe como total. Categoria que o cliente não informou aparece como **indisponível**, nunca como 0 nem como estimativa. No Codex, `input_tokens` inclui o cache; o executor separa as duas partes para não contar em dobro. Registros anteriores a esta versão aparecem como foram gravados e marcados como “registro anterior à identificação da fonte”. O Codex não informa o modelo usado. O `total_cost_usd` do Claude Code é uma estimativa de preço de API e **não** é mostrado como cobrança.

### Diagnóstico de consumo da task-1 (medido)

`pnpm diagnose:run <id>` mostra, para uma execução registrada, o texto montado pelo Setor IA por seção (em **caracteres**, a partir da entrada congelada) ao lado do que o cliente informou (em **tokens**, por categoria).

| | Revisão 1 (87768df8) | Revisão 4 (7ddd04b5) |
|---|---|---|
| Commit / fonte | `0f6cdf6` · GitHub | `c878f7b` · cópia local |
| Texto montado pelo Setor IA | 40.699 car. (4 arquivos inteiros: 27.094) | 48.012 car. (6 trechos: 27.961) |
| Estimativa antes da chamada | ≈ 11.629 tokens | ≈ 13.718 tokens |
| Entrada / cache lido / cache gravado | 4 / 18.251 / 29.436 | 4 / 21.850 / 37.578 |
| Saída (raciocínio incluído) | 17.776 (4.184) | 20.701 (10.494) |
| Turnos / detalhe por requisição | indisponível / indisponível | 3 / 1 de 3 |
| Total informado | 65.467 | 80.133 |
| Duração | 171 s | 206 s |
| Resposta devolvida | 16.038 car. | 11.539 car. |

O que **não** pode ser atribuído ao nosso texto:

- o cliente acrescenta contexto próprio (a definição da ferramenta de saída estruturada com o esquema, instruções internas) e informa só totais por categoria;
- **cache gravado e cache lido são a mesma entrada contada em requisições diferentes** (cada turno relê o prefixo); somá-los ao total não significa texto novo enviado;
- a saída inclui o raciocínio e, pelo progresso em fluxo da revisão 4, **duas emissões da ferramenta de saída estruturada** (duas mensagens `tool_use`, com dois retornos): o JSON foi gerado mais de uma vez pelo mecanismo do cliente;
- não existe tokenizador oficial local sem chave de API, então os caracteres de cada seção não viram tokens.

Reduções feitas depois da falha da revisão 2 (de 61.461 para 48.012 caracteres, −22%): trechos por símbolo em vez de funções inteiras (`use-runs.ts` de 7.873 para 2.532 caracteres; `plan-schema.ts` saiu), janelas sobrepostas fundidas (antes as linhas 72–103 de `use-runs.ts` iam duas vezes), imports limitados, só tipos como referências automáticas, análise anterior como referência, resumo do plano mais curto. **O orçamento de referência de 24.000 do Arquiteto não foi alterado**; o uso informado continua acima dele, e isso aparece como alerta.

## Modelos e esforço

A ficha só mostra o que o cliente instalado oferece:

- Claude Code: aliases citados em `claude --help` (hoje `fable`, `opus`, `sonnet`) e os níveis de `--effort`. A disponibilidade depende da assinatura.
- Codex: modelos visíveis no catálogo do próprio cliente (`codex debug models`) e os níveis de raciocínio de cada modelo.
- “Padrão do cliente” não passa nenhum modelo. Um nome salvo em versões anteriores fica preservado e marcado “não listado pelo cliente”; se a conta não tiver acesso, a execução falha com “modelo indisponível”.

## Publicação na Vercel: o que não funciona e como evoluir

Uma interface hospedada na Vercel **não tem acesso** aos logins do Claude Code e do Codex deste computador. As funções da Vercel rodam em servidores da Vercel, sem o seu `~/.claude` ou `~/.codex`, e o executor local escuta só em `127.0.0.1` e recusa chamadas vindas de páginas web. Hoje, o build publicado mostra o motor como desativado; nada é fingido.

Caminho viável (não implementado nesta fase):

1. **Executor conecta para fora.** Em vez de a Vercel chamar o computador, o executor local abre uma conexão de saída autenticada (WebSocket ou long-polling HTTPS) com o backend do Setor IA e busca trabalhos. O computador não precisa expor porta.
2. **Pareamento do dispositivo.** Você entra no Setor IA hospedado, gera um código de pareamento de uso único e curta duração, e o executor troca esse código por uma credencial de dispositivo própria do Setor IA, revogável e sem relação com as contas Claude/ChatGPT. Essa credencial fica com o executor, fora do navegador.
3. **Filas por usuário.** O backend guarda demandas e execuções em banco (Postgres) com dono. O executor só recebe trabalhos do próprio dono, executa com os clientes locais e devolve resultado, eventos e uso informado.
4. **Limites no servidor.** Limites por usuário e por dispositivo, auditoria, expiração de trabalhos e aviso quando o executor estiver desligado (“seu computador está offline”).

O que continua proibido nesse desenho: receber senha, cookie, token OAuth ou arquivo de autenticação das contas; um serviço público que execute com as assinaturas de outras pessoas. A documentação do Agent SDK proíbe que produtos de terceiros ofereçam login claude.ai a outros usuários sem aprovação da Anthropic, então esse uso fica restrito ao próprio dono das contas, na própria máquina.

## Testes

- `pnpm test`: encaminhamento ao Arquiteto (tarefa elegível, sem Arquiteto, adulterada, sem aprovação, hash diferente, cliques repetidos, dependências, esclarecimento, cliente desconectado, erro, cancelamento, “lido” só para arquivos enviados, pasta de trabalho vazia, argumentos de somente leitura, migração com linhas antigas intactas, persistência e reinício, categorias de uso indisponíveis, seleção e redução de contexto), pipeline do Diretor, validação do plano, composição da entrada, GitHub, registro durável (inclusive reabrindo o arquivo), cliques repetidos, cancelamento, limites, estados de conexão, adaptadores com saídas reais gravadas dos clientes, detecção, execução de processos (real, com `node`) e proteção HTTP (servidor real em 127.0.0.1). Nesses testes, os clientes oficiais são **simulados**.
- A execução real com cada cliente é feita pela interface ou pela API local, com o executor em execução; os resultados ficam no registro com o cliente e o uso informados.
- Tarefa dependente e prévia (simulados; a comparação usa **Git real** em pasta temporária): opções de fonte sem criar registro; análise da dependência enviada uma vez, com o commit e a decisão do usuário; só os arquivos confirmados; aprovação de outra execução recusada; primeiro envio numa cópia local com a comparação arquivo a arquivo e sem mencionar envio anterior inexistente; “lido” por símbolo em trecho; prévia bloqueada até as dependências indiretas, sem registro nem chamada, com os mesmos estados na tela e no Markdown; escopo alterar/criar/consultar; falha ao renovar o token classificada como passageira, sem “sessão expirada”.
- Desenvolvedor (argumentos do cliente verificados sem chamada real; cópia isolada e diff com **Git e `tar` reais** em pasta temporária): modo `developer_write` concede só Read/Edit/Write/Glob/Grep, confina por `--restricted` e nega Bash/PowerShell/rede/subagente, sem alterar o modo somente leitura do Arquiteto; dependências pendentes recusadas; conexão diferente de Claude Code e ficha sem permissão de editar recusadas; preparo congela a revisão sem montar cópia nem chamar o cliente; cliques repetidos geram um único registro; divergência de hash na confirmação recusada e confirmação dupla enfileira uma única vez; execução aprovada materializa a cópia de verdade (sem `.git` do projeto real, sem `node_modules`), escreve de verdade nela e o diff real (não o que o modelo relata) decide o resultado; pedido adversarial que escreve fora do escopo aprovado dentro da própria cópia é reprovado pelo diff real, com o repositório de origem sempre intacto; cancelamento antes e durante a execução; persistência do relatório e do diff (`kind developer_task`).
- `pnpm check:clients`: detecção real (sem chamada de modelo). `pnpm check:readonly`: verificação real de escrita bloqueada (uma chamada pequena por cliente). `pnpm diagnose:run <id>`: composição e uso de uma execução registrada (só leitura do banco).
- Esclarecimento e revisão (simulados): respostas ligadas às perguntas certas, perguntas inventadas/duplicadas/sem resposta recusadas, resposta sua e leitura identificadas, envio anterior intacto (comparação byte a byte do registro), cliques repetidos no novo envio e na confirmação, repetição de pergunta recusada salvo contradição, troca de commit exige motivo e gera revisão, tempo esgotado com limite explícito e revisão seguinte, cópia local com **Git real** em pasta temporária (commit descendente, alteração não commitada ignorada, cópia não modificada, pasta não autorizada, commit fora da história e origem diferente recusados), trechos e janelas, composição que soma exatamente o texto montado, fluxo do Claude Code com repetição de API e uso parcial.

## Desenvolvedor: o que está implementado e o que falta

Implementado (28/09/2026, código real, coberto por testes e por uma revisão real preparada — veja “Caso real da task-3”): encaminhamento em dois passos (preparar/revisar/confirmar); cópia de trabalho isolada por `git archive`, sem histórico do projeto real, sem `node_modules`; escrita do Claude Code confinada por `--restricted` à cópia e aos caminhos aprovados; diff calculado pelo executor (não confiado ao relato do modelo) decidindo o resultado; nada aplicado ao projeto original, comitado ou publicado a partir da execução.

O que falta, de propósito, nesta versão:

- **Verificação real de isolamento de escrita.** O Arquiteto tem `pnpm check:readonly` (uma chamada real, gravada em 25/09/2026). O Desenvolvedor ainda não tem o equivalente — a revisão avisa que o `--restricted` está documentado, não confirmado por uma chamada real neste ambiente. Antes de confiar a execução sem supervisão, vale montar esse mesmo tipo de verificação (pedir para escrever fora da cópia e fora do escopo, confirmar que falha de verdade).
- **Terminal.** Planejado na ficha, mas bloqueado no executor: falta um mecanismo de isolamento de rede comprovado e uma forma de disponibilizar dependências (`node_modules`) sem copiar dados de fora do commit aprovado.
- **Codex.** Bloqueado para o Desenvolvedor (`WRITE_RESTRICTED.codex.safe = false`): a política de rede do sandbox `workspace-write` não foi verificada neste ambiente.
- **Aplicar ao projeto, QA e publicação.** A implementação fica só no registro (diff + relatório); levá-la ao checkout real, acionar o QA ou publicar são etapas futuras, cada uma com sua própria aprovação.
