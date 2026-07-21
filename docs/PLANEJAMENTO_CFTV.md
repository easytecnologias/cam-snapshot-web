# Planejamento de projetos de CFTV

O menu `Implantacao -> Projetos` permite desenhar um parque antes de existir
camera, ONU, OLT, switch ou gravador instalado.

## Regra principal

Todo equipamento criado nesse menu tem estado `planned`. Ele fica nas tabelas
`planning_*` e **nao entra** no inventario, dashboard, Zabbix ou monitoramento.
Isso evita que um projeto futuro apareca como centenas de equipamentos offline.

## Formas de entrada

- Cadastro manual de camera, ONU/ONT, OLT, switch, gravador, caixa e poste.
- Geracao em lote por IP inicial, quantidade e mascara de nome.
- CSV, com delimitador virgula, ponto e virgula ou tabulacao.
- KMZ: pontos podem virar cameras planejadas; linhas e areas permanecem como
  referencia visual no mapa.

Colunas reconhecidas no CSV:

```text
tipo;nome;ip;site;fabricante;modelo;pon;onu;latitude;longitude;imagem;observacoes
```

Somente `nome` e obrigatorio. Quando a coluna `site` traz um nome ainda
inexistente, o site e criado dentro do projeto.

## Hierarquia

O campo `Ligado a` permite montar mais de um site e mais de uma arvore no mesmo
projeto, por exemplo:

```text
OLT A -> ONU A -> Camera 01
                -> Camera 02
OLT B -> ONU B -> Switch A -> Camera 03
```

## Imagens

O campo `Imagem de referencia` aceita a URL de uma foto do fabricante ou outra
imagem publica. A interface sempre a identifica como **imagem ilustrativa do
modelo**; ela nunca e tratada como snapshot real da camera.

## Evolucao prevista

A conversao de um projeto aprovado para o fluxo de implantacao deve ser uma
acao explicita e auditada. Essa conversao ainda nao foi liberada para impedir
que um rascunho altere o inventario operacional por engano.
