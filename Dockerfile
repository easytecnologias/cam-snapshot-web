FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg openssh-client sshpass \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# --no-access-log: o access log padrao do uvicorn grava a query string
# inteira (inclusive live_token, ver app/api/endpoints/live.py) no log do
# container. O RequestContextMiddleware (app/core/observability.py) ja
# loga toda requisicao de forma estruturada (path, status, elapsed_ms,
# request_id) sem a query string -- nao perde visibilidade nenhuma, so
# para de duplicar o log com uma versao que vaza token.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
