# WhatsApp - Evolution API como canal alternativo por site

## Contexto

Hoje o Controle de Acesso manda aviso pros responsaveis (entrada/saida do
aluno) so pela API oficial da Meta (Cloud API). Isso e bom -- e o canal
suportado oficialmente -- mas tem uma dependencia real: toda vez que o
template de mensagem e editado, a Meta manda pra analise de novo, e enquanto
nao aprova, nenhuma notificacao sai por ali. Aconteceu agora: o usuario
editou o template ontem as 19h e ate o momento deste documento a analise nao
voltou.

O sistema ja teve um segundo canal antes -- o Evolution API, que fala com o
WhatsApp Web por engenharia reversa (biblioteca Baileys, nao oficial) -- mas
foi removido de proposito (commit `4dbfd78`, 26/08/2026) porque falhava
calado: aceitava a mensagem com sucesso (HTTP 201 + ack) sem entregar nada,
porque o proprio WhatsApp recusava e o Evolution engolia o erro. A tela
mostrava "Conectado" com a sessao morta.

A prova de que o problema e real e atual: o container `sightops-evolution-api`
(rodando em 10.10.12.7:8090, saudavel) ainda tem uma instancia orfa chamada
"presidente-dutra" -- a MESMA escola que hoje usa a Meta -- travada em
`connectionStatus: "connecting"` desde 2026-08-26T14:41, deslogada
(`401 Unauthorized`, "Log out instance") ha mais de um dia, com 46 mensagens
e 3 contatos guardados sem que ninguem tenha percebido.

## O que o usuario precisa

Nao e "cliente A usa Meta, cliente B usa Evolution" para sempre. E um plano
B: quando a Meta trava (template em analise, instabilidade, etc.), poder
trocar o canal daquela escola pra Evolution na hora, sem esperar ninguem
mexer no sistema; quando a Meta volta a funcionar, trocar de volta.

Decisoes fechadas com o usuario:

- **Por site, nao por cliente**: cada site tem seu proprio canal ativo,
  igual a configuracao de WhatsApp por site que ja existe hoje.
- **Troca manual, sem failover automatico**: o usuario decide quando trocar
  -- sem logica de "tenta um, se falhar tenta o outro" (evita risco de
  mandar a mesma notificacao duas vezes, e deixa o usuario no controle
  sabendo exatamente qual canal esta ativo).
- **Verificacao de saude ativa e obrigatoria**: nao pode repetir o erro de
  confiar no status que o proprio Evolution informa. A verificacao tem que
  testar a conexao de verdade, para que uma sessao morta apareca como
  offline no Dashboard, nao como "Conectado".
- **So a infraestrutura agora**: nao precisa conectar (escanear QR Code) na
  hora -- deixar pronto para conectar quando quiserem.

## Modelo de configuracao

A configuracao de WhatsApp por site (`access_control_whatsapp_notifications`
/ `..._by_site[site]`, ja existente) ganha um campo `provider`:
`cloud_api` (padrao, mantem o comportamento atual) ou `evolution`.
Configuracoes ja existentes continuam em `cloud_api` sem nenhuma mudanca de
comportamento -- e puramente aditivo.

O Evolution API e infraestrutura da propria SightOps (um container so,
compartilhado entre clientes), nao algo que cada escola configura com sua
propria URL/chave -- diferente do provider `cloud_api`, onde cada site tem
seu proprio Phone Number ID/token da Meta. Endereco e chave do Evolution
ficam fixos por variavel de ambiente, no mesmo padrao ja usado para o
Zabbix (`SIGHTOPS_ZABBIX_URL`/`_USER`/`_PASS`) -- so o nome da instancia
(um por site, derivado do nome do site) e o que varia.

## Envio de mensagem

Quando `provider == "evolution"`, o envio da notificacao ao responsavel usa
o Evolution (`POST /message/sendText/{instance}`) em vez da Cloud API. A
funcao que decide o provedor (`_whatsapp_provider`, hoje fixa em
`"cloud_api"`) volta a ler o campo `provider` da configuracao do site.

## Verificacao de saude (o ponto critico)

Reaproveita o mesmo padrao ja usado nesta sessao para OLT/ONU e
controladoras de acesso: o SightOps mesmo verifica ativamente, em vez de
confiar no que o sistema externo diz.

A verificacao periodica que ja existe hoje para canais WhatsApp (criada
nesta mesma sessao, alimenta o card do Dashboard) passa a ser
provider-aware: para sites em `evolution`, em vez de consultar a Graph API
da Meta, consulta o estado real da conexao no Evolution
(`connectionState`/`fetchInstances`) e so considera "conectado" quando o
estado reportado for genuinamente de sessao ativa (`open`) -- qualquer outra
coisa (`connecting`, `close`, deslogado) conta como offline, sem
interpretacao otimista. Isso alimenta o mesmo card "WhatsApp" do Dashboard e
o mesmo envio ao Zabbix que ja existem, sem precisar mudar nada no que ja
foi construido hoje -- so o `list_access_whatsapp_channels()` fica
provider-aware por dentro.

## Conectar (QR Code)

A tela de "Conexoes" do Controle de Acesso ganha, quando o site esta
configurado para `evolution`, uma opcao para mostrar o QR Code (igual
WhatsApp Web) para escanear no celular da escola. Isso fica pronto agora;
conectar de verdade fica para quando o usuario quiser.

## Fora de escopo

- **Confirmacao de entrega mensagem-a-mensagem** (saber se aquela mensagem
  especifica chegou no celular do responsavel, nao so se a sessao esta
  viva) exige escutar um segundo tipo de evento do Evolution
  (`MESSAGES_UPDATE`/ack), com um receptor de webhook proprio. Cobre o
  problema que ja aconteceu (sessao morta relatada como viva); nao cobre
  entrega individual. Pode entrar depois, se o usuario quiser garantia
  mais forte.
- **Failover automatico** entre canais.
- **Migrar/reaproveitar** a instancia orfa "presidente-dutra" -- ela fica
  para tras; quando o site for de fato configurado para Evolution, cria-se
  uma instancia nova e limpa.

## Testes e validacao

- Configuracao de site com `provider: "evolution"` faz o envio de
  notificacao usar o Evolution, nao a Meta.
- Configuracao sem `provider` (ou com `cloud_api`) continua identica ao
  comportamento de hoje -- nenhuma regressao para quem so usa a Meta.
- Verificacao de saude do Evolution reflete o estado real da sessao: uma
  instancia deslogada/travada (como a "presidente-dutra" hoje) tem que
  aparecer como offline no Dashboard, nunca como conectada.
- QR Code exibido corresponde a instancia certa do site.
- Trocar o `provider` de um site para `cloud_api` nao afeta outros sites.
