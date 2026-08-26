"""Importacao de alunos por planilha.

Cobre o que quebra na vida real com planilha de secretaria: coluna com nome
diferente, matricula que veio como numero do Excel, telefone em formatos
variados, matricula repetida no proprio arquivo, e reimportacao da lista
corrigida -- que precisa atualizar, nao duplicar.
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
from pathlib import Path


def planilha(linhas: list[list], nome_aba: str = "Alunos") -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    aba = wb.active
    aba.title = nome_aba
    for linha in linhas:
        aba.append(linha)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATA_DIR"] = tmp
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-import.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-import-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_import import analisar_planilha, aplicar_planilha
        from app.services.access_control_store import ensure_access_control_schema, list_people

        token = set_current_tenant_slug("escola-import")
        try:
            ensure_access_control_schema()

            # --- cabecalho com nomes que uma secretaria usaria, fora de ordem,
            #     com acento e maiuscula
            arquivo = planilha([
                ["Turma", "Matrícula", "Nome do Aluno", "Celular do Responsável", "Responsável"],
                ["5A", 1577, "ADRIEL FONSECA", "(82) 99999-0000", "MARIA FONSECA"],
                ["5A", 1578, "BRENO ANJOS", "82 98888-7777", "JOSE ANJOS"],
                ["5B", 1579, "CLARA LIMA", "", "ANA LIMA"],          # sem telefone: entra assim mesmo
            ])
            analise = analisar_planilha(arquivo, site="ESCOLA TESTE")
            assert analise["total_linhas"] == 3, analise
            assert len(analise["criar"]) == 3, analise["criar"]
            assert not analise["atualizar"], analise["atualizar"]
            assert not analise["recusados"], analise["recusados"]
            assert analise["sem_telefone"] == 1, analise

            # matricula numerica do Excel nao pode virar "1577.0"
            assert analise["criar"][0]["enrollment_code"] == "1577", analise["criar"][0]
            # telefone normalizado com DDI
            assert analise["criar"][0]["guardian_phone"] == "5582999990000", analise["criar"][0]
            assert analise["criar"][1]["guardian_phone"] == "5582988887777", analise["criar"][1]

            # --- analisar nao grava nada
            assert len(list_people()) == 0, list_people()

            resultado = aplicar_planilha(arquivo, site="ESCOLA TESTE")
            assert resultado["criados"] == 3, resultado
            assert resultado["atualizados"] == 0, resultado
            pessoas = list_people()
            assert len(pessoas) == 3, [p["full_name"] for p in pessoas]

            # --- reimportar a lista corrigida: atualiza, nao duplica
            corrigida = planilha([
                ["Matrícula", "Nome do Aluno", "Telefone", "Turma"],
                [1577, "ADRIEL FERNANDO FONSECA", "82999990000", "6A"],   # nome e turma corrigidos
                [1579, "CLARA LIMA", "82977776666", "5B"],                # ganhou telefone
                [1580, "DAVI SANTOS", "82966665555", "6A"],               # aluno novo
            ])
            analise2 = analisar_planilha(corrigida, site="ESCOLA TESTE")
            assert len(analise2["atualizar"]) == 2, analise2["atualizar"]
            assert len(analise2["criar"]) == 1, analise2["criar"]

            resultado2 = aplicar_planilha(corrigida, site="ESCOLA TESTE")
            assert resultado2["atualizados"] == 2, resultado2
            assert resultado2["criados"] == 1, resultado2
            pessoas = list_people()
            assert len(pessoas) == 4, [p["full_name"] for p in pessoas]

            por_matricula = {p["enrollment_code"]: p for p in pessoas}
            assert por_matricula["1577"]["full_name"] == "ADRIEL FERNANDO FONSECA"
            assert por_matricula["1577"]["class_name"] == "6A"
            assert por_matricula["1579"]["guardian_phone"] == "5582977776666"

            # --- linhas problematicas sao recusadas, sem derrubar o resto
            suja = planilha([
                ["Matrícula", "Nome", "Telefone"],
                [1581, "ELIAS COSTA", "82955554444"],
                [1581, "ELIAS COSTA DUPLICADO", "82944443333"],   # repetida no arquivo
                ["", "SEM MATRICULA", "82933332222"],             # sem chave
                [1582, "FABIO ROCHA", "123"],                     # telefone impossivel
            ])
            analise3 = analisar_planilha(suja)
            assert len(analise3["criar"]) == 1, analise3["criar"]
            assert len(analise3["recusados"]) == 3, analise3["recusados"]
            motivos = " | ".join(r["motivo"] for r in analise3["recusados"])
            assert "repetida" in motivos, motivos
            assert "branco" in motivos, motivos
            assert "telefone invalido" in motivos, motivos

            # --- planilha sem as colunas obrigatorias e recusada inteira
            try:
                analisar_planilha(planilha([["Turma", "Observacao"], ["5A", "nada"]]))
                raise AssertionError("deveria ter recusado planilha sem matricula/nome")
            except ValueError as exc:
                assert "matricula" in str(exc), exc

            # --- CSV do Excel brasileiro: ponto e virgula e latin-1
            csv = "Matrícula;Nome;Telefone\n1590;GABRIEL SOUZA;82911112222\n".encode("latin-1")
            analise4 = analisar_planilha(csv, nome_arquivo="alunos.csv")
            assert len(analise4["criar"]) == 1, analise4
            assert analise4["criar"][0]["full_name"] == "GABRIEL SOUZA", analise4["criar"][0]
        finally:
            reset_current_tenant_slug(token)

    print("access-control import de planilha ok")


if __name__ == "__main__":
    main()
