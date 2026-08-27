# Continuar: edição de pontos no mapa (KMZ)

## Contexto
O usuário quer marcar/mover câmeras direto no mapa da tela "KMZ Mapa",
em vez de precisar abrir o Google Earth, marcar lá, e reimportar o KMZ inteiro.

Chegamos a essa tarefa depois de reorganizar o menu de cada camada (que antes
tinha 4 botões soltos e virou um menu de "⋮" no cabeçalho do card, flutuando
com position: fixed porque o card tem overflow:hidden).

## Decisões já tomadas com o usuário
- O ponto marcado/editado fica amarrado a uma câmera pelo nome (não é um
  pino solto) — assim ele já nasce com nome, status e snapshot.
- Se o KMZ original for reimportado depois, o ponto marcado na tela vence
  (é mais recente e foi conferido pelo usuário).
- O KMZ continua sendo a fonte de verdade (não só o geojson), para o mapa e o
  arquivo baixado nunca divergirem.

## O que JÁ ESTÁ PRONTO (backend, publicado em produção)

Arquivo: app/services/kmz_ops.py
Função nova no final do arquivo: editar_ponto_no_kmz(kmz_path, *, nome, lat=None,
lon=None, descricao="", remover=False).
- Casa o Placemark pelo nome (normalizado, sem acento/caixa).
- Três ações: criar (nome não existe), mover (nome existe, só troca coordenada
  preservando estilo/descrição), remover.
- Regrava o KMZ inteiro (zip não suporta editar membro no lugar).
- Recusa nome vazio, e recusa criar/mover sem lat/lon.

Arquivo: app/api/endpoints/tools.py
- Função _editar_ponto_da_camada(layer_id, ponto, generated=False): chama
  editar_ponto_no_kmz, regenera o .geojson a partir do KMZ atualizado
  (kmz_to_geojson), atualiza o .meta.json, e se for camada importada
  chama _apagar_geradas_do_mapa(layer_id) (a cópia enriquecida ficaria
  desatualizada).
- Os dois endpoints existentes de renomear camada foram estendidos:
  - PATCH /api/kmz/import/layers/{layer_id}
  - PATCH /api/kmz/generated/layers/{layer_id}
  Ambos agora aceitam {"ponto": {...}} no corpo. Se vier isso, chama
  _editar_ponto_da_camada em vez do fluxo de renomear.
  Formato do payload "ponto":
  {"nome": "06 - PORTOES", "lat": -9.76, "lon": -36.67, "descricao": "IP: 10.10.8.11"}
  Para remover: {"nome": "06 - PORTOES", "remover": true}

Teste: scripts/sightops_kmz_editar_ponto_test.py — cobre criar, mover,
remover, remover inexistente (não quebra), nome vazio recusado, coordenada
faltando recusada, descrição sobrevive, zip continua válido. Todos passando.

Deploy: imagem sightops-prod-api:20260827-pontokmz, já publicada e
validada em produção (import ok, função disponível).

## O que FALTA (frontend — não foi feito ainda)

Arquivo principal: frontend/js/cameras.js (é onde vive todo o código do mapa
de câmeras — _map, _mapFeatures, mapFindCamera, o menu de camada recém
criado, etc). Também frontend/styles.css e frontend/index.html (que tem os
contadores de versão ?v=NNN de cada arquivo — sempre subir o número ao editar
um arquivo, senão o navegador serve a versão em cache).

Precisa:

1. Novo item no menu da camada (o menu de "⋮" que já existe, ver função
   que monta menu.appendChild(item(...)) perto da linha ~700 de
   cameras.js): algo como "Editar pontos no mapa".

2. Modo de edição: ao clicar, a camada entra num estado onde:
   - As câmeras do inventário sem ponto no mapa (o sistema já calcula isso
     — é o aviso laranja "N camera(s) do inventário sem ponto no mapa" que
     aparece no card) ficam numa lista/painel para o usuário escolher qual
     marcar.
   - Usuário escolhe uma câmera da lista, clica no mapa → chama o PATCH com
     {"ponto": {"nome": <nome da câmera>, "lat":..., "lon":..., "descricao": "IP: <ip>"}}.
   - Pontos já existentes no mapa (os marcadores atuais, feitos com
     L.marker([lat,lng])) ganham draggable: true enquanto em modo de
     edição; ao soltar (dragend), pega a nova posição e chama o mesmo PATCH
     em modo "mover" (mesmo nome, lat/lon novos).
   - Um botão "Sair do modo de edição" ou similar.

3. Recarregar a camada depois de salvar — a função que carrega tudo é a
   que popula _mapFeatures (procurar por "_mapFeatures = results.flatMap",
   perto da linha 627) — provavelmente vale re-chamar o fluxo de carregamento
   daquela camada específica (ou um refresh geral) depois de cada
   criar/mover/remover, para o aviso "sem ponto no mapa" e o marcador
   atualizarem na hora.

4. Feedback visual: toast de sucesso/erro (usar showToast, já existe no
   projeto), e talvez destacar visualmente o pino recém-criado/movido.

## Como testar depois de implementar
1. Abrir "KMZ Mapa", numa camada que tenha o aviso "câmera(s) do inventário
   sem ponto no mapa" (ex.: JARDINS II ou JARDINS I têm 1 cada, no ambiente
   de produção do cliente RADS).
2. Entrar no modo de edição, marcar a câmera que falta.
3. Conferir que o aviso laranja sumiu (ou diminuiu a contagem).
4. Arrastar um ponto existente, soltar em lugar diferente, recarregar a
   página e confirmar que a posição nova persistiu (prova que gravou no KMZ
   e não só na memória do navegador).
5. Baixar o KMZ da camada (botão "Baixar KMZ enriquecido" do menu) e abrir
   no Google Earth pra confirmar que o ponto novo/movido está lá também —
   é a prova de que o arquivo baixado não diverge do que aparece no mapa.

## Fluxo de trabalho deste projeto (importante!)
Este projeto não roda local — produção fica em servidor remoto
(10.10.12.7 / 201.182.184.84 como alternativa, usuário central,
senha nas memórias/histórico). O fluxo de deploy usado até agora:

1. Editar o arquivo local em c:\PROJETOS\cam-snapshot-web-v2.
2. Copiar pro servidor via pscp (PuTTY), depois plink pra rodar comandos.
3. Para arquivos Python (backend): copiar pra
   /tmp/build-cirurgico/envio/app/..., rodar docker build numa imagem nova
   com tag sightops-prod-api:AAAAMMDD-descricao, validar com um teste rápido
   dentro do container (docker run --rm --entrypoint python ... -c "..."),
   e só então python3 deploy_api.py sightops-prod-api:TAG de dentro de
   /home/central/sightops-prod-release.
4. Para arquivos de frontend (.html, .js, .css): copiar direto pra
   /home/central/sightops-prod-release/frontend/... (é servido por nginx,
   não tem build) — mas sempre incrementar o ?v=NNN correspondente em
   frontend/index.html, senão fica em cache no navegador do usuário.
5. Sempre validar com um teste real batendo no endpoint (curl ou script
   Python) antes de considerar pronto — já rolou pelo menos um caso nesta
   sessão em que o código passava em teste unitário isolado mas não
   funcionava de verdade em produção porque o contexto (tenant) estava errado.
6. No final, git commit + push pro remote producao
   (git push producao main) com mensagem descrevendo o que mudou e por quê.
   Adicionar nota no docs/HANDOFF_AGENTES.md quando a mudança for
   estrutural/arriscada (outros agentes trabalham nesse mesmo repo).

## Coisas para NÃO esquecer
- O card da camada tem overflow: hidden no CSS — qualquer elemento novo que
  precise "vazar" pra fora do card (tooltip, painel de edição flutuante) tem
  que usar position: fixed como o menu de ⋮ já faz, calculando a posição
  via getBoundingClientRect() do elemento-gatilho.
- Multi-tenant: todo endpoint já resolve o tenant automaticamente pelo
  contexto de autenticação — não precisa (e não deve) passar tenant_slug
  manualmente nas chamadas do frontend.
- Convenção de nomes/comentários do projeto: comentários em português,
  explicando o "porquê" de decisões não óbvias (não o "o quê").
