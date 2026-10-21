# Lume — tradutor de textos e artigos em PDF

Aplicativo web em português que traduz textos e artigos com **GPT-6 Luna pela API da OpenAI**. A opção de texto oferece entrada e tradução lado a lado, com seleção de idiomas e até 10.000 palavras. Para artigos, o programa analisa o PDF, preserva imagens e equações localmente e monta os arquivos Word e PDF traduzidos. Interface React/TypeScript, build Vite e backend em Netlify Functions.

## Escopo desta versão

- Opção **Traduzir texto** com duas caixas (original e tradução), listas de idiomas, detecção automática da origem, inversão de idiomas e cópia do resultado. A tradução começa **na primeira edição** e continua sendo atualizada durante a digitação, sem exigir uma pausa. Uma tradução é processada por vez; novos caracteres mantêm o trabalho em andamento e substituem apenas o texto pendente. A atualização seguinte usa o conteúdo mais recente e respeita uma cadência mínima de 2,1 segundos entre inícios, sem reiniciar essa contagem a cada tecla. O resultado continua visível enquanto os novos trechos são traduzidos. Substituições, exclusões e mudanças de idioma cancelam o trabalho incompatível; respostas antigas são descartadas. A composição de caracteres em teclados de idiomas como japonês e chinês precisa terminar antes do envio. Aceita somente texto digitado ou colado, sem arquivos, imagens ou anexos, com limite de **10.000 palavras** validado no navegador e no servidor. A contagem considera grupos separados por espaços ou quebras de linha. Conteúdo acima do limite pode ser editado, mas não enviado para tradução.
- Textos longos são divididos em trechos de até 2.500 caracteres, preservando separadores e priorizando parágrafos e frases. O resultado aparece progressivamente; interrupções podem ser retomadas na mesma sessão sem reenviar os trechos concluídos. Edições reaproveitam os trechos iniciais que não mudaram; mudanças de idioma invalidam o resultado anterior. Interromper pausa o texto atual; continuar escrevendo ou clicar em retomar reativa a tradução. Após uma falha, o programa aguarda uma edição ou tentativa explícita, sem repetir indefinidamente a mesma solicitação.
- Entrada exclusiva em **PDF, com até 4 MB (4.000.000 bytes) e 20 páginas**. O programa confere extensão, assinatura e quantidade de páginas antes da tradução. DOC, DOCX, JPG e PNG não são aceitos como entrada.
- Extração local do texto e da ordem de leitura com PDF.js, revisão por página, ajuste dos recortes e associação entre figuras e legendas.
- PDFs digitalizados recebem OCR local em inglês e português com Tesseract.js. O texto reconhecido e as regiões visuais exigem revisão, sobretudo em páginas com fórmulas, tabelas ou colunas. Os modelos, worker e WASM são servidos pelo próprio aplicativo, sem CDN.
- Tradução somente dos parágrafos, títulos e legendas. Imagens e equações são preservadas por recortes do original, sem envio ao modelo.
- Revisão obrigatória antes da tradução e conferência dos avisos após a tradução. Trechos traduzidos podem ser corrigidos localmente.
- Exportação de DOCX com texto editável e PDF com texto selecionável. Ambos são remontados em uma coluna e podem ter paginação diferente do original.
- Interrupção e retomada na mesma sessão, reutilizando os blocos já concluídos e validados.

## Executar

Requer Node.js 22.12+ e pnpm 11.19.0.

```sh
corepack enable
pnpm install --frozen-lockfile
```

Copie `.env.example` para `.env` e preencha `OPENAI_API_KEY` com uma chave da API da OpenAI que tenha acesso a `gpt-6-luna`. A chave é usada apenas nas funções do servidor. Não use o prefixo `VITE_` nem inclua credenciais no Git. `APP_ACCESS_CODE` permite restringir o endpoint por um código compartilhado, solicitado pela interface e mantido em memória.

```sh
pnpm dev
pnpm test
pnpm build
```

Os comandos de desenvolvimento e build preparam os recursos locais de OCR antes de iniciar o Vite. A primeira instalação precisa obter essas dependências; o processamento do PDF continua no navegador.

O plugin Vite da Netlify emula as funções em desenvolvimento. A porta padrão é 5173. Sem chave, a interface informa a configuração pendente. `pnpm preview` serve somente os arquivos estáticos e não emula a API.

## Publicar na Netlify

1. Importe ou vincule o repositório ao projeto Netlify.
2. Use `netlify.toml`: comando `pnpm build`, publicação `dist`, funções `netlify/functions` e Node 22.
3. Cadastre `OPENAI_API_KEY` como variável secreta com escopo **Functions** no contexto da publicação. Configure `APP_ACCESS_CODE` se o uso for restrito.
4. Publique novamente as funções após alterar variáveis e confira o endpoint `/api/config`, que informa o provedor/modelo e a disponibilidade da configuração, sem revelar a chave.
5. Faça um teste real com um PDF pequeno, não confidencial, e confira a tradução e os dois arquivos exportados. Esse teste consome a API da OpenAI.

O endereço do projeto existente é [lume-tradutor.netlify.app](https://lume-tradutor.netlify.app). Alterações locais não atualizam automaticamente esse site. O vínculo local da Netlify fica em `.netlify/state.json`, fora do Git. Para publicar pelo conector, inclua `src/`, `public/`, `netlify/`, `scripts/` e os arquivos de configuração da raiz, incluindo o lockfile e `pnpm-workspace.yaml`; exclua credenciais, caches, dependências, testes e resultados locais. O build prepara os recursos de OCR a partir das dependências instaladas.

A DeepL não participa do novo fluxo. As antigas variáveis `DEEPL_API_KEY` e rotas documentais de upload, status e download não são usadas. A autenticação compartilhada é um controle simples para uso privado; os custos e limites da API devem ser administrados também na conta OpenAI.

## Processamento e API

O navegador lê o PDF, cria blocos com IDs, extrai texto digital ou executa OCR quando necessário e renderiza as figuras e equações como PNG sem perdas a 400 dpi. O OCR reconhece prosa; a seleção e preservação de regiões matemáticas continuam sob responsabilidade do programa e da revisão. A revisão permite conferir o texto, a ordem de leitura e a abrangência dos recortes. Antes da tradução e da exportação, o programa verifica relações entre blocos e objetos e os hashes dos recortes.

A opção de texto usa `POST /api/translate-plain-text`, com `text` obrigatório como string, `target_lang` e `source_lang` opcional. A rota rejeita multipart, objetos, listas, campos extras, caracteres de controle binários e textos acima de 10.000 palavras antes de chamar o provedor. Uma proteção de transporte limita o JSON a 1 MB. O cliente envia trechos menores para respeitar o prazo de resposta. Marcações digitadas são escapadas e tratadas como conteúdo literal; a resposta também é exibida como texto simples.

A rota de tradução dos PDFs é `POST /api/translate-text`. Ela recebe lotes pequenos de XML restrito, com identificadores estáveis e marcadores protegidos, além dos idiomas e do contexto da seção. O cliente envia até quatro trechos por chamada e procura manter a soma do XML abaixo de 3.000 caracteres; um parágrafo maior segue isolado, respeitando o limite rígido de 24 KB da solicitação. O prazo da chamada OpenAI, incluindo a leitura da resposta, é de 25 segundos para permitir um erro JSON antes do encerramento da função neste projeto. O arquivo PDF, seu nome e os recortes não fazem parte dessa solicitação. O contexto pode conter prosa dos trechos vizinhos.

A função chama `POST https://api.openai.com/v1/responses`, usando o modelo `gpt-6-luna` e saída estruturada JSON. Cada tradução deve retornar o ID e o XML correspondentes. A função e o cliente verificam IDs, quantidade de blocos e marcadores; respostas incompletas ou alteradas são recusadas. O texto do artigo é fornecido como conteúdo a traduzir, com instruções de tradução científica separadas.

Mudanças em números, sobrescritos e posição dos símbolos geram avisos de revisão. A validação automática ajuda a detectar perdas de estrutura, mas não comprova o sentido científico da tradução. Tabelas preservadas como imagem e texto desenhado dentro das figuras permanecem no idioma original.

O progresso e os resultados ficam em memória. A retomada reutiliza traduções validadas quando o documento, idiomas e configuração continuam compatíveis; alterações no conteúdo invalidam os blocos correspondentes. Limitação transitória de solicitações (HTTP 429), inclusive da plataforma, pode ser repetida até três tentativas respeitando `Retry-After`. Uma falha de rede ou timeout não comprova ausência de processamento ou cobrança; o aplicativo não repete esse lote silenciosamente. Falhas HTTP fora do formato JSON mostram o status e, quando disponível, a referência Netlify. Interromper impede novos lotes, mas uma solicitação aceita pelo provedor ainda pode ter custo. Atualizar ou fechar a página encerra a sessão e descarta seu progresso.

## Privacidade e limites de fidelidade

A chave da OpenAI permanece no servidor. O aplicativo não mantém banco de dados, histórico, cookies de aplicação ou armazenamento persistente de documentos. As respostas da API usam `Cache-Control: no-store`; o código não registra texto nem encaminha mensagens brutas do provedor. Fechar ou recarregar a página perde os resultados da sessão.

As chamadas à Responses API usam `store: false`. Isso não equivale a retenção zero: o texto enviado é processado pela OpenAI e passa pela infraestrutura Netlify, conforme as políticas aplicáveis. Consulte os [controles de dados da API da OpenAI](https://developers.openai.com/api/docs/guides/your-data).

A detecção de figuras, equações e ordem de leitura usa heurísticas e exige revisão. Os recortes preservam sua aparência, mas não tornam as equações editáveis. A região selecionada precisa conter todos os símbolos. Colunas, hifenização, fontes matemáticas antigas, sub/sobrescritos e gráficos compostos merecem atenção. A montagem não reproduz a diagramação original.

O PDF final usa fontes locais Noto Serif (SIL Open Font License 1.1) quando necessário. Glifos incompatíveis podem impedir a exportação em PDF, com orientação para proteger o símbolo como recorte ou usar o DOCX. Elementos que não caibam com segurança também impedem a exportação, evitando omissões silenciosas.

## Validação

```sh
pnpm test
pnpm build
```

Os testes unitários usam uma OpenAI simulada e cobrem configuração, código de acesso/origem, limites de entrada, contratos de requisição/resposta, IDs e marcadores protegidos, falhas de quota, retomada e exportação. Eles não consomem a API e não comprovam acesso da conta ao modelo nem qualidade de tradução real.

As páginas `tests/structured-analyze-browser.html`, `tests/structured-ui-browser.html` e `tests/structured-export-browser.html` exercitam análise, interface assistida e exportação com documentos sintéticos no navegador. São páginas de desenvolvimento e não fazem parte do build publicado. Outras regressões locais cobrem utilitários de Word e reparo de equações mantidos no repositório.

## Referências

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Respostas estruturadas](https://developers.openai.com/api/docs/guides/structured-outputs)
- [PDF.js](https://mozilla.github.io/pdf.js/)
- [Tesseract.js](https://github.com/naptha/tesseract.js)
- [Netlify Functions](https://docs.netlify.com/build/functions/overview/)
