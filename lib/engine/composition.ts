// Size of what the Setor IA assembled for a run, by section, measured in
// characters from the frozen prompt. This is the only part we can measure
// ourselves: the official client adds its own context (tool definitions for
// the structured output, its own instructions, extra model turns), and it
// reports tokens only in total per category, so tokens are never attributed
// to a section here.
export type CompositionPart = { label: string; chars: number; detail?: string };

const TAGS: Record<string, string> = {
  demanda: "Demanda", tarefa: "Tarefa", plano_do_diretor_resumo: "Resumo do plano do Diretor", revisao_do_contexto: "Revisão do contexto",
  analise_anterior_resumo: "Resumo da análise anterior", esclarecimentos: "Esclarecimentos", decisoes_do_solicitante: "Decisões do solicitante",
  escopo: "Escopo", fonte: "Descrição da fonte", dados_da_fonte: "Conteúdo do repositório", respostas_do_solicitante: "Respostas do solicitante",
  equipe: "Equipe",
};

export function promptComposition(prompt: { system: string; user: string } | null, schemaChars = 0): { parts: CompositionPart[]; total: number } {
  if (!prompt) return { parts: [], total: 0 };
  const parts: CompositionPart[] = [];
  const sys = prompt.system;
  const cut = sys.indexOf("\n\n=== FICHA");
  if (cut > 0) {
    parts.push({ label: "Protocolo da execução (instruções)", chars: cut });
    parts.push({ label: "Ficha salva do colaborador (instruções)", chars: sys.length - cut });
  } else parts.push({ label: "Instruções", chars: sys.length });

  const re = /<([a-z_]+)>\n([\s\S]*?)\n<\/\1>/g;
  let covered = 0;
  for (const m of prompt.user.matchAll(re)) {
    const tag = m[1];
    if (tag !== "dados_da_fonte") { covered += m[0].length; parts.push({ label: TAGS[tag] ?? tag, chars: m[0].length }); continue; }
    const body = m[2];
    const sections = body.split(/\n\n(?=--- arquivo: )/);
    const head = sections.shift() ?? "";
    parts.push({ label: "Lista de arquivos e descrição (só nomes)", chars: head.length });
    // Only the pieces are counted here; the block markers and separators fall into the last line.
    covered += head.length + sections.reduce((n, x) => n + x.length, 0);
    for (const sec of sections) {
      const name = /^--- arquivo: (.+?)(?: \(|\s---)/.exec(sec)?.[1] ?? "?";
      const kind = /\(trecho verificável/.test(sec.split("\n")[0]) ? "trecho" : /\(truncado/.test(sec.split("\n")[0]) ? "truncado" : "inteiro";
      parts.push({ label: `Arquivo: ${name}`, chars: sec.length, detail: kind });
    }
  }
  const rest = prompt.user.length - covered;
  if (rest > 0) parts.push({ label: "Marcadores, separadores e instrução final", chars: rest });
  if (schemaChars) parts.push({ label: "Esquema JSON da resposta (enviado como formato de saída)", chars: schemaChars });
  return { parts, total: parts.reduce((a, p) => a + p.chars, 0) };
}
