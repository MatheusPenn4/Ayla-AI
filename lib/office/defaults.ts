import type { Accessory, Agent, Appearance, HairStyle, Outfit, ToolKey, WorkZoneId } from "./types";

export const baseTools: Record<ToolKey, boolean> = { read: true, edit: false, terminal: false, github: false, browser: false };

export const TOOL_INFO: { key: ToolKey; label: string; description: string }[] = [
  { key: "read", label: "Ler arquivos", description: "Inspecionar código e documentação" },
  { key: "edit", label: "Editar arquivos", description: "Propor alterações no projeto" },
  { key: "terminal", label: "Terminal", description: "Executar comandos e testes" },
  { key: "github", label: "GitHub", description: "Acessar repositórios conectados" },
  { key: "browser", label: "Navegador", description: "Verificar páginas e interfaces" },
];

export const PROVIDERS = ["A definir", "OpenAI", "Claude", "Outro provedor"] as const;

export const SKIN_TONES = ["#f6d3b8", "#eab58f", "#d49a6a", "#b87a4b", "#8d5a36", "#5f3b24"];
export const HAIR_COLORS = ["#1f1a1c", "#3b2a22", "#6a4630", "#a3663a", "#d9a45b", "#c9ccd3", "#7d5bd6", "#e2687c"];
export const PANTS_COLORS = ["#2b3246", "#3a3f4f", "#26394a", "#4b3a33", "#33403a"];

export const HAIR_OPTIONS: { value: HairStyle; label: string }[] = [
  { value: "short", label: "Curto" }, { value: "slick", label: "Penteado" }, { value: "spiky", label: "Espetado" },
  { value: "curly", label: "Cacheado" }, { value: "bun", label: "Coque" }, { value: "long", label: "Longo" },
  { value: "ponytail", label: "Rabo de cavalo" }, { value: "mohawk", label: "Moicano" }, { value: "bald", label: "Careca" },
];
export const OUTFIT_OPTIONS: { value: Outfit; label: string }[] = [
  { value: "blazer", label: "Blazer" }, { value: "hoodie", label: "Moletom" }, { value: "sweater", label: "Gola alta" },
  { value: "vest", label: "Colete" }, { value: "tee", label: "Camiseta" }, { value: "labcoat", label: "Jaleco" },
];
export const ACCESSORY_OPTIONS: { value: Accessory; label: string }[] = [
  { value: "none", label: "Nenhum" }, { value: "glasses", label: "Óculos" }, { value: "headphones", label: "Fones" },
  { value: "headset", label: "Headset" }, { value: "cap", label: "Boné" }, { value: "beanie", label: "Gorro" }, { value: "beard", label: "Barba" },
];

export const ZONE_LABEL: Record<WorkZoneId, string> = { director: "Diretoria", dev: "Desenvolvimento", qa: "QA & Revisão" };

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic look for workers created before appearances existed. */
export function lookFromSeed(seed: string): Appearance {
  const h = hash(seed);
  const pick = <T,>(list: readonly T[], shift: number) => list[(h >>> shift) % list.length];
  return {
    skin: pick(SKIN_TONES, 0),
    hair: pick(HAIR_OPTIONS, 3).value,
    hairColor: pick(HAIR_COLORS, 7),
    outfit: pick(["hoodie", "tee", "sweater", "vest"] as const, 11),
    accessory: pick(["none", "glasses", "headphones", "cap", "beanie", "none"] as const, 15),
    pants: pick(PANTS_COLORS, 19),
  };
}

type Seed = Omit<Agent, "handoffTo" | "modelName" | "custom"> & { handoffTo?: string[] };

const seeds: Seed[] = [
  {
    id: "director", name: "Diretor", role: "Orquestração", color: "#669adf", zone: "director", stationId: "dir-main",
    description: "Recebe a missão, define o plano e distribui o trabalho entre especialistas.", model: "A definir",
    instructions: "Compreenda o objetivo, inspecione o contexto disponível, divida tarefas independentes quando isso trouxer ganho e consolide a entrega.",
    limits: "Não modificar produção nem publicar sem autorização. Não delegar tarefas pequenas sem necessidade.",
    deliverable: "Plano curto, responsáveis, resultado consolidado, evidências e riscos.", handoff: "Arquiteto, Desenvolvedor, QA e Revisor",
    handoffTo: ["architect", "developer", "qa", "reviewer"], budget: 20000, tools: { ...baseTools, github: true },
    look: { skin: "#eab58f", hair: "slick", hairColor: "#c9ccd3", outfit: "blazer", accessory: "beard", pants: "#2b3246" },
  },
  {
    id: "architect", name: "Arquiteto", role: "Arquitetura", color: "#ad95d9", zone: "dev", stationId: "dev2-a",
    description: "Analisa dependências, impacto técnico e decisões de estrutura.", model: "A definir",
    instructions: "Mapeie o código relevante, contratos e impactos da mudança. Recomende a menor solução coerente.",
    limits: "Não alterar código fora do escopo aprovado.", deliverable: "Proposta técnica, arquivos afetados, dependências e riscos.",
    handoff: "Desenvolvedor", handoffTo: ["developer"], budget: 12000, tools: { ...baseTools },
    look: { skin: "#8d5a36", hair: "curly", hairColor: "#1f1a1c", outfit: "sweater", accessory: "glasses", pants: "#3a3f4f" },
  },
  {
    id: "developer", name: "Desenvolvedor", role: "Implementação", color: "#56c9bd", zone: "dev", stationId: "dev2-b",
    description: "Implementa alterações de código com escopo e critérios claros.", model: "A definir",
    instructions: "Leia o contexto da tarefa, implemente a mudança com cuidado, preserve padrões do projeto e relate os arquivos modificados.",
    limits: "Não realizar deploy nem alterar segredos ou configuração de produção.", deliverable: "Código alterado, descrição da solução e validação.",
    handoff: "QA", handoffTo: ["qa"], budget: 24000, tools: { ...baseTools, edit: true, terminal: true },
    look: { skin: "#f6d3b8", hair: "spiky", hairColor: "#3b2a22", outfit: "hoodie", accessory: "headphones", pants: "#26394a" },
  },
  {
    id: "qa", name: "QA", role: "Qualidade", color: "#e6a07f", zone: "qa", stationId: "qa1-a",
    description: "Confere critérios de aceite e registra evidências reais.", model: "A definir",
    instructions: "Verifique os critérios de aceite e execute testes relevantes. Relate falhas reproduzíveis.",
    limits: "Não marcar como validado sem executar a checagem correspondente.", deliverable: "Checklist, resultados, falhas e evidências.",
    handoff: "Revisor", handoffTo: ["reviewer"], budget: 10000, tools: { ...baseTools, terminal: true, browser: true },
    look: { skin: "#d49a6a", hair: "bun", hairColor: "#a3663a", outfit: "vest", accessory: "headset", pants: "#33403a" },
  },
  {
    id: "reviewer", name: "Revisor", role: "Revisão final", color: "#d0b26f", zone: "qa", stationId: "qa1-b",
    description: "Revisa a entrega consolidada antes de chegar a você.", model: "A definir",
    instructions: "Revise o resultado em relação ao pedido original, identifique regressões e resuma o que foi verificado.",
    limits: "Não aprovar trabalho com pendências críticas sem destacá-las.", deliverable: "Parecer final, pendências e recomendações.",
    handoff: "Diretor", handoffTo: ["director"], budget: 8000, tools: { ...baseTools },
    look: { skin: "#f6d3b8", hair: "long", hairColor: "#6a4630", outfit: "labcoat", accessory: "cap", pants: "#4b3a33" },
  },
];

export const DEFAULT_AGENTS: Agent[] = seeds.map(s => ({ ...s, modelName: "", handoffTo: s.handoffTo ?? [], custom: false }));
export const DEFAULT_IDS = new Set(DEFAULT_AGENTS.map(a => a.id));

export function newId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
