# Assets e licenças

Tudo o que o escritório usa em tempo de execução é servido pelo próprio build. Nenhum recurso é carregado de CDN.

## Modelos 3D, texturas e animações

Não há arquivos de modelo (glTF/FBX/OBJ) nem imagens de textura no projeto. Todo o conteúdo é **procedural**, escrito para este projeto:

| O quê | Onde | Como é feito |
|---|---|---|
| Arquitetura (piso, paredes, salas, vidro, telas de parede) | `components/office/scene/world.ts` | Primitivas do three.js mescladas por material (`batch.ts`) |
| Mobiliário (mesas, cadeiras, monitores, estantes, sofás, bancada de testes, arcade, plantas) | `components/office/scene/world.ts` | Primitivas com cor por vértice, mescladas em poucas malhas |
| Personagens (corpo articulado, cabelos, roupas, acessórios) | `components/office/scene/character.ts` | `RoundedBoxGeometry`, cones e icosaedros; rig com quadril, joelhos, ombros e cabeça |
| Animações (respirar, digitar, olhar, acenar, caminhar até a reunião, surgir ao ser contratado) | `components/office/scene/character.ts` | Poses calculadas no código, sem clipes externos |
| Texturas (carpete, madeira, concreto, horizonte noturno, telas dos monitores, painéis de parede) | `components/office/scene/textures.ts` | Geradas em `<canvas>` no navegador |
| Retratos 2D dos funcionários | `components/office/avatar.tsx` | SVG gerado a partir da mesma aparência do personagem 3D |

A imagem `reference/escritorio-referencia.png` serviu só como referência de direção de arte (composição, escala e clima). Nada dela foi copiado nem é distribuído no app.

## Fontes (empacotadas localmente via npm)

| Fonte | Uso | Pacote | Licença |
|---|---|---|---|
| Oxanium | Títulos, etiquetas da cena, painéis | `@fontsource-variable/oxanium` 5.3.0 | SIL Open Font License 1.1, © The Oxanium Project Authors (github.com/sevmeyer/oxanium) |
| Figtree | Texto de interface e formulários | `@fontsource-variable/figtree` 5.3.0 | SIL Open Font License 1.1, © The Figtree Project Authors (github.com/erikdkennedy/figtree) |
| JetBrains Mono | Rótulos técnicos, códigos, payload | `@fontsource-variable/jetbrains-mono` 5.3.0 | SIL Open Font License 1.1, © The JetBrains Mono Project Authors (github.com/JetBrains/JetBrainsMono) |

Os arquivos `.woff2` são copiados para o build pelo Vite. O texto completo de cada licença está em `node_modules/@fontsource-variable/<fonte>/LICENSE`.

## Bibliotecas usadas na cena

| Biblioteca | Licença | Observação |
|---|---|---|
| three.js 0.186 | MIT | Inclui os addons `OrbitControls`, `RoomEnvironment`, `RoundedBoxGeometry` e `BufferGeometryUtils` |
| lucide-react | ISC | Ícones da interface (já existia no projeto) |
| radix-ui / shadcn (vendor) | MIT | Diálogos, ficha lateral, abas e interruptores (já existiam no projeto) |

## Ao adicionar assets externos no futuro

1. Use apenas material com licença compatível (CC0, CC-BY com atribuição, MIT/OFL).
2. Guarde o arquivo no repositório (por exemplo `public/models/`) e não o carregue de CDN.
3. Acrescente uma linha a este arquivo com fonte, autor, licença e data.
