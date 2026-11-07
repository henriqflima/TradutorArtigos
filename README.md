# Lume — tradutor de textos e artigos em PDF

Aplicativo web em português que traduz textos e artigos com **GPT-6.1 Terra pela API da OpenAI** e extrai todos os PDFs com **Mistral OCR**. A opção de texto oferece entrada e tradução lado a lado, com seleção de idiomas e até 10.000 palavras. Para artigos, o programa analisa o PDF, preserva imagens e equações por recortes locais e monta os arquivos Word e PDF traduzidos. A interface usa React e TypeScript, o build usa Vite e o backend roda em funções da Netlify ou da Vercel.

## Escopo desta versão

- Opção **Resumir artigo**, independente da tradução: arquivo, configuração, código de acesso em memória, extração, evidências, progresso e resultados próprios. O resumo parte do PDF original, sem chamar as rotas de tradução.
- Extração para resumo por página, preservando conteúdo original de texto, tabelas, legendas e equações, com leitura complementar da imagem de cada página pela OpenAI. A conferência permite editar o texto reconhecido, inspecionar citações, valores e ressalvas e baixar as evidências em JSON. Correções invalidam a análise da página afetada e o resumo dependente; os demais dados recebidos são preservados.
- Resumo com **Objetivo**, **Base técnica**, **Metodologia** e **Resultados e conclusões**, com referências navegáveis às evidências e páginas físicas do PDF. Leitura incompleta, baixa confiança do OCR, informações ausentes e ambiguidades aparecem como pendências. A cobertura automática e as verificações de citações e números não garantem correção científica.
- Comentários explicativos opcionais para até três conceitos da base técnica, com pesquisa breve e fontes verificadas contra os URLs retornados pela ferramenta de busca. A internet não é usada para preencher resultados ou procedimentos ausentes do artigo. O resumo pode ser copiado e baixado em texto; a exportação Word/PDF continua restrita à tradução nesta versão.

- Opção **Traduzir texto** com duas caixas (original e tradução), listas de idiomas, detecção automática da origem, inversão de idiomas e cópia do resultado. A tradução começa **na primeira edição** e continua sendo atualizada durante a digitação, sem exigir uma pausa. Uma tradução é processada por vez; novos caracteres mantêm o trabalho em andamento e substituem apenas o texto pendente. A atualização seguinte usa o conteúdo mais recente e respeita uma cadência mínima de 2,1 segundos entre inícios, sem reiniciar essa contagem a cada tecla. O resultado continua visível enquanto os novos trechos são traduzidos. Substituições, exclusões e mudanças de idioma cancelam o trabalho incompatível; respostas antigas são descartadas. A composição de caracteres em teclados de idiomas como japonês e chinês precisa terminar antes do envio. Aceita somente texto digitado ou colado, sem arquivos, imagens ou anexos, com limite de **10.000 palavras** validado no navegador e no servidor. A contagem considera grupos separados por espaços ou quebras de linha. Conteúdo acima do limite pode ser editado, mas não enviado para tradução.
- Textos longos são divididos em trechos de até 2.500 caracteres, preservando separadores e priorizando parágrafos e frases. O resultado aparece progressivamente; interrupções podem ser retomadas na mesma sessão sem reenviar os trechos concluídos. Edições reaproveitam os trechos iniciais que não mudaram; mudanças de idioma invalidam o resultado anterior. Interromper pausa o texto atual; continuar escrevendo ou clicar em retomar reativa a tradução. Após uma falha, o programa aguarda uma edição ou tentativa explícita, sem repetir indefinidamente a mesma solicitação.
- Entrada exclusiva em **PDF, com até 7 MB (7.000.000 bytes) e 50 páginas**. O programa confere extensão, assinatura e quantidade de páginas antes da tradução. DOC, DOCX, JPG e PNG não são aceitos como entrada.
- Extração do texto e da ordem de leitura de todas as páginas com Mistral OCR, revisão por página, ajuste dos recortes e associação entre figuras e legendas. O PDF.js é usado para validar o PDF, exibir as páginas e gerar recortes do original.
- Todos os PDFs, inclusive os que têm texto selecionável, passam integralmente pela API Mistral OCR, usando `mistral-ocr-latest` por padrão. Todas as páginas são enviadas e cobradas no primeiro processamento; resultados concluídos podem ser reutilizados na sessão. A extração uniforme não garante correção: recomenda-se conferir o texto reconhecido, a ordem de leitura e as regiões visuais, sobretudo em páginas com fórmulas, tabelas ou colunas.
- Tradução somente dos parágrafos, títulos e legendas. Imagens e equações são preservadas por recortes do original; as páginas enviadas ao OCR incluem seu conteúdo visual, mas os recortes não são enviados ao modelo de tradução.
- Expressões TeX reconhecidas dentro dos parágrafos são protegidas por marcadores durante a tradução e desenhadas localmente com MathJax na exportação, preservando subscritos, sobrescritos e o alinhamento com o texto. Nenhum serviço externo recebe essas expressões para renderizá-las. Os recortes existentes continuam inalterados; a revisão deve conferir possíveis erros do OCR na notação.
- Dois caminhos para artigos em PDF: **Traduzir diretamente** segue do OCR para a tradução e geração dos arquivos automaticamente, sem confirmar cada página; **Analisar e revisar PDF** permite ajustar a extração e confirmar as páginas antes de traduzir. No modo direto, a revisão do resultado é opcional. Trechos traduzidos podem ser corrigidos localmente nos dois caminhos.
- Exportação de DOCX com texto editável em uma coluna e PDF com texto selecionável e montagem baseada no original. O PDF usa as dimensões reais das páginas, identifica uma ou duas colunas e procura manter a proporção e a posição relativa de títulos, figuras, tabelas e equações. A tradução pode ocupar mais espaço e gerar páginas adicionais.
- Comparação visual do PDF original com o resultado, com navegação por página original e pelas continuações traduzidas. A prévia indica páginas com montagem simplificada e adaptações necessárias; não representa uma garantia de percentual de semelhança.
- As exportações são independentes: o PDF é montado primeiro, e uma falha na geração do Word não impede seu download ou comparação. Se apenas um dos formatos puder ser gerado, ele permanece disponível com a indicação do problema no outro.
- Interrupção e retomada na mesma sessão, reutilizando os blocos já concluídos e validados.

## Executar

Requer Node.js 22.12+ e pnpm 11.19.0.

```sh
corepack enable
pnpm install --frozen-lockfile
```

Copie `.env.example` para `.env` e preencha `OPENAI_API_KEY` com uma chave da API da OpenAI que tenha acesso a `gpt-6.1-terra` e `MISTRAL_API_KEY` com uma chave da Mistral com acesso ao OCR. As chaves são usadas apenas nas funções do servidor. Não use o prefixo `VITE_` nem inclua credenciais no Git. Opcionalmente, `MISTRAL_OCR_MODEL` permite fixar uma versão disponível na conta; o padrão é `mistral-ocr-latest`. `APP_ACCESS_CODE` restringe os endpoints pagos por um código compartilhado, solicitado antes da análise e mantido em memória.

```sh
pnpm dev
pnpm test
pnpm build
```

A extração de todos os PDFs depende da API Mistral OCR e não exige modelos, worker ou WASM do Tesseract. O navegador continua responsável pela validação, prévia das páginas, revisão, recortes e exportação.

O plugin Vite da Netlify emula as funções em desenvolvimento. A porta padrão é 5173. Sem chave Mistral ou sem confirmação da configuração do serviço, a análise de qualquer PDF fica indisponível com orientação de configuração. A tradução de texto digitado ou colado depende apenas da OpenAI. Sem chave OpenAI, a revisão de PDFs reconhecidos pela Mistral continua disponível e a tradução fica desativada. `pnpm preview` serve somente os arquivos estáticos e não emula a API.

## Publicar na Netlify

1. Importe ou vincule o repositório ao projeto Netlify.
2. Use `netlify.toml`: comando `pnpm build`, publicação `dist`, funções `netlify/functions` e Node 22.
3. Cadastre `OPENAI_API_KEY` e `MISTRAL_API_KEY` como variáveis secretas com escopo **Functions** no contexto da publicação. Configure `APP_ACCESS_CODE` se o uso for restrito e `MISTRAL_OCR_MODEL` se precisar fixar uma versão.
4. Publique novamente as funções após alterar variáveis e confira o endpoint `/api/config`, que informa separadamente a configuração da tradução e do OCR, sem revelar as chaves.
5. Faça um teste real com um PDF pequeno, não confidencial, e confira reconhecimento, recortes, tradução e os dois arquivos exportados. Esse teste consome as APIs Mistral e OpenAI.

O endereço do projeto existente é [lume-tradutor.netlify.app](https://lume-tradutor.netlify.app). Alterações locais não atualizam automaticamente esse site. O vínculo local da Netlify fica em `.netlify/state.json`, fora do Git. Para publicar pelo conector, inclua `src/`, `public/`, `netlify/` e os arquivos de configuração da raiz, incluindo o lockfile e `pnpm-workspace.yaml`; exclua credenciais, caches, dependências, testes e resultados locais.

A DeepL não participa do novo fluxo. As antigas variáveis `DEEPL_API_KEY` e rotas documentais de upload, status e download não são usadas. A autenticação compartilhada é um controle simples para uso privado; os custos e limites devem ser administrados também nas contas Mistral e OpenAI.

## Publicar na Vercel

1. Importe o repositório do GitHub. Use a raiz do repositório como **Root Directory** e selecione **Vite** como **Framework Preset**. O `vercel.json` define o comando `pnpm build` e a saída `dist`.
2. Em **Settings → Environment Variables**, cadastre `OPENAI_API_KEY` e `MISTRAL_API_KEY` como segredos de servidor em **Production** e também em **Preview** se for testar nesse ambiente. Use os nomes sem o prefixo `VITE_`. Configure `APP_ACCESS_CODE` para restringir as rotas que fazem chamadas pagas. [Variáveis de ambiente na Vercel](https://vercel.com/docs/environment-variables/managing-environment-variables)
3. Após alterar as variáveis, gere um novo deploy. No domínio publicado, confirme que `GET /api/config` e `GET /api/summary-config` retornam HTTP 200 com JSON. Em `/api/summary-config`, os campos `configured` e `ocrConfigured` devem estar como `true` para habilitar a extração do resumo.

Os limites por IP declarados nas funções da Netlify se aplicam apenas à Netlify. Na Vercel, configure a limitação de requisições no Firewall do projeto. [Limitação de requisições na Vercel](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)

## Processamento e API

### Resumo independente

O fluxo usa `GET /api/summary-config`, `POST /api/summary-ocr` (uma página PDF binária), `POST /api/summary-evidence` (regiões com texto original/revisado e imagem JPEG), `POST /api/summary-compose` (uma das quatro partes por chamada) e `POST /api/summary-explain` (até três conceitos, sem o artigo completo). Nenhuma dessas etapas depende do estado ou dos resultados da tradução. Compartilham apenas infraestrutura genérica de PDF, HTTP e acesso aos provedores.

Os PDFs para resumo têm o limite de 7 MB e 50 páginas. A geometria de todas as páginas é verificada antes do primeiro envio pago. O OCR recebe páginas isoladas de até 4 MB; a leitura de evidências recebe lotes de até 24 mil caracteres e uma imagem da página. O conteúdo e a ordem fornecidos pelo OCR são mantidos, inclusive células, notação e símbolos, sem normalizar silenciosamente números ou unidades. Fontes longas são divididas sem descartar o restante. Citações são conferidas nas regiões citadas; diferenças apenas de espaços e quebras de linha recuperam a grafia original. A comparação de quantidades aceita diferenças de apresentação (espaços, sinal negativo tipográfico e separador decimal não ambíguo), preservando sinal, precisão, unidade e ordem de grandeza. Uma quantidade não confirmada separa a evidência inteira para conferência e gera aviso com página e regiões de origem; as outras evidências e as páginas seguintes continuam sendo processadas. A evidência separada não é enviada à composição do resumo. Evidências visuais podem depender da interpretação dos pixels e exigem conferência humana. Divergências e aproximações devem acompanhar o resultado.

`SUMMARY_MODEL` configura o modelo de resumo separadamente; o padrão é `gpt-6.1-terra`. O modelo precisa oferecer entrada de imagens, saída estruturada e, para comentários com pesquisa, a ferramenta `web_search`. São usadas as chaves existentes `OPENAI_API_KEY` e `MISTRAL_API_KEY`, exclusivamente no servidor, e `APP_ACCESS_CODE` quando configurado. A resposta da OpenAI usa `store: false`; o prazo é de 50 segundos incluindo leitura da resposta. A pesquisa tem teto de três chamadas de ferramenta por solicitação. Dados ou fontes inválidos e respostas incompletas são recusados.

O resumo só é liberado após analisar todas as páginas, com indicação explícita das pendências encontradas. Uma interrupção preserva páginas de OCR, lotes de evidências e partes do resumo já validados; a tentativa explícita retoma o que ficou pendente. Falha de rede ou timeout não é repetido silenciosamente e pode ter gerado cobrança. Tudo permanece em memória: fechar ou recarregar a página perde a sessão. Texto e imagem das páginas são enviados à OpenAI para análise; os comentários podem consultar provedores de pesquisa pela ferramenta da OpenAI. Aplicam-se as políticas de retenção dos provedores.

As páginas enviadas ao OCR normalmente preservam o conteúdo PDF e normalizam a área visível, sua origem, a rotação de 180° e a unidade de escala. O arquivo completo pode ter 7 MB, enquanto cada chamada transporta uma única página de até 4 MB. Se uma página isolada exceder esse tamanho, o navegador prepara uma cópia em JPEG dentro de um PDF, a aproximadamente 200 dpi e com teto de 12 milhões de pixels, conservando as dimensões visíveis. Essa cópia é usada somente no OCR; o original e os recortes usados na exportação permanecem intactos. Isso mantém as coordenadas do OCR alinhadas à prévia e aos recortes do original. Páginas com rotação de 90°/270° continuam sendo recusadas antes do envio.

O navegador valida o PDF e prepara todas as suas páginas para a extração pela Mistral. O texto e a ordem de leitura usados na tradução vêm do OCR em todos os documentos. Falhas do OCR impedem a confirmação das páginas afetadas; não há extração local alternativa. Figuras e equações são renderizadas do original como PNG sem perdas a 400 dpi. A revisão permite conferir o texto, a ordem de leitura e a abrangência dos recortes. Antes da tradução e da exportação, o programa verifica relações entre blocos e objetos e os hashes dos recortes.

O OCR usa `POST /api/ocr`: cada página do documento é separada em um PDF de uma página e enviada como corpo binário `application/pdf`, sem o nome original. O servidor confere tamanho, assinatura, quantidade de páginas e autorização antes de chamar `POST https://api.mistral.ai/v1/ocr`. A conversão para Base64 ocorre somente no servidor; não há upload pela Files API nem URL pública do documento. A solicitação habilita blocos e confiança por bloco, sem pedir imagens em Base64. A resposta é validada e normalizada antes de chegar ao navegador. O modelo efetivamente retornado acompanha o resultado.

Na Netlify, a rota de OCR tem limite de 30 chamadas por minuto por IP e domínio. Para documentos com mais de 30 páginas, o navegador espaça os inícios das chamadas em pelo menos 2,1 segundos, evitando uma sequência rápida de 50 envios. Os limites e quotas da conta Mistral continuam sendo aplicados pelo provedor.

As coordenadas dos blocos Mistral são convertidas para pontos do PDF; elas não são tratadas como posições de palavras. Fórmulas reconhecidas dentro do texto geram apenas um aviso de conferência, sem impedir a confirmação da página ou a tradução; preservá-las como recorte é opcional. Ao preservar apenas um símbolo ou fórmula dentro de um parágrafo reconhecido, a revisão permite associar o recorte ao texto exato da expressão original, incluindo suas marcações. Se a expressão se repetir, selecione a ocorrência pelo contexto mostrado. Um recorte parcial sem associação impede a confirmação para evitar apagar prosa ou duplicar a fórmula. Correções manuais do texto atualizam o aviso de fórmulas pendentes; os vínculos continuam referenciando o texto original reconhecido. O reconhecimento pode falhar e não comprova fidelidade científica.

Resultados de OCR concluídos são reaproveitados na memória da sessão. Uma nova tentativa de análise reinicia a revisão manual. Cancelamento e falhas de rede não comprovam ausência de processamento ou cobrança; o aplicativo não repete silenciosamente uma chamada sem resposta. O OCR de todas as páginas é cobrado, inclusive em PDFs digitais, além da tradução e hospedagem; consulte os [preços da Mistral](https://docs.mistral.ai/inference/pricing).

A opção de texto usa `POST /api/translate-plain-text`, com `text` obrigatório como string, `target_lang` e `source_lang` opcional. A rota rejeita multipart, objetos, listas, campos extras, caracteres de controle binários e textos acima de 10.000 palavras antes de chamar o provedor. Uma proteção de transporte limita o JSON a 1 MB. O cliente envia trechos menores para respeitar o prazo de resposta. Marcações digitadas são escapadas e tratadas como conteúdo literal; a resposta também é exibida como texto simples.

A rota de tradução dos PDFs é `POST /api/translate-text`. Ela recebe lotes pequenos de XML restrito, com identificadores estáveis e marcadores protegidos, além dos idiomas e do contexto da seção. O cliente envia até quatro trechos por chamada e procura manter a soma do XML abaixo de 3.000 caracteres; um parágrafo maior segue isolado, respeitando o limite rígido de 24 KB da solicitação. O prazo da chamada OpenAI, incluindo a leitura da resposta, é de 25 segundos para permitir um erro JSON antes do encerramento da função neste projeto. O arquivo PDF, seu nome e os recortes não fazem parte dessa solicitação. O contexto pode conter prosa dos trechos vizinhos.

A função chama `POST https://api.openai.com/v1/responses`, usando o modelo `gpt-6.1-terra`, esforço de raciocínio `medium` e saída estruturada JSON. A configuração se aplica à tradução de PDFs e de texto. Cada tradução deve retornar o ID e o XML correspondentes. A função e o cliente verificam IDs, quantidade de blocos e marcadores; respostas incompletas ou alteradas são recusadas. O texto do artigo é fornecido como conteúdo a traduzir, com instruções de tradução científica separadas.

Mudanças em números, sobrescritos e posição dos símbolos geram avisos de revisão. A validação automática ajuda a detectar perdas de estrutura, mas não comprova o sentido científico da tradução. Tabelas preservadas como imagem e texto desenhado dentro das figuras permanecem no idioma original.

O progresso e os resultados ficam em memória. A retomada reutiliza traduções validadas quando o documento, idiomas e configuração continuam compatíveis; alterações no conteúdo invalidam os blocos correspondentes. Limitação transitória de solicitações (HTTP 429), inclusive da plataforma, pode ser repetida até três tentativas respeitando `Retry-After`. Uma falha de rede ou timeout não comprova ausência de processamento ou cobrança; o aplicativo não repete esse lote silenciosamente. Falhas HTTP fora do formato JSON mostram o status e, quando disponível, a referência Netlify. Interromper impede novos lotes, mas uma solicitação aceita pelo provedor ainda pode ter custo. Atualizar ou fechar a página encerra a sessão e descarta seu progresso.

## Privacidade e limites de fidelidade

As chaves Mistral e OpenAI permanecem no servidor. O aplicativo não mantém banco de dados, histórico, cookies de aplicação ou armazenamento persistente de documentos. As respostas da API usam `Cache-Control: no-store`; o código não registra conteúdo documental nem encaminha mensagens brutas dos provedores. Fechar ou recarregar a página perde os resultados da sessão.

Todas as páginas de todo PDF, incluindo texto, figuras e equações, passam pela infraestrutura de hospedagem do aplicativo para processamento pela Mistral. Isso também se aplica aos PDFs com texto selecionável. O texto revisado é enviado à OpenAI para tradução em chamadas à Responses API com `store: false`. O OCR usa a API da Mistral diretamente, e a retenção de dados segue as políticas dos provedores aplicáveis à conta. [Controles de dados da API da OpenAI](https://developers.openai.com/api/docs/guides/your-data) · [Condições de retenção de dados da Mistral](https://docs.mistral.ai/admin/monitor-comply/zero-data-retention)

A classificação de figuras, equações e ordem de leitura fornecida pelo OCR exige revisão. Os recortes preservam sua aparência, mas não tornam as equações editáveis. A região selecionada precisa conter todos os símbolos. Colunas, hifenização, fontes matemáticas antigas, sub/sobrescritos e gráficos compostos merecem atenção.

A montagem do PDF organiza o artigo em fluxo contínuo, usando as colunas e proporções do original como referência visual. Uma página traduzida pode reunir conteúdo de várias páginas originais. A ordem textual revisada é mantida; a passagem de uma página original para outra não obriga uma quebra na saída. Um perfil de margens e colunas é inferido para cada formato de página; a abertura pode ocupar a largura total antes do corpo em colunas. Mudanças reais no formato da folha continuam separadas. A reconstrução é aproximada: fontes, quebras, espaços e posição dos elementos podem mudar.

A distribuição mede a altura real do texto e mantém a fonte legível, com mínimo de 8 pontos, sem tentar comprimi-lo até a altura da caixa original. Quebras de linha de prosa são reorganizadas; parágrafos explícitos, listas, referências e fórmulas mantêm suas separações. Títulos acompanham o início do próximo trecho. Cabeçalhos, rodapés e números de página reconhecidos nas margens ficam fora do corpo contínuo; páginas originais vazias não geram folhas adicionais.

Figuras e tabelas permanecem nos recortes originais, com suas legendas. Quando um objeto não cabe, o texto pode ocupar a sobra enquanto o objeto aguarda a próxima região adequada. Uma figura larga pode reservar o rodapé das duas colunas ou ocupar o topo de uma próxima página. A fila tem escoamento garantido e preserva a ordem entre figuras; referências iniciam após os objetos pendentes. As imagens mantêm a proporção, com ajuste adicional limitado a 8% quando isso permite aproveitar uma região quase suficiente. Tabelas preservadas como imagem são indivisíveis. Equações permanecem no fluxo do trecho a que pertencem.

A comparação registra as relações nos dois sentidos: origem para destinos e destino para origens, incluindo fragmentos de parágrafos unidos e legendas. Uma origem sem conteúdo exportado mostra essa condição em vez de inventar uma página correspondente. A avaliação visual considera integridade, legibilidade e espaços evitáveis; a contagem final de páginas não é fixada pela quantidade original.

Nos PDFs digitais, informações públicas do PDF.js podem complementar a aparência dos blocos, como tamanho e família de fonte, sem substituir o texto reconhecido pela Mistral. Digitalizações não fornecem essa tipografia nativa e dependem de estimativas conservadoras. Essa análise local não exige uma nova chamada ao serviço de tradução ou ao OCR. O Word continua com a montagem editável em uma coluna.

O PDF final usa fontes locais Noto Serif (SIL Open Font License 1.1) quando necessário. Glifos incompatíveis podem impedir a exportação em PDF, com orientação para proteger o símbolo como recorte ou usar o DOCX. Elementos que não caibam com segurança também impedem a exportação, evitando omissões silenciosas.

## Validação

```sh
pnpm test
pnpm build
```

Os testes unitários usam provedores simulados e cobrem configuração, código de acesso/origem, limites de entrada, contratos de requisição/resposta, geometria do OCR, recortes, IDs e marcadores protegidos, falhas de quota, retomada e exportação. Eles não consomem as APIs e não comprovam acesso da conta aos modelos nem qualidade real de reconhecimento ou tradução.

Para validar o OCR real, configure `MISTRAL_API_KEY`, inicie o aplicativo e analise um PDF pequeno e não confidencial, cobrindo tanto texto selecionável quanto digitalização. Confira a ordem de duas colunas, fórmulas, tabelas, legendas, correções e exportação. Esse teste é opcional e pago; não inclua a chave ou conteúdo confidencial nos resultados de teste.

As páginas `tests/structured-analyze-browser.html`, `tests/structured-ui-browser.html`, `tests/structured-export-browser.html`, `tests/direct-translation-browser.html`, `tests/mistral-ocr-browser.html` e `tests/mistral-ui-browser.html` exercitam análise, interface assistida, vínculos de fórmulas repetidas, correções manuais e exportação com documentos sintéticos no navegador. `tests/pdf-reconstruction-browser.html?autorun=1` compara original e tradução com duas colunas, figura larga e expansão do texto. `tests/pdf-comparison-browser.html` verifica a navegação entre originais e continuações, o fechamento da prévia e a troca do resultado. Depois de gerar o PDF, a comparação permite conferir o original e o resultado sem novo envio às APIs. São páginas de desenvolvimento e não fazem parte do build publicado. As fixtures Mistral simulam o serviço e não consomem a API. Outras regressões locais cobrem utilitários de Word e reparo de equações mantidos no repositório.

`tests/pdf-dense-layout-browser.html` compara um artigo sintético de cerca de 800 palavras com tradução aproximadamente 13% maior, duas colunas, resumo largo e figura com legenda. Inclui um cabeçalho impreciso e expansão extrema em casos separados. As verificações conferem a distribuição, a integridade e a ausência de sobreposições, permitindo a continuação necessária sem reduzir a fonte. Os testes do planejador também cobrem figuras adiadas, títulos acompanhados e documentos mistos determinísticos com conferência de cada linha.

`tests/pdf-continuous-article-browser.html` permite conferir a montagem com um documento real previamente analisado/traduzido e recortes locais em `tmp/pdfs/continuous/`. A fixture é local, ignorada pelo Git e não incluída no build publicado. O ensaio compara palavras, aberturas dos parágrafos, objetos, limites e relações entre origens e destinos, e renderiza todas as páginas para inspeção. Ele não consome APIs, não comprova a qualidade do OCR e não mede sozinho o percentual de semelhança visual.

`tests/ocr-page-transport-browser.html` verifica a cópia compacta de uma página real com mais de 4 MB, preservação do arquivo de entrada, dimensões, recorte, rotação e escala física. Os testes de limites aceitam um PDF de exatamente 7 MB e 50 páginas e recusam os valores imediatamente superiores, sem consumir serviços externos.

## Referências

- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Respostas estruturadas](https://developers.openai.com/api/docs/guides/structured-outputs)
- [PDF.js](https://mozilla.github.io/pdf.js/)
- [Mistral OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr)
- [Referência da API OCR](https://docs.mistral.ai/api/endpoint/ocr)
- [Netlify Functions](https://docs.netlify.com/build/functions/overview/)
