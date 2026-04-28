# Instalacao Rapida Em Ubuntu

Este modo foi criado para replicar a stack completa em servidores novos com o minimo de passos.

Ele instala ou valida:

- Docker oficial e plugin Docker Compose.
- Firewall com as portas usadas pela stack.
- Portainer.
- Clone ou atualizacao do repositorio.
- Arquivo `.env.platform` com senhas fortes geradas automaticamente.
- SightOps Cam Snapshot, PostgreSQL, Zabbix e Grafana.

## Comando Principal

Em um servidor Ubuntu recem-instalado, acesse via SSH e execute:

```bash
sudo apt update
sudo apt install -y curl
curl -fsSL https://raw.githubusercontent.com/easytecnologias/cam-snapshot-web/main/scripts/install-ubuntu-production.sh -o /tmp/sightops-install.sh
sudo bash /tmp/sightops-install.sh --ip IP_DO_SERVIDOR
```

Exemplo:

```bash
sudo apt update
sudo apt install -y curl
curl -fsSL https://raw.githubusercontent.com/easytecnologias/cam-snapshot-web/main/scripts/install-ubuntu-production.sh -o /tmp/sightops-install.sh
sudo bash /tmp/sightops-install.sh --ip 10.10.12.7
```

## Modo Build Local

Use quando quiser compilar a imagem no proprio servidor:

```bash
sudo bash /tmp/sightops-install.sh --ip 10.10.12.7 --build
```

O modo mais rapido para replicacao e sem `--build`, usando a imagem pronta do GHCR.

## Opcoes Uteis

```text
--ip IP_OU_HOST        Define o IP/host usado no ALLOWED_ORIGINS.
--dir CAMINHO         Define a pasta de instalacao.
--repo URL            Define outro repositorio Git.
--build               Builda a imagem localmente.
--no-portainer        Nao instala Portainer.
--force-env           Recria .env.platform e guarda backup do anterior.
```

## Acessos Apos Instalar

Troque `IP_DO_SERVIDOR` pelo IP real:

```text
SightOps:  http://IP_DO_SERVIDOR/
Grafana:   http://IP_DO_SERVIDOR:3000/
Zabbix:    http://IP_DO_SERVIDOR:8081/
Portainer: http://IP_DO_SERVIDOR:9000/
```

Login inicial do SightOps:

```text
usuario: admin_teste
senha: admin_teste
```

Troque essa senha depois do primeiro acesso.

## Onde Ficam As Senhas

O instalador gera senhas fortes automaticamente e salva em:

```text
/opt/sightops/cam-snapshot-web/.env.platform
```

Esse arquivo deve ser protegido e entrar na rotina de backup seguro.

## Quando Usar O Guia Manual

Use `docs/GUIA_INSTALACAO_UBUNTU_PRODUCAO.txt` quando quiser aprender cada etapa.

Use este guia rapido quando quiser replicar instalacoes com velocidade e padrao.
