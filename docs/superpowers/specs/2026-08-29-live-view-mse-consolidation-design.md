# Ver ao vivo - consolidacao num pipeline so (MSE via go2rtc)

## Contexto

O SightOps vai virar um modulo entregue a cliente final, e o "ver ao vivo"
hoje nao e confiavel o suficiente para isso ("as vezes funciona, as vezes
nao, e quando funciona funciona pessimo"). Investigando o codigo, achamos a
causa: **duas implementacoes de live view coexistindo e brigando entre si**.

1. **MJPEG via ffmpeg por espectador** (`app/api/endpoints/live.py` +
   `app/services/live_mjpeg_service.py`). Para cada pessoa que abre a
   camera, o servidor testa ate 13 URLs RTSP candidatas x 2 transportes
   (tcp/udp), cada tentativa com `ffmpeg` sincrono e timeout de varios
   segundos, so entao sobe um `ffmpeg` de verdade que fica gerando MJPEG
   (fotos JPEG em sequencia, 15-18fps). Cada espectador e um processo
   `ffmpeg` e uma conexao RTSP dedicados na propria camera -- a maioria das
   DVRs/cameras baratas so aceita 1-2 conexoes RTSP simultaneas, entao o
   segundo espectador da mesma camera costuma falhar ou derrubar o primeiro.
   **Confirmado que esta morto**: nenhuma tela do frontend chama
   `/api/live/*` hoje.
2. **go2rtc + WebRTC** (`app/api/endpoints/maintenance.py`, funcao
   `stream_register`, usada por `frontend/js/cameras.js` e
   `frontend/js/maintenance.js`, cada um com sua propria copia manual de
   ~80 linhas de sinalizacao WebRTC). Sem servidor TURN, so STUN publico do
   Google -- funciona quando o navegador consegue abrir conexao UDP direta
   com o `go2rtc`, falha silenciosamente (trava em "Aguardando video...")
   atras de NAT/CGNAT mais restritivo, comum em rede de cliente final.
   Alem disso, cada registro de stream **apaga o anterior antes de criar o
   novo** -- se duas pessoas abrem a mesma camera, a segunda derruba a
   primeira.

Durante a investigacao tambem achamos e ja corrigimos em producao (commit
`78e8d84`, 2026-08-29) um problema de seguranca real: a API administrativa
do `go2rtc` (`/go2rtc/api/streams`) estava acessivel publicamente sem
autenticacao e devolvia, em texto puro, usuario/senha RTSP de toda camera
ja aberta no "ver ao vivo" -- de dezenas de clientes diferentes, acumulados
desde que o container subiu (o registro nunca expira nem e removido). O
nginx ja foi corrigido para so liberar `/go2rtc/api/ws` (o WebSocket que o
navegador realmente usa); o acumulo em si (streams que nunca somem do
`go2rtc.yaml`) continua existindo e faz parte do escopo deste documento.

## Decisoes fechadas com o usuario

- Consolidar num pipeline so: **MSE (Media Source Extensions) sobre
  WebSocket via `go2rtc`**. Nao precisa de STUN/TURN -- e WebSocket puro,
  atravessa qualquer rede que ja alcanca o proprio site.
- O pipeline MJPEG antigo (`live.py`/`live_mjpeg_service.py`) e removido
  por completo, nao mantido como fallback (confirmado sem uso real).
- O `go2rtc` passa a fazer parte do modulo: entra no `docker-compose`,
  configuracao versionada no git -- hoje e um container solto, subido na
  mao no servidor, fora do git (mesmo padrao problematico do script de
  sincronizacao WireGuard corrigido antes nesta sessao).
- Publico e so navegador (desktop, tablet, celular pelo browser) -- sem
  app nativo por enquanto. MSE tem suporte solido em todo navegador
  moderno, entao isso fecha a decisao sem precisar manter WebRTC vivo
  "para o futuro".
- Sem audio -- nenhuma camera do parque usa de verdade, e o pipeline MJPEG
  antigo tambem nunca teve.
- Streams devem ser removidos do `go2rtc` automaticamente quando ninguem
  mais esta assistindo -- resolve tanto a instabilidade (evita registro
  preso/conflitante) quanto o acumulo de credenciais.
- Adicionar nesta mesma entrega uma opcao de qualidade (HD/SD) na tela --
  hoje e fixo no stream secundario (mais leve), sem escolha.

## Arquitetura

```
navegador <--WebSocket (MSE/fMP4)--> go2rtc <--RTSP--> camera
```

Um unico caminho, do inicio ao fim. O `go2rtc` fala com a camera via RTSP
(como sempre falou) e expoe o mesmo stream para o navegador via MSE sobre
WebSocket, no endpoint que ele ja tem pronto (`/api/ws?src=<nome>`) -- e o
MESMO endpoint que hoje serve WebRTC; o modo e escolhido pela primeira
mensagem que o cliente manda (`{"type": "mse", ...}` em vez de
`{"type": "webrtc/offer", ...}`).

## go2rtc no compose

Novo servico `go2rtc` em `docker-compose.production.yml` e
`docker-compose.yml`, imagem `alexxit/go2rtc`, na mesma rede
(`sightops-prod`/`default`) dos demais containers -- deixa de ser
enderecado pelo IP do gateway Docker (`172.28.0.1:1984`, fragil, muda se a
rede for recriada) e passa a ser `http://go2rtc:1984` por nome de servico,
igual todo o resto do compose ja faz.

Configuracao versionada em `deploy/go2rtc/go2rtc.yaml`: so a secao `api`
(porta 1984) e `log`; a secao `streams` comeca vazia -- cada camera e
registrada em tempo real quando alguem abre o "ver ao vivo", nunca
pre-cadastrada no arquivo. Isso e proposital: um arquivo de config vazio
no git nao tem credencial nenhuma de cliente.

`nginx` continua proxeando so `/go2rtc/api/ws` (ja corrigido hoje) --
aponta para o novo endereco `go2rtc:1984` em vez do IP do gateway.

**Migracao do container atual:** o `go2rtc` que roda hoje fora do compose
(`/opt/sightops/go2rtc/go2rtc.yaml`, no host) tem ~150 streams acumulados
com credenciais de clientes diferentes (o mesmo acumulo que motivou a
correcao de seguranca de hoje). No deploy desta mudanca, esse container e
substituido pelo novo (do compose) com o `go2rtc.yaml` **vazio** do repo --
nao migra os streams antigos. Streams voltam a ser criados normalmente
conforme as cameras forem sendo abertas; o arquivo antigo fica so de
backup fora do container, sem ser servido por nada.

## Backend: registro idempotente e limpeza automatica

A logica que hoje mora dentro de `app/api/endpoints/maintenance.py`
(`stream_register`, `_stream_rtsp_path_for_camera`) muda de lugar para um
servico novo, `app/services/live_stream_service.py`, ja que deixa de ser
uma feature so de manutencao e passa a ser a base do live view do sistema
inteiro. `_stream_rtsp_path_for_camera` (a heuristica de caminho RTSP por
fabricante) migra junto, sem mudar de comportamento -- o teste que ja
existe (`scripts/sightops_stream_rtsp_path_test.py`) so atualiza o import.

Dois reparos de comportamento:

1. **Registro idempotente.** Hoje o registro sempre faz
   `DELETE /api/streams` antes do `PUT`, derrubando quem ja estava
   assistindo a mesma camera. Passa a checar primeiro
   (`GET /api/streams?name=<nome>`) se o stream ja existe com a fonte
   certa -- so registra de novo se realmente precisar (fonte mudou, ou
   stream nao existe). Dois espectadores da mesma camera passam a
   compartilhar a mesma captacao RTSP no `go2rtc`, sem brigar.
2. **Limpeza automatica de streams ociosos.** Uma tarefa de fundo, dentro
   do proprio processo da API -- mesmo padrao ja usado em `app/main.py`
   para as outras tarefas periodicas do sistema (`_zabbix_status_sync_loop`,
   `_monitoring_refresh_loop`, `_olt_telemetry_loop`,
   `_access_control_sync_loop`: `asyncio.create_task` disparada no
   `@app.on_event("startup")`, guardada em `app.state`, cancelada no
   `@app.on_event("shutdown")`) -- roda a cada poucos minutos: pergunta ao
   `go2rtc` (`GET /api/streams`) quais streams tem `consumers` vazio
   (ninguem assistindo) e remove cada um (`DELETE /api/streams?name=...`).
   Isso substitui a necessidade de rastrear "quando foi a ultima vez que
   alguem assistiu" -- o proprio `go2rtc` ja sabe quem esta conectado.
   Adicionalmente, o frontend desregistra o stream de forma explicita
   quando o painel de camera/modal de manutencao e fechado (limpeza
   imediata no caminho feliz); a tarefa de fundo cobre os casos de aba
   fechada bruscamente, navegador travado, queda de rede.

Dois endpoints substituem o atual `POST /api/maintenance/stream_register/{ip}`
(que continua existindo com o mesmo contrato, so movido de camada):
registrar (idempotente, como acima) e desregistrar.

## Frontend: player unico

`cameras.js` e `maintenance.js` deixam de ter cada um sua propria copia
manual de sinalizacao WebRTC. Em vez disso, o projeto passa a vendorizar o
client MSE que o proprio `go2rtc` ja mantem pronto e testado
(`video-rtc.js`, ~600 linhas, Web Component `VideoRTC` -- confirmado
lendo o codigo real servido pela versao 1.9.14 que roda em producao hoje),
configurado para usar so o modo `mse` (sem webrtc/hls/mp4/mjpeg, que nao
fazem parte desta entrega). Esse client ja resolve sozinho: negociacao de
codec via `MediaSource.isTypeSupported`, buffer de video com autocorrecao
de atraso (ajusta `playbackRate` pra nao acumular atraso em rede lenta),
reconexao automatica com espera crescente se a conexao cair, e pausa
automatica quando a aba fica em segundo plano (economiza banda/CPU).

Uma camada fina (`frontend/js/liveStream.js`) expoe uma funcao unica --
algo como `mountLiveStream(container, {ip, user, pass, subtype, vendor,
model})`, devolvendo um controle com `setSubtype(novoSubtype)` (troca
HD/SD sem recarregar a tela) e `stop()` (desregistra e desconecta). Tanto
o painel de detalhe de camera (`cameras.js`) quanto o modal de manutencao
(`maintenance.js`) passam a chamar essa mesma funcao, eliminando a
duplicacao hoje existente nos dois arquivos.

## Qualidade (HD/SD)

Cada painel ganha um controle simples (dois botoes ou uma chave) para
escolher entre o stream principal (`subtype=0`, mais nitido, mais pesado)
e o secundario (`subtype=1`, mais leve, mais estavel em links ruins --
comportamento atual, vira o padrao inicial ao abrir a tela). Trocar chama
`setSubtype()`: registra o outro stream (se ainda nao estiver registrado)
e reconecta o player, sem fechar e reabrir o painel.

## O que sai do codigo

- `app/api/endpoints/live.py`
- `app/services/live_mjpeg_service.py`
- O registro deles em `app/main.py` (`app.include_router(live_router)`)
- As entradas correspondentes em `app/core/security.py`: `/api/live/jpeg`
  e `/api/live/mjpeg` (lista de rotas publicas) e
  `POST /api/live/session` (lista de permissoes por papel). A entrada
  `/api/system/health/live` (health check, nome parecido mas feature
  diferente) NAO e tocada.
- As ~160 linhas de sinalizacao WebRTC hoje duplicadas em `cameras.js` e
  `maintenance.js`, substituidas pela chamada unica a `liveStream.js`.

`ffmpeg` continua no `Dockerfile` da API -- e usado por outras features
(gravacoes/playback, `app/api/endpoints/playback.py` e
`app/services/recorder_media_service.py`), nao so pelo pipeline que esta
saindo.

## Fora de escopo

- App mobile nativo (decisao do usuario: so navegador por agora).
- Audio (decisao do usuario: nenhuma camera usa de verdade).
- HLS como fallback adicional -- o `go2rtc` ja sabe servir (config, sem
  codigo novo), mas nao entra nesta entrega; so faz sentido se algum
  cenario real (rede muito ruim, navegador sem MSE) aparecer depois.
- Gravacao/playback de video (feature separada, ja existente, nao mexida
  aqui).
- Autenticacao na API do `go2rtc` em si (o container continua sem exigir
  login internamente) -- a protecao e o nginx so liberar o WebSocket
  necessario, que ja foi aplicada. Se no futuro o `go2rtc` precisar ficar
  acessivel para outro uso administrativo, essa autenticacao entra como
  item separado.

## Testes e validacao

- Registro de stream chamado duas vezes seguidas para a mesma camera/
  qualidade nao apaga/recria o stream (idempotencia) -- verificavel testando
  a funcao de registro contra um `go2rtc` fake/mock que grava as chamadas
  recebidas.
- Tarefa de limpeza remove streams com `consumers` vazio e preserva
  streams com `consumers` preenchido -- teste unitario da funcao de
  varredura contra respostas simuladas de `GET /api/streams`.
- `_stream_rtsp_path_for_camera` continua com o mesmo comportamento apos a
  mudanca de arquivo (teste existente, so import atualizado).
- Fechar o painel de camera desregistra o stream (chamada ao endpoint de
  desregistro observavel em teste de frontend/integracao, ou verificacao
  manual durante a implementacao).
- Teste manual em rede real: dois navegadores diferentes assistindo a
  mesma camera ao mesmo tempo, sem um derrubar o outro; trocar HD/SD sem
  recarregar a tela; fechar e reabrir a mesma camera repetidas vezes sem
  acumular streams orfaos no `go2rtc` (`GET /api/streams` deve refletir
  isso).
- Confirmar que `/go2rtc/api/streams` continua bloqueado (403) e
  `/go2rtc/api/ws` respondendo, apos o `go2rtc` passar a rodar dentro do
  compose com o novo endereco de proxy.
- No deploy, confirmar que o container antigo (fora do compose) foi
  desligado e que o novo sobe com `go2rtc.yaml` vazio -- sem os ~150
  streams/credenciais acumulados do arquivo antigo.
