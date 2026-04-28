# Cam-Snapshot - IA Starter

Este pacote adiciona IA leve e offline ao fluxo sem quebrar nada:

- OCR/heurística para preencher `modelo`/`fabricante`.
- Métricas de qualidade e anomalias simples.
- Infra de pHash (integração com uploader em próxima etapa).

## Como usar agora

Após gerar `saida/cam-inventory.csv` e `saida/snapshot/`:

```bash
python tools/ai_enrich.py --csv saida/cam-inventory.csv --snapshot saida/snapshot --out saida/cam-inventory.ai.csv
```

Isso cria `saida/cam-inventory.ai.csv` com colunas extras:
`fabricante, modelo, quality, blur_score, exposure, black_pct, anomalia`.

Se tiver `pytesseract` instalado, o OCR melhora. Sem ele, já usa regex.
