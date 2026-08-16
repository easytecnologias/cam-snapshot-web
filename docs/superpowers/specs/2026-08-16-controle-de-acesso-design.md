# Controle de Acesso — Design

## Contexto

O SightOps já tem um esqueleto do módulo "Controle de Acesso" rodando só em
homologação: CRUD de pessoas (aluno/funcionário/visitante) e um schema vazio
de `access_devices`. O dono do produto quer avançar pra dois objetivos:

1. **Liberar acesso aos dispositivos** — tanto provisionar a credencial da
   pessoa automaticamente na catraca quanto ter um botão de destravar manual.
2. **Avisar o responsável no WhatsApp quando o aluno não entrar na escola.**

Dispositivo de teste disponível: `10.10.13.33`, usuário `admin`, senha
`xzydsP2011`. Identificado ao vivo (auth Digest + `magicBox.cgi?action=getSystemInfo`):
**Dahua ASI6214S-W** — terminal de controle de acesso com reconhecimento
facial. Fala a API de Controle de Acesso da Dahua (`AccessUser` pra
cadastro de pessoa+foto, `AccessControl.openDoor` pra abrir remoto,
`eventManager.cgi?action=attach` pra push de evento em tempo real — não
usado nesta fase, ver "Fora de escopo").

O usuário quer filtros no estilo de sistema de controle de acesso "de
verdade": site, grupo de pessoas, grupo de portas, horário — não só
"pessoa pertence a um site, provisiona em tudo".

## Escopo

Dividido em duas fases por serem tecnicamente separáveis, mesmo
compartilhando a base de pessoas/dispositivos:

- **Fase 1 (este documento, a ser implementada agora):** integração real
  com o dispositivo — grupos, regras, provisionamento de credencial, abrir
  porta manual, ingestão de eventos de entrada/saída.
- **Fase 2 (fora de escopo desta implementação, desenhada em alto nível
  aqui pra não travar decisão de schema):** calendário letivo, horário de
  corte, job de ausência, fila e envio de WhatsApp. Depende da Fase 1
  existir (usa `access_events` e `access_people.site`), mas tem lógica de
  negócio e integração externa próprias — vira spec separada quando for
  a vez de implementar.

## Fase 1 — Modelo de dados

Tabelas novas em `app/services/access_control_store.py` (mesmo backend —
SQLite local / Postgres em produção — já usado por `db_store.py`), todas
com `tenant_slug` pra isolamento entre clientes, seguindo o padrão já
estabelecido no resto do sistema.

```sql
-- access_people ganha uma coluna nova:
ALTER TABLE access_people ADD COLUMN site TEXT NOT NULL DEFAULT '';

-- access_devices já existe (site, name, vendor, model, host, connector_id,
-- username) -- ganha campos de credencial/estado:
ALTER TABLE access_devices ADD COLUMN password_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE access_devices ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE access_devices ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';
ALTER TABLE access_devices ADD COLUMN last_event_id TEXT NOT NULL DEFAULT '';

CREATE TABLE access_groups (
  id TEXT PRIMARY KEY,
  tenant_slug TEXT NOT NULL,
  site TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE access_group_members (
  group_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (group_id, person_id)
);

CREATE TABLE access_door_groups (
  id TEXT PRIMARY KEY,
  tenant_slug TEXT NOT NULL,
  site TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE access_door_group_members (
  door_group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (door_group_id, device_id)
);

CREATE TABLE access_rules (
  id TEXT PRIMARY KEY,
  tenant_slug TEXT NOT NULL,
  people_group_id TEXT NOT NULL,
  door_group_id TEXT NOT NULL,
  weekdays TEXT NOT NULL DEFAULT '1234567',  -- dígitos 1(seg)..7(dom) presentes = liberado
  time_start TEXT NOT NULL DEFAULT '',       -- 'HH:MM', vazio = sem restrição
  time_end TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE access_events (
  id TEXT PRIMARY KEY,
  tenant_slug TEXT NOT NULL,
  site TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL,
  person_id TEXT NOT NULL DEFAULT '',        -- vazio = evento nao casou com pessoa cadastrada
  person_name_raw TEXT NOT NULL DEFAULT '',  -- nome que o equipamento reportou
  event_type TEXT NOT NULL,                  -- 'entrada' | 'saida' | 'negado'
  occurred_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_access_events_tenant_time ON access_events(tenant_slug, occurred_at DESC);
CREATE INDEX idx_access_events_person ON access_events(tenant_slug, person_id, occurred_at DESC);

CREATE TABLE access_provision_status (
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'ok' | 'failed'
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (person_id, device_id)
);
```

Senha do dispositivo cifrada com `app.core.crypto.encrypt`/`decrypt` — o
mesmo padrão já usado pra credencial de OLT/conector, não texto puro (achado
real da auditoria LGPD desta mesma sessão: DVR/NVR guardam senha em texto
puro por inconsistência, controle de acesso começa certo desde o início).

## Fase 1 — Cliente do dispositivo

Novo `app/services/access_control_device.py`, seguindo o padrão de
`olt_service.py`/`connector_service.py` (função pura por operação, sem
estado global):

```python
def _digest_session(device: dict) -> requests.Session: ...
def get_system_info(device: dict) -> dict: ...          # magicBox.cgi?action=getSystemInfo -- healthcheck
def provision_person(device: dict, person: dict, photo_bytes: bytes | None) -> dict: ...  # AccessUser.insertMulti
def remove_person(device: dict, person_id: str) -> dict: ...                              # AccessUser.removeMulti
def open_door(device: dict, channel: int = 1) -> dict: ...                                # AccessControl.openDoor
def poll_events(device: dict, since: str) -> list[dict]: ...                              # AccessControl.getRecordFile / getAllUserRecords
```

Erros da Dahua vêm com HTTP + corpo com o motivo real (ex: "device is
full", senha errada) — propagados como `HTTPException` com o texto da
catraca, não uma mensagem genérica (achado do próprio backlog: sem isso,
ninguém sabe se falhou por senha ou por catraca cheia).

## Fase 1 — API

Novos endpoints em `app/api/endpoints/access_control.py`:

```
GET/POST/DELETE /api/access-control/devices
GET/POST/DELETE /api/access-control/groups
GET/POST/DELETE /api/access-control/door-groups
GET/POST/DELETE /api/access-control/rules
POST            /api/access-control/devices/{id}/open-door
POST            /api/access-control/people/{id}/sync
GET             /api/access-control/events         -- filtro por pessoa/site/data
```

## Fase 1 — Fluxo de provisionamento

Ao salvar uma pessoa, ou mudar membership de grupo, ou criar/editar uma
regra: resolve `pessoa -> grupos -> regras ativas -> grupos de porta ->
dispositivos`, grava `access_provision_status` como `pending` pra cada
par (pessoa, dispositivo) alvo, e dispara `provision_person()` em
background (não bloqueia a resposta do salvar). Falha marca `failed` com
o erro real; sucesso marca `ok`. Uma rotina periódica (mesmo padrão de
retry/loop já usado no projeto pra OLT/Zabbix) re-tenta os `pending`/
`failed` a cada ciclo, sem intervenção manual.

## Fase 1 — Ingestão de eventos

Loop periódico (1-2 min, mesmo padrão de `_olt_telemetry_loop`/
`_zabbix_status_sync_loop` já existentes) busca eventos novos de cada
dispositivo ativo via `poll_events(device, since=last_event_id)` e grava
em `access_events`, casando por `person_id` quando possível (fallback:
grava com `person_name_raw` e `person_id` vazio).

**Fora de escopo desta fase:** push em tempo real via
`eventManager.cgi?action=attach` (exigiria conexão HTTP mantida aberta
por dispositivo — infraestrutura nova que o projeto não tem hoje; nenhum
caso de uso da Fase 1 ou 2 precisa de latência sub-minuto).

## Fase 1 — Frontend

Dentro da view "Controle de Acesso", abas novas ao lado de "Pessoas":

- **Dispositivos** — cadastrar catraca (site, nome, host, usuário/senha,
  conector se remoto), status online/offline, botão "Abrir agora".
- **Grupos** — grupo de pessoas e grupo de portas lado a lado.
- **Regras** — montar grupo de pessoas × grupo de portas × dias/horário.

Na ficha de pessoa: lista de grupos que ela pertence e status de
sincronização por dispositivo (sincronizado / pendente / falhou + motivo).

## Fase 1 — Testes

Seguindo `scripts/sightops_access_control_*_test.py` já existente:
regressão de resolução de regra (pessoa → grupo → regra → grupo de porta
→ dispositivo), parser de evento de entrada/saída, e mock do cliente
Dahua pra não depender do equipamento real rodando durante o teste.

## Fase 2 — Notificação de ausência (visão geral, não implementada agora)

- Calendário letivo por tenant (dias letivos, feriados, recesso).
- Horário de corte (por padrão, um só; expansível pra turno depois).
- Job diário: pra cada aluno ativo com `whatsapp_enabled`, se hoje é dia
  letivo e não existe `access_events` tipo 'entrada' antes do corte,
  enfileira mensagem pro `guardian_phone`.
- Envio de WhatsApp atrás de uma interface única
  (`app/services/whatsapp_notification_service.py`, espelhando
  `telegram_notification_service.py` já existente) — implementação
  inicial via gateway não-oficial self-hosted (ex: Evolution API, Docker,
  mesmo padrão de deploy já usado nesse servidor) pra validar o fluxo
  inteiro com o cliente de teste sem custo/burocracia de conta comercial.
  Antes de oferecer isso pra clientes pagantes de verdade, migrar o envio
  pra API oficial (Meta Cloud API, provavelmente via um BSP brasileiro tipo
  Zenvia pra simplificar cobrança/homologação de template) — a troca fica
  isolada nessa uma função, sem tocar no calendário/corte/fila.

## Não reverter / decisões que não são pra desfazer sem motivo novo

- Senha de dispositivo de controle de acesso cifrada desde o início — não
  seguir o padrão (ruim) de DVR/NVR que guardam em texto puro.
- Provisionamento em background, nunca bloqueando o salvar da pessoa —
  catraca offline não pode travar cadastro.
- Erro da catraca propagado com o texto real, não mensagem genérica.
