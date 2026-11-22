# Lume — tradução e leitura de artigos científicos

O Lume é um aplicativo web para traduzir textos e artigos em PDF e resumir artigos científicos com referências às páginas de origem. Foi pensado para estudantes, pesquisadores e profissionais que precisam consultar conteúdo técnico em outro idioma e conferir os trechos, dados e figuras em que a interpretação se apoia.

## O que você pode fazer

| Fluxo | Como funciona |
| --- | --- |
| **Traduzir texto** | Digite ou cole até 10.000 palavras. A tradução é atualizada conforme o texto muda e aparece ao lado do original. Textos longos são processados em partes e podem ser retomados na mesma sessão. |
| **Traduzir artigo em PDF** | Envie um PDF de até 7 MB (7.000.000 bytes) e 50 páginas. A tradução direta automatiza a extração. A revisão assistida permite corrigir o texto reconhecido, conferir a ordem de leitura e ajustar os recortes. Exporte em Word editável ou PDF e compare o PDF exportado com o original. |
| **Resumir artigo em PDF** | Revise o texto reconhecido e confira evidências por página. O resumo organiza objetivo, base técnica, metodologia e resultados e conclusões. As referências levam às evidências de origem, e avisos sinalizam lacunas ou trechos que precisam de conferência. É possível exportar o resumo em texto e as evidências em JSON. |

Na tradução de artigos, figuras, equações e tabelas preservadas como imagens usam recortes do PDF original. O Word é editável em uma coluna. O PDF recompõe as páginas a partir do texto traduzido e da disposição dos elementos do original. A tradução pode ocupar mais espaço, alterar quebras ou gerar páginas adicionais. A conferência visual também ajuda a detectar erros de reconhecimento em tabelas, fórmulas e textos em colunas.

## Executar localmente

Use Node.js 22.12 ou mais recente e pnpm 11.19.0. Instale as dependências.

```sh
pnpm install --frozen-lockfile
```

Para habilitar o processamento, copie [`.env.example`](.env.example) para `.env` e configure as integrações do servidor.

| Variáveis | Uso |
| --- | --- |
| `LANGUAGE_API_URL`, `LANGUAGE_API_KEY` | URL HTTPS completa e chave do serviço de linguagem. O endpoint deve implementar o formato de requisição e resposta usado pelos adaptadores em `netlify/functions/_shared/`, incluindo saída JSON estruturada. |
| `TRANSLATION_MODEL` | Identificador do modelo disponível no serviço para tradução de textos e artigos. |
| `SUMMARY_MODEL` | Identificador do modelo de resumo. O serviço precisa aceitar imagens e saída estruturada. A explicação opcional de conceitos também usa a ferramenta `web_search`. |
| `OCR_API_URL`, `OCR_API_KEY`, `OCR_MODEL` | URL HTTPS completa, chave e identificador do modelo de reconhecimento de documentos. A integração espera texto, blocos de layout e coordenadas por página. |
| `APP_ACCESS_CODE` | Código compartilhado opcional para restringir o acesso às operações que consomem os serviços. |

Use os nomes de variáveis do exemplo também em instalações existentes. As configurações identificam integrações compatíveis com os protocolos dos adaptadores. APIs com formatos diferentes precisam de um adaptador próprio. Mantenha as chaves no ambiente do servidor, sem prefixo `VITE_`.

```sh
pnpm dev
```

Abra `http://127.0.0.1:5173`.

## Processamento e privacidade

- **Reconhecimento de PDF.** Cada página passa por um serviço externo de reconhecimento de texto e layout (OCR), inclusive em PDFs com texto selecionável. O navegador valida o documento, prepara as páginas e permite revisar a extração. Cada requisição de OCR transporta uma página, com limite de 4 MB. Páginas maiores passam por compactação local.
- **Tradução.** O servidor encaminha trechos de texto ao serviço de linguagem. O navegador gera os recortes, a comparação visual e os arquivos de saída. Na tradução de PDF, o nome do arquivo e os recortes ficam fora das requisições de tradução.
- **Resumo.** O serviço de linguagem recebe texto e imagens das páginas para extrair evidências. O resumo usa essas evidências, e a explicação opcional de conceitos pode consultar fontes externas. A conferência de citações e números ajuda a localizar inconsistências. A interpretação científica exige revisão humana.
- **Sessão.** Progresso e resultados ficam em memória e são descartados ao fechar ou recarregar a página. O aplicativo não mantém banco de dados de documentos, e as respostas de processamento usam `Cache-Control: no-store`. O processamento externo segue as regras de retenção e cobrança dos serviços configurados.

## API e implantação

A interface usa React, TypeScript e Vite. A API de servidor separa reconhecimento (`/api/ocr`), tradução (`/api/translate-text` e `/api/translate-plain-text`) e resumo (`/api/summary-ocr`, `/api/summary-evidence`, `/api/summary-compose` e `/api/summary-explain`).

O repositório contém configurações de implantação em [`netlify.toml`](netlify.toml) e [`vercel.json`](vercel.json). O comando `pnpm build` gera a interface em `dist/`. Configure as variáveis no ambiente das funções e implante a interface e a API juntas. Confira `GET /api/config` e `GET /api/summary-config` para verificar quais recursos estão disponíveis. O comando `pnpm preview` serve a interface estática, enquanto `pnpm dev` integra as funções ao ambiente de desenvolvimento.

Os limites por IP declarados nas funções se aplicam à implantação com `netlify.toml`. Para a implantação que usa `api/[route].ts`, configure os limites de requisições na hospedagem.

## Validação

```sh
pnpm test
pnpm build
```

Os testes automatizados simulam os serviços externos e cobrem contratos, validação de entrada, tradução, extração e exportação. Para verificar uma instalação com serviços ativos, use um PDF pequeno e sem conteúdo confidencial. Esse cenário pode consumir a cota das integrações.
