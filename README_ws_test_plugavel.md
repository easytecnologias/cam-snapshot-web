# Teste simples plugável para /ws/scan (usando SEU frontend atual)

Este arquivo serve para você testar o WebSocket **usando a sua interface atual**, 
sem precisar de pasta `frontend` separada.

## Arquivos dentro do ZIP

- `ws_scan_test.py` → Contém uma rota `@router.websocket("/ws/scan")` que:
  - aceita a conexão,
  - envia 5 mensagens JSON `{ "type": "test", "step": N }` com 1s de intervalo,
  - fecha a conexão.

## Como usar no seu projeto

1. Encontre no SEU código o arquivo onde hoje existe a rota:

   ```python
   @router.websocket("/ws/scan")
   async def ws_scan(...):
       ...
   ```

   Pode estar em algo como:
   - `backend/api/routes/ws_inventory_scan.py`
   - ou `ws_scan.py`
   - ou outro arquivo parecido.

2. Faça backup:

   - Copie esse arquivo original para um lugar seguro:
     por exemplo, `cp ws_inventory_scan.py ws_inventory_scan.bak.py`

3. Substitua pelo teste:

   - Abra o arquivo original e APAGUE o conteúdo da função `ws_scan`.
   - Cole dentro dele o conteúdo de `ws_scan_test.py`.
   - Se já existir um `router = APIRouter()` nesse arquivo, mantenha o seu
     e APAGUE a linha `router = APIRouter()` do teste.
   - IMPORTANTE: não mude o path `"/ws/scan"`.

4. Reinicie o backend do seu projeto (do jeito que você sempre faz).

5. No navegador, com o SEU sistema aberto:

   - Aperte F12 → aba **Network** → filtro **Socket**.
   - Clique em **Iniciar varredura** (o mesmo botão que você usa hoje).
   - Clique na linha `scan` e vá na aba **Messages / Mensagens**.

   Se estiver tudo certo, você deverá ver algo assim:

   ```
   {"type":"test","step":0}
   {"type":"test","step":1}
   {"type":"test","step":2}
   ...
   ```

6. Interpretação:

   - SE as mensagens aparecerem:
     - O frontend está funcionando ✅
     - A rota /ws/scan está sendo chamada ✅
     - O problema está no SEU código de inventário real, que não está
       chamando `send_json`/`send_text` durante o scan.

   - SE as mensagens NÃO aparecerem (0 B transferidos):
     - O frontend não está conectando na mesma URL,
     - ou o include_router / path está diferente,
     - ou o backend nem está chegando na função.

7. Depois do teste:

   - Volte o arquivo original (ou o backup `.bak.py`) para restaurar
     o comportamento do seu inventário real.

Assim a gente testa o WebSocket **exatamente dentro do seu projeto atual**, 
sem precisar criar outro frontend.
