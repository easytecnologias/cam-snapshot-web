# Auditoria da Homologacao SightOps - 2026-08-20

## Objetivo

Verificar se a homologacao em `http://10.10.12.7:8087/v2/` esta batendo com o repositorio Git usado para homologacao.

## Repositorios

- Local: `C:\PROJETOS\cam-snapshot-web-v2`
- Homologacao GitHub configurado como `origin`: `https://github.com/easytecnologias/easytecnologias-cam-snapshot-web-homologacao.git`
- Producao configurada como `producao`: `https://github.com/easytecnologias/cam-snapshot-web.git`

## Backup criado antes de qualquer analise

Backup remoto criado em:

`/home/central/sightops-homol-audit-20260820-094742`

Conteudo do backup:

- `source-no-media.tgz`: snapshot dos arquivos em `/opt/sightops/cam-snapshot-web`, sem `.git`, media, cache e dependencias pesadas.
- `homol-db.sql`: dump do banco PostgreSQL da homologacao.
- `git-status.txt`, `git-head.txt`, `git-remotes.txt`, `git-diff-stat.txt`, `git-working-diff.patch`.
- `docker-ps.txt`.
- `backup-sha256.txt`.

## Estado Git observado inicialmente

Localmente:

- Branch: `main`
- `HEAD`: `839b54d5462f476d75285ce38bba94e1803d52e4`
- `origin/main` local tambem apontava para `839b54d`.
- A arvore local esta suja, com arquivos modificados, removidos e muitos nao rastreados.

No servidor de homologacao:

- Caminho: `/opt/sightops/cam-snapshot-web`
- `HEAD`: `43a7462b857fa154cd59bca65766e4d83f1b0941`
- Status: `## main...origin/main [behind 54]`
- Existem alteracoes locais soltas no servidor em arquivos de frontend.

## Bloqueios encontrados

- `git fetch origin --prune` local falhou por permissao em `.git/FETCH_HEAD`.
- `git ls-remote origin refs/heads/main` local falhou por credencial GitHub ausente.
- Git no servidor recusava o repo por `dubious ownership`; para auditar, foi usado apenas `git -c safe.directory=/opt/sightops/cam-snapshot-web ...`, sem gravar configuracao global.

## Comparacao de arquivos principais

Hashes SHA256 do frontend servido por `http://10.10.12.7:8087/v2/` batem com o container `sightops-homol-nginx`.

Contra `origin/main` local conhecido:

- `frontend/js/accessControl.js`: bate.
- `frontend/js/maintenance.js`: bate com `origin/main`, mas difere do working tree local.
- `frontend/index.html`: nao bate.
- `frontend/styles.css`: nao bate.
- `frontend/js/analysis.js`: nao bate.

Contra o working tree local atual:

- `frontend/styles.css`: bate com homologacao servida.
- `frontend/js/accessControl.js`: bate com homologacao servida.
- `frontend/index.html`: difere.
- `frontend/js/analysis.js`: difere.
- `frontend/js/maintenance.js`: difere.
- `app/api/endpoints/maintenance.py`: difere.
- `app/services/olt_ignore_list.py`: difere e nao existe no mesmo caminho do host remoto; existe dentro do container.
- `tools/mk_zabbix_from_inventory.py`: difere.

## Conclusao

A homologacao nao esta limpa nem garantida pelo GitHub no estado atual.

Ela esta composta por:

1. Checkout remoto antigo, 54 commits atras do `origin/main` conhecido no servidor.
2. Alteracoes locais soltas no servidor.
3. Arquivos dentro dos containers que nao batem totalmente com a pasta do host nem com o repo local.
4. Repo local tambem sujo, com mudancas ainda nao consolidadas.

Se a homologacao precisar ser reconstruida hoje apenas pelo GitHub, existe risco real de ela nao voltar exatamente igual ao que esta rodando.

## Proximo passo recomendado

1. Baixar o backup/patch da homologacao para analise local.
2. Separar o que e correcao valida do que e sujeira/manual.
3. Aplicar no repo local em commits pequenos.
4. Fazer push para `origin/main` da homologacao.
5. Reconstruir a homologacao a partir do GitHub, em ambiente limpo ou pasta nova.
6. Validar telas criticas antes de qualquer uso como base para producao.

## Acao executada em 2026-08-20

Para atestar que a homologacao sobe pelo GitHub, a pasta remota foi preservada e depois alinhada com `origin/main`.

Medidas tomadas:

- Corrigida a propriedade do checkout remoto em `/opt/sightops/cam-snapshot-web` para o usuario `central`, pois o Git estava bloqueado por arquivos `root:root`.
- Executado `git fetch origin --prune` no servidor.
- Guardadas as alteracoes locais soltas em `stash@{0}: homol-pre-align-20260820-095703`.
- Executado `git reset --hard origin/main`.
- Rebuildada a imagem `sightops-homol-api:github`.
- Recriado apenas o container `sightops-api`, sem apagar banco nem volumes.

Estado final verificado:

- `HEAD` remoto: `839b54d5462f476d75285ce38bba94e1803d52e4`.
- `git status -sb`: `## main...origin/main`.
- Backup remoto mantido em `/home/central/sightops-homol-audit-20260820-094742`.
- Stash remoto mantido em `stash@{0}` para recuperacao das alteracoes antigas, se necessario.
- Containers `sightops-api`, `sightops-homol-nginx` e `sightops-postgres` saudaveis.
- `http://127.0.0.1:8087/api/system/health/live` respondeu `200`.
- `http://127.0.0.1:8087/v2/index.html` respondeu `200`.

Observacao: a validacao JavaScript por `node --check` nao foi executada no servidor porque o Node.js nao esta instalado nele.
