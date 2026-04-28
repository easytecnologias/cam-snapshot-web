# Guia de Implantação em Produção

## SightOps Cam Snapshot + PostgreSQL + Zabbix + Grafana + Portainer

Este guia descreve a instalação completa em um servidor Ubuntu recém-instalado.

Use este passo a passo quando for replicar o ambiente em um computador novo.

## 1. Premissas

- Servidor Ubuntu limpo.
- Acesso SSH ao servidor.
- Usuário com permissão `sudo`.
- Acesso à internet para baixar pacotes e imagens Docker.
- Repositório do projeto:

```text
https://github.com/easytecnologias/cam-snapshot-web.git
```

## 2. Atualizar o servidor

```bash
sudo apt update
sudo apt upgrade -y
sudo reboot
```

Após o reboot, conecte novamente via SSH.

## 3. Instalar pacotes básicos

```bash
sudo apt install -y ca-certificates curl gnupg git nano ufw
```

## 4. Instalar Docker oficial

Criar diretório de chaves:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
```

Baixar chave GPG do Docker:

```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
```

Ajustar permissão:

```bash
sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

Adicionar repositório Docker:

```bash
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Instalar Docker:

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Ativar Docker:

```bash
sudo systemctl enable --now docker
```

Testar:

```bash
sudo docker version
sudo docker compose version
```

## 5. Liberar Docker para o usuário atual

```bash
sudo usermod -aG docker $USER
```

Saia do SSH e entre novamente.

Teste:

```bash
docker ps
```

## 6. Configurar firewall

Liberar as portas principais:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 8081/tcp
sudo ufw allow 10051/tcp
sudo ufw allow 9000/tcp
sudo ufw allow 9443/tcp
sudo ufw enable
```

Verificar:

```bash
sudo ufw status
```

Portas utilizadas:

| Serviço | Porta |
| --- | --- |
| SightOps | 80 |
| Grafana | 3000 |
| Zabbix Web | 8081 |
| Zabbix Server | 10051 |
| Portainer HTTP | 9000 |
| Portainer HTTPS | 9443 |

## 7. Instalar Portainer

Criar volume:

```bash
docker volume create portainer_data
```

Subir Portainer:

```bash
docker run -d \
  --name portainer \
  --restart=unless-stopped \
  -p 9000:9000 \
  -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Acesse:

```text
http://IP_DO_SERVIDOR:9000
```

Ou:

```text
https://IP_DO_SERVIDOR:9443
```

Na primeira entrada, crie o usuário administrador do Portainer.

## 8. Criar pasta de instalação

```bash
sudo mkdir -p /opt/sightops
sudo chown -R $USER:$USER /opt/sightops
cd /opt/sightops
```

## 9. Clonar o projeto

```bash
git clone https://github.com/easytecnologias/cam-snapshot-web.git
cd cam-snapshot-web
```

## 10. Criar arquivo de ambiente

```bash
cp .env.platform.example .env.platform
nano .env.platform
```

Edite principalmente:

```env
TZ=America/Sao_Paulo
APP_ENV=production
ENABLE_DOCS=0
AUTH_REQUIRED=1
AUTH_LEGACY_OPEN=0

SIGHTOPS_HTTP_PORT=80
ZABBIX_WEB_PORT=8081
ZABBIX_SERVER_PORT=10051
GRAFANA_PORT=3000

ALLOWED_ORIGINS=http://IP_DO_SERVIDOR
TRUSTED_PROXIES=127.0.0.1

SIGHTOPS_DB_PASSWORD=SENHA_FORTE_SIGHTOPS
ZABBIX_DB_PASSWORD=SENHA_FORTE_ZABBIX
GRAFANA_ADMIN_PASSWORD=SENHA_FORTE_GRAFANA
```

Exemplo:

```env
ALLOWED_ORIGINS=http://10.10.12.7
```

## 11. Subir a stack completa

Este comando sobe:

- Cam Snapshot Web
- PostgreSQL do SightOps
- Nginx
- Zabbix Server
- Zabbix Web
- PostgreSQL do Zabbix
- Zabbix Agent 2
- Grafana

```bash
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  up -d --build
```

## 12. Verificar containers

```bash
docker ps
```

Você deve ver containers parecidos com:

```text
sightops-api
sightops-nginx
sightops-postgres
zabbix-postgres
zabbix-server
zabbix-web
zabbix-agent2
grafana
portainer
```

## 13. Acessar os serviços

Substitua `IP_DO_SERVIDOR` pelo IP real.

```text
SightOps:  http://IP_DO_SERVIDOR/
Grafana:   http://IP_DO_SERVIDOR:3000/
Zabbix:    http://IP_DO_SERVIDOR:8081/
Portainer: http://IP_DO_SERVIDOR:9000/
```

## 14. Login inicial

SightOps:

```text
Usuário: admin_teste
Senha: admin_teste
```

Após entrar, troque a senha.

Grafana:

```text
Usuário: admin
Senha: a senha definida em GRAFANA_ADMIN_PASSWORD
```

Zabbix:

```text
Usuário: Admin
Senha: zabbix
```

Após entrar, troque a senha.

Portainer:

```text
Usuário: criado na primeira entrada
Senha: criada na primeira entrada
```

## 15. Comandos úteis

Logs da API:

```bash
docker logs -f sightops-api
```

Logs do Nginx:

```bash
docker logs -f sightops-nginx
```

Logs do Zabbix:

```bash
docker logs -f zabbix-server
```

Logs do Grafana:

```bash
docker logs -f grafana
```

Reiniciar a stack:

```bash
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  restart
```

Parar a stack:

```bash
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  down
```

Subir novamente:

```bash
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  up -d
```

## 16. Atualizar o sistema

```bash
cd /opt/sightops/cam-snapshot-web
git pull
```

Recriar containers:

```bash
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  up -d --build
```

## 17. Backup básico

Criar pasta:

```bash
sudo mkdir -p /opt/sightops/backups
```

Backup da pasta do projeto:

```bash
tar -czf /opt/sightops/backups/cam-snapshot-web-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /opt/sightops cam-snapshot-web
```

Para backup frio dos volumes, pare primeiro:

```bash
cd /opt/sightops/cam-snapshot-web

docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  down
```

Compacte os volumes:

```bash
sudo tar -czf /opt/sightops/backups/docker-volumes-$(date +%Y%m%d-%H%M%S).tar.gz \
  /var/lib/docker/volumes
```

Suba novamente:

```bash
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  up -d
```

## 18. Instalação pelo Portainer

Depois que o Portainer estiver funcionando, também é possível criar a stack pela interface:

1. Acesse `http://IP_DO_SERVIDOR:9000`.
2. Entre no ambiente local.
3. Vá em `Stacks`.
4. Clique em `Add stack`.
5. Nome da stack: `sightops-platform`.
6. Escolha `Repository`.
7. Repository URL:

```text
https://github.com/easytecnologias/cam-snapshot-web.git
```

8. Branch:

```text
main
```

9. Compose path:

```text
docker-compose.platform.yml
```

10. Adicione as variáveis de ambiente conforme `.env.platform.example`.
11. Clique em `Deploy the stack`.

Observação: esse modo usa imagem pronta, se `CAM_SNAPSHOT_IMAGE` estiver apontando para registry. Para instalação inicial, o modo via terminal com `docker-compose.platform.build.yml` é o mais simples.

## 19. Comando principal para replicar

Sempre que instalar em um servidor novo, o comando mais importante é:

```bash
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  up -d --build
```

## 20. Checklist final

- Docker instalado.
- Portainer acessível.
- Projeto clonado em `/opt/sightops/cam-snapshot-web`.
- `.env.platform` configurado.
- Stack rodando.
- SightOps acessível na porta 80.
- Grafana acessível na porta 3000.
- Zabbix acessível na porta 8081.
- Senhas padrão trocadas.
- Backup configurado.
