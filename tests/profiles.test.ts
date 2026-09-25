import { describe, expect, it } from "vitest";
import { normalizeData, serializeOffice } from "@/lib/office/storage";
import { DEFAULT_PROFILES, LEGACY_V1_PROFILES, PRESET_VERSION } from "@/lib/office/presets";
import { applyPreset, comparePreset, dismissPreset, filterTargets, presetUpdate, profileForHire } from "@/lib/office/profile";
import { agentBrief, buildDemandPayload } from "@/lib/integration/contracts";
import type { Agent, Demand } from "@/lib/office/types";

const IDS = ["director", "architect", "developer", "qa", "reviewer"] as const;
const byId = (agents: Agent[], id: string) => agents.find(a => a.id === id)!;

/** Data exactly as the first release saved it (localStorage key setor-ia-game-v1). */
function legacyV1() {
  return {
    agents: [
      { id: "director", name: "Diretora Ana", role: "Orquestração", color: "#669adf", description: LEGACY_V1_PROFILES.director.description, model: "Claude", instructions: "Sempre responda em tópicos.", limits: "Nunca publicar sexta-feira.", deliverable: LEGACY_V1_PROFILES.director.deliverable, handoff: "Arquiteto e QA", budget: 20000, tools: { read: true, edit: false, terminal: false, github: true, browser: false }, custom: false },
      { id: "qa", name: "QA", role: "Qualidade", color: "#e6a07f", description: LEGACY_V1_PROFILES.qa.description, model: "A definir", instructions: LEGACY_V1_PROFILES.qa.instructions, limits: LEGACY_V1_PROFILES.qa.limits, deliverable: LEGACY_V1_PROFILES.qa.deliverable, handoff: "Revisor", budget: 10000, tools: { read: true, edit: false, terminal: true, github: false, browser: true }, custom: false },
      { id: "abc123", name: "Dados", role: "Analista", color: "#ff00aa", description: "Criado na v1", model: "A definir", instructions: "SQL primeiro.", limits: "", deliverable: "", handoff: "Diretor", budget: 9000, tools: { read: true }, custom: true },
    ],
    demands: [{ id: "d1", title: "Demanda antiga", description: "x", project: "P", recipient: "director", source: "github", sourceLabel: "https://github.com/acme/site", fileCount: 0, createdAt: "2026-01-02T10:00:00.000Z" }],
  };
}

describe("instalação nova", () => {
  const { agents } = normalizeData(null);

  it("vem com as cinco fichas completas na versão atual", () => {
    expect(agents.map(a => a.id)).toEqual([...IDS]);
    for (const a of agents) {
      expect(a.preset).toEqual({ id: a.id, version: PRESET_VERSION });
      expect(presetUpdate(a)).toBeNull();
      for (const v of Object.values(a.playbook)) expect(v.trim().length).toBeGreaterThan(20);
      expect(a.limits && a.deliverable && a.handoff).toBeTruthy();
    }
  });

  it("tem fichas diferentes entre si", () => {
    const missions = new Set(agents.map(a => a.playbook.mission));
    const methods = new Set(agents.map(a => a.playbook.method));
    expect(missions.size).toBe(5);
    expect(methods.size).toBe(5);
  });

  it("encaminha apenas para colaboradores existentes e sem ciclos sem limite", () => {
    const ids = new Set(agents.map(a => a.id));
    for (const a of agents) {
      for (const t of a.handoffTo) expect(ids.has(t)).toBe(true);
      for (const t of a.returnTo) expect(ids.has(t) || t === "user").toBe(true);
      expect(a.maxCycles).toBeGreaterThanOrEqual(1);
    }
    expect(byId(agents, "qa").returnTo).toEqual(["developer"]);
    expect(byId(agents, "director").returnTo).toEqual(["user"]);
  });

  it("não fixa modelo específico nem conecta ferramentas", () => {
    for (const a of agents) { expect(a.model).toBe("A definir"); expect(a.modelName).toBe(""); expect(a.connection).toBe("none"); expect(a.effort).toBe(""); }
  });
});

describe("conexão de execução nas fichas salvas", () => {
  it("fichas v1 ganham a conexão do provedor escolhido, sem perder as personalizações", () => {
    const { agents } = normalizeData(legacyV1());
    const ana = byId(agents, "director");
    expect(ana).toMatchObject({ connection: "claude_code", model: "Claude", name: "Diretora Ana", instructions: "Sempre responda em tópicos.", limits: "Nunca publicar sexta-feira.", budget: 20000 });
    expect(byId(agents, "qa").connection).toBe("none");
    expect(byId(agents, "abc123")).toMatchObject({ connection: "none", instructions: "SQL primeiro." });
  });
  it("a conexão escolhida, o modelo e o esforço sobrevivem a salvar e recarregar", () => {
    const { agents, demands } = normalizeData(null);
    const edited = agents.map(a => (a.id === "director" ? { ...a, connection: "codex" as const, modelName: "gpt-5.5", effort: "high" } : a));
    const again = normalizeData(JSON.parse(JSON.stringify(serializeOffice({ agents: edited, demands }))));
    expect(byId(again.agents, "director")).toMatchObject({ connection: "codex", modelName: "gpt-5.5", effort: "high" });
  });
  it("valores inválidos gravados à mão não viram conexão nem esforço", () => {
    const raw = JSON.parse(JSON.stringify(serializeOffice({ agents: normalizeData(null).agents, demands: [] })));
    raw.agents[0].connection = "chatgpt-web";
    raw.agents[0].effort = "--bare";
    const a = normalizeData(raw).agents[0];
    expect(a.connection).toBe("none");
    expect(a.effort).toBe("");
  });
});

describe("migração de dados antigos", () => {
  const { agents, demands } = normalizeData(legacyV1());
  const director = byId(agents, "director");

  it("preserva nome, textos personalizados, ferramentas, estação e demandas", () => {
    expect(director.name).toBe("Diretora Ana");
    expect(director.model).toBe("Claude");
    expect(director.instructions).toBe("Sempre responda em tópicos.");
    expect(director.limits).toBe("Nunca publicar sexta-feira.");
    expect(director.budget).toBe(20000);
    expect(director.stationId).toBe("dir-main");
    expect(demands).toHaveLength(1);
    expect(demands[0].repo?.owner).toBe("acme");
    const custom = byId(agents, "abc123");
    expect(custom.instructions).toBe("SQL primeiro.");
    expect(custom.preset.id).toBeNull();
  });

  it("não aplica os novos padrões sozinho: campos novos ficam vazios e a atualização é oferecida", () => {
    expect(Object.values(director.playbook).every(v => v === "")).toBe(true);
    expect(director.returnTo).toEqual([]);
    expect(director.maxCycles).toBeNull();
    expect(director.preset).toEqual({ id: "director", version: 1 });
    expect(presetUpdate(director)).toMatchObject({ from: 1, to: PRESET_VERSION, dismissed: false });
    expect(presetUpdate(byId(agents, "abc123"))).toBeNull();
  });

  it("converte encaminhamento em texto para ids existentes", () => {
    expect(director.handoffTo).toEqual(["architect", "qa"]);
  });

  it("salvar e recarregar não perde nada (idempotente)", () => {
    const again = normalizeData(JSON.parse(JSON.stringify(serializeOffice({ agents, demands }))));
    expect(again.agents).toEqual(agents);
    expect(again.demands).toEqual(demands);
  });

  it("remove encaminhamentos para colaboradores inexistentes", () => {
    const data = serializeOffice({ agents, demands });
    (data.agents[0] as Agent).handoffTo = ["qa", "fantasma"];
    (data.agents[0] as Agent).returnTo = ["user", "fantasma", "director"];
    const out = byId(normalizeData(JSON.parse(JSON.stringify(data))).agents, "director");
    expect(out.handoffTo).toEqual(["qa"]);
    expect(out.returnTo).toEqual(["user"]);
  });
});

describe("atualização campo a campo", () => {
  const { agents } = normalizeData(legacyV1());
  const ids = agents.map(a => a.id);
  const director = byId(agents, "director");
  const diffs = comparePreset(director, ids);
  const d = (k: string) => diffs.find(x => x.key === k)!;

  it("sugere só campos vazios ou nunca editados; personalizados ficam desmarcados", () => {
    expect(d("playbook.mission").suggested).toBe(true);
    expect(d("description").suggested).toBe(true); // igual ao texto da v1
    expect(d("deliverable").suggested).toBe(true); // igual ao texto da v1
    expect(d("instructions").customized).toBe(true);
    expect(d("instructions").suggested).toBe(false);
    expect(d("limits").customized).toBe(true);
    expect(d("limits").suggested).toBe(false);
    expect(d("handoffTo").customized).toBe(true); // "Arquiteto e QA" ≠ padrão v1
  });

  it("aplicar os sugeridos preserva personalizações e identidade", () => {
    const keys = diffs.filter(x => x.suggested).map(x => x.key);
    const out = applyPreset(director, keys, ids);
    expect(out.playbook).toEqual(DEFAULT_PROFILES.director.playbook);
    expect(out.instructions).toBe("Sempre responda em tópicos.");
    expect(out.limits).toBe("Nunca publicar sexta-feira.");
    expect(out.handoffTo).toEqual(["architect", "qa"]);
    expect(out.returnTo).toEqual(["user"]);
    expect(out.maxCycles).toBe(3);
    for (const k of ["id", "name", "role", "color", "look", "zone", "stationId", "model", "modelName", "custom"] as const) expect(out[k]).toEqual(director[k]);
    expect(out.preset).toEqual({ id: "director", version: PRESET_VERSION });
    expect(presetUpdate(out)).toBeNull();
  });

  it("comparar (e cancelar) não altera a ficha", () => {
    expect(comparePreset(director, ids)).toEqual(diffs); // comparação não altera o objeto
    expect(director.preset.version).toBe(1);
  });

  it("manter a ficha atual para de sugerir a versão, sem alterar textos", () => {
    const kept = dismissPreset(director);
    expect(presetUpdate(kept)?.dismissed).toBe(true);
    expect({ ...kept, preset: director.preset }).toEqual(director);
  });

  it("restaurar um campo personalizado só acontece se o usuário escolher", () => {
    const out = applyPreset(director, ["limits"], ids);
    expect(out.limits).toBe(DEFAULT_PROFILES.director.limits);
    expect(out.instructions).toBe("Sempre responda em tópicos.");
  });
});

describe("contratação", () => {
  it("modelo rápido copia a ficha inicial e filtra encaminhamentos para quem existe", () => {
    const p = profileForHire("e2e", ["director", "developer"]);
    expect(p.playbook.method).toContain("seletores estáveis");
    expect(p.handoffTo).toEqual([]); // o Revisor não existe nesta equipe
    expect(p.returnTo).toEqual(["developer", "director"]);
    expect(p.preset).toEqual({ id: "e2e", version: PRESET_VERSION });
  });
  it("sem modelo começa com ficha em branco e válida", () => {
    const p = profileForHire(null, ["director"]);
    expect(Object.values(p.playbook).every(v => v === "")).toBe(true);
    expect(p.handoffTo).toEqual(["director"]);
    expect(p.tools.read).toBe(true);
  });
  it("filterTargets remove o próprio colaborador e duplicatas", () => {
    expect(filterTargets(["qa", "qa", "self", "user", "x"], ["qa", "self"], "self")).toEqual(["qa", "user"]);
  });
});

describe("payload para o futuro motor", () => {
  const { agents } = normalizeData(null);
  const demand: Demand = {
    id: "m1", title: "Corrigir PDF", description: "Logo sumiu", acceptanceCriteria: ["Logo aparece"], project: "P", priority: "alta", recipient: "director",
    source: "github", sourceLabel: "https://github.com/o/r", fileCount: 0, repo: { url: "https://github.com/o/r", owner: "o", repo: "r", branch: "dev" }, status: "prepared", createdAt: "2026-09-25T00:00:00.000Z",
  };
  const payload = buildDemandPayload(demand, agents);

  it("inclui todos os campos operacionais configurados", () => {
    const a = payload.assignee;
    expect(a.playbook).toEqual(byId(agents, "director").playbook);
    expect(a.routing).toEqual({ handoffTo: byId(agents, "director").handoffTo, returnTo: ["user"], maxCycles: 3, rules: byId(agents, "director").handoff });
    expect(a.limits).toBe(byId(agents, "director").limits);
    expect(a.deliverable).toBe(byId(agents, "director").deliverable);
    expect(a.toolsPlanned).toEqual(["read", "github"]);
    expect(a.toolsConnected).toEqual([]);
    expect(a.budget).toEqual({ tokensPerTask: 16000, enforced: false });
    expect(payload.team).toHaveLength(5);
    expect(payload.status).toBe("prepared");
    expect(payload.engine).toBe("not_connected");
    expect(payload.source).toMatchObject({ kind: "github", branch: "dev" });
  });

  it("o brief é derivado só da ficha e traz as regras de encaminhamento", () => {
    const dir = byId(agents, "director");
    expect(payload.assignee.brief).toBe(agentBrief(dir, agents));
    expect(payload.assignee.brief).toContain(dir.playbook.mission);
    expect(payload.assignee.brief).toContain("Nunca dispense o QA");
    expect(payload.assignee.brief).toContain("Encaminha para: Arquiteto, Desenvolvedor, QA, Revisor.");
    expect(payload.assignee.brief).toContain("Devolve pendências para: Solicitante (usuário).");
    expect(payload.assignee.brief).not.toContain("Instruções complementares");
  });

  it("o brief de uma ficha migrada mostra as instruções antigas e omite seções vazias", () => {
    const old = normalizeData(legacyV1()).agents;
    const brief = agentBrief(byId(old, "director"), old);
    expect(brief).toContain("## Instruções complementares\nSempre responda em tópicos.");
    expect(brief).not.toContain("## Missão");
  });
});
