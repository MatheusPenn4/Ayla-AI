// Single source of truth for how the current product phase is described across the interface (side rail,
// top status pill, engine banner). Update this file — not the individual screens — when the phase changes,
// so the label and the description never say different things in different places.
export const PHASE_LABEL = "Piloto local";

export const PHASE_SUMMARY =
  "Diretor e Arquiteto já executam de verdade neste computador; o Desenvolvedor já produziu código em uma cópia isolada. " +
  "Os fluxos de QA e de Revisor existem, mas ainda aguardam validação em uma execução real. " +
  "Conexões e execução funcionam só aqui; o uso hospedado depende de uma integração futura ainda não feita.";
