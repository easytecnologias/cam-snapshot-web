# Controle de Acesso - Relatorios de entrada e saida

## Contexto

O modulo Controle de Acesso ja possui cadastro de pessoas, dispositivos,
grupos, regras e uma tabela `access_events`. A necessidade agora e transformar
esses eventos em relatorios operacionais para escolas: saber quem entrou, quem
saiu, quem ainda esta dentro e qual evento deve gerar aviso para os pais.

O primeiro cenario aprovado e: a entrada acontece automaticamente pelo
reconhecimento facial na controladora, e a saida pode ser registrada por um
botao manual no SightOps. A ressalva aprovada e que alguns clientes terao duas
controladoras fisicas: uma configurada como entrada e outra como saida.

## Comportamento desejado

Cada dispositivo de controle de acesso tera um papel operacional:

- `entrada`: eventos vindos dele entram no relatorio como entrada.
- `saida`: eventos vindos dele entram no relatorio como saida.
- `entrada_saida`: usado quando o equipamento ou firmware informa o sentido do
  evento; se nao informar, o fallback sera entrada para manter o comportamento
  atual dos equipamentos ja homologados.

Quando nao existir controladora de saida, o operador podera usar um botao
`Registrar saida` no SightOps. Esse evento sera salvo como `saida_manual`, com
usuario operador, pessoa, data/hora e observacao opcional.

## Dados e isolamento

Todos os dados devem continuar isolados por tenant. Nenhum evento, pessoa,
dispositivo ou relatorio pode ser buscado apenas por IP, porque IP privado se
repete entre clientes.

O relatorio usara `access_events` como fonte principal e podera precisar destes
campos novos ou normalizados:

- `event_type`: `entrada`, `saida` ou `saida_manual`.
- `source`: `device` ou `manual`.
- `device_id`, `device_name` e `device_role`.
- `person_id`, `person_name`, `person_type`, `student_class` e `site`.
- `operator_user` e `manual_reason` para saida manual.
- `notification_status` para indicar WhatsApp pendente/enviado/erro quando a
  fila for homologada.
- `raw_event_id` e `raw_payload` para deduplicar eventos coletados dos
  equipamentos.

O cadastro de dispositivo devera expor o papel operacional. A migracao precisa
assumir `entrada` para dispositivos existentes, evitando quebrar clientes ja
criados.

## Relatorio

Criar uma aba `Relatorios` dentro de Controle de Acesso.

Filtros esperados:

- Periodo: hoje, ontem, ultimos 7 dias e intervalo personalizado.
- Site.
- Turma.
- Pessoa.
- Dispositivo/portaria.
- Tipo: entrada, saida, saida manual, todos.

Indicadores no topo:

- Entradas no periodo.
- Saidas no periodo.
- Saidas manuais no periodo.
- Pessoas presentes agora.
- Eventos sem pessoa vinculada.

Tabela do relatorio:

- Data/hora.
- Tipo.
- Pessoa.
- Turma.
- Site.
- Dispositivo/portaria.
- Origem: equipamento ou manual.
- Operador, quando manual.
- Status WhatsApp.

## Presenca atual

A lista de "presentes agora" sera calculada pelo ultimo evento valido de cada
pessoa no periodo operacional:

- ultimo evento `entrada` => pessoa dentro.
- ultimo evento `saida` ou `saida_manual` => pessoa fora.

Esse calculo deve ser backend, para dashboard e relatorio exibirem os mesmos
numeros.

## Saida manual

O botao `Registrar saida` deve abrir um modal simples:

- Pessoa obrigatoria.
- Site opcional, preenchido pela pessoa quando existir.
- Observacao opcional.

Ao salvar, o backend cria um evento `saida_manual`. Nao deve chamar o
equipamento fisico; e somente um registro operacional.

## WhatsApp

Nesta etapa o relatorio so precisa carregar o campo de status da notificacao.
A fila de WhatsApp pode ser ligada depois. Quando a fila existir:

- Entrada automatica pode gerar aviso de entrada.
- Saida por controladora pode gerar aviso de saida.
- Saida manual pode gerar aviso de saida manual.

## Multi-marca

O parser de eventos deve ser isolado por fabricante/modelo. Intelbras sera o
primeiro caminho homologado, mas a estrutura deve permitir Control iD,
Hikvision, Dahua e outros sem mudar a tela de relatorios.

Cada adapter deve devolver eventos normalizados com:

- `raw_event_id`.
- `occurred_at`.
- `person_ref` ou `person_name`.
- `event_type`, quando o equipamento informar.
- `device_id`.
- `raw_payload`.

Se o equipamento nao informar o sentido, o backend aplica o papel do
dispositivo.

## Testes e validacao

Testes minimos:

- Migracao cria papel `entrada` nos dispositivos existentes.
- Evento de dispositivo `entrada` entra como entrada.
- Evento de dispositivo `saida` entra como saida.
- Evento manual cria `saida_manual` sem chamar equipamento.
- Resumo conta entradas, saidas, saidas manuais e presentes corretamente.
- Tenant A nao enxerga eventos, pessoas ou dispositivos do Tenant B.
- Frontend carrega a aba Relatorios e filtra sem quebrar Pessoas,
  Dispositivos, Grupos e Regras.

Validacao em homologacao:

- Criar uma pessoa aluno.
- Criar uma controladora de entrada e outra de saida, ou simular os dois papeis
  com registros de evento.
- Confirmar que entrada automatica aparece no relatorio.
- Registrar saida manual e confirmar que a pessoa sai de "presentes agora".
- Confirmar que o dashboard nao mostra `Eventos hoje` zerado quando existem
  eventos no dia.
