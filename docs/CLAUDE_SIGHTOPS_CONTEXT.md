# Contexto do SightOps para usar no Claude

Este documento e um briefing para abrir uma conversa nova no Claude sem perder o contexto do produto, das decisoes tecnicas e do estado atual do SightOps.

Use este texto como base. Nao cole senhas, tokens, chaves privadas, URLs com credenciais ou dados sensiveis de clientes. Quando precisar falar de acesso, use placeholders como `<USUARIO>`, `<SENHA>`, `<IP_DA_OLT>` e `<TOKEN>`.

---

## Prompt curto para colar no Claude

Voce vai me ajudar no projeto SightOps, que fica em `C:\PROJETOS\cam-snapshot-web-v2`.

O SightOps e um SaaS operacional para CFTV e infraestrutura GPON. Ele controla implantacao, inventario, monitoramento, conectores MikroTik/RouterOS, OLTs, ONUs/ONTs, cameras IP, DVR/NVR, snapshots, Zabbix/Grafana e projetos planejados de CFTV.

O sistema tem backend Python/FastAPI, frontend HTML/CSS/JS puro em `frontend/`, banco Postgres em producao e containers Docker (`sightops-api`, `sightops-nginx`). O frontend publicado fica em `/home/central/sightops-frontend-html/v2/` no servidor. O backend roda dentro do container em `/app/app/...`.

Regra principal: nunca misturar tenants, sites, fontes de inventario ou modos. Cameras IP podem vir de `basico`, `olt` ou `switch`; esses modos precisam continuar separados. OLTs, conectores, cameras, DVR/NVR e monitoramento precisam respeitar tenant/site/conector. IP privado nao pode ser usado sozinho como identidade em SaaS.

Estilo de UI desejado: painel operacional SaaS/B2B, limpo, alinhado, denso, facil para tecnico usar em campo, sem cara de prototipo. Tabelas precisam ser legiveis, sem texto cortado, com scroll interno quando necessario. Botoes precisam ser padronizados com icones lucide. Modais devem ser claros e profissionais.

Areas importantes:

- Dashboard: cartoes de cameras, gravadores, ONUs/ONTs, OLTs, conectores, computadores, sites e pendencias. Tem drawers laterais para investigar cada card.
- Monitoramento: consolida estados de conectores, OLTs, ONUs/ONTs, cameras, NVR/DVR e Windows. Deve alimentar dashboard e alertas.
- Implantacao > OLT: cadastro de OLTs por fabricante/modelo/site/conector. Senha e cifrada e nao volta pela API. Intelbras 8820i/4840E ja funciona. FiberHome AN5516/AN6000 esta em homologacao.
- Implantacao > ONU: fluxo com conector primeiro, depois OLT cadastrada, PON, descobrir ONUs, autorizar, consultar sinal/MACs e excluir.
- Inventario > OLT: coleta MACs por ONU e cruza serial, PON/ONU, VLAN, MAC CPE, OLT, site. Para FiberHome, ha coleta via Telnet e enriquecimento com MAC/VLAN historicos.
- Inventario > Cameras IP: lista cameras, snapshots, status, modelo, local, PON/ONU e estado da ONU.
- Implantacao > Gravadores e CFTV: conceito baseado em conector/site/inventario. CFTV deve selecionar DVR/NVR salvo no inventario.
- Projetos de CFTV: modo planejamento livre, separado do inventario real. Permite criar projeto, importar KMZ/CSV, montar caixa de CFTV, vincular ONU/switch/injetor/cameras, calcular cabos pelas rotas viarias, exportar KMZ, gerar proposta e documento tecnico em PDF.
- Conectores: MikroTik RouterOS dos clientes. O conector permite executar tarefas remotas e acessar redes de clientes SaaS.
- Configuracoes: area administrativa SaaS com visao geral, clientes, usuarios/acessos, notificacoes Telegram e plataforma/seguranca.

Nao implemente nada sem ler o codigo atual antes. Use `rg` para localizar funcoes e siga o padrao existente.

---

## Estado geral do produto

O SightOps nasceu como uma ferramenta local de gestao de CFTV e esta sendo transformado em SaaS multi-cliente. A ideia central e que cada cliente tenha seus sites, conectores e inventarios isolados, mas o operador use um painel unico.

O produto cobre tres momentos:

1. Planejamento: desenhar projetos antes da instalacao, com KMZ, caixas de CFTV, cameras, ONUs, switches, cabos e proposta.
2. Implantacao: cadastrar OLT, provisionar ONU/ONT, cadastrar gravador, localizar camera, registrar no inventario.
3. Operacao: monitorar status, snapshots, sinal optico, cameras offline, OLTs, conectores e alertas.

O usuario valoriza muito:

- telas alinhadas e profissionais;
- botoes padronizados;
- tabelas que nao cortem informacao importante;
- fluxo guiado para tecnico;
- feedback visual quando algo esta rodando;
- evitar duplicidade de trabalho, como redigitar IP/senha toda hora;
- inventario confiavel cruzando camera, MAC, ONU, OLT, site e gravador.

---

## Arquitetura e caminhos

Repositorio local:

```text
C:\PROJETOS\cam-snapshot-web-v2
```

Arquivos principais:

```text
app/api/endpoints/        Rotas FastAPI
app/services/             Regras de negocio, inventarios, PDF, planejamento
app/cli/tools/            Drivers e ferramentas, incluindo OLT FiberHome
frontend/index.html       Estrutura principal da UI
frontend/styles.css       CSS principal
frontend/js/              Frontend dividido por area
docs/                     Documentacao de trabalho
scripts/                  Testes e ferramentas locais
TELHA/                    Arquivos de projeto/KMZ/CSV do projeto Telha
```

Frontend dividido:

```text
frontend/js/core.js          login, API, navegacao, configuracoes
frontend/js/dashboard.js     Dashboard e drawers laterais
frontend/js/cameras.js       Inventario Cameras IP
frontend/js/recorders.js     Gravadores
frontend/js/windows.js       Windows
frontend/js/snapshots.js     Snapshots
frontend/js/maintenance.js   Manutencao
frontend/js/analysis.js      Reproducao / IA-NVR
frontend/js/network.js       OLT, Switch, Backup, redes
frontend/js/deploy.js        Implantacao ONU/CFTV/Gravadores
frontend/js/deployOlt.js     Cadastro de OLT e auditoria FiberHome
frontend/js/connectors.js    Conectores RouterOS
frontend/js/planning.js      Projetos de CFTV
frontend/js/monitoring.js    Monitoramento consolidado
frontend/js/bootstrap.js     Bind dos botoes/eventos
```

Deploy conhecido:

```text
Frontend no servidor: /home/central/sightops-frontend-html/v2/
Backend no container: /app/app/
Containers: sightops-api, sightops-nginx
```

Ao alterar frontend, normalmente subir `index.html`, `styles.css` e os arquivos em `frontend/js/`, depois recarregar nginx. Ao alterar backend, copiar o arquivo para o container, compilar Python e reiniciar `sightops-api`.

---

## Regras de seguranca e SaaS

Nunca assumir que IP identifica equipamento globalmente. Em SaaS, o mesmo IP privado pode existir em varios clientes.

Identidades devem considerar, quando existir:

```text
tenant_slug
site
connector_id ou remote_connector_id
inventory_key
modo/fonte
host + porta + origem
PON + ONU + serial para OLT
```

Senhas de OLT sao cifradas no backend e a API nunca deve devolver a senha real. A tela deve mostrar apenas se a senha esta cadastrada.

Operacoes destrutivas em equipamento real, como excluir ONU da OLT, precisam de confirmacao forte e devem validar PON/ONU/serial antes de executar.

---

## Padrao visual desejado

O SightOps deve parecer uma ferramenta operacional SaaS madura, nao uma landing page.

Direcao visual:

- fundo cinza claro operacional;
- cards brancos com borda discreta e raio pequeno;
- verde como acao principal;
- vermelho apenas para risco/erro/excluir;
- tabelas com cabecalho claro, linhas bem espacadas e scroll interno;
- botoes com icones lucide e tamanho consistente;
- modais com titulo, resumo curto, formulario alinhado e rodape fixo;
- drawers laterais para investigar cards do dashboard;
- nada de texto cortado em botao, card ou tabela.

Quando o usuario reclamar que "ta torto", normalmente significa:

- colunas desalinhadas;
- cards com tamanhos diferentes;
- botoes quebrando linha sem necessidade;
- conteudo cortado por overflow ruim;
- lacunas grandes;
- tabela menor/maior que o painel vizinho;
- footer cobrindo a ultima linha;
- texto dentro do botao nao cabe.

---

## Dashboard e monitoramento

O Dashboard e a "cara que vende o sistema". Ele deve mostrar rapidamente:

- Cameras IP: online/total;
- Gravadores: DVR/NVR/canais;
- ONUs/ONTs: up/down/atencao;
- OLTs: cadastradas e estado;
- Conectores: online/total;
- Computadores;
- Sites;
- Pendencias.

Os cards devem abrir drawers laterais com filtros por status e site.

Monitoramento consolida entidades em:

```text
connector
olt
onu
camera
nvr
dvr
windows
```

Estados usados:

```text
up
down
unstable
unknown
maintenance
```

Pendencias devem somar tudo que exige verificacao, nao apenas cameras. Ou seja: `down + unstable + unknown` por tipo monitorado.

ONUs precisam ter sinal optico quando possivel:

```text
ONU RX
OLT RX
distancia
serial
PON/ONU
site
```

Telegram sera usado para notificacoes enquanto nao houver app mobile. Configuracao fica em Configuracoes > Notificacoes. Alertas importantes: queda, recuperacao e degradacao de sinal optico.

---

## OLT Intelbras

As OLTs Intelbras 8820i/4840E ja sao o comportamento de referencia.

O padrao esperado:

- cadastrar a OLT uma vez em Implantacao > OLT;
- a OLT aparece nos fluxos de ONU, CFTV e inventario;
- o conector deve ser escolhido antes da OLT ficar "acesa";
- operacoes usam `olt_id` sempre que possivel, resolvendo credenciais no backend;
- coleta inventario com PON, ONU, serial, MACs aprendidos e VLAN;
- consulta sinal/MACs cruza os dados e atualiza inventario;
- autorizar ONU deve aceitar multiplas VLANs e modos diferentes conforme o modelo/terminal.

---

## OLT FiberHome

FiberHome esta em homologacao. O equipamento testado e:

```text
Fabricante: FiberHome
Modelo: AN5516-06
Acesso: Telnet 23
```

Nao registrar credenciais reais em documentacao.

Driver atual:

```text
app/cli/tools/olt_fiberhome.py
```

Pontos importantes do driver FiberHome:

- usa Telnet;
- faz login e depois `enable`;
- a AN5516 pode permitir apenas uma sessao administrativa por vez;
- existe lock local para serializar operacoes do SightOps;
- se outra sessao Telnet/ANM2000 prender o modo admin, a operacao falha;
- ao sair, o driver tenta `exit` para User> e depois `quit`, para nao deixar lock preso;
- coleta layout por `device/show slot`;
- coleta ONUs por `gpononu/show authorization`, `show online`, `show onu_ver`;
- coleta sinal por `show optic_module`;
- coleta distancia por `show rtt_value`;
- coleta MAC/VLAN por `gponlinecard/show pon_mac slot X link Y`;
- tambem le `show mac_list` por ONU/porta;
- filtra MACs reservados como `00:00:00:00:00:00` e `00:00:00:00:00:01`;
- VLAN `65535` indica untagged/sem VLAN real naquela tabela.

Comportamentos observados:

- algumas ONUs aparecem online mas sem MAC aprendido;
- algumas linhas aparecem sem VLAN;
- a tabela `pon_mac` e melhor para relacionar MAC, VLAN e ONU;
- `mac_list` pode vir com VLAN 65535 quando a VLAN real esta na tabela da placa;
- uma ONU offline nao aprende MAC atual, entao VLAN/MAC so podem vir de historico de inventario;
- alguns registros historicos de queda retornam `0000-00-00`, ou seja, sem data confiavel.

Para homologar FiberHome com padrao Intelbras, a meta e:

- descobrir ONUs nao autorizadas;
- autorizar ONU com uma ou varias VLANs;
- suportar modelos tipo ONU/ONT/bridge/router quando necessario;
- suportar casos de internet + IPTV/multicast;
- consultar sinal e MACs;
- coletar inventario completo por OLT;
- excluir ONU com validacao por serial;
- auditoria de ONUs offline antigas.

---

## Auditoria de ONUs offline FiberHome

Existe uma auditoria em Implantacao > OLT, no menu de tres pontinhos da OLT FiberHome:

```text
Auditar ONUs offline
```

Ela consulta a OLT em segundo plano porque pode demorar mais de 60 segundos.

Endpoints:

```text
POST /api/olt/registry/{olt_id}/offline-audit?minimum_days=...
GET  /api/olt/registry/{olt_id}/offline-audit-status
```

O resultado traz:

```text
PON
ONU
serial
modelo
ultima queda
dias offline
confianca
VLANs conhecidas
MACs conhecidos
```

As VLANs/MACs de ONUs offline sao enriquecidas com historico do inventario, pois a ONU offline nao aprende MAC atual.

A tela permite:

- pesquisar por serial, modelo, PON/ONU e VLAN;
- selecionar linhas;
- excluir uma ONU individual;
- excluir selecionadas;
- exportar CSV.

Excluir ONU e destrutivo. Deve validar PON + ONU + serial antes de mandar o comando real.

---

## Projetos de CFTV

Projetos de CFTV sao planejamento, nao inventario real. Itens planejados nao entram no monitoramento.

Fluxo desejado:

1. Criar projeto.
2. Importar KMZ com pontos das cameras.
3. Criar caixas de CFTV/caixas hermeticas.
4. Vincular cameras a caixas.
5. Dentro da caixa colocar ONU/ONT, switch, injetor PoE, CTO ou outros itens.
6. Cameras ficam nas suas coordenadas reais.
7. Caixa fica no ponto de distribuicao.
8. Calcular cabos pela rota viaria, nao linha reta passando por casas.
9. Exportar KMZ com pastas separadas de cameras e caixas.
10. Gerar proposta e documento de rede em PDF.

Termo preferido: `Caixa de CFTV` ou `Caixa hermetica`, nao `caixa GPON`.

Arquivos principais:

```text
frontend/js/planning.js
app/api/endpoints/planning.py
app/services/planning_service.py
app/services/planning_pdf_report.py
scripts/plan_cctv_boxes.py
```

Tipos planejados:

```text
camera
onu
ont
olt
switch
injector
cto
recorder
box
pole
other
```

Catalogo de fabricantes/modelos:

- deve sugerir fabricantes/modelos conhecidos;
- deve permitir digitar fabricante/modelo novo;
- ao salvar, novo valor entra nas sugestoes do cliente;
- futuramente virar Configuracoes > Catalogo de equipamentos.

Calculo de cabos:

- usar percurso viario quando existir `route_distance_m`;
- linha reta e apenas referencia;
- instalado = percurso viario + margem + folga tecnica;
- compra = instalado + reserva;
- limite tecnico padrao do trecho instalado: 100 m;
- cabo entra na proposta como caixas de 305 m.

Documento de rede PDF:

- precisa parecer profissional;
- primeira pagina deve ter capa limpa, nao bloco verde grosseiro;
- restante deve ter tabelas alinhadas, fonte normal, resumo executivo, quantitativos, caixas, cameras, cabos e observacoes.

---

## Conectores MikroTik / RouterOS

Conectores representam o acesso remoto do cliente/site. Eles sao base do SaaS.

O fluxo deve favorecer:

- criar conector por cliente/site;
- verificar heartbeat/online;
- executar tarefas remotas;
- usar conector como origem para OLT, ONU, CFTV e gravadores.

Na implantacao, o conector deve vir primeiro. So depois de selecionar origem/conector e que a OLT ou dados dependentes ficam habilitados.

Em ambientes locais sem conector, pode existir modo `Local / VPN do servidor`, mas no SaaS o caminho natural sera conector.

---

## Gravadores e CFTV

Conceito aprovado:

1. Cadastra ONU.
2. A ONU libera rede para os dispositivos pegarem IP.
3. Vai em Gravadores, informa DVR/NVR, usuario/senha e salva no inventario.
4. No CFTV, o campo host do gravador deve listar os DVR/NVR cadastrados e acessiveis.
5. CFTV usa conector/site e depois camera/gravador.

Gravadores devem seguir o mesmo conceito de conectores/site/fluxo guiado.

Inventario de gravadores precisa mostrar:

- canais ocupados e livres;
- modelos das cameras quando disponiveis;
- snapshots;
- canais livres no topo quando isso ajuda o tecnico;
- destino do inventario (`Basico`, `OLT`, `Switch`) sem mandar para lugar errado.

---

## Inventario Cameras IP

Pontos importantes:

- manter modos `basico`, `olt`, `switch` separados;
- status e snapshot devem aparecer na linha e no drawer lateral;
- camera deve mostrar PON/ONU, ONU serial e estado da ONU quando existir vinculo;
- se camera esta offline mas ONU esta up, mostrar isso claramente;
- se ONU nao foi verificada, indicar e orientar a atualizar monitoramento;
- quando OLT muda PON/ONU apos exclusao e readicao, inventario de cameras precisa atualizar o vinculo pelo serial/MAC e nao ficar preso no nome antigo.

Snapshots:

- nao depender apenas de cache por IP;
- salvar por chave logica quando existir;
- relatorio de Cameras IP ja teve problema travando a aplicacao e deve ser revisado antes de uso pesado.

---

## Configuracoes

Configuracoes foi reorganizado como console administrativo SaaS:

- Visao geral;
- Clientes;
- Usuarios e acessos;
- Notificacoes;
- Plataforma e seguranca.

Ainda e importante manter alinhamento entre menu lateral e painel principal. O usuario rejeita quando o painel fica mais alto/baixo ou deslocado em relacao ao menu.

Telegram:

- token do bot;
- chat/grupo;
- alerta ONU RX;
- critico ONU RX;
- notificacoes ativas;
- avisar recuperacao;
- enviar teste.

---

## Pendencias e riscos conhecidos

Itens tecnicos importantes:

- trocar senha do Postgres se ja vazou em saida de terminal antiga;
- definir `SIGHTOPS_SECRET_KEY` em producao;
- incluir `data/secret.key` no backup, pois sem ela as senhas cifradas de OLT nao voltam;
- resolver volume do nginx no compose principal para nao depender de override;
- jobs em memoria nao sobrevivem a reinicio nem a multiplas instancias;
- testes ainda sao limitados para Postgres real;
- relatorios de Cameras IP podem travar e precisam revisao;
- FiberHome ainda precisa consolidar VLAN/MAC em todos os cenarios;
- catologo central de fabricantes/modelos ainda e futuro.

Itens de produto ja decididos para futuro:

- catalogo central de equipamentos por categoria/fabricante/modelo;
- MCP do SightOps, primeiro somente leitura, depois acoes remotas com permissao e auditoria;
- Zabbix e Grafana internos, sem expor para cliente final; o cliente ve paineis do SightOps;
- notificacoes via Telegram enquanto nao houver app mobile.

---

## Comandos de validacao uteis

Python:

```powershell
python -m py_compile app\api\endpoints\olt.py app\cli\tools\olt_fiberhome.py
python -m unittest scripts.sightops_fiberhome_driver_test
```

Frontend:

```powershell
node --check frontend\js\deployOlt.js
node --check frontend\js\planning.js
node --check frontend\js\dashboard.js
node --check frontend\js\monitoring.js
```

Git:

```powershell
git status --short
git diff --check
```

Deploy manual usado em varias correcoes:

```powershell
pscp frontend\index.html central@<SERVIDOR>:/home/central/sightops-frontend-html/v2/index.html
pscp frontend\styles.css central@<SERVIDOR>:/home/central/sightops-frontend-html/v2/styles.css
pscp frontend\js\deployOlt.js central@<SERVIDOR>:/home/central/sightops-frontend-html/v2/js/deployOlt.js

plink central@<SERVIDOR> "docker cp /home/central/olt.py sightops-api:/app/app/api/endpoints/olt.py && docker exec sightops-api python -m py_compile /app/app/api/endpoints/olt.py && docker restart sightops-api"
plink central@<SERVIDOR> "docker exec sightops-nginx nginx -t && docker exec sightops-nginx nginx -s reload"
```

Use os comandos reais com cuidado e sem expor senha em logs.

---

## Como pedir ajuda ao Claude

Exemplo de pedido bom:

```text
Leia este contexto do SightOps. Quero corrigir a tela X. Antes de mexer, localize os arquivos responsaveis com rg, explique o fluxo de dados frontend/backend, depois proponha uma correcao pequena seguindo o estilo atual. Nao misture os modos basico/olt/switch e nao use IP sozinho como identidade.
```

Exemplo para FiberHome:

```text
Quero melhorar a coleta FiberHome para preencher VLAN/MAC como a Intelbras. Leia `app/cli/tools/olt_fiberhome.py`, `app/services/olt_service.py` e `app/api/endpoints/olt.py`. Preserve o lock Telnet/admin, trate VLAN 65535 como sem VLAN real, use `show pon_mac` como fonte principal quando possivel e nao invente MAC/VLAN para ONU offline.
```

Exemplo para UI:

```text
Quero melhorar a tela sem mudar regra de negocio. Siga o estilo operacional do SightOps: botoes alinhados, tabela legivel, modal profissional, sem texto cortado e sem card dentro de card. Use os componentes/classes ja existentes antes de criar CSS novo.
```

