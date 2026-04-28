# Estrutura do projeto (limpa)

A ideia é separar **biblioteca**, **ferramentas** e **interface web** sem duplicação.

```
cam-snapshot-web/
  api.py                 # FastAPI (servidor web)
  camsnapshot/           # biblioteca (funções reutilizáveis)
  tools/                 # ferramentas CLI (chamam a biblioteca)
  web/                   # frontend (HTML/CSS/JS)
  entrada/               # (opcional) insumos
  saida/                 # gerados automaticamente (inventário, kmz, etc.)
  scripts/               # scripts de manutenção (cleanup, etc.)
  docs/                  # documentação
  config/                # arquivos de exemplo
  requirements.txt
  .env.example
```

## Regras

- **Não existe mais `src/`**: tudo que era CLI/script fica em `tools/`.
- `camsnapshot/` deve conter apenas código reutilizável (sem I/O “hardcoded” quando possível).
- `saida/` é descartável: pode apagar e recriar.
- `.githooks/` é opcional (só se usar Git).
