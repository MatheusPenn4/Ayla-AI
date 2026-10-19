// Single source of truth for how the current product phase is described across the interface (side rail,
// top status pill, engine banner). Update this file — not the individual screens — when the phase changes,
// so the label and the description never say different things in different places.
export const PHASE_LABEL = "Piloto local";

export const PHASE_SUMMARY =
  "Diretor e Arquiteto já executam de verdade neste computador; o Desenvolvedor já produziu código em uma cópia isolada. " +
  "O QA verifica pedindo operações ao executor (leitura, comandos e navegador numa cópia isolada da versão testada, sem editar o código); o Revisor forma o parecer final sem ferramentas. " +
  "No piloto automático, uma política que você aprova uma vez envia sozinha as tarefas do Arquiteto, do QA e do Revisor; o Desenvolvedor continua com você. " +
  "Conexões e execução funcionam só aqui; o uso hospedado depende de uma integração futura ainda não feita.";
