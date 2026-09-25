# Executor local do Setor IA

O Diretor planeja de verdade usando **as suas assinaturas**, por meio dos clientes oficiais instalados e autenticados neste computador:

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
/api/engine/connections                 token só no servidor (.dev.vars)       Host fixo, JSON ≤ 1 MB                 (sessão do próprio cliente)
                                                                               SQLite: .ayla/runs.sqlite
```

Camadas separadas no código:

- **Interface**: `components/office/panels/*`, `hooks/use-runs.ts`, `lib/engine/client.ts`. Não fala com modelos e não vê o token.
- **Rotas web (proxy)**: `app/api/**`, `lib/server/*`. Só funcionam no servidor local de desenvolvimento acessado por `localhost`.
- **Executor**: `executor/main.ts` (entrada), `lib/executor/service.ts` (fila, concorrência, cancelamento), `lib/executor/http.ts` (proteção HTTP), `lib/executor/planner.ts` (pipeline do Diretor), `lib/executor/store.ts` + `sqlite.ts` (registro durável), `lib/executor/github.ts` (leitura pública limitada), `lib/executor/proc.ts` (execução controlada de processos), `lib/executor/clients.ts` (detecção).
- **Adaptadores**: `lib/executor/adapters/claude.ts` e `lib/executor/adapters/codex.ts`, com a mesma interface (`AgentAdapter`). Os cinco colaboradores podem escolher qualquer um dos dois; nesta fase só o Diretor executa.

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

Variáveis opcionais (em `.dev.vars` ou no ambiente do executor): `AYLA_EXECUTOR_PORT` (padrão 4317), `AYLA_MAX_CONCURRENT_RUNS` (padrão 1), `AYLA_MAX_RUNS_PER_HOUR` (padrão 20), `AYLA_CALL_TIMEOUT_MS` (padrão 300000), `AYLA_CLAUDE_PATH` / `AYLA_CODEX_PATH` (caminho absoluto do executável, se não estiver no PATH), `GITHUB_TOKEN` (apenas aumenta o limite de consultas da API pública do GitHub).

## Segurança

- **Nenhuma credencial de conta passa pelo Setor IA.** Senha, cookie, token OAuth e arquivos de autenticação ficam com o cliente oficial (`~/.claude`, `~/.codex`). O Setor IA não abre, copia nem registra esses arquivos; usa apenas os comandos de status dos clientes (`claude auth status`, `codex login status`).
- **Sem automação de sites.** Nada acessa `claude.ai` ou `chatgpt.com` pelo navegador, nem endpoints privados.
- **Processos sem shell.** Executável + lista de argumentos; texto da demanda e da ficha vai por stdin; instruções do Claude por arquivo temporário; esquema do Codex por arquivo. Scripts `.cmd`/`.bat` não são executados (o shim do npm é resolvido para `node` + script). Modelo e esforço são validados por expressão regular antes de virar argumento.
- **Isolamento das chamadas.** Pasta de trabalho vazia e temporária por execução (apagada no fim). Claude: `--tools ""`, `--strict-mcp-config`, `--safe-mode`, `--setting-sources ""`, `--disable-slash-commands`, `--no-session-persistence`. Codex: `--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, ferramentas de shell, apps, plugins, navegador, imagens e multiagente desligadas, busca na web desligada.
- **Limites.** Tempo máximo por chamada, saída máxima de 4 MB, uma execução por vez, 20 por hora, no máximo uma correção por execução.
- **Executor fechado para a internet.** Escuta só em `127.0.0.1`; exige `Authorization: Bearer <token>` (comparação em tempo constante); recusa qualquer requisição com `Origin` ou `Sec-Fetch-*` (marcas de navegador), então páginas da internet não conseguem chamá-lo, e ele nunca envia cabeçalhos CORS; recusa `Host` diferente de `127.0.0.1:<porta>`/`localhost:<porta>` (proteção contra DNS rebinding); aceita só JSON até 1 MB.
- **Rotas web.** Só respondem no servidor de desenvolvimento acessado por `localhost`, com origem local e o cabeçalho `x-ayla-client: web`. Um build de produção sempre recusa a execução.

## O que fica registrado

Arquivo `.ayla/runs.sqlite` (ignorado pelo Git), mantido pelo executor:

- execução: ID, demanda, colaborador, estado, conexão usada, modelo e esforço pedidos, datas (criação, início, fim), prazo de processamento, tentativa, hash e instantâneo congelado da ficha e da demanda, entrada exata enviada (instruções e mensagem), contexto consultado, resultado validado, erro com passos de recuperação, uso informado pelo cliente e resposta bruta;
- eventos com data e hora;
- resultado das chamadas reais por conexão (para detectar sessão expirada).

Execuções sobrevivem ao recarregar a página e ao reiniciar o executor. Uma execução que estava em planejamento quando o executor foi encerrado é marcada como **interrompida** no próximo início; as que estavam na fila continuam.

Cliques repetidos não duplicam: a interface bloqueia o segundo clique, cada pedido leva uma chave de idempotência e o banco só permite uma execução ativa por demanda.

## Estados da conexão

| Estado | Quando |
|---|---|
| Não instalado | executável não encontrado no PATH nem em `AYLA_CLAUDE_PATH`/`AYLA_CODEX_PATH` |
| Desconectado | cliente sem login, ou autenticado por chave de API/outro provedor em vez da assinatura |
| Conectado | o cliente informa login pela assinatura (Claude: `authMethod` claude.ai; Codex: “Logged in using ChatGPT”) |
| Sessão expirada | o cliente ainda lista um login, mas a última chamada real foi recusada por autenticação |
| Indisponível | o cliente não respondeu ao status ou respondeu algo inesperado |

“Verificar conexão” repete os comandos de status. “Testar sessão” faz uma chamada real mínima (usa um pouco da assinatura) e só roda quando você clica.

## Uso e limites

- O **orçamento de tokens da ficha** é um limite do Setor IA. Antes da chamada, o executor estima o texto que vai enviar (caracteres ÷ 3,5) e não chama se passar do orçamento. Depois compara com o uso **informado pelo cliente**. O cliente não pode ser interrompido no meio da resposta; se passar, a execução fica marcada como “excedeu”.
- Os **limites da assinatura** (janelas de uso do Claude, limites do ChatGPT Business compartilhados com o ChatGPT Work) são controlados por Anthropic e OpenAI. Os clientes não informam o saldo restante ao Setor IA, que por isso não mostra saldo nem promete teto. Quando o limite é atingido, o cliente avisa e a execução mostra o erro “limite de uso da assinatura”.
- Uso exibido: Claude Code informa entrada, cache e saída por modelo (`modelUsage`); Codex informa entrada, cache, saída e raciocínio (`turn.completed.usage`), mas não o nome do modelo usado. O `total_cost_usd` do Claude Code é uma estimativa de preço de API e **não** é mostrado como cobrança.

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

- `pnpm test`: pipeline do Diretor, validação do plano, composição da entrada, GitHub, registro durável (inclusive reabrindo o arquivo), cliques repetidos, cancelamento, limites, estados de conexão, adaptadores com saídas reais gravadas dos clientes, detecção, execução de processos (real, com `node`) e proteção HTTP (servidor real em 127.0.0.1). Nesses testes, os clientes oficiais são **simulados**.
- A execução real com cada cliente é feita pela interface ou pela API local, com o executor em execução; os resultados ficam no registro com o cliente e o uso informados.
