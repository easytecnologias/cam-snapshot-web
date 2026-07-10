---
description: Audita o SightOps inteiro (backend, frontend, Docker, conectores) e revisa as mudanças recentes (diff não commitado + commits ainda não enviados).
allowed-tools: Read, Grep, Glob, Bash
---

Use a skill `sightops-audit` para analisar o projeto SightOps (`C:\PROJETOS\cam-snapshot-web-v2`) completo.

Tarefa:
1. Primeiro rode `git status`, `git diff` e `git log --oneline -30` no repositório para entender o que mudou (working tree sujo e commits ainda não enviados ao origin).
2. Para cada mudança, avalie se é consistente com o resto do sistema (rotas ↔ frontend, auth, schema, jobs em background).
3. Mapeie a arquitetura geral: backend FastAPI (`app/`), frontend Vue (`frontend/`), Docker Compose de produção, conectores (OLT, RouterOS/WireGuard, câmeras).
4. Procure bugs reais e inconsistências entre arquivos, com foco extra em regressões causadas pelas mudanças recentes.
5. Verifique segurança: auth, permissões, validação, variáveis de ambiente, segredos soltos na raiz do repo, CORS, logs, tratamento de erro.
6. Rode apenas comandos seguros e não destrutivos.
7. Entregue relatório priorizado com severidade, evidência, impacto e correção, seguindo o formato da skill `sightops-audit`.

Importante:
- Não altere arquivos nesta primeira auditoria.
- Não exponha segredos reais; se encontrar credencial, mascare.
- Seja específico com arquivo e linha.
