# Prompt para o Claude — Refinamento do Setor IA 3D

Você é um engenheiro frontend sênior com experiência em Three.js, direção de arte para jogos isométricos e interfaces de produtos de IA. Receberá o código fonte de um projeto Next.js/Vinext com uma cena 3D construída em Three.js e uma imagem de referência em `reference/escritorio-referencia.png`. Execute a melhoria no próprio código, não entregue apenas uma proposta ou mockup.

## Objetivo

Transforme o Setor IA em uma experiência que pareça um pequeno jogo de gerenciamento de um estúdio de desenvolvimento. A cena do escritório deve ser o produto principal da primeira tela: arquitetura 3D com salas claramente distinguíveis, estações de trabalho, sala de reunião, iluminação, materiais, personagens expressivos e feedback de interação. Use a referência para entender composição, escala e espírito visual. Não copie textos ou elementos ilegíveis da imagem. O visual atual usa geometria simples e serve como base funcional; ele ainda não tem a qualidade artística desejada.

## Fluxo obrigatório

1. O usuário vê o escritório 3D imediatamente, navega pela câmera (orbitar, aproximar e deslocar), identifica os funcionários e clica diretamente em um personagem ou em sua estação.
2. Ao selecionar um funcionário, abre uma ficha com nome, função, descrição, provedor/modelo planejado, instruções, limites, formato de entrega, ferramentas, orçamento estimado de tokens e regras de encaminhamento. Salvar deve manter as alterações após recarregar a página.
3. O usuário pode contratar um novo funcionário, personalizá-lo e vê-lo aparecer numa estação disponível no escritório. O limite atual de 14 pode ser redesenhado se o espaço justificar.
4. O usuário pode clicar no Diretor (ou em outro funcionário), abrir “Enviar demanda”, descrever objetivo e critérios de aceite, associar URL de repositório GitHub ou selecionar uma pasta local e ver o item criado na fila.
5. Mantenha claro que esta fase é somente frontend: não há motor de IA, clone de repositório, upload real da pasta nem delegação automática. A seleção de pasta só registra nome e contagem de arquivos atualmente. Não simule uma execução bem-sucedida.

## Direção de arte

- Cena isométrica/semiaisométrica com profundidade real, estilo jogo premium de estratégia ou simulação de escritório. Personagens reconhecíveis e diferenciados, não apenas esferas ou cilindros com iniciais.
- Materialidade coerente: piso, paredes, divisórias de vidro, mobiliário, monitores, luminárias, plantas e objetos de trabalho. Áreas visualmente separadas para Diretor, desenvolvimento, QA e reunião. Hierarquia clara sem poluição visual.
- Animações discretas e úteis: idle dos funcionários, monitores, hover e seleção; se fizer sentido, movimentação curta entre pontos de trabalho/reunião. Feedback visual imediato ao clicar.
- UI sobreposta com tipografia legível, painéis de configuração e formulários profissionais. Preserve a atmosfera de jogo; evite transformar a cena em um dashboard convencional. Remova rótulos sobrepostos e cartões que encubram personagens.
- Se usar modelos 3D, texturas ou animações externas, utilize apenas recursos licenciados para uso no projeto e documente fonte/licença em `ASSETS.md`. Prefira assets locais no repositório; não dependa de CDN em tempo de execução. É permitido substituir a construção procedural atual por React Three Fiber ou outra arquitetura se isso melhorar manutenção e qualidade.

## Requisitos técnicos

- Leia primeiro `app/page.tsx`, `components/office-scene.tsx`, `app/globals.css`, `package.json` e a imagem de referência. Preserve os dados e os fluxos já implementados, ou migre o armazenamento local sem apagar as configurações dos usuários.
- Estruture a cena, personagens e interações em componentes/managers menores. Separar geometria, iluminação, picking, animação e UI facilita aprimorar personagem por personagem depois.
- Otimize para desktop comum e para um MacBook Pro 2016 com 16 GB: limites de DPR, sombras e polígonos razoáveis, assets compactos, descarte correto de recursos, ajuste responsivo. Tenha fallback legível quando WebGL não estiver disponível.
- Respeite teclado, foco, contraste e redução de movimento. A lista de funcionários deve oferecer uma forma alternativa de seleção fora do canvas.
- Evite segredos no frontend. Não peça API keys no navegador nem implemente uma falsa conexão com GitHub/Claude/OpenAI. Prepare pontos de integração e tipos de dados para a etapa posterior.
- Priorize uma cena convincente e utilizável a efeitos chamativos. Não refaça o projeto inteiro se puder preservar as partes funcionais.

## Critérios de aceite e entrega

- O escritório 3D carrega sem erros em navegador com WebGL; a versão sem WebGL continua interativa.
- Seleção de personagem na cena e pela lista abre a mesma ficha correta; criação de funcionário adiciona-o ao mundo; configurar e recarregar mantém dados; demanda com GitHub/pasta aparece na fila.
- Verifique visualmente nas larguras 390, 834, 1366 e 1920 px. Teste interações reais e corrija sobreposição de painéis e etiquetas.
- Rode TypeScript e build. Descreva em português o que mudou, quais arquivos/assets foram adicionados, o que foi testado e o que continua pendente para o backend.
- Mostre capturas do escritório e da ficha de personagem para avaliação. Se a cena estiver distante da referência, continue refinando antes de concluir.
