# Auth Roadmap

Esta etapa cria a base de seguranca comercial do sistema:

- tenants
- usuarios
- tokens bearer
- auditoria basica
- banco dedicado de auth (`data/auth.db` por padrao)

## O que ja entrou

- bootstrap do primeiro admin
- login/logout
- consulta do usuario autenticado
- criacao de usuarios por `owner/admin`
- trilha de auditoria basica
- RBAC inicial por perfil:
  - `viewer`: leitura
  - `operator`: operacao e varredura
  - `admin`: configuracao e administracao tecnica
  - `owner`: governanca total
- isolamento inicial por tenant:
  - inventario IP tenant-aware
  - configuracoes tenant-aware
  - inventario DVR/NVR tenant-aware
  - snapshots DVR/NVR tenant-aware
  - logos de relatorio tenant-aware
  - workspace de KMZ/importacao tenant-aware
- auth agora pode operar em `sqlite` ou `postgres`, mantendo as mesmas rotas da API

## O que ainda falta para fechar a camada de produto

1. aplicar protecao nas rotas legadas por perfil
2. ligar o frontend ao fluxo de login
3. amarrar dados operacionais por tenant
4. criar reset de senha e revogacao de usuarios
5. adicionar expiracao e rotacao mais forte de tokens
